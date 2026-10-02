/** Radians per point along a ring arc (the CPU's radial steps; the GPU's pieces size their corners by it too). */
export declare const ARC_STEP = 0.06;
/** How far an edge's end (an arrow or a dot) holds the edge off its target, as a share of the end's size. */
export declare const END_ROOM = 0.9;
/**
 * The points of an edge from `s` to `t` (anything with x and y).
 * @param {import("./layouts.js").Routing} routing
 * @param {"straight" | "step" | "fan" | "curve"} shape
 * @param {{ x: number, y: number } | null} [junction] fan only: where the parent's edges split (see fanJunctions)
 * @returns {number[]} flat x, y pairs
 */
export declare function edgePoints(
  routing: import("./layouts.js").Routing,
  shape: "straight" | "step" | "fan" | "curve",
  s: any,
  t: any,
  junction?: {
    x: number;
    y: number;
  } | null,
): number[];
/**
 * Where each parent's fan splits, from where its children are right now: a shared point on a short stub out of
 * the parent. In a tree the stub follows the tree's axis; in a radial it points at the children (the mean of the
 * directions to them), and it shrinks away as they spread around the parent, so a centre root with children on
 * every side gets plain spokes. Nodes without one (leaves, or children behind or all around) get NaN.
 * @returns {Float64Array} x, y pairs by node index
 */
export declare function fanJunctions(graph: any, routing: any): Float64Array;
/** Points along a cubic Bézier, enough for its length to look smooth (about one per 6 world px, 8 to 48). */
export declare function cubic(p0: any, p1: any, p2: any, p3: any): any[];
/**
 * A polyline with each corner replaced by a circular arc of up to `radius` (shrunk where the neighbouring
 * segments are too short), as points. The GPU draws straight segments, so arcs become short ones.
 */
export declare function rounded(pts: any, radius: any): any;
/** Points per B-spline span when drawing a bundled edge. */
export declare const BUNDLE_STEPS = 8;
/** How closely a bundled edge follows its tree path: 1 follows the tree, 0 goes straight. */
export declare const BUNDLE_STRENGTH = 0.85;
/**
 * The tree path a cross-link bundles along: node indices from its source up to (not including, when there's
 * anything else on the way) the lowest common ancestor of its ends and back down to its target. Null when the edge
 * goes straight instead (ends in different trees, or nothing between them). Depends only on the forest, so it
 * lasts until the structure changes: the WebGL renderer works it out once per layout and traces the curve on the
 * GPU from it.
 * @returns {number[] | null}
 */
export declare function bundlePath(graph: any, e: any): number[] | null;
/**
 * The route of a cross-link (an edge that isn't a parent → child link in the forest): along the tree path between
 * its ends (bundlePath), as a B-spline pulled towards that path by `strength` (hierarchical edge bundling, Holten
 * 2006). Cross-links that share an ancestor bundle together along the tree instead of cutting across it. Ends in
 * different trees, or a path with nothing between them, go straight.
 * @returns {number[]} flat x, y pairs
 */
export declare function bundledPoints(
  graph: any,
  e: any,
  strength?: number,
): number[];
/** A uniform cubic B-spline through `control`, clamped (the first and last points repeated) so it starts and ends on them. */
export declare function bspline(control: any): any[];
/**
 * The route of edge `e` in `graph`: a cross-link bundles along the tree (unless edges are straight), anything else
 * follows the edge shape.
 */
export declare function edgeRoute(
  graph: any,
  routing: any,
  shape: any,
  e: any,
  junction?: any,
): any[];
/**
 * A layered layout's edge: through its bend points (one per layer it crosses). Bends were placed for the nodes'
 * homes; when the ends move (a drag, physics), the bends move with them, each in proportion to how far along the
 * edge it is. Straight and fan draw a polyline; step and curve repeat the tree's step or curve between each pair.
 */
export declare function layeredPoints(
  routing: any,
  shape: any,
  e: any,
  s: any,
  t: any,
): any[];
/**
 * How far a radial step edge has turned into a curve, 0 (a step round the ring) to 1 (a smooth curve). A step
 * reads as "round the ring" only while its ends sit on their rings, its child is further out than its parent, and
 * its arc doesn't loop round the centre; as a drag or physics breaks one of those, the edge eases into a curve
 * (and back), rather than snapping. Each test passes halfway where the old yes/no rule switched: an end off its ring
 * by a quarter of the gap between the rings, the child level with its parent, an arc 1.75 times the straight
 * distance. While a layout morph runs, nodes travel between rings on purpose: being off a ring doesn't count then.
 * @param {number} rs where the source is, from the centre; `rt` the target; `hs`, `ht` where their layout put them
 * @param {number} arc the step's arc length; `chord` the straight distance between the ends
 */
export declare function stepCurveWeight(
  rs: number,
  rt: any,
  hs: any,
  ht: any,
  arc: number,
  chord: any,
  morphing?: boolean,
): number;
/**
 * Points `pts` (flat x, y) slid `w` of the way towards a cubic from p0 to p3 (controls p1, p2): each point to the
 * curve's point as far along it as the point is along `pts`.
 */
export declare function blendTowardsCubic(
  pts: any,
  p0: any,
  p1: any,
  p2: any,
  p3: any,
  w: any,
): any[];
/**
 * Cut `from` off the start and `to` off the end of a polyline, measured along it. Returns null when the cuts
 * meet (the nodes overlap).
 */
export declare function trim(pts: any, from: any, to: any): any[];
/**
 * Where each edge starts, as a distance from its source's centre (what `trim` cuts off its route's start, and the
 * GPU pieces' first trim): off the node, and past the node's own label when the edge would leave through it (labels
 * below in a top-to-bottom tree or merged tree: every parent's edges), so labels stay clear of their own edges.
 * Worked out from where the layout put the nodes (homes), so it holds while they move: a step or curve leaves
 * along the layout's axis (a radial's spokes), a straight edge towards its first stop. At most 45% of the way to
 * that stop (35% for a fan, whose trunk splits early). Cross-links that bundle along the tree start off the node
 * only (they rarely leave through the label, and the GPU clips them to a disc). Needs `scene.labelWidths` (each
 * real node's label width as the layout kept room for it); without it, every edge starts at its node's radius.
 * @returns {Float64Array} per edge of the scene's graph
 */
export declare function startTrims(scene: any): Float64Array;
