// Edges built on the GPU. Instead of tracing every edge on the CPU each frame and sending the GPU hundreds of
// thousands of little segments, the GPU gets each node's position (one texture, every frame) and a list of edge
// pieces that only changes with the layout or the styles. A piece is the run of an edge between two stops: its
// source, its target, or one of the bends a layered layout gives a long edge. The vertex shader builds each piece's
// shape (straight, a step with rounded corners, or a curve) from where its stops are this frame. Cross-links that
// bundle along the tree are B-splines whose control points are nodes on the tree path between their ends: one
// instance per span of the spline, naming its four control nodes, so they too move with the positions alone.
//
// This module is the CPU side: which edges the GPU can draw, their pieces, spans and ends as instance data, the
// positions texture's contents, and `piecePoints`, `radialPiecePoints`, `bundleSpanCapsules` and `bundleTip`, the
// same geometry as the shaders in JavaScript (so tests can check it against the CPU's own edge routes). Pure: no GL.

import { parseColour, runsOf } from "./gl-pack.js";
import { BUNDLE_STEPS, bundlePath, stepCurveWeight } from "./geometry.js";

/** Points along each piece: the shader draws the capsules between consecutive ones. */
export const PIECE_POINTS = 16;
/** Points along a radial piece: a ring arc needs more. */
export const RADIAL_POINTS = 30;
const ARC_STEP = 0.06; // radians per chord along a ring arc, as the CPU traces them
/** Floats per piece: stop A (x, y, f, node?), stop B, source and target index, trims, half-width, colour r, g, b. */
export const PIECE_STRIDE = 16;
/** Floats per edge end: last stop before the target (x, y, f, node?), source, target, radius, size, kind, r, g, b. */
export const TIP_STRIDE = 12;
/**
 * Floats per bundle span: its four control nodes, how far along the path each is (0–1), source, target, trims,
 * half-width, colour r, g, b.
 */
export const SPAN_STRIDE = 16;
/**
 * Floats per bundled edge's end: its last four control nodes, how far along the path each is, source, target,
 * target radius, size, kind, colour r, g, b.
 */
export const BUNDLE_TIP_STRIDE = 16;
/** Texels per row of the positions texture. */
export const POSITION_COLUMNS = 2048;

const SHAPES = { straight: 0, step: 1, curve: 2 };

/**
 * The world → layout-axis frame for a tree or layered direction, as a column-major 2×2 matrix: in that frame y
 * runs from parent to child. Its inverse is its transpose.
 */
export const AXIS = {
  TB: [1, 0, 0, 1],
  BT: [1, 0, 0, -1],
  LR: [0, 1, 1, 0],
  RL: [0, -1, 1, 0],
};

/** Whether the GPU can draw this scene's edges: straight, step or curve in any layout (not fans or tapers). */
export function gpuEdges(scene) {
  const { edge, routing } = scene;
  if (edge.taper || !(edge.shape in SHAPES)) return false;
  return (
    routing.kind === "tree" ||
    routing.kind === "layered" ||
    routing.kind === "radial"
  );
}

/**
 * Every edge as GPU instance data, relative to `origin` (world px):
 *
 * - pieces and their ends (tips): the edge's own shape first (`shapedPieces`, `shapedTips` of them), then the ones
 *   drawn straight whatever the shape (cross-links that can't bundle), so each range is drawn with its own shape
 *   and as few vertices as it needs;
 * - bundle spans and their ends: cross-links in a tree or radial layout bundle along the tree (bundlePath in
 *   geometry.js), as a B-spline whose control points are nodes on the path. Each span of the spline is an instance
 *   naming its four control nodes; the shader evaluates it from where they are this frame.
 *
 * `cpu` lists the edges left to the CPU (none: every edge this can pack, the GPU draws).
 * @param {object} scene
 * @param {{ x: number, y: number }} origin
 * @returns {{ pieces: Float32Array, pieceEdge: Int32Array, pieceCount: number, shapedPieces: number,
 *   tips: Float32Array, tipEdge: Int32Array, tipCount: number, shapedTips: number, spans: Float32Array,
 *   spanEdge: Int32Array, spanCount: number, bundleTips: Float32Array, bundleTipEdge: Int32Array,
 *   bundleTipCount: number, cpu: number[], shape: number, axis: number[], radial: boolean, points: number }}
 */
export function packPieces(scene, origin) {
  const { graph, routing, edge, looks } = scene;
  const layered = routing.kind === "layered";
  const end = edge.arrow === "none" ? 0 : edge.arrowSize * 0.9;
  const kind = edge.arrow === "dot" ? 1 : 0;
  const colours = new Map();
  const colour = (hex) => {
    let rgb = colours.get(hex);
    if (!rgb) colours.set(hex, (rgb = parseColour(hex)));
    return rgb;
  };
  const edges = graph.edges;
  // Cross-links bundle (unless edges are straight); those whose path has nothing to bend round go straight.
  const bundled = !layered && edge.shape !== "straight";
  const paths = new Array(edges.length).fill(null);
  let shapedTotal = 0,
    straightTotal = 0,
    spanTotal = 0,
    bundleTotal = 0;
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    if (bundled && !e.tree) {
      const path = bundlePath(graph, e);
      if (path) {
        paths[ei] = path;
        spanTotal += path.length + 1; // a clamped spline through m + 1 points has m + 2 spans
        bundleTotal++;
      } else straightTotal++;
    } else shapedTotal += layered ? (routing.bends.get(e)?.length ?? 0) + 1 : 1;
  }
  const pieceTotal = shapedTotal + straightTotal;
  const pieces = new Float32Array(pieceTotal * PIECE_STRIDE);
  const pieceEdge = new Int32Array(pieceTotal);
  // One end per edge drawn as pieces (an edge with bends has several pieces but one end).
  const shapedEdges = edges.length - bundleTotal - straightTotal;
  const tipTotal = end > 0 ? shapedEdges + straightTotal : 0;
  const tips = new Float32Array(tipTotal * TIP_STRIDE);
  const tipEdge = new Int32Array(tipTotal);
  const spans = new Float32Array(spanTotal * SPAN_STRIDE);
  const spanEdge = new Int32Array(spanTotal);
  const bundleTips = new Float32Array(
    (end > 0 ? bundleTotal : 0) * BUNDLE_TIP_STRIDE,
  );
  const bundleTipEdge = new Int32Array(end > 0 ? bundleTotal : 0);
  // Shaped pieces and tips fill from the start, straight ones from where the shaped ones end.
  let p = 0,
    t = 0,
    ps = shapedTotal,
    ts = end > 0 ? shapedEdges : 0,
    s = 0,
    b = 0;
  const shapedTips = ts;
  // A stop: a node (its position this frame) or a bend (where the layout put it, moved with the edge's ends).
  const write = (out, o, stop) => {
    out[o] = stop.x - origin.x;
    out[o + 1] = stop.y - origin.y;
    out[o + 2] = stop.f;
    out[o + 3] = stop.node ? 1 : 0;
  };
  const NODE_A = { x: 0, y: 0, f: 0, node: true },
    NODE_B = { x: 0, y: 0, f: 1, node: true };
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const rgb = colour(looks.edgeColour[ei]);
    const half = looks.edgeWidth[ei] / 2;
    const trimA = looks.radius[e.source],
      trimB = looks.radius[e.target] + end;
    const path = paths[ei];
    if (path) {
      // A span per four consecutive control points of the clamped spline: points before the first and after the
      // last repeat the end ones. Each control point is a node on the path, pulled towards the straight line
      // between the ends by how far along the path it is (`along`).
      const m = path.length - 1;
      for (let i = 0; i <= m + 1; i++, s++) {
        const o = s * SPAN_STRIDE;
        for (let q = 0; q < 4; q++) {
          const k = Math.min(m, Math.max(0, i - 2 + q));
          spans[o + q] = path[k];
          spans[o + 4 + q] = k / m;
        }
        spans[o + 8] = e.source;
        spans[o + 9] = e.target;
        spans[o + 10] = trimA;
        spans[o + 11] = trimB;
        spans[o + 12] = half;
        spans[o + 13] = rgb[0];
        spans[o + 14] = rgb[1];
        spans[o + 15] = rgb[2];
        spanEdge[s] = ei;
      }
      if (end > 0) {
        // The end: the last four control points (the last three spans), where the curve reaches the target.
        const o = b * BUNDLE_TIP_STRIDE;
        for (let q = 0; q < 4; q++) {
          const k = Math.max(0, m - 3 + q);
          bundleTips[o + q] = path[k];
          bundleTips[o + 4 + q] = k / m;
        }
        bundleTips[o + 8] = e.source;
        bundleTips[o + 9] = e.target;
        bundleTips[o + 10] = looks.radius[e.target];
        bundleTips[o + 11] = edge.arrowSize;
        bundleTips[o + 12] = kind;
        bundleTips[o + 13] = rgb[0];
        bundleTips[o + 14] = rgb[1];
        bundleTips[o + 15] = rgb[2];
        bundleTipEdge[b++] = ei;
      }
      continue;
    }
    const straight = bundled && !e.tree;
    const bends = layered ? (routing.bends.get(e) ?? []) : [];
    const k = bends.length;
    const stops = [NODE_A];
    bends.forEach(([x, y], i) => stops.push({ x, y, f: (i + 1) / (k + 1) }));
    stops.push(NODE_B);
    for (let i = 0; i + 1 < stops.length; i++) {
      const at = straight ? ps++ : p++;
      const o = at * PIECE_STRIDE;
      write(pieces, o, stops[i]);
      write(pieces, o + 4, stops[i + 1]);
      pieces[o + 8] = e.source;
      pieces[o + 9] = e.target;
      pieces[o + 10] = i === 0 ? trimA : 0;
      pieces[o + 11] = i + 2 === stops.length ? trimB : 0;
      pieces[o + 12] = half;
      pieces[o + 13] = rgb[0];
      pieces[o + 14] = rgb[1];
      pieces[o + 15] = rgb[2];
      pieceEdge[at] = ei;
    }
    if (end > 0) {
      const at = straight ? ts++ : t++;
      const o = at * TIP_STRIDE;
      write(tips, o, stops[stops.length - 2]);
      tips[o + 4] = e.source;
      tips[o + 5] = e.target;
      tips[o + 6] = looks.radius[e.target];
      tips[o + 7] = edge.arrowSize;
      tips[o + 8] = kind;
      tips[o + 9] = rgb[0];
      tips[o + 10] = rgb[1];
      tips[o + 11] = rgb[2];
      tipEdge[at] = ei;
    }
  }
  return {
    pieces,
    pieceEdge,
    pieceCount: pieceTotal,
    shapedPieces: shapedTotal,
    tips,
    tipEdge,
    tipCount: tipTotal,
    shapedTips,
    spans,
    spanEdge,
    spanCount: s,
    bundleTips,
    bundleTipEdge,
    bundleTipCount: b,
    cpu: [],
    shape: SHAPES[edge.shape],
    axis: AXIS[routing.direction] ?? AXIS.TB,
    radial: routing.kind === "radial",
    points: routing.kind === "radial" ? RADIAL_POINTS : PIECE_POINTS,
  };
}

/**
 * A point of a uniform cubic B-spline span with control points p0–p3 (each [x, y]), at t (0–1): the same sum as
 * bspline in geometry.js and the bundle shader.
 */
export function splineAt(t, p0, p1, p2, p3) {
  const t2 = t * t,
    t3 = t2 * t;
  const w0 = (1 - 3 * t + 3 * t2 - t3) / 6,
    w1 = (4 - 6 * t2 + 3 * t3) / 6,
    w2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6,
    w3 = t3 / 6;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

/**
 * Capsule a → b with the part inside the disc around `c` of radius `r` cut off: how the GPU trims a bundled edge
 * off its nodes (each capsule on its own, so it needs nothing from the rest of the curve). Null when nothing is
 * left. Assumes the curve crosses the disc's edge once, as it does near the node it starts or ends at.
 * @returns {[number[], number[]] | null}
 */
export function clipDisc(a, b, c, r) {
  if (r <= 0) return [a, b];
  const inA = Math.hypot(a[0] - c[0], a[1] - c[1]) < r,
    inB = Math.hypot(b[0] - c[0], b[1] - c[1]) < r;
  if (inA && inB) return null;
  if (!inA && !inB) return [a, b];
  // Where the line a + d·s meets the circle: |a + d·s − c| = r.
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    fx = a[0] - c[0],
    fy = a[1] - c[1];
  const A = dx * dx + dy * dy,
    B = 2 * (fx * dx + fy * dy),
    C = fx * fx + fy * fy - r * r;
  const root = Math.sqrt(Math.max(B * B - 4 * A * C, 0));
  if (inA) {
    const s = (-B + root) / (2 * A);
    return [[a[0] + dx * s, a[1] + dy * s], b];
  }
  const s = (-B - root) / (2 * A);
  return [a, [a[0] + dx * s, a[1] + dy * s]];
}

/** A control point of a bundled edge: node `p` pulled towards the line S → T at `along` by (1 − strength). */
const controlPoint = (strength, p, along, S, T) => [
  strength * p[0] + (1 - strength) * (S[0] + (T[0] - S[0]) * along),
  strength * p[1] + (1 - strength) * (S[1] + (T[1] - S[1]) * along),
];

/**
 * How many capsules the GPU draws per bundle span at zoom `zoom`: all `BUNDLE_STEPS` (as the CPU traces them) once
 * a span is long enough on screen for its curve to show, fewer when spans are only a few pixels long. Bundles are
 * most of the GPU's edge vertices in real recipe data (a span is 48 vertices), and a zoomed-out view of a big graph
 * is where there are most of them on screen.
 */
export function bundleSteps(zoom) {
  // A span's chords sit up to about 4 world px inside its curve at half the steps, about 16 at a quarter: under a
  // screen pixel below these zooms.
  if (zoom >= 0.18) return BUNDLE_STEPS;
  return zoom >= 0.045 ? BUNDLE_STEPS / 2 : BUNDLE_STEPS / 4;
}

/**
 * The capsules the bundle shader draws for one span, in JavaScript: `steps` of them (null where trimmed away),
 * from the span's four control nodes `nodes` (each [x, y] this frame) and how far along the path each is
 * (`along`), the edge's ends S and T, and its trims.
 * @returns {([number[], number[]] | null)[]}
 */
export function bundleSpanCapsules(
  strength,
  nodes,
  along,
  S,
  T,
  trimA,
  trimB,
  steps = BUNDLE_STEPS,
) {
  const c = nodes.map((p, q) => controlPoint(strength, p, along[q], S, T));
  const out = [];
  for (let i = 0; i < steps; i++) {
    let capsule = [splineAt(i / steps, ...c), splineAt((i + 1) / steps, ...c)];
    capsule = clipDisc(...capsule, S, trimA);
    if (capsule) capsule = clipDisc(...capsule, T, trimB);
    out.push(capsule);
  }
  return out;
}

/**
 * Where a bundled edge's arrowhead or dot goes, in JavaScript (the bundle tip shader): walking back from the target
 * along the last three spans (from its last four control nodes), the first point at least `reach` (target radius
 * plus the end's room) from the target; the tip sits `end` on from where the curve crosses that distance, pointing
 * the way the curve runs there. As the CPU puts it (packEdges).
 * @returns {{ tip: number[], dir: number[] }}
 */
export function bundleTip(strength, nodes, along, S, T, reach, end) {
  const [q0, q1, q2, q3] = nodes.map((p, q) =>
    controlPoint(strength, p, along[q], S, T),
  );
  const spans = [
    [q0, q1, q2, q3],
    [q1, q2, q3, q3],
    [q2, q3, q3, q3],
  ];
  let previous = T;
  for (let k = 1; k <= 3 * BUNDLE_STEPS; k++) {
    const span = spans[2 - Math.floor((k - 1) / BUNDLE_STEPS)];
    const t = 1 - (((k - 1) % BUNDLE_STEPS) + 1) / BUNDLE_STEPS;
    const p = splineAt(t, ...span);
    if (Math.hypot(p[0] - T[0], p[1] - T[1]) >= reach) {
      const [, cut] = clipDisc(p, previous, T, reach) ?? [p, previous];
      const len = Math.hypot(previous[0] - p[0], previous[1] - p[1]) || 1;
      const dir = [(previous[0] - p[0]) / len, (previous[1] - p[1]) / len];
      return { tip: [cut[0] + dir[0] * end, cut[1] + dir[1] * end], dir };
    }
    previous = p;
  }
  // The whole end of the curve is inside the target: point along the last stretch.
  const len = Math.hypot(T[0] - previous[0], T[1] - previous[1]) || 1;
  const dir = [(T[0] - previous[0]) / len, (T[1] - previous[1]) / len];
  return {
    tip: [T[0] - dir[0] * (reach - end), T[1] - dir[1] * (reach - end)],
    dir,
  };
}

/**
 * The points the shader traces for a radial piece from node s to node t (each with x, y and its home, homeX,
 * homeY), around the centre (cx, cy): the same rules as the CPU (radialStep in geometry.js). Returns `RADIAL_POINTS`
 * points; unused ones repeat the last.
 * @param {number} shape 0 straight, 1 step, 2 curve
 */
export function radialPiecePoints(
  shape,
  centre,
  s,
  t,
  trimA,
  trimB,
  corner,
  morphing = false,
) {
  const { cx, cy } = centre;
  const rs = Math.hypot(s.x - cx, s.y - cy),
    rt = Math.hypot(t.x - cx, t.y - cy);
  const at = Math.atan2(t.y - cy, t.x - cx);
  const centred = rs < 1e-6 || Math.hypot(s.homeX - cx, s.homeY - cy) < 1e-6;
  const as = centred ? at : Math.atan2(s.y - cy, s.x - cx);
  const rm = (rs + rt) / 2;
  let delta = at - as;
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  let mode = shape;
  let w = 0; // a step's way to a curve
  if (mode === 1) {
    if (centred) mode = 0;
    else {
      w = stepCurveWeight(
        rs,
        rt,
        Math.hypot(s.homeX - cx, s.homeY - cy),
        Math.hypot(t.homeX - cx, t.homeY - cy),
        rm * Math.abs(delta),
        Math.hypot(t.x - s.x, t.y - s.y),
        morphing,
      );
      if (w >= 1) mode = 2;
    }
  }
  const ray = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const pad = (out) => {
    while (out.length < RADIAL_POINTS) out.push(out[out.length - 1]);
    return out;
  };
  if (mode === 0) {
    const len = Math.hypot(t.x - s.x, t.y - s.y) || 1;
    const dx = (t.x - s.x) / len,
      dy = (t.y - s.y) / len;
    return pad([
      [s.x + dx * trimA, s.y + dy * trimA],
      [t.x - dx * trimB, t.y - dy * trimB],
    ]);
  }
  // The curve: out along the source's spoke and in along the target's, bending at the ring between.
  const p = [[s.x, s.y], ray(as, rm), ray(at, rm), [t.x, t.y]];
  const curveAt = (u) => {
    const v = 1 - u;
    const k = [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u];
    return [0, 1].map((i) => k.reduce((sum, ki, j) => sum + ki * p[j][i], 0));
  };
  const cut = (reach, fromB) => {
    if (reach <= 0) return fromB ? 1 : 0;
    const end = fromB ? p[3] : p[0];
    let lo = 0,
      hi = 0.5;
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      const q = curveAt(fromB ? 1 - m : m);
      if (Math.hypot(q[0] - end[0], q[1] - end[1]) < reach) lo = m;
      else hi = m;
    }
    return fromB ? 1 - lo : lo;
  };
  const t0 = cut(trimA, false),
    t1 = cut(trimB, true);
  if (mode === 2) {
    const out = [];
    for (let i = 0; i < PIECE_POINTS; i++)
      out.push(curveAt(t0 + ((t1 - t0) * i) / (PIECE_POINTS - 1)));
    return pad(out);
  }
  // The step: the source end, a rounded corner, the ring arc (the short way round), a rounded corner, the target end.
  const A = ray(as, rs + trimA),
    B = ray(at, rt - trimB);
  const turn = delta >= 0 ? 1 : -1;
  const chord =
    (rm * Math.abs(delta)) / Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
  const f1 = Math.max(
    0,
    Math.min(corner, Math.min(rm - (rs + trimA), chord) / 2),
  );
  const f2 = Math.max(
    0,
    Math.min(corner, Math.min(rt - trimB - rm, chord) / 2),
  );
  const quad = (q, j, r, k) =>
    [0, 1].map(
      (i) => (1 - k) * (1 - k) * q[i] + 2 * (1 - k) * k * j[i] + k * k * r[i],
    );
  const out = [A];
  for (let i = 0; i < 4; i++)
    out.push(
      quad(
        ray(as, rm - f1),
        ray(as, rm),
        ray(as + (turn * f1) / rm, rm),
        i / 3,
      ),
    );
  const from = as + (turn * f1) / rm,
    to = as + delta - (turn * f2) / rm;
  for (let i = 0; i < 20; i++) out.push(ray(from + ((to - from) * i) / 19, rm));
  for (let i = 0; i < 4; i++)
    out.push(
      quad(
        ray(at - (turn * f2) / rm, rm),
        ray(at, rm),
        ray(at, rm + f2),
        i / 3,
      ),
    );
  out.push(B);
  if (w <= 0) return out;
  // Partway to a curve: each point slides towards the curve's point as far along it as the point is along the step.
  let total = 0;
  const along = [0];
  for (let i = 1; i < out.length; i++) {
    total += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    along.push(total);
  }
  return out.map(([x, y], i) => {
    const [qx, qy] = curveAt(t0 + (t1 - t0) * (total ? along[i] / total : 0));
    return [x + (qx - x) * w, y + (qy - y) * w];
  });
}

/**
 * Every display node's position and home relative to `origin`, four floats a texel (x, y, homeX, homeY), into `out`
 * (grown if too small). The working graph's nodes come straight from its matrix; display-only nodes after them
 * (references, ghosts) from their objects.
 * @returns {Float32Array}
 */
export function packPositions(scene, origin, out) {
  const { graph, matrix } = scene;
  const count = graph.nodes.length;
  const rows = Math.max(1, Math.ceil(count / POSITION_COLUMNS));
  const size = rows * POSITION_COLUMNS * 4;
  if (!out || out.length < size) out = new Float32Array(size);
  const { x: ox, y: oy } = origin;
  let i = 0;
  if (matrix) {
    const { x, y, homeX, homeY } = matrix;
    const real = Math.min(matrix.count, count);
    for (; i < real; i++) {
      const o = i * 4;
      out[o] = x[i] - ox;
      out[o + 1] = y[i] - oy;
      out[o + 2] = homeX[i] - ox;
      out[o + 3] = homeY[i] - oy;
    }
  }
  for (; i < count; i++) {
    const n = graph.nodes[i];
    const o = i * 4;
    out[o] = n.x - ox;
    out[o + 1] = n.y - oy;
    out[o + 2] = (n.homeX ?? n.x) - ox;
    out[o + 3] = (n.homeY ?? n.y) - oy;
  }
  return out;
}

/**
 * The points the piece shader traces from stop a to stop b (world px, already where they are this frame), in
 * JavaScript: `PIECE_POINTS` points, the capsules between consecutive ones making the piece. `trimA` and `trimB`
 * pull the ends in (off the nodes they start and finish at).
 * @param {number} shape 0 straight, 1 step, 2 curve
 * @param {number[]} axis AXIS[direction]
 * @returns {number[][]} [x, y] points
 */
export function piecePoints(shape, axis, a, b, trimA, trimB, corner) {
  const toAxis = ([x, y]) => [
    axis[0] * x + axis[2] * y,
    axis[1] * x + axis[3] * y,
  ];
  const fromAxis = ([u, v]) => [
    axis[0] * u + axis[1] * v,
    axis[2] * u + axis[3] * v,
  ];
  let A = toAxis(a),
    B = toAxis(b);
  const out = new Array(PIECE_POINTS);
  if (shape === 0 || Math.abs(B[0] - A[0]) < 1e-6) {
    // Straight (or a step or curve with nothing to cross): along the line between the stops.
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    A = [A[0] + (dx / len) * trimA, A[1] + (dy / len) * trimA];
    B = [B[0] - (dx / len) * trimB, B[1] - (dy / len) * trimB];
    out[0] = A;
    for (let i = 1; i < PIECE_POINTS; i++) out[i] = B;
    return out.map(fromAxis);
  }
  const sy = Math.sign(B[1] - A[1]) || 1;
  // Halfway between the stops themselves; the ends are pulled in off the nodes after.
  const mid = (A[1] + B[1]) / 2;
  if (shape === 2) {
    // The whole curve between the stops, cut where it's `trim` from each end.
    const at = (t) => {
      const u = 1 - t;
      const w0 = u * u * u,
        w1 = 3 * u * u * t,
        w2 = 3 * u * t * t,
        w3 = t * t * t;
      return [
        (w0 + w1) * A[0] + (w2 + w3) * B[0],
        w0 * A[1] + (w1 + w2) * mid + w3 * B[1],
      ];
    };
    const cut = (reach, fromB) => {
      if (reach <= 0) return fromB ? 1 : 0;
      const end = fromB ? B : A;
      let lo = 0,
        hi = 0.5;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) / 2;
        const p = at(fromB ? 1 - m : m);
        if (Math.hypot(p[0] - end[0], p[1] - end[1]) < reach) lo = m;
        else hi = m;
      }
      return fromB ? 1 - lo : lo;
    };
    const t0 = cut(trimA, false),
      t1 = cut(trimB, true);
    for (let i = 0; i < PIECE_POINTS; i++)
      out[i] = at(t0 + ((t1 - t0) * i) / (PIECE_POINTS - 1));
    return out.map(fromAxis);
  }
  A = [A[0], A[1] + sy * trimA];
  B = [B[0], B[1] - sy * trimB];
  // A step: down to halfway, across, down to the end, each corner rounded (never more than half a run).
  const sx = Math.sign(B[0] - A[0]);
  const across = Math.abs(B[0] - A[0]);
  const r1 = Math.max(
    0,
    Math.min(corner, Math.abs(mid - A[1]) / 2, across / 2),
  );
  const r2 = Math.max(
    0,
    Math.min(corner, Math.abs(B[1] - mid) / 2, across / 2),
  );
  const arc = (PIECE_POINTS - 2) / 2; // points per corner
  out[0] = A;
  for (let k = 0; k < arc; k++) {
    const th = (k / (arc - 1)) * (Math.PI / 2);
    out[1 + k] = [
      A[0] + sx * r1 - sx * r1 * Math.cos(th),
      mid - sy * r1 + sy * r1 * Math.sin(th),
    ];
    out[1 + arc + k] = [
      B[0] - sx * r2 + sx * r2 * Math.sin(th),
      mid + sy * r2 - sy * r2 * Math.cos(th),
    ];
  }
  out[PIECE_POINTS - 1] = B;
  return out.map(fromAxis);
}

/**
 * New looks for some edges (`dirty`: a flag per edge index) in GPU data from packPieces, in place: their colour and
 * half-width, all a restyle can change without a new layout. Returns, for each kind of instance (pieces, tips,
 * spans, bundleTips), the runs [first, end) that changed, for uploading just those.
 * @param {object} scene
 * @param {ReturnType<typeof packPieces>} data
 * @param {Uint8Array} dirty
 * @returns {Record<string, [number, number][]>}
 */
export function restylePieces(scene, data, dirty) {
  const { looks } = scene;
  const colours = new Map();
  const colour = (hex) => {
    let rgb = colours.get(hex);
    if (!rgb) colours.set(hex, (rgb = parseColour(hex)));
    return rgb;
  };
  const kinds = [
    // kind, instances, their edges, count, stride, half-width at (-1: none), colour at
    [
      "pieces",
      data.pieces,
      data.pieceEdge,
      data.pieceCount,
      PIECE_STRIDE,
      12,
      13,
    ],
    ["tips", data.tips, data.tipEdge, data.tipCount, TIP_STRIDE, -1, 9],
    ["spans", data.spans, data.spanEdge, data.spanCount, SPAN_STRIDE, 12, 13],
    [
      "bundleTips",
      data.bundleTips,
      data.bundleTipEdge,
      data.bundleTipCount,
      BUNDLE_TIP_STRIDE,
      -1,
      13,
    ],
  ];
  const out = {};
  for (const [kind, values, edges, count, stride, half, at] of kinds) {
    const changed = [];
    for (let i = 0; i < count; i++) {
      const e = edges[i];
      if (!dirty[e]) continue;
      const o = i * stride;
      if (half >= 0) values[o + half] = looks.edgeWidth[e] / 2;
      const rgb = colour(looks.edgeColour[e]);
      values[o + at] = rgb[0];
      values[o + at + 1] = rgb[1];
      values[o + at + 2] = rgb[2];
      changed.push(i);
    }
    out[kind] = runsOf(changed);
  }
  return out;
}
