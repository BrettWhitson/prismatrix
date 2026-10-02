/**
 * @param {object} graph the proper layered graph
 * @param {number[][]} graph.layers  starting order: layout nodes per layer, left to right
 * @param {ArrayLike<number>} graph.layer  per layout node, its layer
 * @param {number[][]} graph.upper   per layout node, its neighbours one layer up
 * @param {number[][]} graph.lower   per layout node, its neighbours one layer down
 * @param {ArrayLike<number>} graph.block per layout node, the block it belongs to (0 … blocks - 1)
 * @param {number} graph.blocks
 * @param {{ rounds?: number, work?: number, movable?: ArrayLike<number> | null }} [options] work: stop starting new
 *   blocks after this many steps; movable: per block, nonzero if it may be moved (the others keep their order among
 *   themselves, so a layout that's mostly as it was stays so: see layered.js's hint); all of them when left out
 * @returns {{ layers: number[][], rounds: number, exact: boolean, work: number }} exact: the starting order was
 *   the layers given (so the result has no more crossings than they had); work: the steps it took
 */
export declare function globalSifting(
  {
    layers,
    layer,
    upper,
    lower,
    block,
    blocks,
  }: {
    layers: number[][];
    layer: ArrayLike<number>;
    upper: number[][];
    lower: number[][];
    block: ArrayLike<number>;
    blocks: number;
  },
  {
    rounds,
    work,
    movable,
  }?: {
    rounds?: number;
    work?: number;
    movable?: ArrayLike<number> | null;
  },
): {
  layers: number[][];
  rounds: number;
  exact: boolean;
  work: number;
};
