export type NodeOptions = {
  /**
   * every node's shape
   */
  shape:
    "circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile";
  /**
   * diameter, world px
   */
  size: number;
  /**
   * every node the same size, bigger with a bigger subtree, or
   * smaller the deeper it is
   */
  sizeBy: "uniform" | "descendants" | "depth";
  /**
   * what picks a node's colour from the palette: its depth, or its
   * branch (which of its root's children it's under); or one colour for all
   */
  colorBy: "depth" | "branch" | "single";
  /**
   * "#rrggbb", when colouring by one colour
   */
  color: string;
  /**
   * a ring in the background colour round each node, px (0: none)
   */
  outline: number;
  /**
   * a border's width, for nodes whose style gives a `stroke` colour
   */
  strokeWidth: number;
  iconFit: "cover" | "contain";
  /**
   * where labels go
   */
  labels: "off" | "below" | "right" | "outward";
  /**
   * label text size, world px
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
  /**
   * every edge in one colour, or each in its child's colour
   */
  colorBy: "single" | "target";
  /**
   * "#rrggbb", when edges are one colour
   */
  color: string;
  /**
   * edges are drawn as one layer at this opacity, so overlaps don't brighten
   */
  opacity: number;
  /**
   * what an edge ends in at its target
   */
  arrow: "none" | "arrow" | "dot";
  /**
   * the end's size, world px
   */
  arrowSize: number;
  /**
   * where an edge's own label is drawn
   */
  labels: "off" | "target" | "middle";
};
/**
 * @typedef {object} NodeOptions How nodes look: the model's `node` options (NODE_OPTIONS), resolved. Each node's own
 *   `style` wins over them.
 * @property {"circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile"} shape every node's shape
 * @property {number} size              diameter, world px
 * @property {"uniform" | "descendants" | "depth"} sizeBy every node the same size, bigger with a bigger subtree, or
 *   smaller the deeper it is
 * @property {"depth" | "branch" | "single"} colorBy what picks a node's colour from the palette: its depth, or its
 *   branch (which of its root's children it's under); or one colour for all
 * @property {string} color             "#rrggbb", when colouring by one colour
 * @property {number} outline           a ring in the background colour round each node, px (0: none)
 * @property {number} strokeWidth       a border's width, for nodes whose style gives a `stroke` colour
 * @property {"cover" | "contain"} iconFit
 * @property {"off" | "below" | "right" | "outward"} labels where labels go
 * @property {number} labelSize         label text size, world px
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
 * @property {"single" | "target"} colorBy every edge in one colour, or each in its child's colour
 * @property {string} color             "#rrggbb", when edges are one colour
 * @property {number} opacity           edges are drawn as one layer at this opacity, so overlaps don't brighten
 * @property {"none" | "arrow" | "dot"} arrow what an edge ends in at its target
 * @property {number} arrowSize         the end's size, world px
 * @property {"off" | "target" | "middle"} labels where an edge's own label is drawn
 */
/** @type {import("./schema.js").OptionSpec[]} */
export declare const NODE_OPTIONS: import("./schema.js").OptionSpec[];
/** @type {import("./schema.js").OptionSpec[]} */
export declare const EDGE_OPTIONS: import("./schema.js").OptionSpec[];
