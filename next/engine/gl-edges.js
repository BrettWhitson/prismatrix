// Edges built on the GPU. Instead of tracing every edge on the CPU each frame and sending the GPU hundreds of
// thousands of little segments, the GPU gets each node's position (one texture, every frame) and a list of edge
// pieces that only changes with the layout or the styles. A piece is the run of an edge between two stops: its
// source, its target, or one of the bends a layered layout gives a long edge. The vertex shader builds each piece's
// shape (straight, a step with rounded corners, or a curve) from where its stops are this frame.
//
// This module is the CPU side: which edges the GPU can draw, their pieces and ends as instance data, the positions
// texture's contents, and `piecePoints`, the same geometry as the shader in JavaScript (so tests can check it
// against the CPU's own edge routes). Pure: no GL.

import { parseColour } from "./gl-pack.js";

/** Points along each piece: the shader draws the capsules between consecutive ones. */
export const PIECE_POINTS = 16;
/** Points along a radial piece: a ring arc needs more. */
export const RADIAL_POINTS = 30;
const ARC_STEP = 0.06; // radians per chord along a ring arc, as the CPU traces them
/** Floats per piece: stop A (x, y, f, node?), stop B, source and target index, trims, half-width, colour r, g, b. */
export const PIECE_STRIDE = 16;
/** Floats per edge end: last stop before the target (x, y, f, node?), source, target, radius, size, kind, r, g, b. */
export const TIP_STRIDE = 12;
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
 * Every edge the GPU draws as pieces and ends, relative to `origin` (world px), and the edges it leaves to the CPU
 * (cross-links that bundle along the tree in a tree or radial layout).
 * @param {object} scene
 * @param {{ x: number, y: number }} origin
 * @returns {{ pieces: Float32Array, pieceEdge: Int32Array, pieceCount: number, tips: Float32Array,
 *   tipEdge: Int32Array, tipCount: number, cpu: number[], shape: number, axis: number[] }}
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
  // Pieces per edge: one, or one more than its bends.
  let pieceTotal = 0;
  const cpu = [];
  const bundled = !layered && edge.shape !== "straight";
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const e = graph.edges[ei];
    if (bundled && !e.tree) cpu.push(ei);
    else pieceTotal += layered ? (routing.bends.get(e)?.length ?? 0) + 1 : 1;
  }
  const pieces = new Float32Array(pieceTotal * PIECE_STRIDE);
  const pieceEdge = new Int32Array(pieceTotal);
  const tipTotal = end > 0 ? graph.edges.length - cpu.length : 0;
  const tips = new Float32Array(tipTotal * TIP_STRIDE);
  const tipEdge = new Int32Array(tipTotal);
  let p = 0,
    t = 0,
    skip = 0;
  // A stop: a node (its position this frame) or a bend (where the layout put it, moved with the edge's ends).
  const write = (out, o, stop) => {
    out[o] = stop.x - origin.x;
    out[o + 1] = stop.y - origin.y;
    out[o + 2] = stop.f;
    out[o + 3] = stop.node ? 1 : 0;
  };
  for (let ei = 0; ei < graph.edges.length; ei++) {
    if (cpu[skip] === ei) {
      skip++;
      continue;
    }
    const e = graph.edges[ei];
    const bends = layered ? (routing.bends.get(e) ?? []) : [];
    const k = bends.length;
    const stops = [{ x: 0, y: 0, f: 0, node: true }];
    bends.forEach(([x, y], i) => stops.push({ x, y, f: (i + 1) / (k + 1) }));
    stops.push({ x: 0, y: 0, f: 1, node: true });
    const rgb = colour(looks.edgeColour[ei]);
    const half = looks.edgeWidth[ei] / 2;
    for (let i = 0; i + 1 < stops.length; i++, p++) {
      const o = p * PIECE_STRIDE;
      write(pieces, o, stops[i]);
      write(pieces, o + 4, stops[i + 1]);
      pieces[o + 8] = e.source;
      pieces[o + 9] = e.target;
      pieces[o + 10] = i === 0 ? looks.radius[e.source] : 0;
      pieces[o + 11] =
        i + 2 === stops.length ? looks.radius[e.target] + end : 0;
      pieces[o + 12] = half;
      pieces[o + 13] = rgb[0];
      pieces[o + 14] = rgb[1];
      pieces[o + 15] = rgb[2];
      pieceEdge[p] = ei;
    }
    if (end > 0) {
      const o = t * TIP_STRIDE;
      write(tips, o, stops[stops.length - 2]);
      tips[o + 4] = e.source;
      tips[o + 5] = e.target;
      tips[o + 6] = looks.radius[e.target];
      tips[o + 7] = edge.arrowSize;
      tips[o + 8] = kind;
      tips[o + 9] = rgb[0];
      tips[o + 10] = rgb[1];
      tips[o + 11] = rgb[2];
      tipEdge[t++] = ei;
    }
  }
  return {
    pieces,
    pieceEdge,
    pieceCount: p,
    tips,
    tipEdge,
    tipCount: t,
    cpu,
    shape: SHAPES[edge.shape],
    axis: AXIS[routing.direction] ?? AXIS.TB,
    radial: routing.kind === "radial",
    points: routing.kind === "radial" ? RADIAL_POINTS : PIECE_POINTS,
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
  const out = [];
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
  if (mode === 1) {
    if (centred) mode = 0;
    else {
      const hs = Math.hypot(s.homeX - cx, s.homeY - cy),
        ht = Math.hypot(t.homeX - cx, t.homeY - cy);
      const slack = Math.abs(ht - hs) / 4;
      const off = Math.abs(rs - hs) > slack || Math.abs(rt - ht) > slack;
      const loops =
        rt < rs - 1 ||
        rm * Math.abs(delta) > 1.75 * Math.hypot(t.x - s.x, t.y - s.y) + 10;
      if ((!morphing && off) || loops) mode = 2;
    }
  }
  const ray = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  if (mode === 0) {
    const len = Math.hypot(t.x - s.x, t.y - s.y) || 1;
    const dx = (t.x - s.x) / len,
      dy = (t.y - s.y) / len;
    out.push(
      [s.x + dx * trimA, s.y + dy * trimA],
      [t.x - dx * trimB, t.y - dy * trimB],
    );
  } else if (mode === 2) {
    const p = [[s.x, s.y], ray(as, rm), ray(at, rm), [t.x, t.y]];
    const at3 = (u) => {
      const v = 1 - u;
      const w = [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u];
      return [0, 1].map((k) => w.reduce((sum, wi, i) => sum + wi * p[i][k], 0));
    };
    const cut = (reach, fromB) => {
      if (reach <= 0) return fromB ? 1 : 0;
      const end = fromB ? p[3] : p[0];
      let lo = 0,
        hi = 0.5;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) / 2;
        const q = at3(fromB ? 1 - m : m);
        if (Math.hypot(q[0] - end[0], q[1] - end[1]) < reach) lo = m;
        else hi = m;
      }
      return fromB ? 1 - lo : lo;
    };
    const t0 = cut(trimA, false),
      t1 = cut(trimB, true);
    for (let i = 0; i < PIECE_POINTS; i++)
      out.push(at3(t0 + ((t1 - t0) * i) / (PIECE_POINTS - 1)));
  } else {
    const A = ray(as, rs + trimA),
      B = ray(at, rt - trimB);
    const turn = delta >= 0 ? 1 : -1;
    const chord =
      (rm * Math.abs(delta)) /
      Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
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
    out.push(A);
    for (let i = 0; i < 4; i++)
      out.push(
        quad(
          ray(as, rm - f1),
          ray(as, rm),
          ray(as + (turn * f1) / rm, rm),
          i / 3,
        ),
      );
    // Round the short way: from the source's angle by the (wrapped) turn between them.
    const from = as + (turn * f1) / rm,
      to = as + delta - (turn * f2) / rm;
    for (let i = 0; i < 20; i++)
      out.push(ray(from + ((to - from) * i) / 19, rm));
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
  }
  while (out.length < RADIAL_POINTS) out.push(out[out.length - 1]);
  return out;
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
