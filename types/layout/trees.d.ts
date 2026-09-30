/**
 * Seed layouts that treat the graph as a tree: the tidy layered tree and the radial tree (radial layouts
 * and the force engine's first placement). Both write `graph.x` / `graph.y`.
 */
/**
 * The graph as a tree rooted at the root node: breadth-first, each node under the first parent that reaches it
 * (for DAGs; a tree already is one). Parts of the graph the root doesn't reach hang off the root as extra branches
 * (from their own top nodes), so they're placed like everything else instead of piling up where they were. Ghosts
 * (leaving) are left out.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 */
export declare function spanningTree(
  graph: import("./layout-graph.js").LayoutGraph,
): {
  root: number;
  preOrder: any[];
  depthOf: Map<number, number>;
  childrenOf: (i: any) => any;
};
/**
 * Layered tree layout in O(n): each subtree gets a band as wide as its children need, parents centre over their
 * children, and every depth gets its own rank. Crossing
 * minimisation is pointless for trees (they have none), so this replaces the general layered layout for trees.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 * @returns {boolean} false when there's no root to lay out
 */
export declare function tidyTreeLayout(
  graph: import("./layout-graph.js").LayoutGraph,
  {
    direction,
    siblingGap,
    levelGap,
    breadthLabelShare,
    extentLabelShare,
  }: {
    breadthLabelShare?: number;
    direction: any;
    extentLabelShare?: number;
    levelGap: any;
    siblingGap: any;
  },
): boolean;
/** Put node `i` at `along` the flow and `across` it, for a direction naming the flow root → leaves. */
export declare function placeAlong(
  graph: any,
  i: any,
  direction: any,
  along: any,
  across: any,
): void;
/**
 * Radial seed: the root in the centre, depth n on the ring at n × ringStep, and every subtree in an angular wedge
 * proportional to the band it needs (so big branches get more of the circle). The physics then resolves crowding on
 * busy rings by letting them bulge slightly.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 * @returns {{ rootId: string, depthById: Map<string, number> } | null}
 */
export declare function radialTreeLayout(
  graph: import("./layout-graph.js").LayoutGraph,
  {
    siblingGap,
    ringStep,
  }: {
    ringStep: any;
    siblingGap: any;
  },
): {
  rootId: string;
  depthById: Map<string, number>;
} | null;
