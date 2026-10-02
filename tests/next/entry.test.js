// The new engine's entry points: what the index exports (and doesn't), and layout without a screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as engine from "../../next/engine/index.js";
import * as layoutEntry from "../../next/engine/layout.js";
import { layoutGraph } from "../../next/engine/layout.js";
import { GraphController } from "../../next/engine/controller.js";

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/graphs/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("the index exports what an app needs, and no internals", () => {
  assert.deepEqual(Object.keys(engine).sort(), [
    "ANIMATION_OPTIONS",
    "EASINGS",
    "EDGE_OPTIONS",
    "GRAPH_FORMAT",
    "GRAPH_VERSION",
    "GraphController",
    "GraphModel",
    "LAYOUTS",
    "NODE_OPTIONS",
    "PHYSICS",
    "SNAPSHOT_FORMAT",
    "SNAPSHOT_VERSION",
    "THEMES",
    "WORKER_MIN",
    "canvasRenderer",
    "glRenderer",
    "physicsSchema",
    "resolve",
    "resolveTheme",
    "snapshotModel",
  ]);
});

test("the layout entry needs no DOM and lays out as a controller does", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.ok(layoutEntry.GraphModel && layoutEntry.LAYOUTS);
  for (const [name, layout] of [
    ["mjolnir-example", "tree"],
    ["crafting-small", "merged"],
    ["crafting-small", "radial"],
  ]) {
    const json = fixture(name);
    const { positions, routing, model } = layoutGraph(json, { layout });
    const c = new GraphController(json, null, { layout, worker: false });
    await c.laidOut();
    assert.equal(positions.size, model.size);
    assert.equal(routing.kind, layout === "merged" ? "layered" : layout);
    for (const n of c.graph.nodes) {
      const p = positions.get(n.id);
      assert.equal(p.x, n.homeX, `${name} ${layout}: ${n.id} x`);
      assert.equal(p.y, n.homeY, `${name} ${layout}: ${n.id} y`);
    }
  }
});

test("the layout entry takes layout options and node options", () => {
  const json = fixture("mjolnir-example");
  const down = layoutGraph(json, { layoutOptions: { levelGap: 100 } });
  const across = layoutGraph(json, {
    layoutOptions: { direction: "LR", levelGap: 100 },
    node: { labels: "off" },
  });
  const root = json.nodes[0].id;
  const child = json.edges.find((e) => e.source === root).target;
  const gap = (r, axis) =>
    r.positions.get(child)[axis] - r.positions.get(root)[axis];
  assert.ok(gap(down, "y") >= 100);
  assert.ok(gap(across, "x") >= 100);
  assert.equal(across.model.opts.node.labels, "off");
  assert.throws(() => layoutGraph(json, { layout: "nope" }), /Unknown layout/);
});
