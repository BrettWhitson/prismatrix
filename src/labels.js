// Text over the graph, worked out once for both painters:
//
// - node labels, cut to the `labelMaxWidth` node option with an ellipsis (the room the layout kept is for the same
//   text: fitLabel in boxes.js);
// - edge labels: an edge's own `label` (a quantity, "×3"), small, beside the edge near its target (or halfway, the
//   `labels` edge option; halfway too where several edges come into one node, so their labels don't pile up);
// - "×N" beside a shared ingredient that has references (N: how many use it);
// - badges, in pills at a node's top corners: a collapsed node's fold mark ("+N", from `scene.collapsed` and
//   `scene.hidden`) and the node's own style `badge` (the app's text);
// - pinned labels, which stay when the others are too small to show: the roots (a handful at most), nodes whose
//   style pins theirs (`pinLabel`), the selection and the hovered node (whole, never cut short), and the hovered
//   ingredient's name on each of its chips. Too small to read, they're drawn at PINNED_PX on screen instead,
//   whatever the zoom.
//
// Each is a TextItem: the text, its size, where it's anchored and how it's aligned there (as Canvas 2D aligns
// text), how visible, and its colours. Every piece of text has a halo (a stroke in the background colour round its
// glyphs), so edges crossing it don't cut the letters; a badge sits on a pill instead. The Canvas 2D painter writes
// items with fillText (render.js); the WebGL painter cuts them from its atlas (gl-text.js). Both place them by
// textBox, so they agree.
//
// Pure: no DOM, no GL. Text is measured by the painter, the way it draws it (`fit`).

import { fitLabel, labelAnchor, reach } from "./boxes.js";
import {
  fanJunctions,
  pathLength,
  startTrims,
  trimmedRoute,
} from "./geometry.js";
import { ringStroke } from "./references.js";
import { edgeAlpha, labelAlpha, nodeAlpha } from "./render.js";
import { DEFAULT_THEME } from "./theme.js";
import { labelPlace } from "./style.js";
import { CARD_TEXT, cardBox, cardRuns, cardTextArea } from "./cards.js";

/** The font for text `px` high (bold, for a card's title). */
export const font = (px, bold = false) =>
  `${bold ? "600 " : ""}${px}px system-ui, sans-serif`;

/** How far a halo reaches past the glyphs, as a share of the font size (the stroke is twice this wide). */
export const TEXT_HALO = 0.2;
/** Pinned labels are never drawn smaller than this many CSS px. */
export const PINNED_PX = 10;
/** Roots are pinned only when there are at most this many (a forest of recipes would bury the view). */
const PINNED_ROOTS = 12;
/** Text smaller than this many CSS px is never drawn. */
const LABEL_MIN_PX = 2;
/** Edge labels' size as a share of the node label size; hidden when smaller than EDGE_LABEL_MIN_PX on screen. */
export const EDGE_LABEL_SCALE = 0.85;
const EDGE_LABEL_MIN_PX = 6;
/** Room between an edge and its label, world px (past the edge's half-width). */
const EDGE_LABEL_GAP = 3;
/** How far back from its end an edge's label sits, in its font sizes (clear of the target's badge). */
export const EDGE_LABEL_BACK = 1.6;
/** Badges' and usage counts' size as a share of the label size; hidden when smaller than SMALL_MIN_PX on screen. */
const SMALL_SCALE = 0.8;
const SMALL_MIN_PX = 5;
/** A badge's pill: padding either side of the text and height, as shares of its font size. */
export const PILL = { pad: 0.45, height: 1.35 };
/** How far quieter text (edge labels, counts) is taken from the text colour towards the background. */
const QUIET = 0.28;

/** `a` taken `f` of the way to `b` ("#rrggbb" both). */
function mix(a, b, f) {
  const x = parseInt(a.slice(1), 16),
    y = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const p = (x >> shift) & 255,
      q = (y >> shift) & 255;
    out |= Math.round(p + (q - p) * f) << shift;
  }
  return `#${out.toString(16).padStart(6, "0")}`;
}

/**
 * The colours text is drawn in, from the scene's theme (theme.js): `label` (the theme's text; an app badge's pill
 * too), `quiet` (edge labels and counts: the text a little towards the background), `halo` (the theme's textHalo),
 * `pillText` (a badge's text, the background).
 * @returns {{ label: string, quiet: string, halo: string, pillText: string }}
 */
export function textColours(theme = DEFAULT_THEME) {
  return {
    label: theme.text,
    quiet: mix(theme.text, theme.background, QUIET),
    halo: theme.textHalo ?? theme.background,
    pillText: theme.background,
  };
}

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
 * @property {boolean} [bold]   a card's title
 */

/**
 * Real node `i`'s badges: the fold mark of a collapsed node (`scene.collapsed`, `scene.hidden`: "+N" for N nodes
 * hidden below it, a dimmer "+" when nothing is), in a pill of the node's colour at its top right; and the node's
 * own style `badge` (the app's text) in a pill of the label colour, at its top right, or top left when the fold
 * mark is there.
 * @returns {{ text: string, side: "right" | "left", fold: boolean }[]}
 */
export function badgesOf(scene, i) {
  const out = [];
  if (scene.collapsed?.[i]) {
    const hidden = scene.hidden?.[i] ?? 0;
    out.push({
      text: hidden > 0 ? `+${hidden}` : "+",
      side: "right",
      fold: true,
    });
  }
  const own = scene.graph.nodes[i]?.style?.badge;
  if (own) out.push({ text: own, side: out.length ? "left" : "right" });
  return out;
}

/**
 * Where an item sits relative to its anchor, in its units, for text `width` wide: the left edge, vertical middle,
 * width and height of what's drawn (the pill, for a badge), and where its text starts (`text`). Both painters
 * write text left-aligned on its middle line from here.
 */
export function textBox(item, width) {
  const { size } = item;
  const pad = item.pill ? PILL.pad * size : 0;
  const w = width + pad * 2;
  const h = item.pill ? PILL.height * size : size;
  const left = item.align === "left" ? 0 : item.align === "right" ? -w : -w / 2;
  const middle =
    item.baseline === "top" ? h / 2 : item.baseline === "bottom" ? -h / 2 : 0;
  return { left, middle, width: w, height: h, text: left + pad };
}

/**
 * Where an edge's label goes along its route `pts` (flat x, y, already trimmed off its nodes): `back` from the end
 * ("target"), or halfway ("middle"); beside the edge, `gap` off it, to its right (above it, for an edge running
 * across), aligned away from it. Null for a route with no length.
 * @returns {{ x: number, y: number, align: string, baseline: string } | null}
 */
export function edgeLabelAt(pts, place, back, gap) {
  const total = pathLength(pts);
  if (!(total > 0)) return null;
  const at = place === "middle" ? total / 2 : Math.max(total / 2, total - back);
  let walked = 0,
    x = pts[0],
    y = pts[1],
    dx = 1,
    dy = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const len = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (len === 0) continue;
    dx = (pts[i] - pts[i - 2]) / len;
    dy = (pts[i + 1] - pts[i - 1]) / len;
    if (walked + len >= at) {
      const f = (at - walked) / len;
      x = pts[i - 2] + (pts[i] - pts[i - 2]) * f;
      y = pts[i - 1] + (pts[i + 1] - pts[i - 1]) * f;
      break;
    }
    walked += len;
    x = pts[i];
    y = pts[i + 1];
  }
  // The side: the normal pointing right, or up for an edge running across.
  let nx = -dy,
    ny = dx;
  if (Math.abs(nx) < 0.2 ? ny > 0 : nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  return {
    x: x + nx * gap,
    y: y + ny * gap,
    align: nx > 0.35 ? "left" : nx < -0.35 ? "right" : "center",
    baseline: ny > 0.35 ? "top" : ny < -0.35 ? "bottom" : "middle",
  };
}

/**
 * Whether labels show at this zoom. Labels with room kept for them (label collision) show until their text is
 * smaller than LABEL_MIN_PX (a smudge, and with a whole big graph in view, tens of thousands of them to rasterise);
 * others drop out when too small to read (6 px).
 */
export function labelsShown(node, camera) {
  if (labelPlace(node) === "off") return false;
  return node.labelSize * camera.k >= (node.labelCollide ? LABEL_MIN_PX : 6);
}

/** What text shows at this zoom: node labels, edge labels, small text (badges, counts), pinned at world size. */
export function textVisibility(scene) {
  const { node, edge, camera } = scene;
  const k = camera.k;
  return {
    labels: labelsShown(node, camera),
    edges:
      edge.labels !== "off" &&
      node.labelSize * EDGE_LABEL_SCALE * k >= EDGE_LABEL_MIN_PX,
    small: node.labelSize * SMALL_SCALE * k >= SMALL_MIN_PX,
    pinnedWorld: node.labelSize * k >= PINNED_PX,
  };
}

/**
 * The real nodes whose labels are pinned, in drawing order, each with whether it's shown whole (the hovered one):
 * the roots (if there are at most PINNED_ROOTS), nodes whose style pins their label (`pinLabel`), the selection, the
 * hovered node last.
 * @returns {Map<number, boolean>}
 */
export function pinnedNodes(scene) {
  const { graph } = scene;
  const real = Math.min(scene.matrix?.count ?? Infinity, graph.nodes.length);
  const out = new Map();
  const roots = graph.roots ?? [];
  if (roots.length <= PINNED_ROOTS)
    for (const r of roots) if (r < real) out.set(r, false);
  for (let i = 0; i < real; i++)
    if (graph.nodes[i].style?.pinLabel) out.set(i, false);
  const selected = scene.selected;
  if (selected)
    for (let i = 0; i < Math.min(selected.length, real); i++)
      if (selected[i]) out.set(i, false);
  const hover = scene.hover ?? -1;
  if (hover >= 0 && hover < real) {
    out.delete(hover);
    out.set(hover, true);
  }
  return out;
}

/**
 * A label fitter for a painter: `fit(text, size, max)` is `text` cut to `max` world px at font size `size`
 * (fitLabel), measured with `measure(text, size)`, each answer kept.
 * @param {(text: string, size: number) => number} measure
 * @returns {(text: string, size: number, max: number) => string}
 */
export function textFitter(measure) {
  const fits = new Map();
  return (text, size, max) => {
    if (!(max > 0)) return text;
    const key = `${size}|${max}|${text}`;
    let out = fits.get(key);
    if (out === undefined) {
      if (fits.size > 50000) fits.clear();
      out = fitLabel(text, max, (t) => measure(t, size)).text;
      fits.set(key, out);
    }
    return out;
  };
}

/**
 * Text measurement on 2D context `ctx`: `measure(text, size)`, each width kept, and a label fitter on it
 * (textFitter).
 */
export function textMeasurer(ctx) {
  const widths = new Map();
  const measure = (text, size) => {
    const key = `${size}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (widths.size > 50000) widths.clear();
      ctx.font = font(size);
      w = ctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };
  return { measure, fit: textFitter(measure) };
}

/** About the box an item takes (world px), with text estimated at 0.6 font sizes a character: for keeping clear. */
function roughBox(item) {
  const box = textBox(item, Array.from(item.text).length * 0.6 * item.size);
  const x0 = item.x + box.left,
    y0 = item.y + box.middle - box.height / 2;
  return { x0, y0, x1: x0 + box.width, y1: y0 + box.height };
}

/** Boxes taken so far, hashed into square cells `cell` wide, to find overlaps quickly. */
export class Room {
  constructor(cell) {
    this.cell = cell;
    this.cells = new Map();
  }

  /** Take `box` if it overlaps nothing taken yet. Returns whether it was taken. */
  take(box) {
    const c = this.cell;
    const i0 = Math.floor(box.x0 / c),
      i1 = Math.floor(box.x1 / c),
      j0 = Math.floor(box.y0 / c),
      j1 = Math.floor(box.y1 / c);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (const b of this.cells.get(`${i},${j}`) ?? [])
          if (b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)
            return false;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        if (list) list.push(box);
        else this.cells.set(key, [box]);
      }
    return true;
  }
}

/**
 * Every piece of text to draw this frame, in drawing order (edge labels, node labels, counts and badges, pinned
 * labels on top). Only what's anchored in `near` (a world rectangle; everything without it), except pinned labels.
 * @param {import("./controller.js").Scene} scene
 * @param {{ fit: (text: string, size: number, max: number) => string,
 *   measure?: (text: string, size: number) => number,
 *   near?: { x0: number, y0: number, x1: number, y1: number } | null }} options
 * @returns {TextItem[]}
 */
export function planText(scene, { fit, measure = null, near = null }) {
  const { graph, node, edge, looks } = scene;
  const items = [];
  const show = textVisibility(scene);
  const colours = textColours(scene.theme ?? DEFAULT_THEME);
  const under = colours.halo;
  const inside = near
    ? (n) =>
        n.x >= near.x0 && n.x <= near.x1 && n.y >= near.y0 && n.y <= near.y1
    : () => true;
  const reachOf = (i) => looks.radius[i] * reach(looks.shape[i]);
  const real = Math.min(scene.matrix?.count ?? Infinity, graph.nodes.length);
  const labelled = labelPlace(node) !== "off";
  const max = node.labelMaxWidth ?? 0;
  const pinned = labelled ? pinnedNodes(scene) : new Map();

  // Counts and badges are worked out first (they're drawn later, over the labels) so edge labels can keep clear of
  // them.
  const small = [];
  if (show.small) {
    const size = node.labelSize * SMALL_SCALE;
    for (const [i, count] of graph.uses ?? []) {
      const n = graph.nodes[i];
      if (!n || !inside(n)) continue;
      const alpha = labelAlpha(scene, i);
      if (alpha <= 0) continue;
      // On the node's left: edge labels sit on the right of the edges coming in.
      small.push({
        text: `×${count}`,
        size,
        screen: false,
        x: n.x - reachOf(i) - EDGE_LABEL_GAP,
        y: n.y,
        align: "right",
        baseline: "middle",
        alpha,
        colour: colours.quiet,
        under,
        pill: false,
      });
    }
    // Real nodes, and copies of them (references "crossing"): their badges too.
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      if (i >= real && !n.copy) continue;
      if (!scene.collapsed?.[i] && !n.style?.badge) continue;
      if (!inside(n)) continue;
      const alpha = nodeAlpha(scene, i);
      if (alpha <= 0) continue;
      const r = reachOf(i);
      for (const b of badgesOf(scene, i)) {
        const right = b.side === "right";
        small.push({
          text: b.text,
          size,
          screen: false,
          x: n.x + (right ? r : -r) * 0.55,
          y: n.y - r * 0.55,
          align: right ? "left" : "right",
          baseline: "bottom",
          alpha: b.fold && b.text === "+" ? alpha * 0.6 : alpha,
          colour: colours.pillText,
          under: b.fold ? looks.fill[i] : colours.label,
          pill: true,
        });
      }
    }
  }

  if (show.edges) {
    const size = node.labelSize * EDGE_LABEL_SCALE;
    const place = edge.labels === "middle" ? "middle" : "target";
    const taken = new Room(size * 4);
    for (const item of small) taken.take(roughBox(item));
    let starts = null,
      junctions = null,
      into = null;
    for (let ei = 0; ei < graph.edges.length; ei++) {
      const e = graph.edges[ei];
      if (!e.label) continue;
      const s = graph.nodes[e.source],
        t = graph.nodes[e.target];
      if (!inside(s) && !inside(t)) continue;
      const alpha = edgeAlpha(scene, e);
      if (alpha <= 0) continue;
      if (!starts) {
        starts = startTrims(scene);
        if (edge.shape === "fan")
          junctions = fanJunctions(graph, scene.routing);
        into = new Uint32Array(graph.nodes.length);
        for (const f of graph.edges) into[f.target]++;
      }
      const pts = trimmedRoute(scene, ei, junctions, starts);
      if (!pts) continue;
      const gap = EDGE_LABEL_GAP + looks.edgeWidth[ei] / 2;
      const where = into[e.target] > 1 ? "middle" : place;
      // Near the target, a label in the way of a badge or another label moves back along its edge; where edges
      // run together (bundles, shared ends), the first label there is enough.
      for (const back of where === "target" ? [1, 1.7, 2.4] : [1]) {
        const at = edgeLabelAt(pts, where, size * EDGE_LABEL_BACK * back, gap);
        if (!at) break;
        const item = {
          text: e.label,
          size,
          screen: false,
          ...at,
          alpha,
          colour: colours.quiet,
          under,
          pill: false,
        };
        if (!taken.take(roughBox(item))) continue;
        items.push(item);
        break;
      }
    }
  }

  // A label `r` from node `i`'s centre, in its direction.
  const add = (i, text, r, size, screen) => {
    const n = graph.nodes[i];
    const alpha = labelAlpha(scene, i);
    if (alpha <= 0 || !text) return;
    const a = labelAnchor(n.labelAngle, r);
    items.push({
      text,
      size,
      screen,
      x: n.x + a.x,
      y: n.y + a.y,
      align: a.align,
      baseline: a.baseline,
      alpha,
      colour: colours.label,
      under,
      pill: false,
    });
  };

  const cards = node.look === "card";
  if (cards && show.labels)
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      if ((i < real || n.copy) && inside(n))
        cardText(scene, n, show.small, colours, fit, measure, items);
    }
  else if (labelled && show.labels) {
    const size = node.labelSize;
    for (const n of graph.nodes)
      if (n.label && !pinned.has(n.index) && inside(n))
        add(n.index, fit(n.label, size, max), reachOf(n.index), size, false);
  }

  items.push(...small);

  if (labelled) {
    const world = show.pinnedWorld;
    const size = world ? node.labelSize : PINNED_PX;
    // The hovered ingredient's name on each of its chips.
    const hover = scene.hover ?? -1;
    if (hover >= 0 && hover < real)
      for (let i = real; i < graph.nodes.length; i++) {
        if (graph.nodes[i].reference !== hover) continue;
        const r = looks.radius[i];
        add(i, graph.nodes[hover].label, r + ringStroke(r) / 2, size, !world);
      }
    // A card's title is inside it, and shows while it can be read.
    if (!cards)
      for (const [i, whole] of pinned) {
        const label = graph.nodes[i].label;
        const text = whole ? label : fit(label, node.labelSize, max);
        add(i, text, reachOf(i), size, !world);
      }
  }
  return items;
}

/**
 * Card `n`'s text into `items` (cards.js): its label in bold; zoomed in far enough (`detail`), its style's
 * subtitle and value under it, run by run, and its tag in a pill on the card's top edge. The text sits on the card's
 * face, so its halo is the card's colour.
 */
function cardText(scene, n, detail, colours, fit, measure, items) {
  const { node } = scene;
  const theme = scene.theme ?? DEFAULT_THEME;
  const alpha = labelAlpha(scene, n.index);
  if (alpha <= 0) return;
  const style = n.style ?? {};
  const area = cardTextArea(node);
  const box = cardBox(node);
  const size = node.labelSize;
  const lines = [];
  if (detail) {
    const subtitle = cardRuns(style.subtitle);
    const value = cardRuns(style.value);
    if (subtitle.length)
      lines.push({
        runs: subtitle,
        size: size * CARD_TEXT.subtitle,
        colour: colours.quiet,
      });
    if (value.length)
      lines.push({
        runs: value,
        size: size * CARD_TEXT.value,
        colour: colours.label,
      });
  }
  const step = size * CARD_TEXT.line;
  // The lines centred on the card, the title first.
  let y = n.y - (lines.length * step) / 2;
  const x = n.x + area.x;
  const base = {
    screen: false,
    align: "left",
    baseline: "middle",
    alpha,
    under: theme.card,
    pill: false,
  };
  if (n.label)
    items.push({
      ...base,
      text: fit(n.label, size, area.width * 0.94),
      size,
      x,
      y,
      colour: colours.label,
      bold: true,
    });
  for (const line of lines) {
    y += step;
    let at = x;
    for (const run of line.runs) {
      if (!run.text) continue;
      const room = x + area.width - at;
      if (room <= 0) break;
      const text = measure ? fit(run.text, line.size, room) : run.text;
      items.push({
        ...base,
        text,
        size: line.size,
        x: at,
        y,
        colour: run.colour ?? line.colour,
      });
      at += measure ? measure(text, line.size) : text.length * line.size * 0.56;
    }
  }
  if (detail && style.tag)
    items.push({
      ...base,
      text: style.tag,
      size: size * CARD_TEXT.tag,
      x: n.x + box.x + box.width - 6,
      y: n.y + box.y,
      align: "right",
      colour: colours.pillText,
      under: colours.label,
      pill: true,
    });
}
