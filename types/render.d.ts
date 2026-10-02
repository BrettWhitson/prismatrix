export type Looks = {
  /**
   * per node, world px
   */
  radius: Float64Array;
  /**
   * per node, "#rrggbb"
   */
  fill: string[];
  /**
   * per node
   */
  shape: string[];
  /**
   * per node, its border colour (null: none)
   */
  stroke: (string | null)[];
  /**
   * per node (0: no border)
   */
  strokeWidth: Float64Array;
  /**
   * per node, a URL or an image (null: none)
   */
  icon: any[];
  /**
   * per node, its badge image: a URL or an image (null: none)
   */
  badgeIcon: any[];
  /**
   * per node, its border's dashes: 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
   */
  strokeStyle: Uint8Array;
  /**
   * per node, its fill's opacity, 0–1
   */
  opacity: Float64Array;
  /**
   * per node, a ring's colour (null: none)
   */
  ring: (string | null)[];
  /**
   * per node, a glow's colour (null: none)
   */
  aura: (string | null)[];
  /**
   * per node, 1 for a stacked copy behind it
   */
  stack: Uint8Array;
  /**
   * per edge
   */
  edgeColour: string[];
  /**
   * per edge, world px
   */
  edgeWidth: Float64Array;
  /**
   * per edge, 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
   */
  edgeDash: Uint8Array;
  /**
   * per edge, 1 for a glow along it
   */
  edgeGlow: Uint8Array;
  /**
   * an
   * edge's look without a style of its own
   */
  edgeDefault: {
    colour: string;
    width: number;
    byTarget: boolean;
    bySource: boolean;
    dash: number;
  };
  theme: import("./theme.js").Theme;
  /**
   * the node option
   */
  iconFit: string;
  /**
   * per node, which branch of its root it's on (colouring by branch), or null
   */
  branch: Int32Array | null;
};
export type DisplayNode = {
  id: string;
  label: string;
  index: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  /**
   * its parent's index, or -1
   */
  parent: number;
  children: number[];
  depth: number;
  labelAngle?: number;
  descendants?: number;
  style?: Record<string, any>;
  data?: Record<string, any>;
  /**
   * a reference chip: its ingredient's index
   */
  reference?: number;
  /**
   * a node that left the graph, folding away
   */
  ghost?: boolean;
};
export type DisplayEdge = {
  id?: string;
  source: number;
  target: number;
  tree: boolean;
  label?: string;
  style?: Record<string, any>;
  data?: Record<string, any>;
  /**
   * ends at a reference chip
   */
  reference?: boolean;
  ghost?: boolean;
};
export type DisplayGraph = {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  byId: Map<string, any>;
  roots: number[];
  order: number[];
  /**
   * per node, the edges into it
   */
  incoming?: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * per node, the edges out of it
   */
  outgoing?: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * per referenced ingredient (node index), how many use it
   */
  uses?: Map<number, number>;
};
export type Shown = {
  graph: DisplayGraph;
  looks: Looks;
  /**
   * per node, 0–1: how lit it is
   */
  shade: Float32Array;
  /**
   * per node, 0–1: how far it has faded in
   */
  appear: Float32Array;
};
/**
 * @typedef {object} Looks How every node and edge of a graph looks, by index (looksOf).
 * @property {Float64Array} radius     per node, world px
 * @property {string[]} fill           per node, "#rrggbb"
 * @property {string[]} shape          per node
 * @property {(string | null)[]} stroke per node, its border colour (null: none)
 * @property {Float64Array} strokeWidth per node (0: no border)
 * @property {any[]} icon              per node, a URL or an image (null: none)
 * @property {any[]} badgeIcon         per node, its badge image: a URL or an image (null: none)
 * @property {Uint8Array} strokeStyle  per node, its border's dashes: 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
 * @property {Float64Array} opacity    per node, its fill's opacity, 0–1
 * @property {(string | null)[]} ring  per node, a ring's colour (null: none)
 * @property {(string | null)[]} aura  per node, a glow's colour (null: none)
 * @property {Uint8Array} stack        per node, 1 for a stacked copy behind it
 * @property {string[]} edgeColour     per edge
 * @property {Float64Array} edgeWidth  per edge, world px
 * @property {Uint8Array} edgeDash     per edge, 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
 * @property {Uint8Array} edgeGlow     per edge, 1 for a glow along it
 * @property {{ colour: string, width: number, byTarget: boolean, bySource: boolean, dash: number }} edgeDefault an
 *   edge's look without a style of its own
 * @property {import("./theme.js").Theme} theme
 * @property {string} iconFit          the node option
 * @property {Int32Array | null} branch per node, which branch of its root it's on (colouring by branch), or null
 *
 * @typedef {object} DisplayNode A node as painters read it: a working graph's node (graph.js), or one that's only
 *   drawn (a reference chip, a ghost).
 * @property {string} id
 * @property {string} label
 * @property {number} index
 * @property {number} x
 * @property {number} y
 * @property {number} homeX
 * @property {number} homeY
 * @property {number} parent      its parent's index, or -1
 * @property {number[]} children
 * @property {number} depth
 * @property {number} [labelAngle]
 * @property {number} [descendants]
 * @property {Record<string, any>} [style]
 * @property {Record<string, any>} [data]
 * @property {number} [reference] a reference chip: its ingredient's index
 * @property {boolean} [ghost]    a node that left the graph, folding away
 *
 * @typedef {object} DisplayEdge An edge as painters read it (graph.js's Edge, or one that's only drawn).
 * @property {string} [id]
 * @property {number} source
 * @property {number} target
 * @property {boolean} tree
 * @property {string} [label]
 * @property {Record<string, any>} [style]
 * @property {Record<string, any>} [data]
 * @property {boolean} [reference] ends at a reference chip
 * @property {boolean} [ghost]
 *
 * @typedef {object} DisplayGraph What painters draw: a working graph (graph.js), or one with reference chips
 *   (references.js) and ghosts (ghosts.js) appended after its own nodes.
 * @property {DisplayNode[]} nodes
 * @property {DisplayEdge[]} edges
 * @property {Map<string, any>} byId
 * @property {number[]} roots
 * @property {number[]} order
 * @property {ReadonlyArray<ReadonlyArray<number>>} [incoming] per node, the edges into it
 * @property {ReadonlyArray<ReadonlyArray<number>>} [outgoing] per node, the edges out of it
 * @property {Map<number, number>} [uses] per referenced ingredient (node index), how many use it
 *
 * @typedef {object} Shown A display graph and what painters read per node and edge of it.
 * @property {DisplayGraph} graph
 * @property {Looks} looks
 * @property {Float32Array} shade  per node, 0–1: how lit it is
 * @property {Float32Array} appear per node, 0–1: how far it has faded in
 */
/**
 * How every node and edge looks: each element's own `style` (from the model) first, then the view's node and edge
 * options (sizing, colouring rules, defaults), then the theme (the palette, and the colours of options left at their
 * defaults). Per node: radius, fill, shape, stroke colour (null for none) and width, icon (a URL or an image, null
 * for none). Per edge: colour and width. patchLooks redoes some of them in place.
 * @param {DisplayGraph} graph
 * @param {Record<string, any>} node the node options (NODE_OPTIONS, resolved)
 * @param {Record<string, any>} edge the edge options (EDGE_OPTIONS, resolved)
 * @param {import("./theme.js").Theme} [theme]
 * @returns {Looks}
 */
export declare function looksOf(
  graph: DisplayGraph,
  node: Record<string, any>,
  edge: Record<string, any>,
  theme?: import("./theme.js").Theme,
): Looks;
/**
 * Redo the looks of nodes `nodes` and edges `edges` (indices) in place, after their own styles changed: a restyle of
 * a few elements costs what they do, not the whole graph. Edges coloured by their child (or parent) follow it.
 * The options and theme must be the ones `looks` was made with (new ones need a whole new looksOf).
 * @returns {{ nodes: Int32Array, edges: Int32Array }} every node and edge whose look was redone, ascending
 */
export declare function patchLooks(
  looks: any,
  graph: any,
  node: any,
  edge: any,
  nodes: any,
  edges?: any[],
): {
  nodes: Int32Array;
  edges: Int32Array;
};
/** A border's dash styles, as the ids looks and the node shader use. */
export declare const STROKE_STYLES: {
  solid: number;
  dashed: number;
  dotted: number;
};
/**
 * The marks round a node, in proportion to its radius r (world px), with a floor so small nodes still show them:
 * the ring (gap outside the shape, and width), the aura's reach, the stacked copy's shift (right and up), the badge
 * image (its centre along the top-right diagonal, and radius), and the border's dashes (how many round the shape,
 * and the part of each that's drawn). The WebGL painter's shader reads the same numbers.
 */
export declare const MARKS: {
  ringGap: number;
  ringGapMin: number;
  ringWidth: number;
  ringWidthMin: number;
  auraReach: number;
  auraReachMin: number;
  stackShift: number;
  badgeAt: number;
  badgeRadius: number;
  dashes: number;
  dashOn: number;
  dots: number;
  dotOn: number;
};
/** A ring's gap outside the shape and its width, for radius r. */
export declare const ringOf: (r: any) => number[];
/** How far an aura reaches past the shape, for radius r. */
export declare const auraOf: (r: any) => number;
/**
 * How edges are dashed and dotted: a dash's period (world px: at least dashMin, or dashPerWidth times the edge's
 * width) and the part of it that's drawn; a dot's spacing likewise. Both painters use these.
 */
export declare const EDGE_DASH: {
  dashMin: number;
  dashPerWidth: number;
  dashOn: number;
  dotMin: number;
  dotPerWidth: number;
};
/** For an edge `width` wide (world px): its dash period and the part drawn, and its dot spacing. */
export declare function edgeDashes(width: any): {
  dashPeriod: number;
  dashOn: number;
  dotPeriod: number;
};
/** How far an edge's glow reaches past its side, for an edge `width` wide (world px), and how strong it starts. */
export declare const glowReach: (width: any) => number;
export declare const GLOW_ALPHA = 0.45;
/**
 * Draw one whole frame on one 2D canvas (the Canvas 2D painter's): background, edges, nodes, selection halos, the
 * reference chips' link glyphs, text.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("./controller.js").Scene} scene
 */
export declare function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: import("./controller.js").Scene,
  icons?: any,
): void;
/** A selected node's halo: a ring this many CSS px outside its shape, this many wide, in the node's colour. */
export declare const HALO_GAP = 3;
export declare const HALO_WIDTH = 2;
/**
 * A halo round each selected node: the exact outline of its shape pushed out by the gap (so corners come out
 * round), stroked. The WebGL painter draws the same ring as a distance field (HALO_FRAGMENT).
 */
export declare function drawHalos(ctx: any, scene: any): void;
/** Fill the canvas with `colour`, or clear it to transparent when there's none. */
export declare function clearTo(
  ctx: any,
  {
    width,
    height,
    dpr,
  }: {
    dpr: any;
    height: any;
    width: any;
  },
  colour: any,
): void;
/**
 * How visible things are: faded in (`scene.appear`, 0–1 per node, for nodes arriving) and lit or dimmed by hover
 * (`scene.shade`, 0–1 per node, 1 lit). `scene.dim` is how far a fully dimmed thing fades; edges and labels fade a
 * little further than nodes so the lit lineage stands out. Either array may be missing (everything 1).
 */
export declare function nodeAlpha(scene: any, i: any): number;
export declare function labelAlpha(scene: any, i: any): number;
export declare function edgeAlpha(scene: any, e: any): number;
/**
 * Every node: its fill, its icon (from `icons`, once loaded, clipped to the shape), its border, its outline. Icons
 * still loading leave the node as it is without one.
 */
export declare function drawNodes(ctx: any, scene: any, icons?: any): void;
/** The Canvas 2D dash pattern for a border style (STROKE_STYLES) round a shape of radius r, or [] for solid. */
export declare function dashPattern(style: any, shape: any, r: any): number[];
/** How many rings the Canvas 2D painter builds an aura from, and how strong an aura is at the shape's edge. */
export declare const AURA_RINGS = 10;
export declare const AURA_ALPHA = 0.6;
/** How far a stacked copy's fill goes toward the background (so it reads as behind). */
export declare const STACK_FADE = 0.45;
/** The Canvas 2D painter: everything on the renderer's canvas. Also the reference the WebGL painter is checked against. */
export declare class CanvasPainter {
  name: string;
  ctx: CanvasRenderingContext2D;
  icons: import("./icons.js").IconStore;
  /** Set by the renderer: asks for a frame (an icon came in). */
  wake: any;
  unlisten: () => boolean;
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ icons?: import("./icons.js").IconStore }} [options] where icons come from (default: the page's shared
   *   store)
   */
  constructor(
    canvas: HTMLCanvasElement,
    {
      icons,
    }?: {
      icons?: import("./icons.js").IconStore;
    },
  );
  resize(): void;
  draw(scene: any): void;
  dispose(): void;
}
