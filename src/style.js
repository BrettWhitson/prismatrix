import { isRichText } from "./render/card-text.js";
import {
  checkField,
  defaultsOf,
  describeSchema,
  flowOf,
  resolve,
} from "./layout/index.js";

/**
 * Prismatrix's look: an element's classes + data + the options + the theme → the plain values the renderer draws. States
 * read as an aura, a ring, a badge or a card stack; interaction states (hover, selection, lineage, highlights) aren't
 * here at all: the renderer animates those itself. Pure: no DOM.
 *
 * Two classes are built in: "root" (bigger, bold, its label wins) and "collapsed" (a card stack: there's more
 * inside). Every other class means whatever the caller's rules say (GraphView.setClassStyles).
 *
 * The order, each step able to change any style field: options and theme → built-in classes → class rules (in
 * their own order) → the node's or edge's own `style` → the nodeStyle / edgeStyle hook (options).
 */

/** @returns {import('./layout/index.js').Field} */
const color = (label, value, hint) => ({
  type: "color",
  group: "Theme",
  label,
  default: value,
  hint,
});

/** Every colour Prismatrix draws with. Pass a partial theme to GraphView (or setTheme) to change any of them. */
export const THEME_SCHEMA = Object.freeze({
  node: color(
    "Node",
    "#8a93a6",
    "A node's colour (border, tint) when its data has none.",
  ),
  nodeFill: color(
    "Node fill",
    "#1a2030",
    "Inside nodes (unless tintNodeFill).",
  ),
  edge: color("Edge", "#3b4558", "Edges (edgeColorMode: neutral)."),
  ancestors: color(
    "Ancestors",
    "#d6a74a",
    "Lit edges toward the root, on hover or selection.",
  ),
  descendants: color("Descendants", "#62a4da", "Lit edges away from the root."),
  highlight: color("Highlight", "#ffd166", "setHighlightedNodes() glow."),
  focus: color("Focus", "#62a4da", "flash() glow."),
  selected: color("Selected", "#f0c46a", "The selected node's glow."),
  hover: color("Hover", "#cfd8ea", "The hovered node's glow."),
  labelText: color("Label text", "#e3e6ec", "Node labels."),
  edgeLabelText: color("Edge label text", "#8a93a6", "Edge labels."),
  labelBackdrop: color(
    "Label backdrop",
    "rgba(11, 14, 20, 0.8)",
    "Behind node labels (labelBackdrop).",
  ),
  edgeLabelBackdrop: color(
    "Edge label backdrop",
    "rgba(13, 16, 23, 0.9)",
    "Behind edge labels.",
  ),
  cardBorder: color(
    "Card border",
    "#2a3242",
    "Card outlines (the node's colour goes to its stripe).",
  ),
  cardText: color("Card text", "#e3e6ec", "A card's title and value."),
  cardMuted: color("Card muted text", "#8a93a6", "A card's subtitle."),
  portFill: color(
    "Port fill",
    "#0d1017",
    "Inside the port dots, and behind a card's tag.",
  ),
});

/**
 * @typedef {{ node: string, nodeFill: string, edge: string, ancestors: string, descendants: string,
 *             highlight: string, focus: string, selected: string, hover: string, labelText: string,
 *             edgeLabelText: string, labelBackdrop: string, edgeLabelBackdrop: string, cardBorder: string,
 *             cardText: string, cardMuted: string, portFill: string }} Theme
 */

/** @type {Readonly<Theme>} */
export const DEFAULT_THEME = Object.freeze(defaultsOf(THEME_SCHEMA));

/** The theme as a list, for settings UIs. */
export const THEME_OPTIONS = Object.freeze(describeSchema(THEME_SCHEMA));

/** The theme colours the renderer draws interaction and labels with (WebGLGraph's colors). */
export const RENDERER_COLOR_KEYS = Object.freeze([
  "selected",
  "hover",
  "labelText",
  "edgeLabelText",
  "labelBackdrop",
  "edgeLabelBackdrop",
  "cardText",
  "cardMuted",
  "portFill",
]);

/**
 * `patch` checked against the theme schema, on top of `base` (default: the default theme).
 * @param {Partial<Theme>} patch
 * @param {{ base?: Theme, strict?: boolean, warn?: (message: string) => void }} [options]
 * @returns {Theme}
 */
export function resolveTheme(patch, options = {}) {
  return resolve(THEME_SCHEMA, patch, {
    scope: "Prismatrix theme",
    ...options,
  });
}

/**
 * What the renderer draws for a node. Class rules, a node's `style` and the nodeStyle hook can set any of it.
 * @typedef {object} NodeStyle
 * @property {number} size  width and height, before any scaling for hover or drag
 * @property {string} shape  a built-in or registered shape
 * @property {string} fill
 * @property {number} fillAlpha
 * @property {string} border
 * @property {number} borderWidth
 * @property {"solid" | "dashed" | "dotted" | "stack"} pattern  stack: a card peeking out behind (there's more inside)
 * @property {number} iconAlpha
 * @property {string | null} aura  a soft glow around the node for a standing state
 * @property {string | null} ring  a thin ring just outside the border
 * @property {boolean} badge  the renderer's badge image in the corner (its badgeUrl)
 * @property {string} label
 * @property {number} fontSize
 * @property {boolean} bold
 * @property {number} labelPriority  labels that stay when zoomed out and win label collisions
 * @property {boolean} events  false: the pointer passes through (no hover, tap or drag); still drawn and labelled
 * @property {string | null} [icon]  the icon's URL (the node's `icon`)
 * @property {"icon" | "card"} look  from the nodeLook option; a class rule or hook can change it per node
 * @property {number} width  the box (graph units): for icons, `size` unless set; for cards, cardWidth
 * @property {number} height
 * @property {string | null} stripe  cards: the colour stripe down the left edge (default: the node's colour)
 * @property {string | null} portIn  cards: the port dot on the leaf side of the flow, or null (default: the node's
 *   colour, where the node has children)
 * @property {string | null} portOut  cards: the port dot on the root side, or null (default: the node's colour, where
 *   the node has a parent)
 * @property {import('./render/card-text.js').RichText} subtitle  cards: the second line (the node's `subtitle`)
 * @property {import('./render/card-text.js').RichText} value  cards: the third line (the node's `value`)
 * @property {string} tag  cards: a pill on the top edge, top right (the node's `tag`)
 * @property {string | null} tagColor
 * @property {string | null} valueColor
 * @property {number} iconSize  cards: the icon's size, its inset from the left, the stripe and port sizes, and the
 *   subtitle and value font sizes, from the card options
 * @property {number} iconInset
 * @property {number} stripeWidth
 * @property {number} stripeInset
 * @property {number} portSize
 * @property {number} subtitleSize
 * @property {number} valueSize
 * @property {number} cardPadding
 */

/**
 * What the renderer draws for an edge.
 * @typedef {object} EdgeStyle
 * @property {string} color
 * @property {number} width
 * @property {number} alpha
 * @property {"dashed" | "dotted" | "arrows" | null} pattern  arrows: small chevrons pointing toward `patternToward`
 * @property {"target" | "source"} patternToward  which end the "arrows" pattern points to (flowToward)
 * @property {string | null} arrowAtSource
 * @property {string | null} arrowAtTarget
 * @property {number} arrowScale
 * @property {string} label
 * @property {number} fontSize
 * @property {boolean} glow  a soft glow under the line (standing emphasis)
 */

/**
 * @typedef {Partial<NodeStyle>} NodeRule
 * @typedef {Partial<EdgeStyle>} EdgeRule
 * @typedef {{ nodes?: Record<string, NodeRule>, edges?: Record<string, EdgeRule> }} ClassRules
 */

/** @returns {import('./layout/index.js').Field} */
const field = (type, extra = {}) => ({ type, default: undefined, ...extra });

/**
 * What each style field may be, for checking class rules, an element's own `style` and the hooks. No defaults: a
 * value that can't be used is left out (the style keeps what it had), and a number out of range is clamped.
 */
export const NODE_STYLE_SCHEMA = Object.freeze({
  size: field("number", { min: 1, max: 100000 }), // at least 1: a node never vanishes
  shape: field("string"),
  fill: field("color"),
  fillAlpha: field("number", { min: 0, max: 1 }),
  border: field("color"),
  borderWidth: field("number", { min: 0, max: 1000 }),
  pattern: field("enum", { values: ["solid", "dashed", "dotted", "stack"] }),
  iconAlpha: field("number", { min: 0, max: 1 }),
  aura: field("color", { nullable: true }),
  ring: field("color", { nullable: true }),
  badge: field("boolean"),
  label: field("string"),
  fontSize: field("number", { min: 0, max: 1000 }),
  bold: field("boolean"),
  labelPriority: field("number"),
  events: field("boolean"),
  icon: field("string", { nullable: true }),
  look: field("enum", { values: ["icon", "card"] }),
  width: field("number", { min: 1, max: 100000 }),
  height: field("number", { min: 1, max: 100000 }),
  stripe: field("color", { nullable: true }),
  portIn: field("color", { nullable: true }),
  portOut: field("color", { nullable: true }),
  subtitle: field("rich"),
  value: field("rich"),
  tag: field("string"),
  tagColor: field("color", { nullable: true }),
  valueColor: field("color", { nullable: true }),
  iconSize: field("number", { min: 0, max: 1000 }),
  iconInset: field("number", { min: 0, max: 1000 }),
  stripeWidth: field("number", { min: 0, max: 100 }),
  stripeInset: field("number", { min: 0, max: 1000 }),
  portSize: field("number", { min: 0, max: 100 }),
  subtitleSize: field("number", { min: 0, max: 1000 }),
  valueSize: field("number", { min: 0, max: 1000 }),
  cardPadding: field("number", { min: 0, max: 1000 }),
});

export const EDGE_STYLE_SCHEMA = Object.freeze({
  color: field("color"),
  width: field("number", { min: 0, max: 1000 }),
  alpha: field("number", { min: 0, max: 1 }),
  pattern: field("enum", {
    values: ["dashed", "dotted", "arrows"],
    nullable: true,
  }),
  patternToward: field("enum", { values: ["target", "source"] }),
  arrowAtSource: field("string", { nullable: true }),
  arrowAtTarget: field("string", { nullable: true }),
  arrowScale: field("number", { min: 0, max: 100 }),
  label: field("string"),
  fontSize: field("number", { min: 0, max: 1000 }),
  glow: field("boolean"),
});

const warned = new Set();
function warnStyle(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

function describe(value) {
  if (typeof value === "function") return "a function";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/**
 * Copy `changes` onto `style`, checked against `schema`: unknown fields and unusable values are left out, numbers out
 * of range clamped, each problem warned about once (per source, field and problem). null clears the fields that can
 * be "none" (aura, ring, an edge's pattern and arrowheads) and is ignored elsewhere.
 * @param {string} source  where the changes came from, for the warning
 */
function applyStyle(style, changes, schema, source) {
  if (!changes || typeof changes !== "object") return;
  for (const key of Object.keys(changes)) {
    const value = changes[key];
    if (value === undefined) continue;
    const rule = schema[key];
    if (!rule) {
      warnStyle(
        `Prismatrix: ${source}: unknown style field "${key}" (ignored)`,
      );
      continue;
    }
    if (value === null) {
      if (rule.nullable) style[key] = null;
      continue;
    }
    if (rule.type === "rich") {
      // Card text: a string, or runs (strings, { text, color }, { mark }, { dot }).
      if (isRichText(value)) style[key] = value;
      else
        warnStyle(
          `Prismatrix: ${source}: "${key}" expected a string or a list of runs (strings, { text, color }, { mark }, { dot }); got ${describe(value)}, ignored`,
        );
      continue;
    }
    const checked = checkField(rule, value);
    if (checked.problem) {
      warnStyle(
        `Prismatrix: ${source}: "${key}" ${checked.problem}; got ${describe(value)}, ${checked.value === undefined ? "ignored" : `using ${describe(checked.value)}`}`,
      );
      if (checked.value === undefined) continue;
    }
    style[key] = checked.value;
  }
}

/** "auto" puts labels where the layout leaves room: beside horizontal trees, below everything else. */
export function resolveLabelPosition(o) {
  if (o.labelPosition !== "auto") return o.labelPosition;
  const { directional, growth } = flowOf(o);
  if (!directional) return "below";
  return growth === "LR" ? "right" : growth === "RL" ? "left" : "below";
}

/**
 * The renderer's routing: "straight", "taxi", "round-taxi", "s-curve" (bends along the flow), "arc", or a routing
 * added with registerEdgeRouting (passed through as it is). Right angles need a direction, so layouts without one
 * get arcs instead.
 */
export function resolveRouting(o) {
  const builtIn = ["straight", "taxi", "round-taxi", "curved"];
  if (!builtIn.includes(o.edgeRouting)) return o.edgeRouting;
  if (o.edgeRouting === "straight") return "straight";
  const radial = !flowOf(o).directional;
  if (o.edgeRouting === "curved") return radial ? "arc" : "s-curve";
  if (radial) return "arc";
  return o.edgeRouting === "round-taxi" ? "round-taxi" : "taxi";
}

/** The axis a directional layout spreads its levels along. */
export function resolveFlowAxis(o) {
  return flowOf(o).axis ?? "y";
}

/**
 * @param {Set<string>} classes
 * @param {{ color?: string, label?: string, style?: NodeRule }} data  the node (its `style`: its own overrides)
 * @param {import('./options.js').Options} o
 * @param {Theme} theme
 * @param {ClassRules} [rules]  per class, applied in their own order
 * @returns {NodeStyle}
 */
export function resolveNodeStyle(classes, data, o, theme, rules = {}) {
  const style = buildNodeStyle(classes, data, o, theme, rules, o.nodeLook);
  // A rule or hook turned this node into the other look: start again from that look's defaults.
  return style.look === o.nodeLook
    ? style
    : buildNodeStyle(classes, data, o, theme, rules, style.look);
}

function buildNodeStyle(classes, data, o, theme, rules, look) {
  const color = data.color ?? theme.node;
  const card = look === "card";
  /** @type {NodeStyle} */
  const style = {
    size: o.nodeSize * o.nodeSizeScale,
    shape: o.nodeShape,
    fill: o.tintNodeFill ? color : theme.nodeFill,
    fillAlpha: o.tintNodeFill ? o.tintFillAlpha : 1,
    border: color,
    borderWidth: o.nodeBorderWidth,
    pattern: "solid",
    iconAlpha: o.showIcons ? 1 : 0,
    aura: null,
    ring: null,
    badge: false,
    label: o.showLabels ? (data.label ?? "") : "",
    fontSize: o.fontSize * o.labelFontScale,
    bold: false,
    labelPriority: 0,
    events: true,
    look,
    width: undefined, // filled in last: see below
    height: undefined,
    stripe: card ? color : null,
    portIn: card ? color : null,
    portOut: card ? color : null,
    subtitle: data.subtitle ?? "",
    value: data.value ?? "",
    tag: data.tag ?? "",
    tagColor: null,
    valueColor: null,
    iconSize: o.cardIconSize,
    iconInset: o.cardIconInset,
    stripeWidth: o.cardStripeWidth,
    stripeInset: o.cardStripeInset,
    portSize: o.cardPortSize,
    subtitleSize: o.cardSubtitleSize,
    valueSize: o.cardValueSize,
    cardPadding: o.cardPadding,
  };
  if (card) {
    // A card: a quiet outline (the colour is its stripe), the text inside.
    style.border = theme.cardBorder;
    style.borderWidth = 1;
    style.fontSize = o.cardTitleSize;
    style.shape = "round-rectangle";
  }
  if (classes.has("root")) {
    if (!card) {
      style.size *= o.rootSizeScale;
      style.borderWidth += o.rootBorderBoost;
      style.fontSize *= o.rootFontScale;
    }
    style.bold = true;
    style.labelPriority = 3;
  }
  if (classes.has("collapsed")) style.pattern = "stack";
  for (const [name, rule] of Object.entries(rules.nodes ?? {}))
    if (classes.has(name))
      applyStyle(style, rule, NODE_STYLE_SCHEMA, `node class "${name}"`);
  applyStyle(style, data.style, NODE_STYLE_SCHEMA, "a node's style");
  if (o.nodeStyle)
    applyStyle(
      style,
      o.nodeStyle(/** @type {any} */ (data), style),
      NODE_STYLE_SCHEMA,
      "the nodeStyle hook",
    );
  // The box: set explicitly, or the look's own (an icon's size, a card's width and height).
  style.width ??= card ? o.cardWidth : style.size;
  style.height ??= card ? o.cardHeight : style.size;
  return style;
}

/**
 * @param {Set<string>} classes
 * @param {{ label?: string, sourceColor?: string, targetColor?: string, style?: EdgeRule }} data
 * @param {import('./options.js').Options} o
 * @param {Theme} theme
 * @param {ClassRules} [rules]
 * @returns {EdgeStyle}
 */
export function resolveEdgeStyle(classes, data, o, theme, rules = {}) {
  const color =
    o.edgeColorMode === "target"
      ? (data.targetColor ?? theme.edge)
      : o.edgeColorMode === "source"
        ? (data.sourceColor ?? theme.edge)
        : theme.edge;
  const arrow = o.showArrows ? o.arrowShape : null;
  /** @type {EdgeStyle} */
  const style = {
    color,
    width: o.edgeWidth,
    alpha: o.edgeOpacity,
    pattern:
      o.edgeLineStyle === "dashed" ||
      o.edgeLineStyle === "dotted" ||
      o.edgeLineStyle === "arrows"
        ? o.edgeLineStyle
        : null,
    patternToward: o.flowToward,
    arrowAtSource: o.arrowEnd !== "target" ? arrow : null,
    arrowAtTarget: o.arrowEnd !== "source" ? arrow : null,
    arrowScale: o.arrowScale,
    label: o.edgeLabels ? (data.label ?? "") : "",
    fontSize: o.fontSize * o.labelFontScale - 1,
    glow: false,
  };
  for (const [name, rule] of Object.entries(rules.edges ?? {}))
    if (classes.has(name))
      applyStyle(style, rule, EDGE_STYLE_SCHEMA, `edge class "${name}"`);
  applyStyle(style, data.style, EDGE_STYLE_SCHEMA, "an edge's style");
  if (o.edgeStyle)
    applyStyle(
      style,
      o.edgeStyle(/** @type {any} */ (data), style),
      EDGE_STYLE_SCHEMA,
      "the edgeStyle hook",
    );
  return style;
}
