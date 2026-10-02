export type Routing = {
  kind: "tree" | "radial" | "layered";
  /**
   * tree and layered: TB, BT, LR or RL
   */
  direction?: string;
  /**
   * radial: the centre
   */
  cx?: number;
  cy?: number;
  /**
   * layered: the bends of edges that cross layers (by edge object)
   */
  bends?: Map<object, number[][]>;
  /**
   * layered: edges drawn to a chip under their source
   */
  references?: import("./layered.js").Reference[];
  /**
   * layered: edge crossings left
   */
  crossings?: number;
  /**
   * layered: crossings before ordering
   */
  initialCrossings?: number;
  /**
   * layered: each node's layer
   */
  layerOf?: Int32Array;
  /**
   * layered with ranking "simplex": the exchanges the
   * layering made, and whether it reached the fewest long edges or stopped at its work budget
   */
  simplex?: {
    pivots: number;
    optimal: boolean;
  };
  /**
   * set by the controller while a layout morph runs
   */
  morphing?: boolean;
};
export type Sizing = {
  /**
   *   a node's footprint relative to its centre, with its label placed at `angle` (see boxes.js)
   */
  box: (
    index: number,
    angle: number,
  ) => {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  /**
   * extra clearance every footprint keeps from its neighbours
   */
  gap: number;
};
export type LayoutHint = import("./layout-job.js").LayoutHint;
export type TreeLayoutOptions = {
  /**
   * which way the tree grows from its roots
   */
  direction: "TB" | "BT" | "LR" | "RL";
  /**
   * at least this far between levels, world px
   */
  levelGap: number;
  /**
   * between neighbours with the same parent
   */
  siblingGap: number;
  /**
   * between neighbours with different parents (separate trees get twice this)
   */
  subtreeGap: number;
  /**
   * a parent over its children's centres, or their whole span
   */
  parentAlign: "centres" | "edges";
};
export type MergedLayoutOptions = {
  /**
   * which way the layers run from the sources
   */
  direction: "TB" | "BT" | "LR" | "RL";
  /**
   * at least this far between layers, world px
   */
  levelGap: number;
  /**
   * between neighbours on a layer
   */
  nodeGap: number;
  /**
   * layers by depth from the top, or fewest long edges
   */
  ranking: "longest" | "simplex";
  /**
   * how each layer is ordered to cut crossings
   */
  ordering: "sifting" | "barycenter";
  /**
   * where nodes sit along their layer: balanced keeps long edges straight
   * (an exact L1 placement), median sits each node at the median of its neighbours
   */
  placement: "balanced" | "median";
  /**
   * busy shared ingredients get reference chips, or long edges
   */
  references: "hubs" | "off";
  /**
   * how many users make an ingredient busy
   */
  shareMin: number;
  /**
   * 0–1: how firmly a change keeps everything else in its place
   */
  stability: number;
};
export type RadialLayoutOptions = {
  /**
   * at least this far between rings, world px
   */
  ringGap: number;
  /**
   * degrees of the circle the tree fans over
   */
  sweep: number;
  /**
   * degrees the drawing is turned
   */
  rotation: number;
  /**
   * how the circle is shared out
   */
  spacing: "tidy" | "leaves";
};
export type LayoutOptions =
  | Partial<TreeLayoutOptions>
  | Partial<MergedLayoutOptions>
  | Partial<RadialLayoutOptions>;
export type LayoutSpec = {
  label: string;
  /**
   *   places every node's home (`graph`'s homeX and homeY) and says how edges bend
   */
  run: (
    graph: import("./graph.js").Graph,
    options?: any,
    sizing?: Sizing,
    hint?: LayoutHint | null,
  ) => Routing;
  options: import("./schema.js").OptionSpec[];
  /**
   *   the physics modes it offers: for each, options only this layout has, and its own defaults for the mode's options
   */
  physics: Record<
    string,
    {
      options?: import("./schema.js").OptionSpec[];
      defaults?: Record<string, any>;
    }
  >;
  /**
   * edge options it shows by default (in place of
   * EDGE_OPTIONS' defaults) where they weren't set on purpose
   */
  edgeDefaults?: Partial<import("./style.js").EdgeOptions>;
};
/**
 * @typedef {object} Routing How edges bend for this layout (what a layout returns, with edges by object).
 * @property {"tree" | "radial" | "layered"} kind
 * @property {string} [direction] tree and layered: TB, BT, LR or RL
 * @property {number} [cx]        radial: the centre
 * @property {number} [cy]
 * @property {Map<object, number[][]>} [bends] layered: the bends of edges that cross layers (by edge object)
 * @property {import("./layered.js").Reference[]} [references] layered: edges drawn to a chip under their source
 * @property {number} [crossings] layered: edge crossings left
 * @property {number} [initialCrossings] layered: crossings before ordering
 * @property {Int32Array} [layerOf] layered: each node's layer
 * @property {{ pivots: number, optimal: boolean }} [simplex] layered with ranking "simplex": the exchanges the
 *   layering made, and whether it reached the fewest long edges or stopped at its work budget
 * @property {boolean} [morphing] set by the controller while a layout morph runs
 */
/**
 * @typedef {object} Sizing What a layout needs to know about node sizes.
 * @property {(index: number, angle: number) => { x0: number, y0: number, x1: number, y1: number }} box
 *   a node's footprint relative to its centre, with its label placed at `angle` (see boxes.js)
 * @property {number} gap extra clearance every footprint keeps from its neighbours
 */
/**
 * @typedef {import("./layout-job.js").LayoutHint} LayoutHint Where everything was before a change (layout-job.js).
 *   Every layout takes one as its fourth argument and keeps kept nodes near where they were: a tree and a radial
 *   tree move as a whole (their shape is fixed by the tree), the merged tree also keeps its order and pulls nodes
 *   back (layered.js).
 */
/**
 * @typedef {object} TreeLayoutOptions The tree layout's options (LAYOUTS.tree.options).
 * @property {"TB" | "BT" | "LR" | "RL"} direction which way the tree grows from its roots
 * @property {number} levelGap   at least this far between levels, world px
 * @property {number} siblingGap between neighbours with the same parent
 * @property {number} subtreeGap between neighbours with different parents (separate trees get twice this)
 * @property {"centres" | "edges"} parentAlign a parent over its children's centres, or their whole span
 *
 * @typedef {object} MergedLayoutOptions The merged tree's options (LAYOUTS.merged.options).
 * @property {"TB" | "BT" | "LR" | "RL"} direction which way the layers run from the sources
 * @property {number} levelGap   at least this far between layers, world px
 * @property {number} nodeGap    between neighbours on a layer
 * @property {"longest" | "simplex"} ranking layers by depth from the top, or fewest long edges
 * @property {"sifting" | "barycenter"} ordering how each layer is ordered to cut crossings
 * @property {"balanced" | "median"} placement where nodes sit along their layer: balanced keeps long edges straight
 *   (an exact L1 placement), median sits each node at the median of its neighbours
 * @property {"hubs" | "off"} references busy shared ingredients get reference chips, or long edges
 * @property {number} shareMin   how many users make an ingredient busy
 * @property {number} stability  0–1: how firmly a change keeps everything else in its place
 *
 * @typedef {object} RadialLayoutOptions The radial layout's options (LAYOUTS.radial.options).
 * @property {number} ringGap    at least this far between rings, world px
 * @property {number} sweep      degrees of the circle the tree fans over
 * @property {number} rotation   degrees the drawing is turned
 * @property {"tidy" | "leaves"} spacing how the circle is shared out
 *
 * @typedef {Partial<TreeLayoutOptions> | Partial<MergedLayoutOptions> | Partial<RadialLayoutOptions>} LayoutOptions
 *   Options for one of the layouts (all or some)
 *
 * @typedef {object} LayoutSpec A layout, as LAYOUTS lists it.
 * @property {string} label
 * @property {(graph: import("./graph.js").Graph, options?: any, sizing?: Sizing, hint?: LayoutHint | null) => Routing} run
 *   places every node's home (`graph`'s homeX and homeY) and says how edges bend
 * @property {import("./schema.js").OptionSpec[]} options
 * @property {Record<string, { options?: import("./schema.js").OptionSpec[], defaults?: Record<string, any> }>} physics
 *   the physics modes it offers: for each, options only this layout has, and its own defaults for the mode's options
 * @property {Partial<import("./style.js").EdgeOptions>} [edgeDefaults] edge options it shows by default (in place of
 *   EDGE_OPTIONS' defaults) where they weren't set on purpose
 */
/**
 * Nodes of radius 8 with no labels.
 * @type {Sizing}
 */
export declare const DEFAULT_SIZING: Sizing;
/** Where an "outward" label points in a tree. */
export declare const TREE_LABEL_ANGLE: {
  TB: number;
  BT: number;
  LR: number;
  RL: number;
};
/**
 * Every node's footprint (sizing.box, its label pointing the tree's way) in a tree's or a layered drawing's terms,
 * into the arrays given by node index: how far it reaches `left` and `right` along its level, and `near` and `far`
 * across levels, in the direction they grow.
 * @param {{ index: number }[]} nodes
 * @param {Sizing} sizing
 * @param {string} direction TB, BT, LR or RL
 * @param {Float64Array} left
 * @param {Float64Array} right
 * @param {Float64Array} near
 * @param {Float64Array} far
 */
export declare function levelFootprints(
  nodes: {
    index: number;
  }[],
  sizing: Sizing,
  direction: string,
  left: Float64Array,
  right: Float64Array,
  near: Float64Array,
  far: Float64Array,
): void;
/**
 * Tidy tree: Walker's algorithm in linear time (Buchheim, Jünger & Leipert; see tidy.js), with every node's real
 * footprint (node and label). Subtrees pack as tightly as their outlines allow, small ones between big ones are
 * spread out evenly, and every parent sits centred over its children. Levels are at least `levelGap` apart, and
 * further when their footprints need it.
 * @param {import("./graph.js").Graph} graph
 * @param {Partial<TreeLayoutOptions>} [options]
 * @param {Sizing} [sizing]
 * @param {LayoutHint | null} [hint]
 * @returns {Routing}
 */
export declare function treeLayout(
  graph: import("./graph.js").Graph,
  {
    direction,
    levelGap,
    siblingGap,
    subtreeGap,
    parentAlign,
  }?: Partial<TreeLayoutOptions>,
  sizing?: Sizing,
  hint?: LayoutHint | null,
): Routing;
/**
 * Radial tree: depth is the ring. One root sits in the middle; several roots share the first ring around an empty
 * centre. Rings are at least `ringGap` apart, and clear of each other's footprints.
 *
 * Spacing "tidy" (the default) lays the tree out as a tidy tree in angle (as d3's radial trees do): every node takes
 * the angle its footprint spans on its ring (so inner rings, being smaller, give a node more angle), and the tidy
 * tree (tidy.js) packs subtrees as tightly as those angles allow, spreads small ones evenly and centres every parent
 * over its children. If that needs more than the sweep, every ring moves out in proportion until it fits; the
 * angles are then spread across the sweep. No subtree is ever given angle it doesn't use, so one big branch can't
 * leave the middle empty.
 *
 * Spacing "leaves" is the classic rule: each subtree gets a wedge of its parent's in proportion to its leaf count,
 * and each ring moves out until every node fits across its wedge.
 * @param {import("./graph.js").Graph} graph
 * @param {Partial<RadialLayoutOptions>} [options]
 * @param {Sizing} [sizing]
 * @param {LayoutHint | null} [hint]
 * @returns {Routing}
 */
export declare function radialLayout(
  graph: import("./graph.js").Graph,
  { ringGap, sweep, rotation, spacing }?: Partial<RadialLayoutOptions>,
  sizing?: Sizing,
  hint?: LayoutHint | null,
): Routing;
/** Keeps a node on its level (tree) or its ring (radial) while physics moves it. */
export declare function constrainer(
  routing: any,
  opts: any,
): (m: any, i: any) => void;
/**
 * The layouts. `physics` lists the modes each one supports; for each mode, `options` are extra knobs only this
 * layout has and `defaults` override the mode's general defaults. `edgeDefaults`, where a layout has them, replace
 * EDGE_OPTIONS' defaults while it's shown, for any edge option that wasn't set on purpose (the controller's `edge`).
 * @type {{ tree: LayoutSpec, merged: LayoutSpec, radial: LayoutSpec }}
 */
export declare const LAYOUTS: {
  tree: LayoutSpec;
  merged: LayoutSpec;
  radial: LayoutSpec;
};
