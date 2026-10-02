import { GraphModel } from "./model.js";
import { Matrix } from "./matrix.js";
/** A node of the working graph: its model record, its place in the forest, and its row of the matrix. */
export declare class Node {
  /** The model's record (frozen): id, label, style, data. */
  record: any;
  /** Position in graph.nodes, and the node's row in the matrix. */
  index: any;
  matrix: any;
  /** Index of the parent in the forest, or -1 for a root. */
  parent: any;
  /** @type {number[]} indices of the children in the forest */
  children: number[];
  depth: any;
  /** Leaves in its subtree (1 for a leaf). */
  leaves: any;
  /** Nodes in its subtree, not counting itself. */
  descendants: any;
  constructor(record: any, index: any, matrix: any, forest: any);
  get id(): any;
  get label(): any;
  get style(): any;
  get data(): any;
  get x(): any;
  set x(v: any);
  get y(): any;
  set y(v: any);
  get vx(): any;
  set vx(v: any);
  get vy(): any;
  set vy(v: any);
  get homeX(): any;
  set homeX(v: any);
  get homeY(): any;
  set homeY(v: any);
  get labelAngle(): any;
  set labelAngle(v: any);
  get radius(): any;
  set radius(v: any);
  /** Its footprint relative to its centre: { x0, y0, x1, y1 } (a copy; set a new one to change it). */
  get box(): {
    x0: any;
    y0: any;
    x1: any;
    y1: any;
  };
  set box(b: { x0: any; y0: any; x1: any; y1: any });
  /** A plain copy, for the console and logs. */
  toJSON(): {
    id: any;
    label: any;
    index: any;
    x: any;
    y: any;
    vx: any;
    vy: any;
    homeX: any;
    homeY: any;
    depth: any;
    parent: any;
  };
}
export type Edge = {
  /**
   * the model edge's id
   */
  id: string;
  /**
   * index of the source node
   */
  source: number;
  /**
   * index of the target node
   */
  target: number;
  /**
   * true when this edge is the target's parent link in the forest
   */
  tree: boolean;
  /**
   * the model edge's label ("" for none)
   */
  label: string;
  /**
   * the model edge's style overrides (frozen)
   */
  style: object;
  /**
   * the model edge's data (frozen)
   */
  data: object;
};
export type Part = {
  /**
   * model node indices, ascending
   */
  nodes: Int32Array;
  /**
   * model edge indices, ascending (both ends shown)
   */
  edges: Int32Array;
  /**
   * names this part of this structure: a graph built for it is current while it's the same
   */
  key: string;
};
/**
 * @typedef {object} Edge
 * @property {string} id     the model edge's id
 * @property {number} source index of the source node
 * @property {number} target index of the target node
 * @property {boolean} tree  true when this edge is the target's parent link in the forest
 * @property {string} label  the model edge's label ("" for none)
 * @property {object} style  the model edge's style overrides (frozen)
 * @property {object} data   the model edge's data (frozen)
 */
/**
 * @typedef {object} Part the part of a model a working graph shows (disclosure.js): the rest is folded away
 * @property {Int32Array} nodes  model node indices, ascending
 * @property {Int32Array} edges  model edge indices, ascending (both ends shown)
 * @property {string} key        names this part of this structure: a graph built for it is current while it's the same
 */
export declare class Graph {
  /** @type {GraphModel} */
  model: GraphModel;
  /** The part of the model shown, or null for all of it. */
  part: Part;
  /**
   * What this graph was built for: the model's structure version, or (showing part of it) the part's key. A
   * graph is current while that's unchanged.
   * @type {number | string}
   */
  structure: number | string;
  /** @type {Int32Array | null} per model node, its index here (-1: not shown); null when every node is */
  local: Int32Array | null;
  /** @type {Int32Array | null} per model edge, its index here (-1: not shown); null when every edge is */
  localEdges: Int32Array | null;
  /** Every node's live state, one column per quantity. */
  matrix: Matrix;
  /** @type {Node[]} */
  nodes: Node[];
  /** @type {Map<string, Node>} */
  byId: Map<string, Node>;
  /** @type {Edge[]} */
  edges: Edge[];
  /** @type {ReadonlyArray<ReadonlyArray<number>>} per node, the indices of the edges out of it and into it */
  outgoing: ReadonlyArray<ReadonlyArray<number>>;
  incoming: any;
  /** @type {number[]} roots of the forest, in the order they were found */
  roots: number[];
  /** @type {number[]} every node, parents before children (breadth first per root) */
  order: number[];
  maxDepth: any;
  /**
   * @param {GraphModel | { id: string | number, label?: string, data?: object }[]} [nodes] a model, or nodes
   * @param {{ source: string | number, target: string | number, id?: string, data?: object }[] | null} [edges]
   * @param {Part | null} [part] with a model: show only this part of it (null: all of it)
   */
  constructor(
    nodes?:
      | GraphModel
      | {
          id: string | number;
          label?: string;
          data?: object;
        }[],
    edges?:
      | {
          source: string | number;
          target: string | number;
          id?: string;
          data?: object;
        }[]
      | null,
    part?: Part | null,
  );
  /** Model node `i`'s index in this graph, or -1 when it isn't shown. */
  indexOf(i: any): any;
  /** Model edge `i`'s index in this graph, or -1 when it isn't shown. */
  edgeIndexOf(i: any): any;
  /** A per-model-node array (label widths, say) as one per node of this graph. */
  pick(values: any): any;
  /**
   * Take the model's current records (labels, styles, data) after a change that kept the structure: same nodes and
   * edges in the same order, so rows and indices still line up.
   */
  refresh(): void;
  /** The bounding box of the live positions, or of the homes. */
  bounds(homes?: boolean): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}
