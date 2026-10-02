import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
export type SizingSpec = {
  /**
   * each node's label width (0 when labels don't take room)
   */
  widths: Float64Array;
  /**
   * how far each node's shape reaches from its centre
   */
  reach: Float64Array;
  /**
   * a label's height
   */
  height: number;
  /**
   * extra clearance between nodes
   */
  gap: number;
  /**
   * the node option: "off", "below", "right" or "outward"
   */
  labels: string;
  /**
   * whether labels take room (label collision on): without it, they may overlap
   */
  collide: boolean;
};
export type LayoutHint = {
  /**
   * previous home, x (NaN: a new node)
   */
  x: Float64Array;
  /**
   * previous home, y
   */
  y: Float64Array;
  /**
   * per edge, where its reference chip was, if it ended at one (merged tree)
   */
  refX?: Float64Array;
  refY?: Float64Array;
  /**
   * per edge, where its bends start in `bendXY` (edges + 1 entries: edge i's bends
   * are points bendStart[i] to bendStart[i + 1] - 1), in the edge's own direction
   */
  bendStart?: Int32Array;
  /**
   * bends, x and y in turn
   */
  bendXY?: Float64Array;
};
/**
 * @typedef {object} SizingSpec
 * @property {Float64Array} widths  each node's label width (0 when labels don't take room)
 * @property {Float64Array} reach   how far each node's shape reaches from its centre
 * @property {number} height        a label's height
 * @property {number} gap           extra clearance between nodes
 * @property {string} labels        the node option: "off", "below", "right" or "outward"
 * @property {boolean} collide      whether labels take room (label collision on): without it, they may overlap
 */
/**
 * @typedef {object} LayoutHint Where everything was in the layout before a change, so the new layout can keep its
 *   place: a layout keeps the old order where it can, pulls kept nodes towards their old homes and moves the whole
 *   drawing so they stay put. Per node and per edge of the graph being laid out (by index); NaN where there's no
 *   old place (a new node, an edge that had no reference). Plain typed arrays, made for each layout: they cross to a
 *   worker as cheaply as the sizing spec.
 * @property {Float64Array} x previous home, x (NaN: a new node)
 * @property {Float64Array} y previous home, y
 * @property {Float64Array} [refX] per edge, where its reference chip was, if it ended at one (merged tree)
 * @property {Float64Array} [refY]
 * @property {Int32Array} [bendStart] per edge, where its bends start in `bendXY` (edges + 1 entries: edge i's bends
 *   are points bendStart[i] to bendStart[i + 1] - 1), in the edge's own direction
 * @property {Float64Array} [bendXY] bends, x and y in turn
 */
/**
 * The hint for laying out `graph` after `previous` (both working graphs, with homes), found by id: each node's
 * home in `previous`, and with `routing` (previous's routing, edges by object) each edge's reference chip and
 * bends. Null when no node is kept (nothing to keep in place).
 * @param {import("./graph.js").Graph} previous
 * @param {import("./graph.js").Graph} graph
 * @param {import("./layouts.js").Routing | null} [routing]
 * @returns {LayoutHint | null}
 */
export declare function hintFrom(
  previous: import("./graph.js").Graph,
  graph: import("./graph.js").Graph,
  routing?: import("./layouts.js").Routing | null,
): LayoutHint | null;
/**
 * Whether `hint` fits a graph of `nodes` nodes and `edges` edges (one entry each, edge parts optional) and keeps at
 * least one node. A layout is given a hint only when it does.
 */
export declare function usableHint(hint: any, nodes: any, edges: any): boolean;
/**
 * What a layout needs to know about sizes, for working graph `graph` of `model`: each node's label width (the
 * model's, measured once each) and how far its shape reaches (from `looks`, render.js's looksOf), and the label
 * settings (the model's node options) that turn those into footprints.
 * @param {Graph} graph
 * @param {GraphModel} model
 * @param {{ radius: Float64Array, shape: string[] }} looks per node of `graph`
 * @returns {SizingSpec}
 */
export declare function sizingSpec(
  graph: Graph,
  model: GraphModel,
  looks: {
    radius: Float64Array;
    shape: string[];
  },
): SizingSpec;
/** A layout's sizing (see layouts.js) from a spec: label widths, and each node's footprint for a label direction. */
export declare function sizingFrom({
  widths,
  reach,
  height,
  gap,
  labels,
  collide,
}: {
  collide: any;
  gap: any;
  height: any;
  labels: any;
  reach: any;
  widths: any;
}): {
  widths: any;
  height: any;
  gap: any;
  box: (
    i: any,
    angle: any,
  ) => {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
};
/**
 * The structure of a working graph, for a worker: node count and edge ends, as typed arrays. The arrays are new
 * each time and nothing else holds them, so they can be moved (transferred) to the worker rather than copied.
 */
export declare function structureOf(graph: any): {
  count: any;
  from: Int32Array<ArrayBuffer>;
  to: Int32Array<ArrayBuffer>;
};
/** A working graph with just a structure: nodes by index, edges in the same order (so indices line up). */
export declare function graphFromStructure({
  count,
  from,
  to,
}: {
  count: any;
  from: any;
  to: any;
}): Graph;
/**
 * Lay `graph` out with layout `name`: every node's home, and the routing, packed for the trip back from a worker
 * (bends and references refer to edges by index). With a `hint` (the previous layout's homes), the layout keeps
 * kept nodes near where they were.
 * @param {import("./graph.js").Graph} graph
 * @param {string} name
 * @param {object} options
 * @param {SizingSpec} spec
 * @param {LayoutHint | null} [hint]
 */
export declare function runLayout(
  graph: import("./graph.js").Graph,
  name: string,
  options: object,
  spec: SizingSpec,
  hint?: LayoutHint | null,
): {
  homeX: Float64Array<ArrayBuffer>;
  homeY: Float64Array<ArrayBuffer>;
  routing: any;
};
/** A routing with its edge-keyed parts (bends, references) by edge index. */
export declare function packRouting(routing: any, graph: any): any;
/** The routing again, its bends and references keyed by `graph`'s own edge objects. */
export declare function unpackRouting(packed: any, graph: any): any;
