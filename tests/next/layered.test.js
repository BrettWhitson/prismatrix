// The merged tree: a layered drawing (Sugiyama) of a graph where nodes can have several parents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import {
  countCrossings,
  layeredLayout,
  project,
} from "../../next/engine/layered.js";
import { edgeRoute } from "../../next/engine/geometry.js";
import { lineage } from "../../next/engine/render.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A random tree plus `shared` extra edges from earlier to later nodes: shared ingredients, no cycles. */
function recipes(seed, count, shared) {
  const r = rng(seed);
  const nodes = [{ id: "0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: String(i) });
    edges.push({
      source: String(Math.floor(r() ** 1.3 * i)),
      target: String(i),
    });
  }
  for (let k = 0; k < shared; k++) {
    const a = Math.floor(r() * count),
      b = Math.floor(r() * count);
    if (a !== b)
      edges.push({
        source: String(Math.min(a, b)),
        target: String(Math.max(a, b)),
      });
  }
  return new Graph(nodes, edges);
}

const sizing = { gap: 0, box: () => ({ x0: -8, y0: -8, x1: 8, y1: 8 }) };

test("every edge points down at least one layer, and shared nodes sit below everything that uses them", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = recipes(seed, 30 + seed * 3, seed);
    const routing = layeredLayout(g, {}, sizing);
    for (const e of g.edges) {
      assert.ok(
        routing.layerOf[e.target] > routing.layerOf[e.source],
        `seed ${seed}`,
      );
      assert.ok(
        g.nodes[e.target].homeY > g.nodes[e.source].homeY,
        `seed ${seed}: drawn below`,
      );
    }
  }
});

test("nothing overlaps on a layer, checked pair by pair", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = recipes(seed, 80, 20);
    const routing = layeredLayout(g, { nodeGap: 10 }, sizing);
    const byLayer = new Map();
    g.nodes.forEach((n) =>
      byLayer.set(routing.layerOf[n.index], [
        ...(byLayer.get(routing.layerOf[n.index]) ?? []),
        n,
      ]),
    );
    for (const list of byLayer.values()) {
      list.sort((a, b) => a.homeX - b.homeX);
      for (let i = 1; i < list.length; i++)
        assert.ok(
          list[i].homeX - list[i - 1].homeX >= 16 + 10 - 1e-6,
          `seed ${seed}`,
        );
    }
  }
});

test("ordering never ends with more crossings than it started with, and usually removes some", () => {
  let improved = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = recipes(seed, 60, 25);
    const routing = layeredLayout(g, {}, sizing);
    assert.ok(routing.crossings <= routing.initialCrossings, `seed ${seed}`);
    if (routing.crossings < routing.initialCrossings) improved++;
  }
  assert.ok(improved >= 20, `fewer crossings in ${improved} of 40`);
});

test("a plain tree lays out with no crossings and no bends", () => {
  const g = recipes(5, 100, 0);
  const routing = layeredLayout(g, {}, sizing);
  assert.equal(routing.crossings, 0);
  for (const e of g.edges) assert.equal(routing.bends.get(e).length, 0);
});

test("long edges get one bend per layer they cross, in order down the edge", () => {
  // root → a → b → c, and root → c directly: the long edge crosses two layers.
  const g = new Graph(
    ["root", "a", "b", "c"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["a", "b"],
      ["b", "c"],
      ["root", "c"],
    ].map(([source, target]) => ({ source, target })),
  );
  const routing = layeredLayout(g, { levelGap: 50 }, sizing);
  const long = g.edges.find(
    (e) => g.nodes[e.source].id === "root" && g.nodes[e.target].id === "c",
  );
  const bends = routing.bends.get(long);
  assert.equal(bends.length, 2);
  assert.deepEqual(
    bends.map((b) => b[1]),
    [g.byId.get("a").homeY, g.byId.get("b").homeY],
  );
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const pts = edgeRoute(g, routing, "straight", long);
  assert.equal(pts.length, 8, "root, two bends, c");
});

test("cycles are laid out anyway (a reversed edge), and the same input gives the same output", () => {
  const make = () =>
    new Graph(
      ["a", "b", "c"].map((id) => ({ id })),
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ].map(([source, target]) => ({ source, target })),
    );
  const g = make();
  layeredLayout(g, {}, sizing);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.homeX + n.homeY)));
  const a = recipes(9, 120, 30),
    b = recipes(9, 120, 30);
  layeredLayout(a, {}, sizing);
  layeredLayout(b, {}, sizing);
  assert.deepEqual(
    a.nodes.map((n) => [n.homeX, n.homeY]),
    b.nodes.map((n) => [n.homeX, n.homeY]),
  );
});

test("bends move with their edge's ends when the nodes are dragged", () => {
  const g = new Graph(
    ["root", "a", "b"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["a", "b"],
      ["root", "b"],
    ].map(([source, target]) => ({ source, target })),
  );
  const routing = layeredLayout(g, {}, sizing);
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const long = g.edges[2];
  const [bend] = routing.bends.get(long);
  g.byId.get("b").x += 100; // drag the end
  const pts = edgeRoute(g, routing, "straight", long);
  assert.ok(
    Math.abs(pts[2] - (bend[0] + 50)) < 1e-9,
    "the middle bend moves halfway",
  );
});

test("hovering a shared ingredient lights up every recipe that uses it", () => {
  const g = new Graph(
    ["sword", "shield", "ingot", "ore"].map((id) => ({ id })),
    [
      ["sword", "ingot"],
      ["shield", "ingot"],
      ["ingot", "ore"],
    ].map(([source, target]) => ({ source, target })),
  );
  const lit = lineage(g, g.byId.get("ingot").index);
  for (const id of ["sword", "shield", "ingot", "ore"])
    assert.ok(lit.has(g.byId.get(id).index), id);
});

test("crossings and the order-keeping projection, on their own", () => {
  // Two layers, two edges crossing: (0 → 1') and (1 → 0').
  const pos = Float64Array.of(0, 1, 1, 0);
  assert.equal(
    countCrossings(
      [
        [0, 1],
        [2, 3],
      ],
      [[2], [3], [], []],
      pos,
    ),
    1,
  );
  // Desired positions on top of each other: pushed apart symmetrically, in order.
  const out = project([10, 10, 10], [5, 5], [1, 1, 1]);
  assert.deepEqual([...out], [5, 10, 15]);
  // Already far enough apart: left where they are.
  assert.deepEqual([...project([0, 50], [10], [1, 1])], [0, 50]);
});

test("2,000 nodes with shared ingredients lay out in well under a second", () => {
  const g = recipes(3, 2000, 400);
  const start = performance.now();
  layeredLayout(g, {}, sizing);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});
