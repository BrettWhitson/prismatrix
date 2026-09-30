/**
 * Prismatrix's public API. Everything an app needs is exported from here; the modules behind it (prism/<module>.js) stay
 * importable for tools that want one piece, but only this entry point is the stable interface.
 *
 * Layout and physics are Prismatrix's: its whole API is re-exported too (registerLayout, registerForce, the tuning…),
 * so an app needs only this one import.
 */
export { GraphView } from "./graph-view.js";
export {
  OPTIONS_SCHEMA,
  OPTIONS,
  DEFAULT_OPTIONS,
  resolveOptions,
  STYLE_BASE,
} from "./options.js";
export {
  THEME_SCHEMA,
  THEME_OPTIONS,
  DEFAULT_THEME,
  resolveTheme,
  NODE_STYLE_SCHEMA,
  EDGE_STYLE_SCHEMA,
  resolveNodeStyle,
  resolveEdgeStyle,
} from "./style.js";
export {
  registerNodeShape,
  registerArrowShape,
  registerEdgeRouting,
  registerEasing,
  nodeShapeNames,
  edgeRoutingNames,
  easingNames,
  MAX_POLYGON_VERTICES,
} from "./render/plugins.js";
export {
  WebGLGraph,
  DEFAULT_COLORS,
  DEFAULT_INPUT,
} from "./render/webgl-graph.js";
export * from "./layout/index.js";
export type Options = import("./options.js").Options;
export type Theme = import("./style.js").Theme;
export type NodeStyle = import("./style.js").NodeStyle;
export type EdgeStyle = import("./style.js").EdgeStyle;
export type ClassRules = import("./style.js").ClassRules;
export type GraphNode = import("./graph-view.js").GraphNode;
export type GraphEdge = import("./graph-view.js").GraphEdge;
export type Viewport = import("./graph-view.js").Viewport;
export type GraphViewEvents = import("./graph-view.js").GraphViewEvents;
export type EdgeRouter = import("./render/plugins.js").EdgeRouter;
/**
 * @typedef {import('./options.js').Options} Options
 * @typedef {import('./style.js').Theme} Theme
 * @typedef {import('./style.js').NodeStyle} NodeStyle
 * @typedef {import('./style.js').EdgeStyle} EdgeStyle
 * @typedef {import('./style.js').ClassRules} ClassRules
 * @typedef {import('./graph-view.js').GraphNode} GraphNode
 * @typedef {import('./graph-view.js').GraphEdge} GraphEdge
 * @typedef {import('./graph-view.js').Viewport} Viewport
 * @typedef {import('./graph-view.js').GraphViewEvents} GraphViewEvents
 * @typedef {import('./render/plugins.js').EdgeRouter} EdgeRouter
 */
