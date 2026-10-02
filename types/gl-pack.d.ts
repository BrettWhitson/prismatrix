/** Shape names to the ids the node shader switches on. */
export declare const SHAPE_IDS: {
  circle: number;
  square: number;
  rounded: number;
  diamond: number;
  hexagon: number;
  ring: number;
  tile: number;
};
/**
 * Floats per node: centre x, y; radius; colour r, g, b, a (a: how visible, see nodeAlpha); shape id; border colour
 * r, g, b and width (0: no border); its icon's rectangle in the icon atlas (u0, v0, u1, v1), page (-1: no icon) and
 * box (half its width and height, world px: iconBox); its ring's colour r, g, b and 1 (0: none); its aura's colour
 * r, g, b and 1 (0: none); its border style (STROKE_STYLES), 1 for a stacked copy, its fill's opacity; its badge
 * image's rectangle in the icon atlas (u0, v0, u1, v1) and page (-1: none).
 */
export declare const NODE_STRIDE = 35;
/**
 * Floats per edge segment: ends x0, y0, x1, y1; half-widths at each end; colour r, g, b. Its brightness lives in a
 * separate buffer (edgeBrightness), so a hover fade refills that alone instead of rebuilding every edge.
 */
export declare const SEGMENT_STRIDE = 9;
/** Floats per edge end: tip x, y; direction x, y (unit, along the edge); size; kind (0 arrow, 1 dot); colour r, g, b. */
export declare const END_STRIDE = 9;
/**
 * "#rrggbb" to [r, g, b] in 0–1.
 * @returns {[number, number, number]}
 */
export declare function parseColour(hex: any): [number, number, number];
/**
 * A typed array (Float32Array unless `Type` says otherwise) of at least `n`: `old` when it's big enough, else a
 * bigger one holding what `old` held.
 * @template {Float32Array | Int32Array} T
 * @param {T | null | undefined} old
 * @param {number} n
 * @param {any} [Type]
 * @returns {T}
 */
export declare function room<T extends Float32Array | Int32Array>(
  old: T | null | undefined,
  n: number,
  Type?: any,
): T;
/** A cache of parsed colours, so each distinct colour is parsed once per frame. */
export declare function palette(): (hex: any) => any;
export type IconAt = (source: any) => {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  layer: number;
  aspect: number;
} | null;
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
export declare function packNodes(
  scene: any,
  out: any,
  origin?: Readonly<{
    x: number;
    y: number;
  }>,
  iconAt?: IconAt | null,
): Float32Array;
/**
 * Nodes `indices` only, into `out` as packNodes packed it (a restyle of a few nodes).
 * @param {Iterable<number> & ArrayLike<number>} indices
 * @param {IconAt | null} [iconAt]
 */
export declare function patchNodes(
  scene: any,
  out: any,
  indices: Iterable<number> & ArrayLike<number>,
  origin?: Readonly<{
    x: number;
    y: number;
  }>,
  iconAt?: IconAt | null,
): void;
/**
 * The selected nodes (scene.selected), for the halo shader: their rows of `nodeData` (from packNodes), a handful of
 * instances, refilled when the selection, the shading or the positions change (nothing else is rebuilt for a
 * selection).
 * @param {Float32Array} nodeData
 * @returns {{ data: Float32Array, count: number }}
 */
export declare function packHalos(
  scene: any,
  nodeData: Float32Array,
  out?: any,
): {
  data: Float32Array;
  count: number;
};
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
export declare function packEdges(
  scene: import("./controller.js").Scene,
  reuse?: {
    segments?: Float32Array;
    ends?: Float32Array;
    segmentEdge?: Int32Array;
    endEdge?: Int32Array;
  },
  only?: number[] | null,
  origin?: {
    x: number;
    y: number;
  },
): {
  segments: Float32Array;
  ends: Float32Array;
  segmentEdge: Int32Array;
  endEdge: Int32Array;
  segmentCount: number;
  endCount: number;
};
/**
 * How bright each packed segment and end is: its edge's brightness (edgeAlpha: hover, fading in). Cheap enough to
 * redo every frame of a fade. `bright` is true when every edge is at full brightness.
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packEdges>} packed
 * @param {{ segmentAlpha?: Float32Array, endAlpha?: Float32Array }} [reuse]
 * @returns {{ segmentAlpha: Float32Array, endAlpha: Float32Array, bright: boolean }}
 */
export declare function edgeBrightness(
  scene: import("./controller.js").Scene,
  packed: ReturnType<typeof packEdges>,
  reuse?: {
    segmentAlpha?: Float32Array;
    endAlpha?: Float32Array;
  },
  perEdge?: any,
): {
  segmentAlpha: Float32Array;
  endAlpha: Float32Array;
  bright: boolean;
};
/** Floats per link glyph: centre x, y; radius; colour r, g, b; alpha. */
export declare const GLYPH_STRIDE = 7;
/**
 * Every reference chip's link glyph (linkGlyphs), whatever its size on screen (the shader leaves out the ones too
 * small to see, so a zoom needs nothing new), relative to `origin`.
 * @returns {{ data: Float32Array, count: number }}
 */
export declare function packGlyphs(
  scene: any,
  out: any,
  origin?: Readonly<{
    x: number;
    y: number;
  }>,
): {
  data: Float32Array;
  count: number;
};
/**
 * Ascending indices as runs [first, end) to upload, neighbouring runs joined when less than `gap` apart (one bigger
 * upload is cheaper than many small ones).
 * @param {ArrayLike<number>} sorted
 * @returns {[number, number][]}
 */
export declare function runsOf(
  sorted: ArrayLike<number>,
  gap?: number,
): [number, number][];
/**
 * Edges `edges` (ascending indices) packed again into `packed` (from packEdges, for the same layout: only their looks
 * changed, so each keeps its segments and ends), in place. Edges `packed` doesn't hold (drawn by the GPU, or trimmed
 * away) are skipped. Returns the runs of segments and ends that changed, for uploading just those.
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packEdges>} packed
 * @param {Iterable<number> & ArrayLike<number>} edges
 * @returns {{ segments: [number, number][], ends: [number, number][] }}
 */
export declare function patchEdges(
  scene: import("./controller.js").Scene,
  packed: ReturnType<typeof packEdges>,
  edges: Iterable<number> & ArrayLike<number>,
  origin?: Readonly<{
    x: number;
    y: number;
  }>,
): {
  segments: [number, number][];
  ends: [number, number][];
};
