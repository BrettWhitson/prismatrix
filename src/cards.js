// Cards (the `look` node option): each node is a rounded box holding its icon on the left and its text to the right:
// its label in bold, then its style's `subtitle` and `value` (text, or runs of coloured text, marks and dots), with
// its `tag` in a pill on the top edge. Every card is the same size (cardWidth × cardHeight), so layouts space them
// as nodes with a label beside them: the icon is the node, the text its label (cardTextWidth in model.js).
//
// A node's centre is its icon's centre: the card reaches its half height every way from there, and on to the right
// for its width. Marks, halos and edges go round the card rather than the icon.
//
// Pure: no DOM.

import { LABEL_GAP } from "./boxes.js";

/**
 * A card's parts, world px: its corner radius, the stripe in the node's colour down its left edge, how far its
 * icon sits in from its edge, its border's width, and the room at the right end of its text.
 */
export const CARD = { corner: 8, stripe: 4, inset: 8, border: 1, pad: 8 };

/** A card's text lines, as shares of the label size: the title, the subtitle and the value, and the line spacing. */
export const CARD_TEXT = {
  title: 1,
  subtitle: 0.85,
  value: 0.9,
  tag: 0.72,
  line: 1.35,
};

/**
 * A card's box relative to its node's centre (its icon's): left, top, width, height; and its icon's radius.
 * @param {Record<string, any>} node the node options (cardWidth, cardHeight)
 */
export function cardBox(node) {
  const half = node.cardHeight / 2;
  return {
    x: -half,
    y: -half,
    width: node.cardWidth,
    height: node.cardHeight,
    half,
    icon: Math.max(4, half - CARD.inset),
  };
}

/** Where a card's text starts, relative to its node's centre, and how wide it may run. */
export function cardTextArea(node) {
  const half = node.cardHeight / 2;
  return {
    x: half + LABEL_GAP,
    width: Math.max(0, node.cardWidth - node.cardHeight - LABEL_GAP - CARD.pad),
  };
}

/**
 * A card line (CardText in model.js) as runs: each `{ text, colour }` (colour null for the line's own), a mark as a
 * small square and a dot as a small disc, written with their glyphs.
 * @param {any} line
 * @returns {{ text: string, colour: string | null }[]}
 */
export function cardRuns(line) {
  if (line === undefined || line === null || line === "") return [];
  if (typeof line === "string") return [{ text: line, colour: null }];
  return line.map((run) =>
    typeof run === "string"
      ? { text: run, colour: null }
      : run.mark
        ? { text: "■", colour: run.mark }
        : run.dot
          ? { text: "●", colour: run.dot }
          : { text: run.text, colour: run.color ?? null },
  );
}
