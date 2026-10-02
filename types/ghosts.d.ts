export type Ancestry = {
  id: string;
  up: Ancestry | null;
};
export type Ghost = {
  id: string;
  label: string;
  labelAngle: number;
  /**
   * as drawn when it left
   */
  radius: number;
  fill: string;
  shape: string;
  /**
   * where it was when it left
   */
  x0: number;
  y0: number;
  /**
   * its ancestors in the graph it left, from its parent up to its root
   */
  up: Ancestry | null;
  /**
   * how many ancestors it has
   */
  depth: number;
  /**
   * when it left (ms, the view's clock)
   */
  start: number;
};
/**
 * A ghost's ancestors, as a chain shared between ghosts: `id` is one ancestor's, `up` the chain above it (null at
 * the root). A removed subtree's ghosts all share their parents' chains, so making them costs one link each.
 * @typedef {{ id: string, up: Ancestry | null }} Ancestry
 */
/**
 * @typedef {object} Ghost
 * @property {string} id
 * @property {string} label
 * @property {number} labelAngle
 * @property {number} radius     as drawn when it left
 * @property {string} fill
 * @property {string} shape
 * @property {number} x0         where it was when it left
 * @property {number} y0
 * @property {Ancestry | null} up its ancestors in the graph it left, from its parent up to its root
 * @property {number} depth      how many ancestors it has
 * @property {number} start      when it left (ms, the view's clock)
 */
/**
 * The nodes of `previous` that aren't in `next`, as ghosts starting at `now`. `looks` are previous's radius and
 * fill per node. Linear in the nodes that left: each one's ancestry is its parent's with one link added, made once.
 * @returns {Ghost[]}
 */
export declare function departures(
  previous: any,
  next: any,
  looks: any,
  now: any,
): Ghost[];
/**
 * Where a ghost folds to: its nearest ancestor that `graph` still has (a node), or that is itself a ghost still
 * leaving (a ghost id), or nothing (it fades where it is).
 * @returns {{ node: import("./render.js").DisplayNode, ghost?: undefined } | { ghost: string, node?: undefined } | null}
 */
export declare function foldTarget(
  ghost: any,
  graph: any,
  ghostIds: any,
):
  | {
      node: import("./render.js").DisplayNode;
      ghost?: undefined;
    }
  | {
      ghost: string;
      node?: undefined;
    }
  | null;
/**
 * The display graph for a frame: `graph`'s nodes and edges with the ghosts appended (nodes at their current
 * positions, plus an edge from each ghost's parent, real or ghost, where it has one), and the per-node arrays the
 * renderer reads, extended to match. Ghosts past their time are left out.
 * @param {import("./render.js").DisplayGraph} graph the real graph
 * @param {Ghost[]} ghosts
 * @param {Omit<import("./render.js").Shown, "graph">} base for the real graph
 * @param {number} now
 * @param {number} ms      how long a ghost takes to fold away
 * @param {(t: number) => number} ease
 * @returns {import("./render.js").Shown & { live: Ghost[] }}
 */
export declare function withGhosts(
  graph: import("./render.js").DisplayGraph,
  ghosts: Ghost[],
  base: Omit<import("./render.js").Shown, "graph">,
  now: number,
  ms: number,
  ease: (t: number) => number,
): import("./render.js").Shown & {
  live: Ghost[];
};
