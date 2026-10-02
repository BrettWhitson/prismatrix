// The edge shaders' geometry (gl-shaders.js) in JavaScript, so tests can check what the GPU traces against the CPU's
// own edge routes: the same constants (gl-edges.js) and the same steps. And where a label's text sits.

import {
  CORNER_POINTS,
  CUT_STEPS,
  PIECE_POINTS,
  RADIAL_ARC_POINTS,
  RADIAL_CORNER_POINTS,
  RADIAL_POINTS,
} from "../../next/engine/gl-edges.js";
import { labelAnchor } from "../../next/engine/boxes.js";
import { textBox } from "../../next/engine/labels.js";
import {
  ARC_STEP,
  BUNDLE_STEPS,
  stepCurveWeight,
} from "../../next/engine/geometry.js";

/** A cubic Bézier through p0–p3 (each [x, y]) at t (0–1). */
function cubicAt(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1].map(
    (i) => k[0] * p0[i] + k[1] * p1[i] + k[2] * p2[i] + k[3] * p3[i],
  );
}

/** Where a cubic is `reach` from its start (or, fromB, its end): where the shaders cut a curve off its node. */
function cubicCut(reach, p0, p1, p2, p3, fromB) {
  if (reach <= 0) return fromB ? 1 : 0;
  const end = fromB ? p3 : p0;
  let lo = 0,
    hi = 0.5;
  for (let k = 0; k < CUT_STEPS; k++) {
    const m = (lo + hi) / 2;
    const q = cubicAt(fromB ? 1 - m : m, p0, p1, p2, p3);
    if (Math.hypot(q[0] - end[0], q[1] - end[1]) < reach) lo = m;
    else hi = m;
  }
  return fromB ? 1 - lo : lo;
}

/**
 * A point of a uniform cubic B-spline span with control points p0–p3 (each [x, y]), at t (0–1): the same sum as
 * bspline in geometry.js and the bundle shader.
 */
function splineAt(t, p0, p1, p2, p3) {
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
function clipDisc(a, b, c, r) {
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
 * The capsules the bundle shader draws for one span: `steps` of them (null where trimmed away), from the span's
 * four control nodes `nodes` (each [x, y] this frame) and how far along the path each is (`along`), the edge's ends
 * S and T, and its trims.
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
 * Where a bundled edge's arrowhead or dot goes (the bundle tip shader): walking back from the target along the last
 * three spans (from its last four control nodes), the first point at least `reach` (target radius plus the end's
 * room) from the target; the tip sits `end` on from where the curve crosses that distance, pointing the way the
 * curve runs there. As the CPU puts it (packEdges).
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
  const t0 = cubicCut(trimA, ...p, false),
    t1 = cubicCut(trimB, ...p, true);
  if (mode === 2) {
    const out = [];
    for (let i = 0; i < PIECE_POINTS; i++)
      out.push(cubicAt(t0 + ((t1 - t0) * i) / (PIECE_POINTS - 1), ...p));
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
  for (let i = 0; i < RADIAL_CORNER_POINTS; i++)
    out.push(
      quad(
        ray(as, rm - f1),
        ray(as, rm),
        ray(as + (turn * f1) / rm, rm),
        i / (RADIAL_CORNER_POINTS - 1),
      ),
    );
  const from = as + (turn * f1) / rm,
    to = as + delta - (turn * f2) / rm;
  for (let i = 0; i < RADIAL_ARC_POINTS; i++)
    out.push(ray(from + ((to - from) * i) / (RADIAL_ARC_POINTS - 1), rm));
  for (let i = 0; i < RADIAL_CORNER_POINTS; i++)
    out.push(
      quad(
        ray(at - (turn * f2) / rm, rm),
        ray(at, rm),
        ray(at, rm + f2),
        i / (RADIAL_CORNER_POINTS - 1),
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
    const [qx, qy] = cubicAt(
      t0 + (t1 - t0) * (total ? along[i] / total : 0),
      ...p,
    );
    return [x + (qx - x) * w, y + (qy - y) * w];
  });
}

/**
 * The points the piece shader traces from stop a to stop b (world px, already where they are this frame):
 * `PIECE_POINTS` points, the capsules between consecutive ones making the piece. `trimA` and `trimB` pull the ends
 * in (off the nodes they start and finish at).
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
    // The whole curve between the stops, leaving and arriving along the axis, cut where it's `trim` from each end.
    const p = [A, [A[0], mid], [B[0], mid], B];
    const t0 = cubicCut(trimA, ...p, false),
      t1 = cubicCut(trimB, ...p, true);
    for (let i = 0; i < PIECE_POINTS; i++)
      out[i] = cubicAt(t0 + ((t1 - t0) * i) / (PIECE_POINTS - 1), ...p);
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
  const arc = CORNER_POINTS;
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
 * Where a label sits in the world: its left edge, its vertical middle (the middle of the em box, as Canvas 2D's
 * "middle" baseline), and its width, for a node at (x, y) of radius `r`, label direction `angle`, font size `size`
 * and text width `width` (world px).
 */
export function labelBox(x, y, r, angle, size, width) {
  const a = labelAnchor(angle, r);
  const box = textBox({ size, align: a.align, baseline: a.baseline }, width);
  return { left: x + a.x + box.left, middle: y + a.y + box.middle, width };
}
