// The layout engine's building blocks: the layered layout, the physics' quadtree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutGraph } from "../src/layout-graph.js";
import { countCrossings, layeredLayout } from "../src/layered.js";
import { CollisionGrid, Quadtree } from "../src/physics.js";

/** Nodes 40 × 40 unless given; the first is the root. Edges as "a>b". */
function graph(ids, edges, size = {}) {
  return new LayoutGraph(
    ids.map((id, i) => ({ id, w: 40, h: 40, ...size[id], root: i === 0 })),
    edges.map((edge) => {
      const [source, target] = edge.split(">");
      return { source, target };
    }),
  );
}

// A DAG: two parents share "e"; "f" is reached at two depths (via "d" and directly).
const IDS = ["root", "b", "c", "d", "e", "f", "g"];
const EDGES = ["root>b", "root>c", "b>e", "c>e", "c>d", "d>f", "b>g", "root>f"];
const depthOf = (g, id) => Math.round(g.positionOf(id).y); // TB: rank along y

test("layered: every edge runs down at least one rank, and edges stay short", () => {
  const g = graph(IDS, EDGES);
  layeredLayout(g, { direction: "TB", rankSep: 50 });
  for (const edge of EDGES) {
    const [s, t] = edge.split(">");
    assert.ok(depthOf(g, t) > depthOf(g, s), edge);
  }
  // g only hangs off b, so it sits right under it rather than down with the deepest leaf (f).
  assert.ok(depthOf(g, "g") < depthOf(g, "f"));
});

test("layered: cycles don't stop it, and the same graph always gives the same layout", () => {
  const cyclic = [...EDGES, "e>b"]; // e → b closes a loop
  const a = graph(IDS, cyclic),
    b = graph(IDS, cyclic);
  layeredLayout(a, { direction: "TB" });
  layeredLayout(b, { direction: "TB" });
  assert.deepEqual(a.positions(), b.positions());
  for (const id of IDS) assert.ok(Number.isFinite(a.positionOf(id).x));
});

test("layered: an avoidable crossing is removed, and nodes on a rank keep their spacing", () => {
  // Starting order puts x's children in y's order and y's in x's: the sweeps have to swap them.
  const ids = ["r", "x", "y", "x1", "y1"];
  const g = graph(ids, ["r>x", "r>y", "y>y1", "x>x1"], {
    y1: { w: 40, h: 40 },
  });
  const { crossings } = layeredLayout(g, { direction: "TB", nodeSep: 20 });
  assert.equal(crossings, 0);
  const x = (id) => g.positionOf(id).x;
  assert.equal(x("x") < x("y"), x("x1") < x("y1"), "children follow parents");
  assert.ok(Math.abs(x("x1") - x("y1")) >= 40 + 20 - 1e-9);
});

test("layered: directions follow the flow (root → leaves)", () => {
  const cases = { TB: ["y", 1], BT: ["y", -1], LR: ["x", 1], RL: ["x", -1] };
  for (const [direction, [axis, sign]] of Object.entries(cases)) {
    const g = graph(IDS, EDGES);
    layeredLayout(g, { direction });
    const along = (id) => g.positionOf(id)[axis] * sign;
    assert.ok(along("e") > along("b"), direction);
    assert.ok(along("b") > along("root"), direction);
  }
});

test("crossings are counted exactly between neighbouring ranks", () => {
  // a─d and b─c cross; a─c doesn't cross b─c (shared end).
  const ranks = [
    ["a", "b"],
    ["c", "d"],
  ];
  const down = { a: ["d", "c"], b: ["c"], c: [], d: [] };
  const position = new Map([
    ["a", 0],
    ["b", 1],
    ["c", 0],
    ["d", 1],
  ]);
  assert.equal(countCrossings(ranks, down, position), 1);
});

test("quadtree: masses and centres of mass add up; coincident points merge", () => {
  const x = Float64Array.from([0, 10, 10, 0, 5, 5, 5]);
  const y = Float64Array.from([0, 0, 10, 10, 5, 5, 5]); // three points on (5, 5)
  const tree = new Quadtree(2); // too small on purpose: it grows
  tree.build(x, y, x.length);
  assert.equal(tree.mass[0], 7);
  assert.ok(Math.abs(tree.cx[0] - 35 / 7) < 1e-9);
  assert.ok(Math.abs(tree.cy[0] - 35 / 7) < 1e-9);
  // Rebuilt in place, with the same answer.
  tree.build(x, y, x.length);
  assert.equal(tree.mass[0], 7);
});

test("footprints: a share of the label's overhang on each axis", () => {
  const g = new LayoutGraph(
    [{ id: "n", w: 40, h: 40, fullW: 140, fullH: 60 }],
    [],
  );
  assert.deepEqual(g.footprint(0, 1, 1), { w: 140, h: 60 });
  assert.deepEqual(g.footprint(0, 0.5, 0), { w: 90, h: 40 });
});

test("collision grid: every point is found in its cell, negative cells and crowded tables included", () => {
  const count = 500;
  const x = new Float64Array(count),
    y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = ((i * 37) % 101) * 13 - 600; // spread over negative and positive cells
    y[i] = ((i * 53) % 97) * 11 - 500;
  }
  const grid = new CollisionGrid(count);
  for (const cellSize of [7, 50]) {
    grid.build(x, y, count, cellSize); // rebuilt in place: the old cells mustn't leak through
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const gx = Math.floor(x[i] / cellSize),
        gy = Math.floor(y[i] / cellSize);
      const members = [];
      for (let j = grid.first(gx, gy); j >= 0; j = grid.next[j])
        members.push(j);
      assert.ok(members.includes(i), `${i} in its cell`);
      for (const j of members) {
        assert.equal(Math.floor(x[j] / cellSize), gx);
        assert.equal(Math.floor(y[j] / cellSize), gy);
        seen.add(j);
      }
    }
    assert.equal(seen.size, count);
    assert.equal(grid.first(1e6, 1e6), -1, "an empty cell");
  }
});
