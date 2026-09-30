/**
 * Layered (Sugiyama-style) layout for graphs that aren't trees (DAGs, where shared nodes have
 * several parents, and graphs with cycles). In five steps:
 *
 *  1. cycles: edges that close a cycle (found depth-first from the root) are treated as reversed;
 *  2. ranks: every edge goes down at least one rank, and each node sits between its parents and children so edges
 *     stay short (a local optimum of the total edge length, like network simplex);
 *  3. long edges get a chain of dummy nodes, one per rank they cross, so they can bend around nodes;
 *  4. order within each rank: barycentre sweeps down and up, keeping the order with the fewest crossings, then
 *     swapping neighbours while that removes crossings. The starting order is the graph's own (depth-first,
 *     children in edge order), so the caller's child order carries over;
 *  5. coordinates: each rank is placed as close as possible to the median of its neighbours on the rank just placed,
 *     keeping every pair at least its separation apart. Each placement is an exact weighted isotonic regression (pool
 *     adjacent violators); dummies weigh more, so long edges run straight.
 *
 * Deterministic: ties are broken by index.
 *
 * @param {import('./layout-graph.js').LayoutGraph} graph  positions are written to graph.x / graph.y
 * @param {{ direction: 'TB'|'BT'|'LR'|'RL', nodeSep: number, rankSep: number, edgeSep?: number,
 *           sweeps?: number, transposePasses?: number, alignRounds?: number, rankPasses?: number,
 *           longEdgeWeight?: number,
 *           widthLabelShare?: number, heightLabelShare?: number }} options
 *   direction: root → leaves
 * @returns {{ ranks: number[][], crossings: number }} for tests and diagnostics (dummies included, as indexes ≥ count)
 */
export declare function layeredLayout(
  graph: import("./layout-graph.js").LayoutGraph,
  {
    direction,
    nodeSep,
    rankSep,
    edgeSep,
    sweeps,
    transposePasses,
    alignRounds,
    rankPasses,
    longEdgeWeight,
    widthLabelShare,
    heightLabelShare,
  }: {
    direction: "TB" | "BT" | "LR" | "RL";
    nodeSep: number;
    rankSep: number;
    edgeSep?: number;
    sweeps?: number;
    transposePasses?: number;
    alignRounds?: number;
    rankPasses?: number;
    longEdgeWeight?: number;
    widthLabelShare?: number;
    heightLabelShare?: number;
  },
): {
  ranks: number[][];
  crossings: number;
};
/** Crossings between every pair of neighbouring ranks, counted with a Fenwick tree (O(E log V) per pair). */
export declare function countCrossings(
  ranks: any,
  down: any,
  position: any,
): number;
