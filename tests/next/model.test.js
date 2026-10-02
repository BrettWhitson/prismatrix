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

const graphOf = (nodes, edges = []) =>
  new Graph(GraphModel.from({ nodes, edges }));

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

test("the working graph is built from a model, and keeps it", () => {
  const m = GraphModel.from(recipe());
  const g = new Graph(m);
  assert.equal(g.model, m);
  assert.equal(g.byId.get("ingot").data.rarity, "basic");
  assert.equal(g.edges[1].id, "gift>ingot");
  assert.equal(g.edges[1].tree, false);
  // The old way still works, and builds a model on the way.
  const old = graphOf(
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

test("a model changes only through its own methods, and never freezes the caller's objects", () => {
  const input = recipe();
  const m = GraphModel.from(input);
  assert.throws(() => m.nodes.push({ id: "x" }));
  assert.throws(() => {
    m.node("mjolnir").data.icon.url = "changed";
  });
  input.nodes[0].data.icon.url = "mine to change";
  assert.equal(m.node("mjolnir").data.icon.url, "m.png");
  assert.ok(!Object.isFrozen(input.nodes[0].data.icon));
});

test("update: removals (with their edges), changes and additions, and exactly what changed", () => {
  const m = GraphModel.from(recipe());
  const heard = [];
  m.onChange((change) => heard.push(change));
  const ore = m.node("ore");

  // A price: no structure, no size, nothing drawn changes (data only). Untouched nodes keep their records.
  let change = m.update({ changeNodes: [{ id: "ingot", data: { price: 3 } }] });
  assert.deepEqual(change.nodesChanged, ["ingot"]);
  assert.equal(change.structure, false);
  assert.equal(change.sizes, false);
  assert.equal(change.looks, false);
  assert.equal(change.dataOnly, true);
  assert.equal(m.node("ingot").data.price, 3);
  assert.equal(m.node("ore"), ore, "unchanged nodes keep their records");

  // A label (labels are shown) changes a node's room.
  change = m.update({ changeNodes: [{ id: "ore", label: "Mithril Ore" }] });
  assert.equal(change.sizes, true);
  assert.equal(change.structure, false);

  // Removing a node takes its edges; adding appends.
  change = m.update({
    removeNodes: ["ingot"],
    addNodes: [{ id: "coin", label: "Mystic Coin" }],
    addEdges: [{ source: "gift", target: "coin" }],
  });
  assert.equal(change.structure, true);
  assert.deepEqual(change.nodesRemoved, ["ingot"]);
  assert.deepEqual(change.nodesAdded, ["coin"]);
  assert.deepEqual(change.edgesAdded, ["gift>coin"]);
  assert.deepEqual(change.edgesRemoved.sort(), [
    "gift>ingot",
    "ingot>ore",
    "mjolnir>ingot",
  ]);
  assert.deepEqual(
    m.nodes.map((n) => n.id),
    ["mjolnir", "gift", "ore", "coin"],
  );
  assert.deepEqual(m.ends, [
    [0, 1],
    [1, 3],
  ]);
  assert.equal(m.forest().depth[3], 2, "cached views follow the new structure");
  assert.equal(heard.length, 3);
  assert.deepEqual(
    heard.map((c) => c.version),
    [2, 3, 4],
  );

  // Nothing to do: no change, nobody told.
  assert.equal(
    m.update({ changeNodes: [{ id: "coin", label: "Mystic Coin" }] }),
    null,
  );
  assert.equal(heard.length, 3);

  // Problems are listed and skipped.
  change = m.update({
    changeNodes: [{ id: "nope", label: "x" }],
    addEdges: [{ source: "coin", target: "ghost" }],
    addNodes: [{ id: "coin" }],
  });
  assert.equal(change, null);
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["missing-node", "duplicate-node", "missing-endpoint"],
  );
});

test("replace: the whole graph in, records reused where nothing changed, order taken from the input", () => {
  const m = GraphModel.from(recipe());
  const kept = m.node("gift");
  const json = recipe();
  json.nodes[2].data = { rarity: "rare" };
  json.nodes.reverse();
  const change = m.replace(json);
  assert.equal(m.node("gift"), kept);
  assert.deepEqual(change.nodesChanged, ["ingot"]);
  assert.equal(change.structure, true, "a new order is a new structure");
  assert.equal(m.replace(json), null, "the same again changes nothing");
  // Replacing gives the same model as building from scratch.
  assert.deepEqual(m.toJSON(), GraphModel.from(json).toJSON());
});

test("options: how nodes and edges look, and which changes need a new layout", () => {
  const m = GraphModel.from(recipe(), { node: { size: 20 } });
  assert.equal(m.opts.node.size, 20);
  let change = m.setOptions({ node: { color: "#ff0000" }, edge: { width: 3 } });
  assert.equal(change.sizes, false);
  assert.deepEqual(change.options.node, { color: "#ff0000" });
  assert.deepEqual(change.options.edge, { width: 3 });
  change = m.setOptions({ node: { labelSize: 20 } });
  assert.equal(change.sizes, true);
  assert.equal(m.setOptions({ node: { labelSize: 20 } }), null);
});

test("label widths are measured once per distinct label, and again only when the label size or measure changes", () => {
  const measured = [];
  const measure = (text, size) => {
    measured.push(text);
    return text.length * size;
  };
  const m = GraphModel.from(recipe(), {
    measure,
    node: { labelSize: 10, labelMaxWidth: 0 }, // no cutting short: one measure per label
  });
  assert.deepEqual([...m.labelWidths()], [70, 150, 130, 30]);
  assert.equal(measured.length, 4);
  m.update({ addNodes: [{ id: "ore2", label: "ore" }] });
  m.labelWidths();
  assert.equal(
    measured.length,
    4,
    "a label already measured isn't measured again",
  );
  m.setOptions({ node: { labelSize: 20 } });
  assert.equal(m.labelWidths()[0], 140);
  assert.equal(measured.length, 8);
  assert.equal(m.labelHeight, 25);
});
