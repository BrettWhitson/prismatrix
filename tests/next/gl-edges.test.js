// Edges built on the GPU: the shader's geometry (mirrored in piecePoints) against the CPU's own edge routes, and
// the instance data the GPU gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import { treeLayout } from "../../next/engine/layouts.js";
import { layeredLayout } from "../../next/engine/layered.js";
import {
  edgeRoute,
  rounded,
  stepCurveWeight,
  trim,
} from "../../next/engine/geometry.js";
import { looksOf } from "../../next/engine/render.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "../../next/engine/style.js";
import { resolve } from "../../next/engine/schema.js";
import {
  AXIS,
  PIECE_POINTS,
  PIECE_STRIDE,
  POSITION_COLUMNS,
  gpuEdges,
  packPieces,
  RADIAL_POINTS,
  packPositions,
  piecePoints,
  radialPiecePoints,
} from "../../next/engine/gl-edges.js";

/** The furthest any point of polyline `a` is from polyline `b` (both flat or as [x, y] points). */
function distance(a, b) {
  const pa = Array.isArray(a[0]) ? a : pairs(a),
    pb = Array.isArray(b[0]) ? b : pairs(b);
  let worst = 0;
  for (const [x, y] of pa) {
    let best = Infinity;
    for (let i = 1; i < pb.length; i++) {
      const [x0, y0] = pb[i - 1],
        [x1, y1] = pb[i];
      const dx = x1 - x0,
        dy = y1 - y0;
      const t = Math.max(
        0,
        Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)),
      );
      best = Math.min(best, Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}
const pairs = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
const hausdorff = (a, b) => Math.max(distance(a, b), distance(b, a));

test("the GPU's step, curve and straight pieces trace the CPU's routes, trimmed the same way", () => {
  const cases = [
    [0, 0, 120, 90],
    [0, 0, -60, 90],
    [0, 0, 8, 90], // a step too narrow for its corner radius
    [0, 0, 0, 90], // straight down
    [10, 20, 300, 400],
  ];
  for (const direction of ["TB", "LR", "BT", "RL"]) {
    const routing = { kind: "tree", direction };
    for (const [ax, ay, bx, by] of cases) {
      // In LR / RL the layout runs along x: swap so the child is still further along the axis.
      const across = direction === "LR" || direction === "RL";
      const sign = direction === "BT" || direction === "RL" ? -1 : 1;
      const s = across ? { x: ay * sign, y: ax } : { x: ax, y: ay * sign };
      const t = across ? { x: by * sign, y: bx } : { x: bx, y: by * sign };
      for (const [shape, id] of [
        ["step", 1],
        ["curve", 2],
        ["straight", 0],
      ]) {
        for (const [trimA, trimB] of [
          [0, 0],
          [6, 10],
        ]) {
          let cpu = edgeRoute({ nodes: [s, t] }, routing, shape, {
            source: 0,
            target: 1,
            tree: true,
          });
          cpu = trim(cpu, trimA, trimB);
          if (shape === "step") cpu = rounded(cpu, 8);
          const gpu = piecePoints(
            id,
            AXIS[direction],
            [s.x, s.y],
            [t.x, t.y],
            trimA,
            trimB,
            8,
          );
          assert.equal(gpu.length, PIECE_POINTS);
          const gap = hausdorff(gpu, cpu);
          // Steps and straight lines match closely; a curve is sampled at 16 points, so its chords sit a little
          // inside the CPU's finer ones.
          const tolerance = shape === "curve" ? 1.5 : 0.75;
          assert.ok(
            gap < tolerance,
            `${direction} ${shape} ${[ax, ay, bx, by]} trim ${trimA},${trimB}: ${gap.toFixed(2)} px apart`,
          );
        }
      }
    }
  }
});

/** A small recipe with a shared ingredient: root → a, b; a → x; b → x (a cross-link); x → y. */
function recipe() {
  return GraphModel.from({
    nodes: ["root", "a", "b", "x", "y"].map((id) => ({ id })),
    edges: [
      ["root", "a"],
      ["root", "b"],
      ["a", "x"],
      ["b", "x"],
      ["x", "y"],
      ["root", "y"],
    ].map(([source, target]) => ({ source, target })),
  });
}

function sceneFor(g, routing, edge = {}) {
  const node = resolve(NODE_OPTIONS);
  const edgeOpts = resolve(EDGE_OPTIONS, edge);
  return {
    graph: g,
    matrix: g.matrix,
    routing,
    edge: edgeOpts,
    node,
    looks: looksOf(g, node, edgeOpts),
  };
}

test("pieces: one per edge, one more per layered bend; cross-links that bundle are left to the CPU", () => {
  const g = new Graph(recipe());
  const tree = sceneFor(g, treeLayout(g, {}), { shape: "step" });
  assert.ok(gpuEdges(tree));
  const packed = packPieces(tree, { x: 0, y: 0 });
  const crossLinks = g.edges.filter((e) => !e.tree).length;
  assert.equal(packed.cpu.length, crossLinks);
  assert.equal(packed.pieceCount, g.edges.length - crossLinks);

  const routing = layeredLayout(g, { references: "off" });
  const merged = sceneFor(g, routing, { shape: "step", arrow: "arrow" });
  const m = packPieces(merged, { x: 0, y: 0 });
  const bends = [...routing.bends.values()].reduce((n, b) => n + b.length, 0);
  assert.ok(bends > 0, "the fixture has a long edge");
  assert.equal(m.cpu.length, 0, "a layered layout's edges all go to the GPU");
  assert.equal(m.pieceCount, g.edges.length + bends);
  assert.equal(m.tipCount, g.edges.length);
  // A bend stop sits at its home, relative to the origin, a share of the way along its edge.
  const long = g.edges.find((e) => routing.bends.get(e)?.length);
  const first = m.pieceEdge.indexOf(g.edges.indexOf(long));
  const o = first * PIECE_STRIDE;
  assert.equal(m.pieces[o + 3], 1, "the first piece starts at the source node");
  assert.equal(m.pieces[o + 7], 0, "and ends at a bend");
  assert.deepEqual(
    [m.pieces[o + 4], m.pieces[o + 5]].map(Math.round),
    routing.bends.get(long)[0].map(Math.round),
  );
});

test("the GPU draws straight, step and curve edges in every layout; fans and tapers stay on the CPU", () => {
  const g = new Graph(recipe());
  const t = treeLayout(g, {});
  assert.ok(gpuEdges(sceneFor(g, t, { shape: "curve" })));
  assert.ok(!gpuEdges(sceneFor(g, t, { shape: "fan" })));
  assert.ok(!gpuEdges(sceneFor(g, t, { shape: "step", taper: true })));
  const radial = { kind: "radial", cx: 0, cy: 0 };
  assert.ok(gpuEdges(sceneFor(g, radial, { shape: "straight" })));
  assert.ok(gpuEdges(sceneFor(g, radial, { shape: "step" })));
});

test("radial pieces trace the CPU's routes: spokes from the centre, ring arcs, curves when off the rings", () => {
  const centre = { cx: 0, cy: 0 };
  const routing = { kind: "radial", cx: 0, cy: 0 };
  const at = (r, deg, home = r) => {
    const a = (deg * Math.PI) / 180;
    return {
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      homeX: Math.cos(a) * home,
      homeY: Math.sin(a) * home,
    };
  };
  const cases = [
    ["ring arc", at(100, 10), at(200, 40)],
    ["ring arc the other way", at(100, 40), at(200, -20)],
    ["a wide arc", at(300, 0), at(400, 70)],
    ["across the ±180° line", at(80, -145), at(160, 172)],
    ["across it the other way", at(80, 170), at(160, -150)],
    ["spoke from the centre", at(0, 0), at(150, 33)],
    ["off its ring: a curve", at(160, 10, 100), at(200, 40)],
  ];
  for (const [name, s, t] of cases)
    for (const [shape, id] of [
      ["step", 1],
      ["curve", 2],
      ["straight", 0],
    ])
      for (const [trimA, trimB] of [
        [0, 0],
        [6, 10],
      ]) {
        let cpu = edgeRoute({ nodes: [s, t] }, routing, shape, {
          source: 0,
          target: 1,
          tree: true,
        });
        cpu = trim(cpu, trimA, trimB);
        if (shape === "step") cpu = rounded(cpu, 8);
        const gpu = radialPiecePoints(id, centre, s, t, trimA, trimB, 8);
        assert.equal(gpu.length, RADIAL_POINTS);
        const gap = hausdorff(gpu, cpu);
        assert.ok(
          gap < 2,
          `${name}, ${shape}, trim ${trimA},${trimB}: ${gap.toFixed(2)} px apart`,
        );
      }
});

test("positions: the matrix, then display-only nodes, relative to the origin, in rows of the texture", () => {
  const g = new Graph(recipe());
  g.nodes.forEach((n, i) => {
    n.x = 100 + i;
    n.y = 200 + i;
    n.homeX = 300 + i;
    n.homeY = 400 + i;
  });
  const extra = { x: 7, y: 8 };
  const scene = { graph: { nodes: [...g.nodes, extra] }, matrix: g.matrix };
  const out = packPositions(scene, { x: 100, y: 200 });
  assert.equal(out.length, POSITION_COLUMNS * 4);
  assert.deepEqual([...out.slice(4, 8)], [1, 1, 201, 201]);
  assert.deepEqual([...out.slice(5 * 4, 6 * 4)], [-93, -192, -93, -192]);
});

test("a radial step eases into a curve as its node drifts off its ring: no jumps, on the CPU or the GPU", () => {
  const routing = { kind: "radial", cx: 0, cy: 0 };
  const polar = (r, deg, home) => {
    const a = (deg * Math.PI) / 180;
    return {
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      homeX: Math.cos(a) * home,
      homeY: Math.sin(a) * home,
    };
  };
  const t = polar(200, 40, 200);
  let cpuBefore = null,
    gpuBefore = null;
  let weights = [];
  // Drag the source outward off its ring (home radius 100) in 1 px steps, well past the old yes/no switch (25 px).
  for (let r = 100; r <= 160; r += 1) {
    const s = polar(r, 10, 100);
    const cpu = trim(
      edgeRoute({ nodes: [s, t] }, routing, "step", {
        source: 0,
        target: 1,
        tree: true,
      }),
      6,
      10,
    );
    const gpu = radialPiecePoints(1, routing, s, t, 6, 10, 8);
    if (cpuBefore) {
      assert.ok(hausdorff(cpu, cpuBefore) < 6, `CPU jumps at ${r}`);
      assert.ok(hausdorff(gpu, gpuBefore) < 6, `GPU jumps at ${r}`);
    }
    cpuBefore = cpu;
    gpuBefore = gpu;
    weights.push(
      stepCurveWeight(r, 200, 100, 200, 0, 1), // the off-ring part alone
    );
  }
  assert.equal(weights[0], 0, "on its ring: a step");
  assert.equal(weights.at(-1), 1, "far off: a curve");
  assert.ok(
    weights.every((w, i) => i === 0 || w >= weights[i - 1]),
    "never back towards a step while drifting further off",
  );
  // During a layout morph, being off a ring doesn't count.
  assert.equal(stepCurveWeight(130, 200, 100, 200, 0, 1, true), 0);
});
