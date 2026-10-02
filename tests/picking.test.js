// Picking: the hit grid finds what a scan of every node finds, and lineage masks are the lineage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HIT_SCALE,
  HitGrid,
  LineageCache,
  lineageMask,
} from "../src/picking.js";
import { Graph } from "../src/graph.js";
import { GraphModel } from "../src/model.js";

/** Node `index`'s lineage the slow way: whatever reaches it and whatever it reaches, edge by edge until nothing grows. */
function lineage(graph, index) {
  const set = new Set([index]);
  for (const [from, to] of [
    ["target", "source"],
    ["source", "target"],
  ]) {
    const seen = new Set([index]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of graph.edges)
        if (seen.has(e[from]) && !seen.has(e[to])) {
          seen.add(e[to]);
          set.add(e[to]);
          grew = true;
        }
    }
  }
  return set;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** The topmost node under (px, py), the slow way. */
function scan({ x, y, radius, count }, px, py, slack) {
  for (let i = count - 1; i >= 0; i--)
    if (Math.hypot(x[i] - px, y[i] - py) <= radius[i] * HIT_SCALE + slack)
      return i;
  return -1;
}

test("the hit grid finds the topmost node under a point, as a scan of every node does", () => {
  const r = rng(7);
  for (const [count, spread, big] of [
    [500, 2000, 0],
    [3000, 400, 0], // crowded: many overlaps, the topmost must win
    [800, 50_000, 1], // sparse, with one huge node
    [200, 0, 0], // all in one place
  ]) {
    const m = {
      count,
      x: Float64Array.from({ length: count }, () => (r() - 0.5) * spread),
      y: Float64Array.from({ length: count }, () => (r() - 0.5) * spread * 0.1),
      radius: Float64Array.from({ length: count }, () => 4 + r() * 12),
    };
    if (big) m.radius[17] = 900;
    m.x[5] = NaN; // a node that flew off: never hit, never breaks the grid
    const grid = new HitGrid(m);
    for (let k = 0; k < 2000; k++) {
      const px = (r() - 0.5) * spread * 1.1,
        py = (r() - 0.5) * spread * 0.11;
      const slack = r() * 8;
      assert.equal(grid.at(px, py, slack), scan(m, px, py, slack));
    }
    // Every node's own centre finds it, or one drawn over it.
    for (let i = 0; i < count; i++)
      if (i !== 5) assert.ok(grid.at(m.x[i], m.y[i]) >= i);
  }
  const empty = new HitGrid({
    count: 0,
    x: new Float64Array(0),
    y: new Float64Array(0),
    radius: new Float64Array(0),
  });
  assert.equal(empty.at(0, 0, 10), -1);
});

test("a lineage mask is the node, everything above it and everything below it; unions and the cache agree", () => {
  const r = rng(3);
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}` }));
  const edges = [];
  for (let i = 1; i < 300; i++) {
    edges.push({ source: `n${Math.floor(r() * i)}`, target: `n${i}` });
    if (r() < 0.3)
      edges.push({ source: `n${Math.floor(r() * i)}`, target: `n${i}` });
  }
  const graph = new Graph(new GraphModel({ nodes, edges }));
  const cache = new LineageCache();
  for (const i of [0, 17, 150, 299]) {
    const mask = lineageMask(graph, i);
    const set = lineage(graph, i);
    for (let j = 0; j < 300; j++)
      assert.equal(!!mask[j], set.has(j), `${i}:${j}`);
    assert.equal(cache.get(graph, i), cache.get(graph, i), "kept");
  }
  const union = lineageMask(graph, 40, lineageMask(graph, 220));
  const a = lineage(graph, 40),
    b = lineage(graph, 220);
  for (let j = 0; j < 300; j++)
    assert.equal(!!union[j], a.has(j) || b.has(j), `${j}`);
});
