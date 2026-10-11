/**
 * With a `hint` (the layout before a change, layout-job.js) and `stability` above 0, a change moves only what it
 * has to (the mental map): the order starts from the old one, with only what's new sifted into place (orderFromHint);
 * every kept node, reference and bend is pulled towards where it was in placement, with a weight that grows with
 * `stability`; and the drawing is moved so that kept nodes move least in all. On the fixtures, adding or removing
 * one leaf moves 0–2% of the other nodes (0–7% at stability 0.25), against 81–100% laid out afresh. With a hint
 * and stability 0, it's laid out afresh and only moved into place.
 *
 * @param {import("./graph.js").Graph} graph
 * @param {{ direction?: string, levelGap?: number, nodeGap?: number, ranking?: string, ordering?: string,
 *   placement?: string, references?: string, shareMin?: number, stability?: number }} [options]
 * @param {import("./layouts.js").Sizing} [sizing]
 * @param {import("./layout-job.js").LayoutHint | null} [hint]
 * @returns {{ kind: "layered", direction: string, bends: Map<object, number[][]>, references: Reference[],
 *   crossings: number, initialCrossings: number, layerOf: Int32Array,
 *   simplex?: { pivots: number, optimal: boolean } }} `simplex` (ranking "simplex" only): how many exchanges the
 *   layering made, and whether it reached the fewest long edges or stopped at its work budget (very big graphs)
 */
export declare function layeredLayout(
  graph: import("./graph.js").Graph,
  options?: {
    direction?: string;
    levelGap?: number;
    nodeGap?: number;
    ranking?: string;
    ordering?: string;
    placement?: string;
    references?: string;
    shareMin?: number;
    stability?: number;
  },
  sizing?: import("./layouts.js").Sizing,
  hint?: import("./layout-job.js").LayoutHint | null,
  collect?: boolean,
): {
  kind: "layered";
  direction: string;
  bends: Map<object, number[][]>;
  references: Reference[];
  crossings: number;
  initialCrossings: number;
  layerOf: Int32Array;
  simplex?: {
    pivots: number;
    optimal: boolean;
  };
};
/**
 * The shift that moves the first `count` positions least in all (L1) towards where they were: the median of
 * `now[v] - was[v]` over those with a `was` (NaN: none). `fallback` when none has.
 */
export declare function medianShift(
  now: any,
  was: any,
  count: any,
  fallback: any,
): any;
export type Reference = {
  /**
   * the edge it stands in for
   */
  edge: import("./graph.js").Edge;
  /**
   * the edge's source (node index)
   */
  source: number;
  /**
   * the ingredient (node index)
   */
  target: number;
  /**
   * where the chip sits
   */
  x: number;
  y: number;
  /**
   * the most the chip should reach from its centre: the room the layout kept for it
   */
  radius: number;
  /**
   * drawn as a whole copy of its ingredient (label, icon and all), not a chip
   */
  copy: boolean;
};
/**
 * Edge crossings between every pair of neighbouring layers, at places `pos` (each node's index on its layer): for
 * each pair, the edges are taken by their upper end, left to right, and each counts the edges before it whose lower
 * end is further right, with a Fenwick tree over the lower layer's places (Barth, Jünger & Mutzel 2002), O(E log V).
 */
export declare function countCrossings(
  layers: any,
  lower: any,
  pos: any,
): number;
/**
 * The exact L1 step on its own (for tests and other callers): positions in order, at least `seps[i]` between
 * neighbours i and i + 1, with the least weighted sum of distances to what each wants. `desired[i]` is one position
 * or a list of them, with `weights[i]` the matching weight or list of weights (positive).
 *
 * @param {(number | number[])[]} desired
 * @param {ArrayLike<number>} seps
 * @param {(number | number[])[]} weights
 * @returns {Float64Array}
 */
export declare function project(
  desired: (number | number[])[],
  seps: ArrayLike<number>,
  weights: (number | number[])[],
): Float64Array;
