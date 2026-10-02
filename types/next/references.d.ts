/** How big a reference is drawn, relative to its ingredient (and never bigger than the room the layout kept). */
export declare const REFERENCE_SCALE = 0.7;
/** A reference's chip radius: its ingredient's, scaled down, within the room the layout kept for it. */
export declare function referenceRadius(
  ref: any,
  ingredientRadius: any,
): number;
/**
 * The link glyph, in units of its radius, before it's turned 45° (lying from lower left to upper right): two
 * stadiums (rounded bars) `length` × `height`, their centres `offset` either side of the middle, stroked `stroke`
 * wide. The Canvas 2D painter strokes them as rounded rectangles; the WebGL one draws the same as a distance field
 * (GLYPH_FRAGMENT).
 */
export declare const LINK: {
  offset: number;
  length: number;
  height: number;
  stroke: number;
};
/** A chip's ring is this wide (as Canvas 2D strokes a ring node; the node shader's ringHalfStroke is half). */
export declare const ringStroke: (r: any) => number;
/** The link glyph's radius inside a chip of radius `r`: the ring's hole, less a little room. */
export declare const glyphRadius: (r: any) => number;
/** A glyph is drawn once it's at least this many CSS px across (radius), else the chip is just its ring. */
export declare const GLYPH_MIN_PX = 2.5;
/**
 * Where to draw link glyphs this frame: one per chip (display-only node with a `reference`) whose glyph is at
 * least `minimum` CSS px (radius) on screen, in its ingredient's colour.
 * @returns {{ index: number, x: number, y: number, radius: number, colour: string }[]}
 */
export declare function linkGlyphs(
  scene: any,
  minimum?: number,
): {
  index: number;
  x: number;
  y: number;
  radius: number;
  colour: string;
}[];
/**
 * The display graph with references: `graph`'s nodes plus one per reference, and its edges with each referenced
 * one ending at its reference (same index, so per-edge looks still line up). Per-node arrays are extended to match.
 * The display graph's `uses` maps each referenced ingredient's index to its in-degree.
 * @param {import("./render.js").DisplayGraph} graph the real graph
 * @param {import("./layered.js").Reference[] | undefined} references from the layout (layered.js)
 * @param {Omit<import("./render.js").Shown, "graph">} base for the real graph
 * @returns {import("./render.js").Shown}
 */
export declare function withReferences(
  graph: import("./render.js").DisplayGraph,
  references: import("./layered.js").Reference[] | undefined,
  base: Omit<import("./render.js").Shown, "graph">,
): import("./render.js").Shown;
