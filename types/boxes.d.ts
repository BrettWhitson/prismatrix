export declare const LABEL_GAP = 4;
/** Line height of a label, as a multiple of its font size. */
export declare const LINE = 1.25;
export declare const reach: (shape: any) => any;
/** The direction a label sits in from its node, in radians (0 = right, π/2 = below). */
export declare function labelAngle(
  place: any,
  routing: any,
  x: any,
  y: any,
): any;
/** Where a label is drawn from, relative to its node, and how it's aligned there. */
export declare function labelAnchor(
  angle: any,
  r: any,
): {
  x: number;
  y: number;
  align: string;
  baseline: string;
};
/**
 * A label's own box (`w` × `h`) relative to its node's centre, for a node whose shape reaches `r` and a label at
 * `angle`: where it's drawn (labelAnchor), the label's part of the footprint.
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
export declare function labelRect(
  r: any,
  angle: any,
  w: any,
  h: any,
): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
/**
 * The footprint of a node of radius `r` with a label `w` × `h` placed at `angle` (no label when `w` is 0).
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
export declare function footprint(
  r: any,
  angle: any,
  w: any,
  h: any,
): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
/** What a label cut short ends with. */
export declare const ELLIPSIS = "\u2026";
/**
 * `text` cut to `max` wide with an ellipsis, as `width(text)` measures it: whole when it fits or when `max` is 0
 * (no limit). It's cut between characters (code points), and spaces before the ellipsis go. The layout keeps room
 * for this width and the painters draw this text, so labels and footprints agree.
 * @param {string} text
 * @param {number} max world px (0: no limit)
 * @param {(text: string) => number} width
 * @returns {{ text: string, width: number }}
 */
export declare function fitLabel(
  text: string,
  max: number,
  width: (text: string) => number,
): {
  text: string;
  width: number;
};
/** Room left between a label and an edge that leaves its node past it, world px. */
export declare const EDGE_CLEAR = 3;
/**
 * How far from its node's centre an edge leaving in direction (dx, dy) (a unit vector) starts: off the node
 * (`radius`), and if it would leave through the node's own label (`w` × `h` at `angle`, of a shape reaching `r`),
 * past the label's far side and EDGE_CLEAR more, so no edge strikes through its own label. Never more than `cap` (a
 * short edge keeps something to draw), never less than `radius`.
 */
export declare function startTrim(
  radius: any,
  r: any,
  angle: any,
  w: any,
  h: any,
  dx: any,
  dy: any,
  cap?: number,
): any;
