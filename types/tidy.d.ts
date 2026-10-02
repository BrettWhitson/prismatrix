/**
 * @param {object} tree
 * @param {Int32Array | number[]} tree.parent  parent index per node, -1 for a root
 * @param {number[][]} tree.children           children per node, in the order they're drawn
 * @param {number[]} tree.roots                roots in the order they're drawn
 * @param {ArrayLike<number>} tree.left        how far each node reaches before its centre, along the level (≥ 0)
 * @param {ArrayLike<number>} tree.right       how far it reaches after its centre (≥ 0)
 * @param {object} [gaps]
 * @param {number} [gaps.sibling]  between neighbours with the same parent
 * @param {number} [gaps.cousin]   between neighbours with different parents
 * @param {number} [gaps.root]     between separate trees
 * @param {"centres" | "edges"} [gaps.parent] centre a parent between its first and last child's centres (the
 *   classic rule), or between their outer edges (the whole span the children take up)
 * @returns {{ x: Float64Array, steps: number }} each node's centre along the level, with the trees centred on 0;
 *   `steps` counts contour comparisons, for checking the time is linear
 */
export declare function tidy(
  {
    parent,
    children,
    roots,
    left,
    right,
  }: {
    parent: Int32Array | number[];
    children: number[][];
    roots: number[];
    left: ArrayLike<number>;
    right: ArrayLike<number>;
  },
  {
    sibling,
    cousin,
    root,
    parent: centring,
  }?: {
    sibling?: number;
    cousin?: number;
    root?: number;
    parent?: "centres" | "edges";
  },
): {
  x: Float64Array;
  steps: number;
};
