// Node and edge options.

import { bool, color, range, select } from "./schema.js";

/**
 * @typedef {object} NodeOptions How nodes look: the model's `node` options (NODE_OPTIONS), resolved. Each node's own
 *   `style` wins over them.
 * @property {"circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile"} shape
 * @property {number} size              diameter, world px
 * @property {"uniform" | "descendants" | "depth"} sizeBy
 * @property {"depth" | "branch" | "single"} colorBy
 * @property {string} color             "#rrggbb", when colouring by one colour
 * @property {number} outline
 * @property {number} strokeWidth       a border's width, for nodes whose style gives a `stroke` colour
 * @property {"cover" | "contain"} iconFit
 * @property {"off" | "below" | "right" | "outward"} labels
 * @property {number} labelSize         px
 * @property {number} labelMaxWidth     px; 0: no limit
 * @property {number} collisionRadius   clearance around every node, world px
 * @property {boolean} labelCollide     labels take room in layouts and collisions
 *
 * @typedef {object} EdgeOptions How edges look: the model's `edge` options (EDGE_OPTIONS), resolved. Each edge's own
 *   `style` wins over them.
 * @property {"straight" | "step" | "fan" | "curve"} shape
 * @property {number} corner            a step edge's corner radius
 * @property {number} width             world px
 * @property {boolean} taper
 * @property {"single" | "target"} colorBy
 * @property {string} color             "#rrggbb"
 * @property {number} opacity
 * @property {"none" | "arrow" | "dot"} arrow
 * @property {number} arrowSize
 * @property {"off" | "target" | "middle"} labels where an edge's own label is drawn
 */

/** @type {import("./schema.js").OptionSpec[]} */
export const NODE_OPTIONS = [
  select(
    "shape",
    "Shape",
    [
      { value: "circle", label: "Circle" },
      { value: "square", label: "Square" },
      { value: "rounded", label: "Rounded square" },
      { value: "diamond", label: "Diamond" },
      { value: "hexagon", label: "Hexagon" },
      { value: "ring", label: "Ring" },
      { value: "tile", label: "Tile" },
    ],
    "circle",
    "Tile: a rounded square that is its icon (like an item in a game's inventory); its fill shows only until the icon is in, or when it has none.",
  ),
  range("size", "Size", 4, 60, 1, 16),
  select(
    "sizeBy",
    "Size by",
    [
      { value: "uniform", label: "Uniform" },
      { value: "descendants", label: "Subtree size" },
      { value: "depth", label: "Shrink with depth" },
    ],
    "uniform",
  ),
  select(
    "colorBy",
    "Colour by",
    [
      { value: "depth", label: "Depth" },
      { value: "branch", label: "Branch" },
      { value: "single", label: "One colour" },
    ],
    "depth",
  ),
  color("color", "Colour", "#7aa2f7", "Used when colouring by one colour."),
  range("outline", "Outline", 0, 6, 0.5, 0),
  range(
    "strokeWidth",
    "Border width",
    0,
    12,
    0.5,
    2,
    "How wide a node's border is drawn (inside its shape) when its style gives it a stroke colour.",
  ),
  select(
    "iconFit",
    "Icon fit",
    [
      { value: "cover", label: "Fill the shape" },
      { value: "contain", label: "Fit inside" },
    ],
    "cover",
    "How a node's icon sits in its shape: filling it (cropped to the shape) or whole inside it, the fill around it.",
  ),
  select(
    "labels",
    "Labels",
    [
      { value: "off", label: "Off" },
      { value: "below", label: "Below" },
      { value: "right", label: "Right" },
      { value: "outward", label: "Outward" },
    ],
    "below",
    "Outward points labels away from the layout's centre or root.",
  ),
  range("labelSize", "Label size", 6, 24, 1, 11),
  range(
    "labelMaxWidth",
    "Label width",
    0,
    400,
    10,
    160,
    "Longer labels are cut short with an ellipsis (shown whole on hover). 0: no limit.",
  ),
  range(
    "collisionRadius",
    "Collision radius",
    0,
    60,
    1,
    4,
    "Clearance kept around every node: layouts leave it, and colliding nodes keep it.",
  ),
  bool(
    "labelCollide",
    "Label collision",
    true,
    "Labels take up room too: layouts make space for them and collisions push them apart, so they never overlap and never need hiding.",
  ),
];

/** @type {import("./schema.js").OptionSpec[]} */
export const EDGE_OPTIONS = [
  select(
    "shape",
    "Shape",
    [
      { value: "straight", label: "Straight" },
      { value: "step", label: "Step" },
      { value: "fan", label: "Fan" },
      { value: "curve", label: "Curve" },
    ],
    "step",
    "Step bends around the layout: right angles in a tree, ring arcs in a radial. Fan leaves the parent along the layout's axis, then goes straight to the child. Curve flows from the parent to the child along the layout's axis or spokes.",
  ),
  range("corner", "Corner radius", 0, 40, 1, 8, "Rounds a step edge's bends."),
  range("width", "Width", 0.25, 8, 0.25, 1.5),
  bool("taper", "Taper", false, "Thick at the parent, thin at the child."),
  select(
    "colorBy",
    "Colour",
    [
      { value: "single", label: "One colour" },
      { value: "target", label: "Child's colour" },
    ],
    "single",
  ),
  color("color", "Colour", "#5b6478"),
  range("opacity", "Opacity", 0.05, 1, 0.05, 0.8),
  select(
    "arrow",
    "End",
    [
      { value: "none", label: "None" },
      { value: "arrow", label: "Arrow" },
      { value: "dot", label: "Dot" },
    ],
    "none",
  ),
  range("arrowSize", "End size", 2, 16, 0.5, 6),
  select(
    "labels",
    "Labels",
    [
      { value: "off", label: "Off" },
      { value: "target", label: "Near the target" },
      { value: "middle", label: "Middle" },
    ],
    "target",
    "Where an edge's own label (a quantity, say) is drawn. Shown once zoomed in far enough to read.",
  ),
];

/** Colours by depth, then wrapping. Picked to read on the dark background. */
export const PALETTE = [
  "#f6c177",
  "#7aa2f7",
  "#9ece6a",
  "#e27e8d",
  "#bb9af7",
  "#5ccfe6",
  "#ff9e64",
  "#c0caf5",
];
