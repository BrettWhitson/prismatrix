/**
 * A card's parts, world px: its corner radius, the stripe in the node's colour down its left edge, how far its
 * icon sits in from its edge, its border's width, and the room at the right end of its text.
 */
export declare const CARD: {
  corner: number;
  stripe: number;
  inset: number;
  border: number;
  pad: number;
};
/** A card's text lines, as shares of the label size: the title, the subtitle and the value, and the line spacing. */
export declare const CARD_TEXT: {
  title: number;
  subtitle: number;
  value: number;
  tag: number;
  line: number;
};
/**
 * A card's box relative to its node's centre (its icon's): left, top, width, height; and its icon's radius.
 * @param {Record<string, any>} node the node options (cardWidth, cardHeight)
 */
export declare function cardBox(node: Record<string, any>): {
  x: number;
  y: number;
  width: any;
  height: any;
  half: number;
  icon: number;
};
/** Where a card's text starts, relative to its node's centre, and how wide it may run. */
export declare function cardTextArea(node: any): {
  x: number;
  width: number;
};
/**
 * A card line (CardText in model.js) as runs: each `{ text, colour }` (colour null for the line's own), a mark as a
 * small square and a dot as a small disc, written with their glyphs.
 * @param {any} line
 * @returns {{ text: string, colour: string | null }[]}
 */
export declare function cardRuns(line: any): {
  text: string;
  colour: string | null;
}[];
