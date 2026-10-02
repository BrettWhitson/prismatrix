export type Disclosure = {
  /**
   * per model node, 1 when it's shown
   */
  shown: Uint8Array;
  /**
   * per model node, 1 when it's collapsed (and has edges out)
   */
  folded: Uint8Array;
  /**
   * the shown nodes' model indices, ascending (null when everything is shown)
   */
  nodes: Int32Array | null;
  /**
   * the shown edges' model indices, ascending: those from a shown node that isn't
   * collapsed (null when every edge is shown)
   */
  edges: Int32Array | null;
  /**
   * everything is shown (nothing collapsed, or nothing collapsed hides anything)
   */
  all: boolean;
};
/**
 * @typedef {object} Disclosure what a view shows of a model
 * @property {Uint8Array} shown   per model node, 1 when it's shown
 * @property {Uint8Array} folded  per model node, 1 when it's collapsed (and has edges out)
 * @property {Int32Array | null} nodes the shown nodes' model indices, ascending (null when everything is shown)
 * @property {Int32Array | null} edges the shown edges' model indices, ascending: those from a shown node that isn't
 *   collapsed (null when every edge is shown)
 * @property {boolean} all        everything is shown (nothing collapsed, or nothing collapsed hides anything)
 */
/**
 * What a view of `model` shows with the nodes in `collapsed` collapsed. Breadth first from the roots, never past a
 * collapsed node: linear in the model's size.
 * @param {import("./model.js").GraphModel} model
 * @param {Iterable<string>} collapsed ids (ones the model doesn't have, or that have no edges out, are ignored)
 * @returns {Disclosure}
 */
export declare function disclose(
  model: import("./model.js").GraphModel,
  collapsed: Iterable<string>,
): Disclosure;
/**
 * Per model node, how many nodes are hidden below it: for a shown, collapsed node, the hidden nodes it leads to
 * through hidden nodes only (what a "+N" badge counts); 0 for every other node. A hidden node below two collapsed
 * nodes counts for both. Costs the size of each collapsed node's hidden region: linear for trees, more where many
 * collapsed nodes share one big hidden region.
 * @param {import("./model.js").GraphModel} model
 * @param {Disclosure} disclosure
 * @returns {Int32Array}
 */
export declare function hiddenBelow(
  model: import("./model.js").GraphModel,
  { shown, folded }: Disclosure,
): Int32Array;
/**
 * Each model node's depth: edges from the nearest of `from` (default: the roots), following every edge out; -1 where
 * none of them leads.
 * @param {import("./model.js").GraphModel} model
 * @param {number[]} [from] model indices
 * @param {number} [limit] stop looking past this depth (nodes deeper are left at -1)
 * @returns {Int32Array}
 */
export declare function depths(
  model: import("./model.js").GraphModel,
  from?: number[],
  limit?: number,
): Int32Array;
/**
 * The collapsed ids that show `levels` levels below the roots (0: just the roots) and nothing deeper: every node at
 * that depth with an edge to a deeper node.
 * @param {import("./model.js").GraphModel} model
 * @param {number} levels
 * @returns {Set<string>}
 */
export declare function collapsedAt(
  model: import("./model.js").GraphModel,
  levels: number,
): Set<string>;
/**
 * The collapsed ids after expanding model node `index` to show `levels` levels below it: it and every node fewer
 * than `levels` edges below it are expanded, and nodes exactly `levels` below that were hidden are collapsed if they
 * lead on to more hidden nodes, so expanding one node never spills its whole subtree. Nodes shown elsewhere are
 * left as they are. `levels` Infinity expands everything below.
 * @param {import("./model.js").GraphModel} model
 * @param {Set<string>} collapsed the collapsed ids now
 * @param {number} index
 * @param {number} levels at least 1
 * @param {Uint8Array} shown  per model node, shown now (disclose)
 * @returns {Set<string>}
 */
export declare function expandedTo(
  model: import("./model.js").GraphModel,
  collapsed: Set<string>,
  index: number,
  levels: number,
  shown: Uint8Array,
): Set<string>;
/**
 * The collapsed ids after revealing model node `index`: the collapsed nodes on its path from a root (the model's
 * forest path) and every node below them on that path are expanded, and whatever else that brings into view is
 * collapsed if it leads on to more hidden nodes (so only the path opens). Null when it's shown already. Costs the
 * path and its nodes' edges.
 * @param {import("./model.js").GraphModel} model
 * @param {Set<string>} collapsed
 * @param {number} index
 * @param {Disclosure} disclosure
 * @returns {Set<string> | null}
 */
export declare function revealed(
  model: import("./model.js").GraphModel,
  collapsed: Set<string>,
  index: number,
  { shown, folded }: Disclosure,
): Set<string> | null;
