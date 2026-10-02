// Layouts off the page's thread: the worker's job gives the same layout as running it in place, and a controller
// keeps showing the graph it has until a layout arrives, and uses only the newest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import { LAYOUTS } from "../../next/engine/layouts.js";
import { resolve } from "../../next/engine/schema.js";
import {
  graphFromStructure,
  runLayout,
  sizingFrom,
  structureOf,
  unpackRouting,
} from "../../next/engine/layout-job.js";
import { GraphController } from "../../next/engine/controller.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A recipe-like graph: a tree plus shared ingredients. */
function recipes(count, shared, seed = 3) {
  const r = rng(seed);
  const nodes = [{ id: "n0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: `n${i}`, label: `item ${i}` });
    edges.push({ source: `n${Math.floor(r() ** 1.3 * i)}`, target: `n${i}` });
  }
  for (let k = 0; k < shared; k++) {
    const a = Math.floor(r() * count),
      b = Math.floor(r() * count);
    if (a !== b)
      edges.push({
        source: `n${Math.min(a, b)}`,
        target: `n${Math.max(a, b)}`,
      });
  }
  return { nodes, edges };
}

const spec = (g) => ({
  widths: Float64Array.from(g.nodes, (n) => 6 * n.label.length),
  reach: new Float64Array(g.nodes.length).fill(8),
  height: 14,
  gap: 4,
  labels: "below",
  collide: true,
});

test("a layout across the worker boundary (structure in, packed result out) is the layout run in place", () => {
  const model = GraphModel.from(recipes(300, 60));
  for (const name of ["tree", "radial", "merged"]) {
    const options = resolve(LAYOUTS[name].options);
    const here = new Graph(model);
    const sizing = spec(here);
    const routingHere = LAYOUTS[name].run(here, options, sizingFrom(sizing));
    // The worker gets only the structure and the sizing, and builds its own graph.
    const there = graphFromStructure(structureOf(here));
    const result = runLayout(there, name, options, sizing);
    assert.deepEqual([...result.homeX], [...here.matrix.homeX], name);
    assert.deepEqual([...result.homeY], [...here.matrix.homeY], name);
    const routing = unpackRouting(result.routing, here);
    assert.equal(routing.kind, routingHere.kind);
    if (name === "merged") {
      for (const e of here.edges)
        assert.deepEqual(
          routing.bends.get(e) ?? [],
          routingHere.bends.get(e) ?? [],
        );
      assert.deepEqual(
        routing.references.map((r) => [r.edge, r.x, r.y]),
        routingHere.references.map((r) => [r.edge, r.x, r.y]),
      );
    }
  }
});

/**
 * A stand-in for the browser's Worker: answers each layout later (when `flush` is called), running the same job
 * the real worker runs.
 */
function fakeWorkers() {
  const queue = [];
  class FakeWorker {
    constructor() {
      this.structure = null;
    }
    postMessage(data) {
      if (data.type === "structure") {
        this.structure = graphFromStructure(data.structure);
        return;
      }
      const graph = this.structure;
      queue.push(() => {
        const result = runLayout(graph, data.layout, data.options, data.sizing);
        this.onmessage({ data: { id: data.id, result } });
      });
    }
    terminate() {}
  }
  return {
    FakeWorker,
    flush: () => queue.splice(0).forEach((answer) => answer()),
    pending: () => queue.length,
  };
}

test("with layouts in a worker, the graph on screen stays as it is until its layout arrives, and only the newest is used", async () => {
  const { FakeWorker, flush, pending } = fakeWorkers();
  globalThis.Worker = FakeWorker;
  try {
    const time = 1000;
    const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
      worker: true,
      clock: () => time,
    });
    c.setViewport(800, 600);
    assert.equal(
      c.graph.nodes.length,
      0,
      "nothing shown before the first layout",
    );
    assert.equal(c.tick(time).state, "laying out");
    flush();
    await Promise.resolve();
    assert.equal(c.graph.nodes.length, 50);
    const first = c.graph;

    // Three changes in a row: while their layouts are worked out, the old graph stays.
    c.setGraph(recipes(60, 5));
    c.setGraph(recipes(70, 5));
    c.setGraph(recipes(80, 5));
    assert.equal(c.graph, first);
    assert.equal(pending(), 3);
    flush();
    await Promise.resolve();
    assert.equal(
      c.graph.nodes.length,
      80,
      "the newest layout was put in place",
    );
    assert.equal(c.layoutPending, false);
    // It's laid out: every node has a home, and they don't all sit in one place.
    const xs = new Set([...c.graph.matrix.homeX].map(Math.round));
    assert.ok(xs.size > 10);
    // Nodes the old graph had glide from where they were.
    for (let i = 0; i < 50; i++) {
      const before = first.byId.get(`n${i}`);
      const now = c.graph.byId.get(`n${i}`);
      assert.equal(now.x, before.x);
    }
    c.destroy();
  } finally {
    delete globalThis.Worker;
  }
});
