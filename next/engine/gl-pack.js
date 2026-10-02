// What the WebGL renderer sends the GPU each frame, worked out on the CPU. Pure: no GL, so it can be tested.

import { edgeRoute, fanJunctions, rounded, trim } from "./geometry.js";
import { edgeAlpha, nodeAlpha } from "./render.js";

/** Shape names to the ids the node shader switches on. */
export const SHAPE_IDS = {
  circle: 0,
  square: 1,
  rounded: 2,
  diamond: 3,
  hexagon: 4,
  ring: 5,
};

/** Floats per node: centre x, y; radius; colour r, g, b, a (a: how visible, see nodeAlpha); shape id. */
export const NODE_STRIDE = 8;
/**
 * Floats per edge segment: ends x0, y0, x1, y1; half-widths at each end; colour r, g, b. Its brightness lives in a
 * separate buffer (edgeBrightness), so a hover fade refills that alone instead of rebuilding every edge.
 */
export const SEGMENT_STRIDE = 9;
/** Floats per edge end: tip x, y; direction x, y (unit, along the edge); size; kind (0 arrow, 1 dot); colour r, g, b. */
export const END_STRIDE = 9;

/** "#rrggbb" to [r, g, b] in 0–1. */
export function parseColour(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A Float32Array of at least `floats`: `old` when it's big enough, else a bigger one holding what `old` held. */
function room(old, floats) {
  if (old && old.length >= floats) return old;
  const grown = new Float32Array(Math.ceil(Math.max(floats, 1024) * 1.5));
  if (old) grown.set(old);
  return grown;
}

/** An Int32Array of at least `count`, keeping what `old` held. */
function roomInt(old, count) {
  if (old && old.length >= count) return old;
  const grown = new Int32Array(Math.ceil(Math.max(count, 1024) * 1.5));
  if (old) grown.set(old);
  return grown;
}

/** A cache of parsed colours, so each distinct colour is parsed once per frame. */
function palette() {
  const seen = new Map();
  return (hex) => {
    let rgb = seen.get(hex);
    if (!rgb) seen.set(hex, (rgb = parseColour(hex)));
    return rgb;
  };
}

/** World 0, 0: where positions are measured from unless a renderer asks for an origin of its own. */
const ORIGIN = Object.freeze({ x: 0, y: 0 });

/**
 * Every node as instance data for the node shader, into `out` (grown if too small), positions relative to
 * `origin`.
 * @returns {Float32Array}
 */
export function packNodes(scene, out, origin = ORIGIN) {
  const { graph, looks } = scene;
  out = room(out, graph.nodes.length * NODE_STRIDE);
  const colour = palette();
  for (const n of graph.nodes) {
    const rgb = colour(looks.fill[n.index]);
    const o = n.index * NODE_STRIDE;
    out[o] = n.x - origin.x;
    out[o + 1] = n.y - origin.y;
    out[o + 2] = looks.radius[n.index];
    out[o + 3] = rgb[0];
    out[o + 4] = rgb[1];
    out[o + 5] = rgb[2];
    out[o + 6] = nodeAlpha(scene, n.index);
    out[o + 7] = SHAPE_IDS[looks.shape[n.index]] ?? 0;
  }
  return out;
}

/**
 * Every edge as straight segments (curves and rounded corners already broken down) and every arrow or dot at an
 * edge's end, with the index of the edge each one belongs to (for edgeBrightness).
 * @param {object} scene
 * @param {{ segments?: Float32Array, ends?: Float32Array, segmentEdge?: Int32Array, endEdge?: Int32Array }} [reuse]
 *   buffers from the last frame
 * @param {number[] | null} [only] just these edges (by index); all of them when null
 * @param {{ x: number, y: number }} [origin] where positions are measured from (world 0, 0 by default)
 * @returns {{ segments: Float32Array, ends: Float32Array, segmentEdge: Int32Array, endEdge: Int32Array,
 *   segmentCount: number, endCount: number }}
 */
export function packEdges(scene, reuse = {}, only = null, origin = ORIGIN) {
  const { graph, routing, edge, looks } = scene;
  const colour = palette();
  const junctions = edge.shape === "fan" ? fanJunctions(graph, routing) : null;
  const corner =
    edge.shape === "step" || edge.shape === "fan" ? edge.corner : 0;
  const end = edge.arrow === "none" ? 0 : edge.arrowSize * 0.9;
  const kind = edge.arrow === "dot" ? 1 : 0;
  let segments = reuse.segments ?? null;
  let ends = reuse.ends ?? null;
  let segmentEdge = reuse.segmentEdge ?? null;
  let endEdge = reuse.endEdge ?? null;
  let segmentCount = 0,
    endCount = 0;

  const count = only ? only.length : graph.edges.length;
  for (let k = 0; k < count; k++) {
    const edgeIndex = only ? only[k] : k;
    const e = graph.edges[edgeIndex];
    const s = graph.nodes[e.source],
      t = graph.nodes[e.target];
    let junction = null;
    if (junctions && e.tree) {
      const jx = junctions[e.source * 2];
      if (!Number.isNaN(jx))
        junction = { x: jx, y: junctions[e.source * 2 + 1] };
    }
    let pts = trim(
      edgeRoute(graph, routing, edge.shape, e, junction),
      looks.radius[s.index],
      looks.radius[t.index] + end,
    );
    if (!pts) continue;
    // Bundled cross-links are already smooth; layered edges follow their bends, tree edge or not.
    if (corner > 0 && (e.tree || routing.kind === "layered"))
      pts = rounded(pts, corner);
    const rgb = colour(looks.edgeColour[edgeIndex]);
    const width = looks.edgeWidth[edgeIndex];

    const points = pts.length / 2;
    segments = room(segments, (segmentCount + points) * SEGMENT_STRIDE);
    segmentEdge = roomInt(segmentEdge, segmentCount + points);
    // A taper narrows from twice the width at the parent to a third of it at the child, by distance along the edge.
    let total = 0;
    if (edge.taper)
      for (let i = 2; i < pts.length; i += 2)
        total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    const half = (walked) =>
      (edge.taper ? width * (2 - 1.7 * (walked / total)) : width) / 2;
    let walked = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const length = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      segmentEdge[segmentCount] = edgeIndex;
      const o = segmentCount++ * SEGMENT_STRIDE;
      segments[o] = pts[i - 2] - origin.x;
      segments[o + 1] = pts[i - 1] - origin.y;
      segments[o + 2] = pts[i] - origin.x;
      segments[o + 3] = pts[i + 1] - origin.y;
      segments[o + 4] = half(walked);
      walked += length;
      segments[o + 5] = half(walked);
      segments[o + 6] = rgb[0];
      segments[o + 7] = rgb[1];
      segments[o + 8] = rgb[2];
    }

    if (end > 0) {
      const n = pts.length;
      let dx = pts[n - 2] - pts[n - 4],
        dy = pts[n - 1] - pts[n - 3];
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      ends = room(ends, (endCount + 1) * END_STRIDE);
      endEdge = roomInt(endEdge, endCount + 1);
      endEdge[endCount] = edgeIndex;
      const o = endCount++ * END_STRIDE;
      ends[o] = pts[n - 2] + dx * end - origin.x;
      ends[o + 1] = pts[n - 1] + dy * end - origin.y;
      ends[o + 2] = dx;
      ends[o + 3] = dy;
      ends[o + 4] = edge.arrowSize;
      ends[o + 5] = kind;
      ends[o + 6] = rgb[0];
      ends[o + 7] = rgb[1];
      ends[o + 8] = rgb[2];
    }
  }
  return {
    segments: segments ?? new Float32Array(0),
    ends: ends ?? new Float32Array(0),
    segmentEdge: segmentEdge ?? new Int32Array(0),
    endEdge: endEdge ?? new Int32Array(0),
    segmentCount,
    endCount,
  };
}

/**
 * How bright each packed segment and end is: its edge's brightness (edgeAlpha: hover, fading in). Cheap enough to
 * redo every frame of a fade. `bright` is true when every edge is at full brightness.
 * @param {object} scene
 * @param {ReturnType<typeof packEdges>} packed
 * @param {{ segmentAlpha?: Float32Array, endAlpha?: Float32Array }} [reuse]
 * @returns {{ segmentAlpha: Float32Array, endAlpha: Float32Array, bright: boolean }}
 */
export function edgeBrightness(scene, packed, reuse = {}, perEdge = null) {
  const { edges } = scene.graph;
  perEdge ??= Float32Array.from(edges, (e) => edgeAlpha(scene, e));
  let bright = true;
  for (let i = 0; i < edges.length; i++) if (perEdge[i] < 1) bright = false;
  let segmentAlpha = reuse.segmentAlpha;
  if (!segmentAlpha || segmentAlpha.length < packed.segmentCount)
    segmentAlpha = new Float32Array(Math.ceil(packed.segmentCount * 1.5) + 16);
  let endAlpha = reuse.endAlpha;
  if (!endAlpha || endAlpha.length < packed.endCount)
    endAlpha = new Float32Array(Math.ceil(packed.endCount * 1.5) + 16);
  for (let i = 0; i < packed.segmentCount; i++)
    segmentAlpha[i] = perEdge[packed.segmentEdge[i]];
  for (let i = 0; i < packed.endCount; i++)
    endAlpha[i] = perEdge[packed.endEdge[i]];
  return { segmentAlpha, endAlpha, bright };
}
