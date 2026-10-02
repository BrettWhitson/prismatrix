/** Points along each piece: the shader draws the capsules between consecutive ones. */
export declare const PIECE_POINTS = 16;
/** Points round each rounded corner of a step piece (the other two are its ends). */
export declare const CORNER_POINTS: number;
/** A radial step's points round each of its two rounded corners, and along the ring arc between them. */
export declare const RADIAL_CORNER_POINTS = 4;
export declare const RADIAL_ARC_POINTS = 20;
/** Points along a radial piece (a ring arc needs more): its ends, two corners and the arc. */
export declare const RADIAL_POINTS: number;
/** Halvings that find where a curve is cut off the node it starts or ends at. */
export declare const CUT_STEPS = 12;
/**
 * Floats per piece: stop A (x, y, f, node?), stop B, source and target index, trims, half-width, colour r, g, b,
 * dash style (0 solid, 1 dashed, 2 dotted), glow (1: yes).
 */
export declare const PIECE_STRIDE = 18;
/**
 * Floats per edge end: the last stop before the node it's at (x, y, f, node?), the edge's other node and that node
 * (an end at the source names them the other way round, as if the edge ran backwards), how far the edge is cut off
 * that node, size, kind, r, g, b; how far the edge's other end is trimmed (where a tree curve turns).
 */
export declare const TIP_STRIDE = 13;
/**
 * Floats per bundle span: its four control nodes, how far along the path each is (0–1), source, target, trims,
 * half-width, colour r, g, b, dash style, glow.
 */
export declare const SPAN_STRIDE = 18;
/**
 * Floats per bundled edge's end: its last four control nodes, how far along the path each is, source, target,
 * target radius, size, kind, colour r, g, b. An end at the source is the path backwards: its first four control
 * nodes in reverse, how far along each is from the target, and the ends swapped.
 */
export declare const BUNDLE_TIP_STRIDE = 16;
/** Texels per row of the positions texture. */
export declare const POSITION_COLUMNS = 2048;
/**
 * The world → layout-axis frame for a tree or layered direction, as a column-major 2×2 matrix: in that frame y
 * runs from parent to child. Its inverse is its transpose.
 */
export declare const AXIS: {
  TB: number[];
  BT: number[];
  LR: number[];
  RL: number[];
};
/** Whether the GPU can draw this scene's edges: straight, step or curve in any layout (not fans or tapers). */
export declare function gpuEdges(scene: any): boolean;
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
export declare function packPieces(
  scene: import("./controller.js").Scene,
  origin: {
    x: number;
    y: number;
  },
): {
  pieces: Float32Array;
  pieceEdge: Int32Array;
  pieceCount: number;
  shapedPieces: number;
  tips: Float32Array;
  tipEdge: Int32Array;
  tipCount: number;
  shapedTips: number;
  spans: Float32Array;
  spanEdge: Int32Array;
  spanCount: number;
  bundleTips: Float32Array;
  bundleTipEdge: Int32Array;
  bundleTipCount: number;
  shape: number;
  axis: number[];
  radial: boolean;
};
/**
 * How many capsules the GPU draws per bundle span at zoom `zoom`: all `BUNDLE_STEPS` (as the CPU traces them) once
 * a span is long enough on screen for its curve to show, fewer when spans are only a few pixels long. Bundles are
 * most of the GPU's edge vertices in real recipe data (a span is 48 vertices), and a zoomed-out view of a big graph
 * is where there are most of them on screen.
 */
export declare function bundleSteps(zoom: any): number;
/**
 * Every display node's position and home relative to `origin`, four floats a texel (x, y, homeX, homeY), into `out`
 * (grown if too small). The working graph's nodes come straight from its matrix; display-only nodes after them
 * (references, ghosts) from their objects.
 * @returns {Float32Array}
 */
export declare function packPositions(
  scene: any,
  origin: any,
  out: any,
): Float32Array;
/**
 * The kinds of GPU edge instance: each one's instances in packPieces' data (and its buffer on the WebGL layer), the
 * keys of their edges and of their count, its stride, and where its half-width (-1: none), colour, and dash style
 * and glow (-1: none) are.
 * @type {[string, string, string, number, number, number, number][]}
 */
export declare const KINDS: [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
][];
/**
 * New looks for some edges (`dirty`: a flag per edge index) in GPU data from packPieces, in place: their colour,
 * half-width, dashes and glow, all a restyle can change without a new layout. Returns, for each kind of instance (pieces, tips,
 * spans, bundleTips), the runs [first, end) that changed, for uploading just those.
 * @param {import("./controller.js").Scene} scene
 * @param {ReturnType<typeof packPieces>} data
 * @param {Uint8Array} dirty
 * @returns {Record<string, [number, number][]>}
 */
export declare function restylePieces(
  scene: import("./controller.js").Scene,
  data: ReturnType<typeof packPieces>,
  dirty: Uint8Array,
): Record<string, [number, number][]>;
