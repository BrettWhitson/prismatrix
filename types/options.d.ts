/** @type {Readonly<import('./layout/index.js').Schema>} */
export declare const OPTIONS_SCHEMA: Readonly<
  import("./layout/index.js").Schema
>;
export type Options = import("./layout/index.js").LayoutSettings & {
  nodeLook: "icon" | "card";
  cardWidth: number;
  cardHeight: number;
  cardIconSize: number;
  cardIconInset: number;
  cardPadding: number;
  cardTitleSize: number;
  cardSubtitleSize: number;
  cardValueSize: number;
  cardStripeWidth: number;
  cardStripeInset: number;
  cardPortSize: number;
  cardDetailZoom: number;
  cardConnectors: "dots" | "arrows" | "both";
  nodeSize: number;
  nodeSizeScale: number;
  rootSizeScale: number;
  nodeShape: string;
  tintNodeFill: boolean;
  tintFillAlpha: number;
  nodeBorderWidth: number;
  rootBorderBoost: number;
  showIcons: boolean;
  showLabels: boolean;
  fontSize: number;
  labelFontScale: number;
  rootFontScale: number;
  labelPosition: "auto" | "below" | "above" | "left" | "right";
  labelBackdrop: boolean;
  labelFadeZoom: number;
  labelWidth: number;
  labelWrapScale: number;
  labelOverflow: "wrap" | "ellipsis";
  edgeRouting: string;
  edgeCornerRadius: number;
  edgeCurvature: number;
  edgeWidth: number;
  edgeOpacity: number;
  edgeLineStyle: "solid" | "dashed" | "dotted" | "arrows";
  edgeColorMode: "neutral" | "source" | "target";
  showArrows: boolean;
  arrowShape: string;
  arrowEnd: "target" | "source" | "both";
  arrowScale: number;
  edgeLabels: boolean;
  hoverMode: "both" | "ancestors" | "descendants" | "none";
  hoverDelay: number;
  lineageColor: "theme" | "edge";
  pinSelectionLineage: boolean;
  animateFlow: boolean;
  flowToward: "target" | "source";
  flowSpeed: number;
  dimOpacity: number;
  nodesDraggable: boolean;
  smoothZoom: boolean;
  zoomSpeed: number;
  minZoom: number;
  maxZoom: number;
  maxFitZoom: number;
  fitPadding: number;
  focusPadding: number;
  focusMaxZoom: number;
  smartFitMinZoom: number;
  smartFitMinNodes: number;
  smartFitZoom: number;
  doubleTapMs: number;
  longPressMs: number;
  dragThresholdMouse: number;
  dragThresholdPen: number;
  dragThresholdTouch: number;
  panInertia: number;
  flickMinSpeed: number;
  canvasBackground: string;
  backgroundCellSize: number;
  animationsEnabled: boolean;
  animationDuration: number;
  animationEasing: string;
  growNewGraphs: boolean;
  growStagger: number;
  growMaxDelay: number;
  maxAnimatedNodes: number;
  maxStaggeredNodes: number;
  nodeStyle:
    | ((
        node: import("./graph-view.js").GraphNode,
        style: import("./style.js").NodeStyle,
      ) => Partial<import("./style.js").NodeStyle> | void)
    | null;
  edgeStyle:
    | ((
        edge: import("./graph-view.js").GraphEdge,
        style: import("./style.js").EdgeStyle,
      ) => Partial<import("./style.js").EdgeStyle> | void)
    | null;
};
/**
 * @typedef {import('./layout/index.js').LayoutSettings & {
 *   nodeLook: "icon" | "card", cardWidth: number, cardHeight: number, cardIconSize: number, cardIconInset: number,
 *   cardPadding: number, cardTitleSize: number, cardSubtitleSize: number, cardValueSize: number,
 *   cardStripeWidth: number, cardStripeInset: number, cardPortSize: number, cardDetailZoom: number,
 *   cardConnectors: "dots" | "arrows" | "both",
 *   nodeSize: number, nodeSizeScale: number, rootSizeScale: number, nodeShape: string, tintNodeFill: boolean,
 *   tintFillAlpha: number, nodeBorderWidth: number, rootBorderBoost: number, showIcons: boolean,
 *   showLabels: boolean, fontSize: number, labelFontScale: number, rootFontScale: number,
 *   labelPosition: "auto" | "below" | "above" | "left" | "right", labelBackdrop: boolean, labelFadeZoom: number,
 *   labelWidth: number, labelWrapScale: number, labelOverflow: "wrap" | "ellipsis",
 *   edgeRouting: string, edgeCornerRadius: number, edgeCurvature: number, edgeWidth: number, edgeOpacity: number,
 *   edgeLineStyle: "solid" | "dashed" | "dotted" | "arrows", edgeColorMode: "neutral" | "source" | "target",
 *   showArrows: boolean, arrowShape: string, arrowEnd: "target" | "source" | "both", arrowScale: number,
 *   edgeLabels: boolean,
 *   hoverMode: "both" | "ancestors" | "descendants" | "none", hoverDelay: number, lineageColor: "theme" | "edge", pinSelectionLineage: boolean,
 *   animateFlow: boolean, flowToward: "target" | "source", flowSpeed: number, dimOpacity: number,
 *   nodesDraggable: boolean, smoothZoom: boolean, zoomSpeed: number, minZoom: number, maxZoom: number,
 *   maxFitZoom: number, fitPadding: number, focusPadding: number, focusMaxZoom: number, smartFitMinZoom: number,
 *   smartFitMinNodes: number, smartFitZoom: number, doubleTapMs: number, longPressMs: number,
 *   dragThresholdMouse: number, dragThresholdPen: number, dragThresholdTouch: number, panInertia: number,
 *   flickMinSpeed: number, canvasBackground: string, backgroundCellSize: number,
 *   animationsEnabled: boolean, animationDuration: number, animationEasing: string, growNewGraphs: boolean,
 *   growStagger: number, growMaxDelay: number, maxAnimatedNodes: number, maxStaggeredNodes: number,
 *   nodeStyle: ((node: import('./graph-view.js').GraphNode, style: import('./style.js').NodeStyle) =>
 *     Partial<import('./style.js').NodeStyle> | void) | null,
 *   edgeStyle: ((edge: import('./graph-view.js').GraphEdge, style: import('./style.js').EdgeStyle) =>
 *     Partial<import('./style.js').EdgeStyle> | void) | null,
 * }} Options
 */
/** @type {Readonly<Options>} */
export declare const DEFAULT_OPTIONS: Readonly<Options>;
/** The options as a list, in schema order, for settings UIs: { key, type, default, min, max, step, values, label, group, hint }. */
export declare const OPTIONS: readonly (import("./layout/schema.js").Field & {
  key: string;
})[];
/**
 * `patch` checked against the schema, on top of `base` (default: the defaults).
 * @param {Partial<Options>} patch
 * @param {{ base?: Options, strict?: boolean, warn?: (message: string) => void }} [options]
 * @returns {Options}
 */
export declare function resolveOptions(
  patch: Partial<Options>,
  options?: {
    base?: Options;
    strict?: boolean;
    warn?: (message: string) => void;
  },
): Options;
/**
 * Base sizes in graph units, as of the defaults (nodeSize, fontSize and labelWidth are options now).
 * @deprecated read the options instead
 */
export declare const STYLE_BASE: Readonly<{
  nodeSize: number;
  fontSize: number;
  labelWidth: number;
}>;
