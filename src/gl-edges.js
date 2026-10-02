// Edges built on the GPU. Instead of tracing every edge on the CPU each frame and sending the GPU hundreds of
// thousands of little segments, the GPU gets each node's position (one texture, every frame) and a list of edge
// pieces that only changes with the layout or the styles. A piece is the run of an edge between two stops: its
// source, its target, or one of the bends a layered layout gives a long edge. The vertex shader builds each piece's
// shape (straight, a step with rounded corners, or a curve) from where its stops are this frame. Cross-links that
// bundle along the tree are B-splines whose control points are nodes on the tree path between their ends: one
// instance per span of the spline, naming its four control nodes, so they too move with the positions alone.
//
// This module is the CPU side: which edges the GPU can draw, their pieces, spans and ends as instance data, and the
// positions texture's contents. Pure: no GL. (The shaders' geometry in JavaScript, for tests to check against the
// CPU's own edge routes, is in tests/helpers/gl-twins.js.)

import { palette, runsOf } from "./gl-pack.js";
import {
  BUNDLE_STEPS,
  bundlePath,
  clearOf,
  endRooms,
  endTrims,
  startTrims,
} from "./geometry.js";

// The shaders (gl-shaders.js) take these from here, so the GPU and its JavaScript twins (tests/helpers/gl-twins.js)
// trace the same points.

/** Points along each piece: the shader draws the capsules between consecutive ones. */
export const PIECE_POINTS = 16;
/** Points round each rounded corner of a step piece (the other two are its ends). */
export const CORNER_POINTS = (PIECE_POINTS - 2) / 2;
/** A radial step's points round each of its two rounded corners, and along the ring arc between them. */
export const RADIAL_CORNER_POINTS = 4;
export const RADIAL_ARC_POINTS = 20;
/** Points along a radial piece (a ring arc needs more): its ends, two corners and the arc. */
export const RADIAL_POINTS = 2 + 2 * RADIAL_CORNER_POINTS + RADIAL_ARC_POINTS;
/** Halvings that find where a curve is cut off the node it starts or ends at. */
export const CUT_STEPS = 12;
/**
 * Floats per piece: stop A (x, y, f, node?), stop B, source and target index, trims, half-width, colour r, g, b,
 * dash style (0 solid, 1 dashed, 2 dotted), glow (1: yes).
 */
export const PIECE_STRIDE = 18;
/**
 * Floats per edge end: the last stop before the node it's at (x, y, f, node?), the edge's other node and that node
 * (an end at the source names them the other way round, as if the edge ran backwards), how far the edge is cut off
 * that node, size, kind, r, g, b.
 */
export const TIP_STRIDE = 12;
/**
 * Floats per bundle span: its four control nodes, how far along the path each is (0–1), source, target, trims,
 * half-width, colour r, g, b, dash style, glow.
 */
export const SPAN_STRIDE = 18;
/**
 * Floats per bundled edge's end: its last four control nodes, how far along the path each is, source, target,
 * target radius, size, kind, colour r, g, b. An end at the source is the path backwards: its first four control
 * nodes in reverse, how far along each is from the target, and the ends swapped.
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

 * @param {import("./controller.js").Scene} scene
 * @param {{ x: number, y: number }} origin
 * @returns {{ pieces: Float32Array, pieceEdge: Int32Array, pieceCount: number, shapedPieces: number,
 *   tips: Float32Array, tipEdge: Int32Array, tipCount: number, shapedTips: number, spans: Float32Array,
 *   spanEdge: Int32Array, spanCount: number, bundleTips: Float32Array, bundleTipEdge: Int32Array,
 *   bundleTipCount: number, shape: number, axis: number[], radial: boolean }}
 */
export function packPieces(scene, origin) {
  const { graph, routing, edge, looks } = scene;
  const layered = routing.kind === "layered";
  const rooms = endRooms(edge);
  // Ends per edge: at the target, the source, or both.
  const perEdge = (rooms.target > 0 ? 1 : 0) + (rooms.source > 0 ? 1 : 0);
  const kind = edge.arrow === "dot" ? 1 : 0;
  const colour = palette();
  const edges = graph.edges;
  const starts = startTrims(scene);
  const targetTrims = endTrims(scene);
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
  // Its ends per edge drawn as pieces (an edge with bends has several pieces but one end at each node).
  const shapedEdges = edges.length - bundleTotal - straightTotal;
  const tipTotal = (shapedEdges + straightTotal) * perEdge;
  const tips = new Float32Array(tipTotal * TIP_STRIDE);
  const tipEdge = new Int32Array(tipTotal);
  const spans = new Float32Array(spanTotal * SPAN_STRIDE);
  const spanEdge = new Int32Array(spanTotal);
  const bundleTips = new Float32Array(
    bundleTotal * perEdge * BUNDLE_TIP_STRIDE,
  );
  const bundleTipEdge = new Int32Array(bundleTotal * perEdge);
  // Shaped pieces and tips fill from the start, straight ones from where the shaped ones end.
  let p = 0,
    t = 0,
    ps = shapedTotal,
    ts = shapedEdges * perEdge,
    s = 0,
    b = 0;
  const shapedTips = ts;
  // A stop: a node (its position this frame) or a bend (where the layout put it, moved with the edge's ends).
  const write = (out, o, stop, backwards = false) => {
    out[o] = stop.x - origin.x;
    out[o + 1] = stop.y - origin.y;
    out[o + 2] = backwards ? 1 - stop.f : stop.f;
    out[o + 3] = stop.node ? 1 : 0;
  };
  const NODE_A = { x: 0, y: 0, f: 0, node: true },
    NODE_B = { x: 0, y: 0, f: 1, node: true };
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const rgb = colour(looks.edgeColour[ei]);
    const half = looks.edgeWidth[ei] / 2;
    const dash = looks.edgeDash?.[ei] ?? 0;
    const glow = looks.edgeGlow?.[ei] ?? 0;
    // A piece's first stop is trimmed past its source's label (startTrims); a bundle's only off its node (a disc).
    // Each end holds the edge off its node by its own room.
    const trimA = starts[ei] + rooms.source,
      trimB = targetTrims[ei] + rooms.target;
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
        spans[o + 10] = clearOf(scene, e.source) + rooms.source;
        spans[o + 11] = trimB;
        spans[o + 12] = half;
        spans[o + 13] = rgb[0];
        spans[o + 14] = rgb[1];
        spans[o + 15] = rgb[2];
        spans[o + 16] = dash;
        spans[o + 17] = glow;
        spanEdge[s] = ei;
      }
      // The ends: the last four control points (the last three spans), where the curve reaches the target; for the
      // source, the first four backwards (a uniform B-spline backwards is the same curve).
      for (const backwards of [false, true]) {
        if (!((backwards ? rooms.source : rooms.target) > 0)) continue;
        const o = b * BUNDLE_TIP_STRIDE;
        for (let q = 0; q < 4; q++) {
          const k = backwards ? Math.min(m, 3 - q) : Math.max(0, m - 3 + q);
          bundleTips[o + q] = path[k];
          bundleTips[o + 4 + q] = backwards ? 1 - k / m : k / m;
        }
        bundleTips[o + 8] = backwards ? e.target : e.source;
        bundleTips[o + 9] = backwards ? e.source : e.target;
        bundleTips[o + 10] = clearOf(scene, backwards ? e.source : e.target);
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
    /** @type {{ x: number, y: number, f: number, node?: boolean }[]} */
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
      pieces[o + 16] = dash;
      pieces[o + 17] = glow;
      pieceEdge[at] = ei;
    }
    // The ends. One at the source is the edge read backwards: from the stop after the source, its ends swapped,
    // cut off the source as far as the edge is (past its label, if it leaves through it).
    for (const backwards of [false, true]) {
      if (!((backwards ? rooms.source : rooms.target) > 0)) continue;
      const at = straight ? ts++ : t++;
      const o = at * TIP_STRIDE;
      write(tips, o, stops[backwards ? 1 : stops.length - 2], backwards);
      tips[o + 4] = backwards ? e.target : e.source;
      tips[o + 5] = backwards ? e.source : e.target;
      tips[o + 6] = backwards ? starts[ei] : targetTrims[ei];
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
    shape: SHAPES[edge.shape],
    axis: AXIS[routing.direction] ?? AXIS.TB,
    radial: routing.kind === "radial",
  };
}

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
 * The kinds of GPU edge instance: each one's instances in packPieces' data (and its buffer on the WebGL layer), the
 * keys of their edges and of their count, its stride, and where its half-width (-1: none), colour, and dash style
 * and glow (-1: none) are.
 * @type {[string, string, string, number, number, number, number][]}
 */
export const KINDS = [
  ["pieces", "pieceEdge", "pieceCount", PIECE_STRIDE, 12, 13, 16],
  ["tips", "tipEdge", "tipCount", TIP_STRIDE, -1, 9, -1],
  ["spans", "spanEdge", "spanCount", SPAN_STRIDE, 12, 13, 16],
  [
    "bundleTips",
    "bundleTipEdge",
    "bundleTipCount",
    BUNDLE_TIP_STRIDE,
    -1,
    13,
    -1,
  ],
];

/**
 * New looks for some edges (`dirty`: a flag per edge index) in GPU data from packPieces, in place: their colour,
 * half-width, dashes and glow, all a restyle can change without a new layout. Returns, for each kind of instance (pieces, tips,
 * spans, bundleTips), the runs [first, end) that changed, for uploading just those.
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packPieces>} data
 * @param {Uint8Array} dirty
 * @returns {Record<string, [number, number][]>}
 */
export function restylePieces(scene, data, dirty) {
  const { looks } = scene;
  const colour = palette();
  const out = {};
  for (const [kind, edgesOf, countOf, stride, half, at, style] of KINDS) {
    const values = data[kind],
      edges = data[edgesOf],
      count = data[countOf];
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
      if (style >= 0) {
        values[o + style] = looks.edgeDash?.[e] ?? 0;
        values[o + style + 1] = looks.edgeGlow?.[e] ?? 0;
      }
      changed.push(i);
    }
    out[kind] = runsOf(changed);
  }
  return out;
}
