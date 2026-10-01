// The graph model (prismatrix-graph) and snapshots (prismatrix-snapshot): the format tests, telemetry and the API
// share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRAPH_FORMAT, GraphModel } from "../../next/engine/model.js";
import { Graph } from "../../next/engine/graph.js";
import {
  SNAPSHOT_FORMAT,
  applyState,
  snapshotModel,
  takeSnapshot,
} from "../../next/engine/snapshot.js";

const recipe = () => ({
  meta: { name: "Mjölnir (part)" },
  nodes: [
    {
      id: "mjolnir",
      label: "Mjölnir",
      data: { rarity: "legendary", icon: { url: "m.png" } },
    },
    { id: "gift", label: "Gift of Mjölnir" },
    { id: "ingot", label: "Mithril Ingot", data: { rarity: "basic" } },
    { id: "ore" },
  ],
  edges: [
    { source: "mjolnir", target: "gift", data: { count: 1 } },
    { source: "gift", target: "ingot", data: { count: 250 } },
    { source: "mjolnir", target: "ingot", data: { count: 10 } }, // shared ingredient: a cross-link
    { source: "ingot", target: "ore", data: { count: 2 } },
  ],
});

test("a model holds nodes and edges by id, with labels and data", () => {
  const m = GraphModel.from(recipe());
  assert.equal(m.size, 4);
  assert.equal(m.node("ore").label, "ore", "the label defaults to the id");
  assert.equal(m.node("ingot").data.rarity, "basic");
  assert.equal(
    m.edge("gift>ingot").data.count,
    250,
    "edge ids default to source>target",
  );
  assert.deepEqual(
    m.outgoing[m.index.get("mjolnir")].map((i) => m.edges[i].target),
    ["gift", "ingot"],
  );
  assert.equal(m.incoming[m.index.get("ingot")].length, 2);
  assert.deepEqual(m.issues, []);
});

test("a model never changes, and never freezes the caller's objects", () => {
  const input = recipe();
  const m = GraphModel.from(input);
  assert.throws(() => m.nodes.push({ id: "x" }));
  assert.throws(() => {
    m.node("mjolnir").data.icon.url = "changed";
  });
  input.nodes[0].data.icon.url = "mine to change";
  assert.equal(
    m.node("mjolnir").data.icon.url,
    "m.png",
    "the model kept its own copy",
  );
  assert.ok(!Object.isFrozen(input.nodes[0].data.icon));
});

test("problems are listed, not silently mangled; strict throws on the first", () => {
  const m = GraphModel.from({
    nodes: [
      { id: "a", label: "first" },
      { id: "a", label: "second" },
      { id: "b" },
    ],
    edges: [
      { source: "a", target: "nope" },
      { source: "b", target: "b" },
      { source: "a", target: "b" },
      { source: "a", target: "b" },
    ],
  });
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["duplicate-node", "missing-endpoint", "self-loop"],
  );
  assert.equal(m.node("a").label, "first");
  assert.deepEqual(
    m.edges.map((e) => e.id),
    ["a>b", "a>b#2"],
    "repeated edges are kept, with distinct ids",
  );
  assert.throws(
    () => GraphModel.from({ nodes: [{ id: 1 }, { id: 1 }] }, { strict: true }),
    /duplicate node/,
  );
});

test("JSON round trip: from(toJSON()) gives an equal model", () => {
  const m = GraphModel.from(recipe());
  const json = m.toJSON();
  assert.equal(json.format, GRAPH_FORMAT);
  assert.equal(json.version, 1);
  const again = GraphModel.from(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(again.toJSON(), json);
  assert.deepEqual(again.stats(), m.stats());
});

test("forest view: first edge to reach a node is its tree edge, the rest are cross-links", () => {
  const m = GraphModel.from(recipe());
  const f = m.forest();
  const at = (id) => m.index.get(id);
  assert.deepEqual(f.roots, [at("mjolnir")]);
  assert.equal(
    f.parent[at("ingot")],
    at("mjolnir"),
    "reached from mjolnir first (breadth first)",
  );
  assert.equal(f.depth[at("ore")], 2);
  const cross = m.edges.filter((_, i) => !f.tree[i]).map((e) => e.id);
  assert.deepEqual(cross, ["gift>ingot"]);
  assert.equal(m.forest(), f, "computed once");
});

test("DAG view: back edges of cycles, topological order, longest path from a source", () => {
  const m = GraphModel.from(recipe());
  const d = m.dag();
  const at = (id) => m.index.get(id);
  assert.equal(
    d.back.reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(
    d.longest[at("ingot")],
    2,
    "below the gift as well as the hammer",
  );
  assert.equal(d.longest[at("ore")], 3);
  assert.deepEqual(d.sources, [at("mjolnir")]);
  assert.deepEqual(d.sinks, [at("ore")]);
  const cyclic = GraphModel.from({
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ],
  });
  assert.equal(
    cyclic.dag().back.reduce((a, b) => a + b, 0),
    1,
    "one edge reversed breaks the cycle",
  );
  assert.equal(cyclic.dag().order.length, 3);
});

test("stats describe the graph's shape", () => {
  const s = GraphModel.from(recipe()).stats();
  assert.deepEqual(
    { ...s },
    {
      nodes: 4,
      edges: 4,
      roots: 1,
      depth: 2,
      layers: 4,
      crossLinks: 1,
      sharedNodes: 1,
      maxInDegree: 2,
      maxOutDegree: 2,
      backEdges: 0,
      issues: 0,
    },
  );
});

test("diff: added, removed, kept and changed nodes; added and removed edges", () => {
  const before = GraphModel.from(recipe());
  const next = recipe();
  next.nodes = next.nodes.filter((n) => n.id !== "ore");
  next.nodes.push({ id: "coin", label: "Mystic Coin" });
  next.nodes[2] = { ...next.nodes[2], label: "Mithril Ingot (x2)" };
  next.edges = next.edges.filter((e) => e.target !== "ore");
  next.edges.push({ source: "gift", target: "coin" });
  const change = GraphModel.from(next).diff(before);
  assert.deepEqual(change.nodesAdded, ["coin"]);
  assert.deepEqual(change.nodesRemoved, ["ore"]);
  assert.deepEqual(change.nodesChanged, ["ingot"]);
  assert.deepEqual(change.edgesAdded, ["gift>coin"]);
  assert.deepEqual(change.edgesRemoved, ["ingot>ore"]);
});

test("the working graph is built from a model, and keeps it", () => {
  const m = GraphModel.from(recipe());
  const g = new Graph(m);
  assert.equal(g.model, m);
  assert.equal(g.byId.get("ingot").data.rarity, "basic");
  assert.equal(g.edges[1].id, "gift>ingot");
  assert.equal(g.edges[1].tree, false);
  // The old way still works, and builds a model on the way.
  const old = new Graph(
    [{ id: "a" }, { id: "b" }],
    [{ source: "a", target: "b" }],
  );
  assert.ok(old.model instanceof GraphModel);
});

test("snapshots record graph, settings, camera and layout state by id, and restore them", () => {
  const g = new Graph(GraphModel.from(recipe()));
  g.nodes.forEach((n, i) =>
    Object.assign(n, {
      x: i * 10.123,
      y: -i,
      homeX: i * 10,
      homeY: 0,
      vx: 1,
      vy: 0,
    }),
  );
  const shot = takeSnapshot(
    {
      graph: g,
      settings: { layout: "merged", layoutOptions: { direction: "LR" } },
      camera: { x: 1, y: 2, k: 0.5 },
    },
    "test",
  );
  assert.equal(shot.format, SNAPSHOT_FORMAT);
  assert.equal(shot.note, "test");
  assert.equal(shot.stats.crossLinks, 1);
  assert.deepEqual(shot.state.ingot, {
    x: 20.25,
    y: -2,
    homeX: 20,
    homeY: 0,
    vx: 1,
    vy: 0,
  });
  const json = JSON.parse(JSON.stringify(shot));
  const back = new Graph(snapshotModel(json));
  applyState(back, json.state);
  assert.equal(back.byId.get("ingot").x, 20.25);
  assert.equal(back.byId.get("ore").homeX, 30);
  assert.throws(
    () => snapshotModel({ format: "something else" }),
    /not a prismatrix-snapshot/,
  );
  assert.throws(() => snapshotModel({ ...json, version: 99 }), /newer/);
});

import { readFileSync, readdirSync } from "node:fs";

test("every fixture graph loads cleanly and round-trips byte for byte", () => {
  const dir = new URL("../fixtures/graphs/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 7);
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const model = GraphModel.from(JSON.parse(text));
    assert.deepEqual(model.issues, [], file);
    assert.equal(
      JSON.stringify(model.toJSON(), null, 1) + "\n",
      text,
      `${file} round-trips`,
    );
    assert.equal(new Graph(model).nodes.length, model.size);
  }
});
