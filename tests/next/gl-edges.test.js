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

test("pieces: one per edge, one more per layered bend; cross-links that bundle are spans instead", () => {
  const g = new Graph(recipe());
  const tree = sceneFor(g, treeLayout(g, {}), { shape: "step" });
  assert.ok(gpuEdges(tree));
  const packed = packPieces(tree, { x: 0, y: 0 });
  const crossLinks = g.edges.filter((e) => !e.tree);
  const bundled = crossLinks.filter((e) => bundlePath(g, e)).length;
  assert.ok(bundled > 0, "the fixture has a cross-link that bundles");
  assert.equal(packed.cpu.length, 0);
  assert.equal(packed.pieceCount, g.edges.length - bundled);
  assert.equal(packed.shapedPieces, g.edges.length - crossLinks.length);
  const straight = sceneFor(g, treeLayout(g, {}), { shape: "straight" });
  assert.equal(
    packPieces(straight, { x: 0, y: 0 }).spanCount,
    0,
    "straight edges don't bundle",
  );

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
  const weights = [];
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

// ---- bundled cross-links on the GPU ------------------------------------------------------------------------

import {
  BUNDLE_STRENGTH,
  bundlePath,
  bundledPoints,
} from "../../next/engine/geometry.js";
import { radialLayout } from "../../next/engine/layouts.js";
import { packEdges, END_STRIDE } from "../../next/engine/gl-pack.js";
import {
  BUNDLE_TIP_STRIDE,
  SPAN_STRIDE,
  bundleSpanCapsules,
  bundleSteps,
  bundleTip,
} from "../../next/engine/gl-edges.js";
import { readFileSync } from "node:fs";

/** A crafting fixture: a real recipe shape, about a third of its edges shared ingredients. */
function crafting(name = "crafting-medium") {
  const url = new URL(`../fixtures/graphs/${name}.json`, import.meta.url);
  return GraphModel.from(JSON.parse(readFileSync(url, "utf8")));
}

/** Nudge every node off its home by a deterministic amount (a morph or a drag in progress). */
function jostle(g, amount) {
  g.nodes.forEach((n, i) => {
    n.x = n.homeX + Math.sin(i * 12.9898) * amount;
    n.y = n.homeY + Math.cos(i * 78.233) * amount;
  });
}

/**
 * A bundled edge as the GPU draws it, from the packed instance data and the positions texture: its spans' capsules
 * joined into one polyline (world px, relative to the origin), and its end.
 */
function gpuBundle(packed, positions, ei, scene, steps = undefined) {
  const at = (index) => [positions[index * 4], positions[index * 4 + 1]];
  const line = [];
  let tip = null;
  for (let s = 0; s < packed.spanCount; s++) {
    if (packed.spanEdge[s] !== ei) continue;
    const o = s * SPAN_STRIDE;
    const f = packed.spans;
    const nodes = [0, 1, 2, 3].map((q) => at(f[o + q]));
    const along = [4, 5, 6, 7].map((q) => f[o + q]);
    for (const capsule of bundleSpanCapsules(
      BUNDLE_STRENGTH,
      nodes,
      along,
      at(f[o + 8]),
      at(f[o + 9]),
      f[o + 10],
      f[o + 11],
      steps,
    )) {
      if (!capsule) continue;
      if (!line.length) line.push(capsule[0]);
      line.push(capsule[1]);
    }
  }
  for (let b = 0; b < packed.bundleTipCount; b++) {
    if (packed.bundleTipEdge[b] !== ei) continue;
    const o = b * BUNDLE_TIP_STRIDE;
    const f = packed.bundleTips;
    const end = scene.edge.arrowSize * 0.9;
    tip = bundleTip(
      BUNDLE_STRENGTH,
      [0, 1, 2, 3].map((q) => at(f[o + q])),
      [4, 5, 6, 7].map((q) => f[o + q]),
      at(f[o + 8]),
      at(f[o + 9]),
      f[o + 10] + end,
      end,
    );
  }
  return { line, tip };
}

test("bundled cross-links on the GPU trace the CPU's B-splines, trimmed, with their ends where the CPU puts them", () => {
  for (const [name, layout] of [
    ["tree", (g) => treeLayout(g, {})],
    ["tree LR", (g) => treeLayout(g, { direction: "LR" })],
    ["radial", (g) => radialLayout(g, {})],
  ])
    for (const amount of [0, 25]) {
      const g = new Graph(crafting());
      const routing = layout(g);
      jostle(g, amount);
      const scene = sceneFor(g, routing, { shape: "curve", arrow: "arrow" });
      const origin = { x: 1234.5, y: -678.25 };
      const packed = packPieces(scene, origin);
      const positions = packPositions(scene, origin);
      const cpu = packEdges(scene);
      let checked = 0;
      for (let ei = 0; ei < g.edges.length; ei++) {
        const e = g.edges[ei];
        if (e.tree || !bundlePath(g, e)) continue;
        const s = g.nodes[e.source],
          t = g.nodes[e.target];
        const end = scene.edge.arrowSize * 0.9;
        const route = trim(
          bundledPoints(g, e),
          scene.looks.radius[s.index],
          scene.looks.radius[t.index] + end,
        );
        const { line, tip } = gpuBundle(packed, positions, ei, scene);
        const world = line.map(([x, y]) => [x + origin.x, y + origin.y]);
        const where = `${name}, jostled ${amount}, edge ${e.source}→${e.target}`;
        assert.ok(route, where);
        const gap = hausdorff(world, route);
        // The GPU trims each end where the curve leaves the node's disc, the CPU by distance along the curve: the
        // same on a curve's smooth ends, to within float precision.
        assert.ok(gap < 0.5, `${where}: ${gap.toFixed(3)} px apart`);
        const k = cpu.endEdge.indexOf(ei);
        const o = k * END_STRIDE;
        const [cx, cy, dx, dy] = cpu.ends.subarray(o, o + 4);
        assert.ok(
          Math.hypot(tip.tip[0] + origin.x - cx, tip.tip[1] + origin.y - cy) <
            0.5,
          `${where}: the end is off by ${Math.hypot(tip.tip[0] + origin.x - cx, tip.tip[1] + origin.y - cy).toFixed(3)} px`,
        );
        assert.ok(
          tip.dir[0] * dx + tip.dir[1] * dy > 0.999,
          `${where}: the end points the same way`,
        );
        checked++;
      }
      assert.ok(checked > 50, `${name}: ${checked} bundled edges checked`);
    }
});

test("bundles: a span per four control points, the ends repeated; cross-links with nothing to bend round go straight", () => {
  const g = new Graph(recipe());
  const routing = treeLayout(g, {});
  const scene = sceneFor(g, routing, { shape: "step", arrow: "dot" });
  const packed = packPieces(scene, { x: 0, y: 0 });
  assert.equal(packed.cpu.length, 0, "nothing left to the CPU");
  let spans = 0,
    straight = 0;
  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei];
    if (e.tree) continue;
    const path = bundlePath(g, e);
    if (!path) {
      straight++;
      continue;
    }
    const mine = [];
    for (let s = 0; s < packed.spanCount; s++)
      if (packed.spanEdge[s] === ei) mine.push(s);
    assert.equal(mine.length, path.length + 1, "m + 2 spans for m + 1 points");
    const first = packed.spans.subarray(mine[0] * SPAN_STRIDE);
    assert.deepEqual(
      [...first.subarray(0, 4)],
      [path[0], path[0], path[0], path[1]],
      "the first span starts on the source, repeated",
    );
    const last = packed.spans.subarray(mine.at(-1) * SPAN_STRIDE);
    assert.deepEqual(
      [...last.subarray(4, 8)],
      [(path.length - 2) / (path.length - 1), 1, 1, 1],
    );
    spans += mine.length;
  }
  assert.equal(packed.spanCount, spans);
  assert.equal(
    packed.pieceCount - packed.shapedPieces,
    straight,
    "straight cross-links come after the shaped pieces",
  );
  assert.equal(
    packed.tipCount + packed.bundleTipCount,
    g.edges.length,
    "one end per edge",
  );
  for (let i = packed.shapedPieces; i < packed.pieceCount; i++)
    assert.ok(!g.edges[packed.pieceEdge[i]].tree);
  for (let i = packed.shapedTips; i < packed.tipCount; i++)
    assert.ok(!g.edges[packed.tipEdge[i]].tree);
});

test("zoomed out, bundle spans are drawn with fewer capsules, never more than a pixel off on screen", () => {
  const g = new Graph(crafting());
  const routing = treeLayout(g, {});
  jostle(g, 10);
  const scene = sceneFor(g, routing, { shape: "step" });
  const packed = packPieces(scene, { x: 0, y: 0 });
  const positions = packPositions(scene, { x: 0, y: 0 });
  assert.equal(bundleSteps(1), 8);
  for (const zoom of [2, 0.5, 0.2, 0.17, 0.1, 0.05, 0.04, 0.01]) {
    const steps = bundleSteps(zoom);
    assert.ok(steps >= 2 && steps <= 8);
    let worst = 0;
    for (let ei = 0; ei < g.edges.length; ei++) {
      const e = g.edges[ei];
      if (e.tree || !bundlePath(g, e)) continue;
      const full = gpuBundle(packed, positions, ei, scene).line;
      const coarse = gpuBundle(packed, positions, ei, scene, steps).line;
      worst = Math.max(worst, hausdorff(full, coarse) * zoom);
    }
    assert.ok(
      worst < 1,
      `zoom ${zoom}: ${steps} capsules a span are ${worst.toFixed(2)} screen px off`,
    );
  }
});
