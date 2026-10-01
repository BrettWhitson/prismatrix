// Footprints: the box a node and its label take up, relative to the node's centre. Layouts space nodes by them
// and collision keeps them apart, so a label always has room and never has to be hidden.

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
  return { TB: Math.PI / 2, BT: -Math.PI / 2, LR: 0, RL: Math.PI }[
    routing.direction
  ];
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
 * The footprint of a node of radius `r` with a label `w` × `h` placed at `angle` (no label when `w` is 0).
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
export function footprint(r, angle, w, h) {
  const box = { x0: -r, y0: -r, x1: r, y1: r };
  if (!(w > 0)) return box;
  const a = labelAnchor(angle, r);
  const x0 =
    a.align === "left" ? a.x : a.align === "right" ? a.x - w : a.x - w / 2;
  const y0 =
    a.baseline === "top"
      ? a.y
      : a.baseline === "bottom"
        ? a.y - h
        : a.y - h / 2;
  box.x0 = Math.min(box.x0, x0);
  box.y0 = Math.min(box.y0, y0);
  box.x1 = Math.max(box.x1, x0 + w);
  box.y1 = Math.max(box.y1, y0 + h);
  return box;
}
