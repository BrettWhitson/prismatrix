// Layout without a screen: the engine's layouts on their own, for a worker, a build step or a tool. No renderer, no
// controller and nothing that needs a DOM: a graph in, every node's home out. It runs the same code a controller
// runs (on its own thread or in its layout worker), sized the same way, so the homes are the ones a view would show.
//
//   import { layoutGraph } from "prismatrix/layout";
//   const { positions } = layoutGraph(json, { layout: "merged" });
//   positions.get("mjolnir"); // { x, y }

import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { LAYOUTS } from "./layouts.js";
import { looksOf } from "./render.js";
import { resolve } from "./schema.js";
import { runLayout, sizingSpec } from "./layout-job.js";

export { GraphModel, GRAPH_FORMAT, GRAPH_VERSION } from "./model.js";
export { LAYOUTS } from "./layouts.js";
export { NODE_OPTIONS, EDGE_OPTIONS } from "./style.js";
export { resolve } from "./schema.js";

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
export function layoutGraph(
  input,
  { layout = "tree", layoutOptions, node, measure } = {},
) {
  const spec = LAYOUTS[layout];
  if (!spec) throw new Error(`Unknown layout "${layout}"`);
  const model = GraphModel.from(input, { node, measure });
  const graph = new Graph(model);
  const looks = looksOf(graph, model.opts.node, model.opts.edge);
  const result = runLayout(
    graph,
    layout,
    resolve(spec.options, layoutOptions),
    sizingSpec(graph, model, looks),
  );
  const positions = new Map();
  for (let i = 0; i < graph.nodes.length; i++)
    positions.set(graph.nodes[i].id, {
      x: result.homeX[i],
      y: result.homeY[i],
    });
  return { positions, routing: result.routing, model };
}
