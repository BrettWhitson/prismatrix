export type NodeOptions = {
  shape:
    "circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile";
  /**
   * diameter, world px
   */
  size: number;
  sizeBy: "uniform" | "descendants" | "depth";
  colorBy: "depth" | "branch" | "single";
  /**
   * "#rrggbb", when colouring by one colour
   */
  color: string;
  outline: number;
  /**
   * a border's width, for nodes whose style gives a `stroke` colour
   */
  strokeWidth: number;
  iconFit: "cover" | "contain";
  labels: "off" | "below" | "right" | "outward";
  /**
   * px
   */
  labelSize: number;
  /**
   * px; 0: no limit
   */
  labelMaxWidth: number;
  /**
   * clearance around every node, world px
   */
  collisionRadius: number;
  /**
   * labels take room in layouts and collisions
   */
  labelCollide: boolean;
};
export type EdgeOptions = {
  shape: "straight" | "step" | "fan" | "curve";
  /**
   * a step edge's corner radius
   */
  corner: number;
  /**
   * world px
   */
  width: number;
  taper: boolean;
  colorBy: "single" | "target";
  /**
   * "#rrggbb"
   */
  color: string;
  opacity: number;
  arrow: "none" | "arrow" | "dot";
  arrowSize: number;
  /**
   * where an edge's own label is drawn
   */
  labels: "off" | "target" | "middle";
};
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
export declare const NODE_OPTIONS: import("./schema.js").OptionSpec[];
/** @type {import("./schema.js").OptionSpec[]} */
export declare const EDGE_OPTIONS: import("./schema.js").OptionSpec[];
/** Colours by depth, then wrapping. Picked to read on the dark background. */
export declare const PALETTE: string[];
