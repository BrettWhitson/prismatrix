// What the WebGL renderer sends the GPU each frame, worked out on the CPU. Pure: no GL, so it can be tested.

import {
  END_ROOM,
  fanJunctions,
  rounded,
  startTrims,
  trimmedRoute,
} from "./geometry.js";
import { linkGlyphs } from "./references.js";
import { edgeAlpha, nodeAlpha } from "./render.js";
import { iconBox } from "./icons.js";

/** Shape names to the ids the node shader switches on. */
export const SHAPE_IDS = {
  circle: 0,
  square: 1,
  rounded: 2,
  diamond: 3,
  hexagon: 4,
  ring: 5,
  tile: 6,
};

/**
 * Floats per node: centre x, y; radius; colour r, g, b, a (a: how visible, see nodeAlpha); shape id; border colour
 * r, g, b and width (0: no border); its icon's rectangle in the icon atlas (u0, v0, u1, v1), page (-1: no icon) and
 * box (half its width and height, world px: iconBox); its ring's colour r, g, b and 1 (0: none); its aura's colour
 * r, g, b and 1 (0: none); its border style (STROKE_STYLES), 1 for a stacked copy, its fill's opacity; its badge
 * image's rectangle in the icon atlas (u0, v0, u1, v1) and page (-1: none).
 */
export const NODE_STRIDE = 35;
/**
 * Floats per edge segment: ends x0, y0, x1, y1; half-widths at each end; colour r, g, b. Its brightness lives in a
 * separate buffer (edgeBrightness), so a hover fade refills that alone instead of rebuilding every edge.
 */
export const SEGMENT_STRIDE = 9;
/** Floats per edge end: tip x, y; direction x, y (unit, along the edge); size; kind (0 arrow, 1 dot); colour r, g, b. */
export const END_STRIDE = 9;

/**
 * "#rrggbb" to [r, g, b] in 0–1.
 * @returns {[number, number, number]}
 */
export function parseColour(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * A typed array (Float32Array unless `Type` says otherwise) of at least `n`: `old` when it's big enough, else a
 * bigger one holding what `old` held.
 * @template {Float32Array | Int32Array} T
 * @param {T | null | undefined} old
 * @param {number} n
 * @param {any} [Type]
 * @returns {T}
 */
export function room(old, n, Type = Float32Array) {
  if (old && old.length >= n) return old;
  const grown = new Type(Math.ceil(Math.max(n, 1024) * 1.5));
  if (old) grown.set(old);
  return grown;
}

/** A cache of parsed colours, so each distinct colour is parsed once per frame. */
export function palette() {
  const seen = new Map();
  return (hex) => {
    let rgb = seen.get(hex);
    if (!rgb) seen.set(hex, (rgb = parseColour(hex)));
    return rgb;
  };
}

/**
 * World 0, 0: where positions are measured from unless a renderer asks for an origin of its own.
 * @type {Readonly<{ x: number, y: number }>}
 */
const ORIGIN = Object.freeze({ x: 0, y: 0 });

/**
 * @callback IconAt where an icon is in the icon atlas, or null while it isn't there (loading, failed)
 * @param {any} source a node's `icon` (URL or image)
 * @returns {{ u0: number, v0: number, u1: number, v1: number, layer: number, aspect: number } | null}
 */

/**
 * Every node as instance data for the node shader, into `out` (grown if too small), positions relative to
 * `origin`, icons where `iconAt` says they are.
 * @param {IconAt | null} [iconAt]
 * @returns {Float32Array}
 */
export function packNodes(scene, out, origin = ORIGIN, iconAt = null) {
  const { graph } = scene;
  out = room(out, graph.nodes.length * NODE_STRIDE);
  const colour = palette();
  for (const n of graph.nodes) packNode(scene, n, out, origin, colour, iconAt);
  return out;
}

/**
 * Nodes `indices` only, into `out` as packNodes packed it (a restyle of a few nodes).
 * @param {Iterable<number> & ArrayLike<number>} indices
 * @param {IconAt | null} [iconAt]
 */
export function patchNodes(
  scene,
  out,
  indices,
  origin = ORIGIN,
  iconAt = null,
) {
  const colour = palette();
  const { nodes } = scene.graph;
  for (const i of indices)
    if (i < nodes.length)
      packNode(scene, nodes[i], out, origin, colour, iconAt);
}

function packNode(scene, n, out, origin, colour, iconAt) {
  const { looks } = scene;
  const i = n.index;
  const o = i * NODE_STRIDE;
  const rgb = colour(looks.fill[i]);
  const radius = looks.radius[i];
  const shape = looks.shape[i];
  out[o] = n.x - origin.x;
  out[o + 1] = n.y - origin.y;
  out[o + 2] = radius;
  out[o + 3] = rgb[0];
  out[o + 4] = rgb[1];
  out[o + 5] = rgb[2];
  out[o + 6] = nodeAlpha(scene, i);
  out[o + 7] = SHAPE_IDS[shape] ?? 0;
  const stroke = looks.stroke?.[i];
  const strokeWidth = stroke ? looks.strokeWidth[i] : 0;
  const s = strokeWidth > 0 ? colour(stroke) : NONE;
  out[o + 8] = s[0];
  out[o + 9] = s[1];
  out[o + 10] = s[2];
  out[o + 11] = strokeWidth;
  const source = shape === "ring" ? null : looks.icon?.[i];
  const at = source && iconAt ? iconAt(source) : null;
  if (at) {
    const [hx, hy] = iconBox(
      shape,
      looks.iconFit,
      at.aspect,
      radius,
      strokeWidth,
    );
    out[o + 12] = at.u0;
    out[o + 13] = at.v0;
    out[o + 14] = at.u1;
    out[o + 15] = at.v1;
    out[o + 16] = at.layer;
    out[o + 17] = hx;
    out[o + 18] = hy;
  } else {
    out.fill(0, o + 12, o + 19);
    out[o + 16] = -1;
  }
  const ring = looks.ring?.[i];
  const rr = ring ? colour(ring) : NONE;
  out[o + 19] = rr[0];
  out[o + 20] = rr[1];
  out[o + 21] = rr[2];
  out[o + 22] = ring ? 1 : 0;
  const aura = looks.aura?.[i];
  const ar = aura ? colour(aura) : NONE;
  out[o + 23] = ar[0];
  out[o + 24] = ar[1];
  out[o + 25] = ar[2];
  out[o + 26] = aura ? 1 : 0;
  out[o + 27] = looks.strokeStyle?.[i] ?? 0;
  out[o + 28] = looks.stack?.[i] ?? 0;
  out[o + 29] = looks.opacity?.[i] ?? 1;
  const badge = looks.badgeIcon?.[i];
  const b = badge && iconAt ? iconAt(badge) : null;
  if (b) {
    out[o + 30] = b.u0;
    out[o + 31] = b.v0;
    out[o + 32] = b.u1;
    out[o + 33] = b.v1;
    out[o + 34] = b.layer;
  } else {
    out.fill(0, o + 30, o + 34);
    out[o + 34] = -1;
  }
}

const NONE = [0, 0, 0];

/**
 * The selected nodes (scene.selected), for the halo shader: their rows of `nodeData` (from packNodes), a handful of
 * instances, refilled when the selection, the shading or the positions change (nothing else is rebuilt for a
 * selection).
 * @param {Float32Array} nodeData
 * @returns {{ data: Float32Array, count: number }}
 */
export function packHalos(scene, nodeData, out = null) {
  const { graph, selected } = scene;
  let count = 0;
  const total = selected ? Math.min(selected.length, graph.nodes.length) : 0;
  for (let i = 0; i < total; i++) if (selected[i]) count++;
  out = room(out, count * NODE_STRIDE);
  let o = 0;
  for (let i = 0; i < total; i++) {
    if (!selected[i]) continue;
    // Centre, radius, colour, visibility and shape: what the halo shader reads.
    out.set(nodeData.subarray(i * NODE_STRIDE, i * NODE_STRIDE + 8), o);
    o += NODE_STRIDE;
  }
  return { data: out, count };
}

/**
 * Every edge as straight segments (curves and rounded corners already broken down) and every arrow or dot at an
 * edge's end, with the index of the edge each one belongs to (for edgeBrightness).
 * @param {import("./controller.js").Scene} scene
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
  const end = edge.arrow === "none" ? 0 : edge.arrowSize * END_ROOM;
  const kind = edge.arrow === "dot" ? 1 : 0;
  let segments = reuse.segments ?? null;
  let ends = reuse.ends ?? null;
  let segmentEdge = reuse.segmentEdge ?? null;
  let endEdge = reuse.endEdge ?? null;
  let segmentCount = 0,
    endCount = 0;
  const starts = startTrims(scene); // past each source's own label

  const count = only ? only.length : graph.edges.length;
  for (let k = 0; k < count; k++) {
    const edgeIndex = only ? only[k] : k;
    const e = graph.edges[edgeIndex];
    let pts = trimmedRoute(scene, edgeIndex, junctions, starts);
    if (!pts) continue;
    // Bundled cross-links are already smooth; layered edges follow their bends, tree edge or not.
    if (corner > 0 && (e.tree || routing.kind === "layered"))
      pts = rounded(pts, corner);
    const rgb = colour(looks.edgeColour[edgeIndex]);
    const width = looks.edgeWidth[edgeIndex];

    const points = pts.length / 2;
    segments = room(segments, (segmentCount + points) * SEGMENT_STRIDE);
    segmentEdge = room(segmentEdge, segmentCount + points, Int32Array);
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
      endEdge = room(endEdge, endCount + 1, Int32Array);
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
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packEdges>} packed
 * @param {{ segmentAlpha?: Float32Array, endAlpha?: Float32Array }} [reuse]
 * @returns {{ segmentAlpha: Float32Array, endAlpha: Float32Array, bright: boolean }}
 */
export function edgeBrightness(scene, packed, reuse = {}, perEdge = null) {
  const { edges } = scene.graph;
  perEdge ??= Float32Array.from(edges, (e) => edgeAlpha(scene, e));
  let bright = true;
  for (let i = 0; i < edges.length; i++) if (perEdge[i] < 1) bright = false;
  const segmentAlpha = room(reuse.segmentAlpha, packed.segmentCount);
  const endAlpha = room(reuse.endAlpha, packed.endCount);
  for (let i = 0; i < packed.segmentCount; i++)
    segmentAlpha[i] = perEdge[packed.segmentEdge[i]];
  for (let i = 0; i < packed.endCount; i++)
    endAlpha[i] = perEdge[packed.endEdge[i]];
  return { segmentAlpha, endAlpha, bright };
}

/** Floats per link glyph: centre x, y; radius; colour r, g, b; alpha. */
export const GLYPH_STRIDE = 7;

/**
 * Every reference chip's link glyph (linkGlyphs), whatever its size on screen (the shader leaves out the ones too
 * small to see, so a zoom needs nothing new), relative to `origin`.
 * @returns {{ data: Float32Array, count: number }}
 */
export function packGlyphs(scene, out, origin = ORIGIN) {
  const glyphs = linkGlyphs(scene, 0);
  out = room(out, glyphs.length * GLYPH_STRIDE);
  const colour = palette();
  glyphs.forEach((g, k) => {
    const o = k * GLYPH_STRIDE;
    const rgb = colour(g.colour);
    out[o] = g.x - origin.x;
    out[o + 1] = g.y - origin.y;
    out[o + 2] = g.radius;
    out[o + 3] = rgb[0];
    out[o + 4] = rgb[1];
    out[o + 5] = rgb[2];
    out[o + 6] = nodeAlpha(scene, g.index);
  });
  return { data: out, count: glyphs.length };
}

/**
 * Ascending indices as runs [first, end) to upload, neighbouring runs joined when less than `gap` apart (one bigger
 * upload is cheaper than many small ones).
 * @param {ArrayLike<number>} sorted
 * @returns {[number, number][]}
 */
export function runsOf(sorted, gap = 16) {
  const runs = [];
  for (let k = 0; k < sorted.length; k++) {
    const i = sorted[k];
    const last = runs.at(-1);
    if (last && i < last[1] + gap) last[1] = Math.max(last[1], i + 1);
    else runs.push([i, i + 1]);
  }
  return runs;
}

/**
 * Edges `edges` (ascending indices) packed again into `packed` (from packEdges, for the same layout: only their looks
 * changed, so each keeps its segments and ends), in place. Edges `packed` doesn't hold (drawn by the GPU, or trimmed
 * away) are skipped. Returns the runs of segments and ends that changed, for uploading just those.
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packEdges>} packed
 * @param {Iterable<number> & ArrayLike<number>} edges
 * @returns {{ segments: [number, number][], ends: [number, number][] }}
 */
export function patchEdges(scene, packed, edges, origin = ORIGIN) {
  const wanted = new Set(edges);
  // Where each wanted edge's segments and end start.
  const firstSegment = new Map(),
    firstEnd = new Map();
  for (let i = 0; i < packed.segmentCount; i++) {
    const e = packed.segmentEdge[i];
    if (wanted.has(e) && !firstSegment.has(e)) firstSegment.set(e, i);
  }
  for (let i = 0; i < packed.endCount; i++) {
    const e = packed.endEdge[i];
    if (wanted.has(e) && !firstEnd.has(e)) firstEnd.set(e, i);
  }
  const only = [...wanted].filter((e) => firstSegment.has(e));
  const fresh = packEdges(scene, {}, only, origin);
  const copy = (count, edgeOf, from, to, first, stride) => {
    const changed = [];
    let previous = -1,
      base,
      offset = 0;
    for (let k = 0; k < count; k++) {
      const e = edgeOf[k];
      if (e !== previous) {
        base = first.get(e);
        offset = 0;
        previous = e;
      } else offset++;
      if (base === undefined) continue;
      const at = base + offset;
      to.set(from.subarray(k * stride, (k + 1) * stride), at * stride);
      changed.push(at);
    }
    return runsOf(changed.sort((a, b) => a - b));
  };
  return {
    segments: copy(
      fresh.segmentCount,
      fresh.segmentEdge,
      fresh.segments,
      packed.segments,
      firstSegment,
      SEGMENT_STRIDE,
    ),
    ends: copy(
      fresh.endCount,
      fresh.endEdge,
      fresh.ends,
      packed.ends,
      firstEnd,
      END_STRIDE,
    ),
  };
}
