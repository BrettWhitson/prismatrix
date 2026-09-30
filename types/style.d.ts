/** Every colour Prismatrix draws with. Pass a partial theme to GraphView (or setTheme) to change any of them. */
export declare const THEME_SCHEMA: Readonly<{
  node: import("./layout/schema.js").Field;
  nodeFill: import("./layout/schema.js").Field;
  edge: import("./layout/schema.js").Field;
  ancestors: import("./layout/schema.js").Field;
  descendants: import("./layout/schema.js").Field;
  highlight: import("./layout/schema.js").Field;
  focus: import("./layout/schema.js").Field;
  selected: import("./layout/schema.js").Field;
  hover: import("./layout/schema.js").Field;
  labelText: import("./layout/schema.js").Field;
  edgeLabelText: import("./layout/schema.js").Field;
  labelBackdrop: import("./layout/schema.js").Field;
  edgeLabelBackdrop: import("./layout/schema.js").Field;
  cardBorder: import("./layout/schema.js").Field;
  cardText: import("./layout/schema.js").Field;
  cardMuted: import("./layout/schema.js").Field;
  portFill: import("./layout/schema.js").Field;
}>;
export type Theme = {
  node: string;
  nodeFill: string;
  edge: string;
  ancestors: string;
  descendants: string;
  highlight: string;
  focus: string;
  selected: string;
  hover: string;
  labelText: string;
  edgeLabelText: string;
  labelBackdrop: string;
  edgeLabelBackdrop: string;
  cardBorder: string;
  cardText: string;
  cardMuted: string;
  portFill: string;
};
/**
 * @typedef {{ node: string, nodeFill: string, edge: string, ancestors: string, descendants: string,
 *             highlight: string, focus: string, selected: string, hover: string, labelText: string,
 *             edgeLabelText: string, labelBackdrop: string, edgeLabelBackdrop: string, cardBorder: string,
 *             cardText: string, cardMuted: string, portFill: string }} Theme
 */
/** @type {Readonly<Theme>} */
export declare const DEFAULT_THEME: Readonly<Theme>;
/** The theme as a list, for settings UIs. */
export declare const THEME_OPTIONS: readonly (import("./layout/schema.js").Field & {
  key: string;
})[];
/** The theme colours the renderer draws interaction and labels with (WebGLGraph's colors). */
export declare const RENDERER_COLOR_KEYS: readonly string[];
/**
 * `patch` checked against the theme schema, on top of `base` (default: the default theme).
 * @param {Partial<Theme>} patch
 * @param {{ base?: Theme, strict?: boolean, warn?: (message: string) => void }} [options]
 * @returns {Theme}
 */
export declare function resolveTheme(
  patch: Partial<Theme>,
  options?: {
    base?: Theme;
    strict?: boolean;
    warn?: (message: string) => void;
  },
): Theme;
export type NodeStyle = {
  /**
   * width and height, before any scaling for hover or drag
   */
  size: number;
  /**
   * a built-in or registered shape
   */
  shape: string;
  fill: string;
  fillAlpha: number;
  border: string;
  borderWidth: number;
  /**
   * stack: a card peeking out behind (there's more inside)
   */
  pattern: "solid" | "dashed" | "dotted" | "stack";
  iconAlpha: number;
  /**
   * a soft glow around the node for a standing state
   */
  aura: string | null;
  /**
   * a thin ring just outside the border
   */
  ring: string | null;
  /**
   * the renderer's badge image in the corner (its badgeUrl)
   */
  badge: boolean;
  label: string;
  fontSize: number;
  bold: boolean;
  /**
   * labels that stay when zoomed out and win label collisions
   */
  labelPriority: number;
  /**
   * false: the pointer passes through (no hover, tap or drag); still drawn and labelled
   */
  events: boolean;
  /**
   * the icon's URL (the node's `icon`)
   */
  icon?: string | null;
  /**
   * from the nodeLook option; a class rule or hook can change it per node
   */
  look: "icon" | "card";
  /**
   * the box (graph units): for icons, `size` unless set; for cards, cardWidth
   */
  width: number;
  height: number;
  /**
   * cards: the colour stripe down the left edge (default: the node's colour)
   */
  stripe: string | null;
  /**
   * cards: the port dot on the leaf side of the flow, or null (default: the node's
   * colour, where the node has children)
   */
  portIn: string | null;
  /**
   * cards: the port dot on the root side, or null (default: the node's colour, where
   * the node has a parent)
   */
  portOut: string | null;
  /**
   * cards: the second line (the node's `subtitle`)
   */
  subtitle: import("./render/card-text.js").RichText;
  /**
   * cards: the third line (the node's `value`)
   */
  value: import("./render/card-text.js").RichText;
  /**
   * cards: a pill on the top edge, top right (the node's `tag`)
   */
  tag: string;
  tagColor: string | null;
  valueColor: string | null;
  /**
   * cards: the icon's size, its inset from the left, the stripe and port sizes, and the
   * subtitle and value font sizes, from the card options
   */
  iconSize: number;
  iconInset: number;
  stripeWidth: number;
  stripeInset: number;
  portSize: number;
  subtitleSize: number;
  valueSize: number;
  cardPadding: number;
};
export type EdgeStyle = {
  color: string;
  width: number;
  alpha: number;
  /**
   * arrows: small chevrons pointing toward `patternToward`
   */
  pattern: "dashed" | "dotted" | "arrows" | null;
  /**
   * which end the "arrows" pattern points to (flowToward)
   */
  patternToward: "target" | "source";
  arrowAtSource: string | null;
  arrowAtTarget: string | null;
  arrowScale: number;
  label: string;
  fontSize: number;
  /**
   * a soft glow under the line (standing emphasis)
   */
  glow: boolean;
};
export type NodeRule = Partial<NodeStyle>;
export type EdgeRule = Partial<EdgeStyle>;
export type ClassRules = {
  nodes?: Record<string, NodeRule>;
  edges?: Record<string, EdgeRule>;
};
/**
 * What each style field may be, for checking class rules, an element's own `style` and the hooks. No defaults: a
 * value that can't be used is left out (the style keeps what it had), and a number out of range is clamped.
 */
export declare const NODE_STYLE_SCHEMA: Readonly<{
  size: import("./layout/schema.js").Field;
  shape: import("./layout/schema.js").Field;
  fill: import("./layout/schema.js").Field;
  fillAlpha: import("./layout/schema.js").Field;
  border: import("./layout/schema.js").Field;
  borderWidth: import("./layout/schema.js").Field;
  pattern: import("./layout/schema.js").Field;
  iconAlpha: import("./layout/schema.js").Field;
  aura: import("./layout/schema.js").Field;
  ring: import("./layout/schema.js").Field;
  badge: import("./layout/schema.js").Field;
  label: import("./layout/schema.js").Field;
  fontSize: import("./layout/schema.js").Field;
  bold: import("./layout/schema.js").Field;
  labelPriority: import("./layout/schema.js").Field;
  events: import("./layout/schema.js").Field;
  icon: import("./layout/schema.js").Field;
  look: import("./layout/schema.js").Field;
  width: import("./layout/schema.js").Field;
  height: import("./layout/schema.js").Field;
  stripe: import("./layout/schema.js").Field;
  portIn: import("./layout/schema.js").Field;
  portOut: import("./layout/schema.js").Field;
  subtitle: import("./layout/schema.js").Field;
  value: import("./layout/schema.js").Field;
  tag: import("./layout/schema.js").Field;
  tagColor: import("./layout/schema.js").Field;
  valueColor: import("./layout/schema.js").Field;
  iconSize: import("./layout/schema.js").Field;
  iconInset: import("./layout/schema.js").Field;
  stripeWidth: import("./layout/schema.js").Field;
  stripeInset: import("./layout/schema.js").Field;
  portSize: import("./layout/schema.js").Field;
  subtitleSize: import("./layout/schema.js").Field;
  valueSize: import("./layout/schema.js").Field;
  cardPadding: import("./layout/schema.js").Field;
}>;
export declare const EDGE_STYLE_SCHEMA: Readonly<{
  color: import("./layout/schema.js").Field;
  width: import("./layout/schema.js").Field;
  alpha: import("./layout/schema.js").Field;
  pattern: import("./layout/schema.js").Field;
  patternToward: import("./layout/schema.js").Field;
  arrowAtSource: import("./layout/schema.js").Field;
  arrowAtTarget: import("./layout/schema.js").Field;
  arrowScale: import("./layout/schema.js").Field;
  label: import("./layout/schema.js").Field;
  fontSize: import("./layout/schema.js").Field;
  glow: import("./layout/schema.js").Field;
}>;
/** "auto" puts labels where the layout leaves room: beside horizontal trees, below everything else. */
export declare function resolveLabelPosition(o: any): any;
/**
 * The renderer's routing: "straight", "taxi", "round-taxi", "s-curve" (bends along the flow), "arc", or a routing
 * added with registerEdgeRouting (passed through as it is). Right angles need a direction, so layouts without one
 * get arcs instead.
 */
export declare function resolveRouting(o: any): any;
/** The axis a directional layout spreads its levels along. */
export declare function resolveFlowAxis(o: any): "x" | "y";
/**
 * @param {Set<string>} classes
 * @param {{ color?: string, label?: string, style?: NodeRule }} data  the node (its `style`: its own overrides)
 * @param {import('./options.js').Options} o
 * @param {Theme} theme
 * @param {ClassRules} [rules]  per class, applied in their own order
 * @returns {NodeStyle}
 */
export declare function resolveNodeStyle(
  classes: Set<string>,
  data: {
    color?: string;
    label?: string;
    style?: NodeRule;
  },
  o: import("./options.js").Options,
  theme: Theme,
  rules?: ClassRules,
): NodeStyle;
/**
 * @param {Set<string>} classes
 * @param {{ label?: string, sourceColor?: string, targetColor?: string, style?: EdgeRule }} data
 * @param {import('./options.js').Options} o
 * @param {Theme} theme
 * @param {ClassRules} [rules]
 * @returns {EdgeStyle}
 */
export declare function resolveEdgeStyle(
  classes: Set<string>,
  data: {
    label?: string;
    sourceColor?: string;
    targetColor?: string;
    style?: EdgeRule;
  },
  o: import("./options.js").Options,
  theme: Theme,
  rules?: ClassRules,
): EdgeStyle;
