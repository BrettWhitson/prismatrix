/** Points along each piece: the shader draws the capsules between consecutive ones. */
export declare const PIECE_POINTS = 16;
/** Points along a radial piece: a ring arc needs more. */
export declare const RADIAL_POINTS = 30;
/** Floats per piece: stop A (x, y, f, node?), stop B, source and target index, trims, half-width, colour r, g, b. */
export declare const PIECE_STRIDE = 16;
/** Floats per edge end: last stop before the target (x, y, f, node?), source, target, radius, size, kind, r, g, b. */
export declare const TIP_STRIDE = 12;
/**
 * Floats per bundle span: its four control nodes, how far along the path each is (0–1), source, target, trims,
 * half-width, colour r, g, b.
 */
export declare const SPAN_STRIDE = 16;
/**
 * Floats per bundled edge's end: its last four control nodes, how far along the path each is, source, target,
 * target radius, size, kind, colour r, g, b.
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
 *
 * `cpu` lists the edges left to the CPU (none: every edge this can pack, the GPU draws).
 * @param {import("./controller.js").Scene} scene
 * @param {{ x: number, y: number }} origin
 * @returns {{ pieces: Float32Array, pieceEdge: Int32Array, pieceCount: number, shapedPieces: number,
 *   tips: Float32Array, tipEdge: Int32Array, tipCount: number, shapedTips: number, spans: Float32Array,
 *   spanEdge: Int32Array, spanCount: number, bundleTips: Float32Array, bundleTipEdge: Int32Array,
 *   bundleTipCount: number, cpu: number[], shape: number, axis: number[], radial: boolean, points: number }}
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
  cpu: number[];
  shape: number;
  axis: number[];
  radial: boolean;
  points: number;
};
/**
 * A point of a uniform cubic B-spline span with control points p0–p3 (each [x, y]), at t (0–1): the same sum as
 * bspline in geometry.js and the bundle shader.
 */
export declare function splineAt(
  t: any,
  p0: any,
  p1: any,
  p2: any,
  p3: any,
): number[];
/**
 * Capsule a → b with the part inside the disc around `c` of radius `r` cut off: how the GPU trims a bundled edge
 * off its nodes (each capsule on its own, so it needs nothing from the rest of the curve). Null when nothing is
 * left. Assumes the curve crosses the disc's edge once, as it does near the node it starts or ends at.
 * @returns {[number[], number[]] | null}
 */
export declare function clipDisc(
  a: any,
  b: any,
  c: any,
  r: any,
): [number[], number[]] | null;
/**
 * How many capsules the GPU draws per bundle span at zoom `zoom`: all `BUNDLE_STEPS` (as the CPU traces them) once
 * a span is long enough on screen for its curve to show, fewer when spans are only a few pixels long. Bundles are
 * most of the GPU's edge vertices in real recipe data (a span is 48 vertices), and a zoomed-out view of a big graph
 * is where there are most of them on screen.
 */
export declare function bundleSteps(zoom: any): number;
/**
 * The capsules the bundle shader draws for one span, in JavaScript: `steps` of them (null where trimmed away),
 * from the span's four control nodes `nodes` (each [x, y] this frame) and how far along the path each is
 * (`along`), the edge's ends S and T, and its trims.
 * @returns {([number[], number[]] | null)[]}
 */
export declare function bundleSpanCapsules(
  strength: any,
  nodes: any,
  along: any,
  S: any,
  T: any,
  trimA: any,
  trimB: any,
  steps?: number,
): ([number[], number[]] | null)[];
/**
 * Where a bundled edge's arrowhead or dot goes, in JavaScript (the bundle tip shader): walking back from the target
 * along the last three spans (from its last four control nodes), the first point at least `reach` (target radius
 * plus the end's room) from the target; the tip sits `end` on from where the curve crosses that distance, pointing
 * the way the curve runs there. As the CPU puts it (packEdges).
 * @returns {{ tip: number[], dir: number[] }}
 */
export declare function bundleTip(
  strength: any,
  nodes: any,
  along: any,
  S: any,
  T: any,
  reach: any,
  end: any,
): {
  tip: number[];
  dir: number[];
};
/**
 * The points the shader traces for a radial piece from node s to node t (each with x, y and its home, homeX,
 * homeY), around the centre (cx, cy): the same rules as the CPU (radialStep in geometry.js). Returns `RADIAL_POINTS`
 * points; unused ones repeat the last.
 * @param {number} shape 0 straight, 1 step, 2 curve
 */
export declare function radialPiecePoints(
  shape: number,
  centre: any,
  s: any,
  t: any,
  trimA: any,
  trimB: any,
  corner: any,
  morphing?: boolean,
): any;
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
 * The points the piece shader traces from stop a to stop b (world px, already where they are this frame), in
 * JavaScript: `PIECE_POINTS` points, the capsules between consecutive ones making the piece. `trimA` and `trimB`
 * pull the ends in (off the nodes they start and finish at).
 * @param {number} shape 0 straight, 1 step, 2 curve
 * @param {number[]} axis AXIS[direction]
 * @returns {number[][]} [x, y] points
 */
export declare function piecePoints(
  shape: number,
  axis: number[],
  a: any,
  b: any,
  trimA: any,
  trimB: any,
  corner: any,
): number[][];
/**
 * New looks for some edges (`dirty`: a flag per edge index) in GPU data from packPieces, in place: their colour and
 * half-width, all a restyle can change without a new layout. Returns, for each kind of instance (pieces, tips,
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
