/** The font for text `px` high. */
export declare const font: (px: any) => string;
/** How far a halo reaches past the glyphs, as a share of the font size (the stroke is twice this wide). */
export declare const TEXT_HALO = 0.2;
/** Pinned labels are never drawn smaller than this many CSS px. */
export declare const PINNED_PX = 10;
/** Edge labels' size as a share of the node label size; hidden when smaller than EDGE_LABEL_MIN_PX on screen. */
export declare const EDGE_LABEL_SCALE = 0.85;
/** How far back from its end an edge's label sits, in its font sizes (clear of the target's badge). */
export declare const EDGE_LABEL_BACK = 1.6;
/** A badge's pill: padding either side of the text and height, as shares of its font size. */
export declare const PILL: {
  pad: number;
  height: number;
};
/**
 * The colours text is drawn in, from the scene's theme (theme.js): `label` (the theme's text; an app badge's pill
 * too), `quiet` (edge labels and counts: the text a little towards the background), `halo` (the theme's textHalo),
 * `pillText` (a badge's text, the background).
 * @returns {{ label: string, quiet: string, halo: string, pillText: string }}
 */
export declare function textColours(
  theme?: Readonly<import("./theme.js").Theme>,
): {
  label: string;
  quiet: string;
  halo: string;
  pillText: string;
};
export type TextItem = {
  text: string;
  /**
   * font size, in the item's units: world px, or CSS px when `screen`
   */
  size: number;
  /**
   * drawn the same size on screen at any zoom (its units are CSS px)
   */
  screen: boolean;
  /**
   * where it's anchored, world px
   */
  x: number;
  y: number;
  /**
   * as Canvas 2D's textAlign
   */
  align: "left" | "center" | "right";
  /**
   * as Canvas 2D's textBaseline (top and bottom: the em box's)
   */
  baseline: "top" | "middle" | "bottom";
  /**
   * how visible, 0–1
   */
  alpha: number;
  /**
   * the text's, "#rrggbb"
   */
  colour: string;
  /**
   * the halo's (or the pill's), "#rrggbb"
   */
  under: string;
  /**
   * a badge: the text on a pill, instead of a halo
   */
  pill: boolean;
};
/**
 * @typedef {object} TextItem
 * @property {string} text
 * @property {number} size      font size, in the item's units: world px, or CSS px when `screen`
 * @property {boolean} screen   drawn the same size on screen at any zoom (its units are CSS px)
 * @property {number} x         where it's anchored, world px
 * @property {number} y
 * @property {"left" | "center" | "right"} align        as Canvas 2D's textAlign
 * @property {"top" | "middle" | "bottom"} baseline     as Canvas 2D's textBaseline (top and bottom: the em box's)
 * @property {number} alpha     how visible, 0–1
 * @property {string} colour    the text's, "#rrggbb"
 * @property {string} under     the halo's (or the pill's), "#rrggbb"
 * @property {boolean} pill     a badge: the text on a pill, instead of a halo
 */
/**
 * Real node `i`'s badges: the fold mark of a collapsed node (`scene.collapsed`, `scene.hidden`: "+N" for N nodes
 * hidden below it, a dimmer "+" when nothing is), in a pill of the node's colour at its top right; and the node's
 * own style `badge` (the app's text) in a pill of the label colour, at its top right, or top left when the fold
 * mark is there.
 * @returns {{ text: string, side: "right" | "left", fold: boolean }[]}
 */
export declare function badgesOf(
  scene: any,
  i: any,
): {
  text: string;
  side: "right" | "left";
  fold: boolean;
}[];
/**
 * Where an item sits relative to its anchor, in its units, for text `width` wide: the left edge, vertical middle,
 * width and height of what's drawn (the pill, for a badge), and where its text starts (`text`). Both painters
 * write text left-aligned on its middle line from here.
 */
export declare function textBox(
  item: any,
  width: any,
): {
  left: number;
  middle: number;
  width: any;
  height: any;
  text: number;
};
/**
 * Where an edge's label goes along its route `pts` (flat x, y, already trimmed off its nodes): `back` from the end
 * ("target"), or halfway ("middle"); beside the edge, `gap` off it, to its right (above it, for an edge running
 * across), aligned away from it. Null for a route with no length.
 * @returns {{ x: number, y: number, align: string, baseline: string } | null}
 */
export declare function edgeLabelAt(
  pts: any,
  place: any,
  back: any,
  gap: any,
): {
  x: number;
  y: number;
  align: string;
  baseline: string;
} | null;
/**
 * Whether labels show at this zoom. Labels with room kept for them (label collision) show until their text is
 * smaller than LABEL_MIN_PX (a smudge, and with a whole big graph in view, tens of thousands of them to rasterise);
 * others drop out when too small to read (6 px).
 */
export declare function labelsShown(node: any, camera: any): boolean;
/** What text shows at this zoom: node labels, edge labels, small text (badges, counts), pinned at world size. */
export declare function textVisibility(scene: any): {
  labels: boolean;
  edges: boolean;
  small: boolean;
  pinnedWorld: boolean;
};
/**
 * The real nodes whose labels are pinned, in drawing order, each with whether it's shown whole (the hovered one):
 * the roots (if there are at most PINNED_ROOTS), nodes whose style pins their label (`pinLabel`), the selection, the
 * hovered node last.
 * @returns {Map<number, boolean>}
 */
export declare function pinnedNodes(scene: any): Map<number, boolean>;
/**
 * A label fitter for a painter: `fit(text, size, max)` is `text` cut to `max` world px at font size `size`
 * (fitLabel), measured with `measure(text, size)`, each answer kept.
 * @param {(text: string, size: number) => number} measure
 * @returns {(text: string, size: number, max: number) => string}
 */
export declare function textFitter(
  measure: (text: string, size: number) => number,
): (text: string, size: number, max: number) => string;
/**
 * Text measurement on 2D context `ctx`: `measure(text, size)`, each width kept, and a label fitter on it
 * (textFitter).
 */
export declare function textMeasurer(ctx: any): {
  measure: (text: any, size: any) => any;
  fit: (text: string, size: number, max: number) => string;
};
/** Boxes taken so far, hashed into square cells `cell` wide, to find overlaps quickly. */
export declare class Room {
  cell: any;
  cells: Map<any, any>;
  constructor(cell: any);
  /** Take `box` if it overlaps nothing taken yet. Returns whether it was taken. */
  take(box: any): boolean;
}
/**
 * Every piece of text to draw this frame, in drawing order (edge labels, node labels, counts and badges, pinned
 * labels on top). Only what's anchored in `near` (a world rectangle; everything without it), except pinned labels.
 * @param {import("./controller.js").Scene} scene
 * @param {{ fit: (text: string, size: number, max: number) => string,
 *   near?: { x0: number, y0: number, x1: number, y1: number } | null }} options
 * @returns {TextItem[]}
 */
export declare function planText(
  scene: import("./controller.js").Scene,
  {
    fit,
    near,
  }: {
    fit: (text: string, size: number, max: number) => string;
    near?: {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    } | null;
  },
): TextItem[];
