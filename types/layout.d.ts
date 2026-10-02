import { GraphModel } from "./model.js";
export { GraphModel, GRAPH_FORMAT, GRAPH_VERSION } from "./model.js";
export { LAYOUTS } from "./layouts.js";
export { NODE_OPTIONS, EDGE_OPTIONS } from "./style.js";
export { resolve } from "./schema.js";
export type LayoutGraphOptions = {
  /**
   * "tree" (the default), "merged" or "radial"
   */
  layout?: import("./controller.js").LayoutName;
  /**
   * the layout's options, all or some
   */
  layoutOptions?: import("./layouts.js").LayoutOptions;
  /**
   * node options, for JSON input (a model brings its own):
   * sizes, shapes and labels decide how much room each node takes
   */
  node?: Partial<import("./style.js").NodeOptions>;
  /**
   * a label's width at a font size, for JSON input
   * (default: an estimate, about right for a sans-serif face)
   */
  measure?: (text: string, size: number) => number;
};
export type LayoutResult = {
  /**
   * every node's home, by id (world px)
   */
  positions: Map<
    string,
    {
      x: number;
      y: number;
    }
  >;
  /**
   * how edges bend: `kind` ("tree", "radial" or "layered"), the tree's
   * `direction` or the radial's centre (`cx`, `cy`), and for the merged tree `bends` (`{ edges, start, xy }`: edge
   * `edges[k]`'s bends are points `start[k]` to `start[k + 1] - 1` of `xy`, x and y in turn) and `references`
   * (`{ edge, source, target, x, y, radius }`), edges by their index in the model's `edges` and nodes by theirs in
   * its `nodes`
   */
  routing: Record<string, any>;
  /**
   * the model laid out
   */
  model: GraphModel;
};
/**
 * @typedef {object} LayoutGraphOptions
 * @property {import("./controller.js").LayoutName} [layout] "tree" (the default), "merged" or "radial"
 * @property {import("./layouts.js").LayoutOptions} [layoutOptions] the layout's options, all or some
 * @property {Partial<import("./style.js").NodeOptions>} [node] node options, for JSON input (a model brings its own):
 *   sizes, shapes and labels decide how much room each node takes
 * @property {(text: string, size: number) => number} [measure] a label's width at a font size, for JSON input
 *   (default: an estimate, about right for a sans-serif face)
 *
 * @typedef {object} LayoutResult
 * @property {Map<string, { x: number, y: number }>} positions every node's home, by id (world px)
 * @property {Record<string, any>} routing how edges bend: `kind` ("tree", "radial" or "layered"), the tree's
 *   `direction` or the radial's centre (`cx`, `cy`), and for the merged tree `bends` (`{ edges, start, xy }`: edge
 *   `edges[k]`'s bends are points `start[k]` to `start[k + 1] - 1` of `xy`, x and y in turn) and `references`
 *   (`{ edge, source, target, x, y, radius }`), edges by their index in the model's `edges` and nodes by theirs in
 *   its `nodes`
 * @property {GraphModel} model the model laid out
 */
/**
 * Lay out a graph (prismatrix-graph JSON, or a model) with one of the layouts.
 * @param {import("./model.js").GraphJSON | GraphModel} input
 * @param {LayoutGraphOptions} [options]
 * @returns {LayoutResult}
 */
export declare function layoutGraph(
  input: import("./model.js").GraphJSON | GraphModel,
  { layout, layoutOptions, node, measure }?: LayoutGraphOptions,
): LayoutResult;
