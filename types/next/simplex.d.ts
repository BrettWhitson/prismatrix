/**
 * @param {number} count             nodes 0 … count - 1
 * @param {Int32Array | number[]} tail  per edge, its start
 * @param {Int32Array | number[]} head  per edge, its end
 * @param {ArrayLike<number>} minLength per edge, ≥ 0
 * @param {ArrayLike<number>} weight    per edge, ≥ 0
 * @param {{ work?: number }} [options] work: stop pivoting once about this many nodes and edges
 *   have been visited (every pivot leaves a feasible ranking, so stopping early gives a good one, just not the best)
 * @returns {{ rank: Int32Array, pivots: number, optimal: boolean, work: number }} ranks start at 0; `work` is what
 *   the run used, setup included
 *
 * The edges must form a DAG; nodes in separate components are joined internally, so the graph needn't be connected.
 */
export declare function networkSimplex(
  count: number,
  tail: Int32Array | number[],
  head: Int32Array | number[],
  minLength: ArrayLike<number>,
  weight: ArrayLike<number>,
  {
    work: budget,
  }?: {
    work?: number;
  },
): {
  rank: Int32Array;
  pivots: number;
  optimal: boolean;
  work: number;
};
