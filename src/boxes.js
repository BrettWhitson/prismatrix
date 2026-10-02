// Footprints: the box a node and its label take up, relative to the node's centre. Layouts space nodes by them
// and collision keeps them apart, so a label always has room and never has to be hidden. Long labels are cut to the
// `labelMaxWidth` option with an ellipsis (fitLabel), the same for the room kept and the text drawn, and edges start
// past their own node's label (startTrim) rather than striking through it.

import { TREE_LABEL_ANGLE } from "./layouts.js";

export const LABEL_GAP = 4;
/** Line height of a label, as a multiple of its font size. */
export const LINE = 1.25;

/** How far a shape reaches past its radius. */
const REACH = { diamond: 1.25, hexagon: 1.1 };
export const reach = (shape) => REACH[shape] ?? 1;

/** The direction a label sits in from its node, in radians (0 = right, π/2 = below). */
export function labelAngle(place, routing, x, y) {
  if (place === "right") return 0;
  if (place !== "outward") return Math.PI / 2;
  if (routing.kind === "radial") {
    const dx = x - routing.cx,
      dy = y - routing.cy;
    return Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : Math.PI / 2;
  }
  return TREE_LABEL_ANGLE[routing.direction];
}

/** Where a label is drawn from, relative to its node, and how it's aligned there. */
export function labelAnchor(angle, r) {
  const gap = r + LABEL_GAP;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  return {
    x: cos * gap,
    y: sin * gap,
    align: cos > 0.35 ? "left" : cos < -0.35 ? "right" : "center",
    baseline: sin > 0.35 ? "top" : sin < -0.35 ? "bottom" : "middle",
  };
}

/**
 * A label's own box (`w` × `h`) relative to its node's centre, for a node whose shape reaches `r` and a label at
 * `angle`: where it's drawn (labelAnchor), the label's part of the footprint.
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
export function labelRect(r, angle, w, h) {
  const a = labelAnchor(angle, r);
  const x0 =
    a.align === "left" ? a.x : a.align === "right" ? a.x - w : a.x - w / 2;
  const y0 =
    a.baseline === "top"
      ? a.y
      : a.baseline === "bottom"
        ? a.y - h
        : a.y - h / 2;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/**
 * The footprint of a node of radius `r` with a label `w` × `h` placed at `angle` (no label when `w` is 0).
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
export function footprint(r, angle, w, h) {
  if (!(w > 0)) return { x0: -r, y0: -r, x1: r, y1: r };
  const l = labelRect(r, angle, w, h);
  return {
    x0: Math.min(-r, l.x0),
    y0: Math.min(-r, l.y0),
    x1: Math.max(r, l.x1),
    y1: Math.max(r, l.y1),
  };
}

/** What a label cut short ends with. */
export const ELLIPSIS = "…";

/**
 * `text` cut to `max` wide with an ellipsis, as `width(text)` measures it: whole when it fits or when `max` is 0
 * (no limit). It's cut between characters (code points), and spaces before the ellipsis go. The layout keeps room
 * for this width and the painters draw this text, so labels and footprints agree.
 * @param {string} text
 * @param {number} max world px (0: no limit)
 * @param {(text: string) => number} width
 * @returns {{ text: string, width: number }}
 */
export function fitLabel(text, max, width) {
  const whole = width(text);
  if (!(max > 0) || whole <= max) return { text, width: whole };
  const chars = Array.from(text);
  const cut = (k) => chars.slice(0, k).join("").trimEnd() + ELLIPSIS;
  // The most characters that fit: the width grows with every character kept, so halve the range each time.
  let lo = 0,
    hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(cut(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const out = cut(lo);
  return { text: out, width: width(out) };
}

/** Room left between a label and an edge that leaves its node past it, world px. */
export const EDGE_CLEAR = 3;

/**
 * How far from its node's centre an edge leaving in direction (dx, dy) (a unit vector) starts: off the node
 * (`radius`), and if it would leave through the node's own label (`w` × `h` at `angle`, of a shape reaching `r`),
 * past the label's far side and EDGE_CLEAR more, so no edge strikes through its own label. Never more than `cap` (a
 * short edge keeps something to draw), never less than `radius`.
 */
export function startTrim(radius, r, angle, w, h, dx, dy, cap = Infinity) {
  if (!(w > 0)) return radius;
  const box = labelRect(r, angle, w, h);
  // Where the ray from the centre is inside the box on both axes (slabs): from `enter` to `leave`.
  let enter = 0,
    leave = Infinity;
  for (const [d, lo, hi] of [
    [dx, box.x0, box.x1],
    [dy, box.y0, box.y1],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (lo > 0 || hi < 0) return radius;
      continue;
    }
    const a = lo / d,
      b = hi / d;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  if (enter > leave) return radius;
  return Math.max(radius, Math.min(cap, leave + EDGE_CLEAR));
}
