// The camera's arithmetic: a camera is { x, y, k }, the world point at the middle of the view and the scale (screen
// px per world px). Framing a graph, how far a zoom may go, zooming about a point, coasting after a pan, easing from
// one camera to another. The controller (controller.js) owns the camera and decides when each happens.
//
// Pure: no DOM.

const MAX_ZOOM = 8;
const MIN_ZOOM = 0.05; // the furthest out a zoom may go, unless the graph needs further to fit
const FIT_PAD = 40; // screen px kept clear around a framed graph
const FIT_MAX = 2.5; // the closest a fit zooms in (a tiny graph isn't blown up)

/**
 * @typedef {{ x: number, y: number, k: number }} Camera
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Box
 */

/** A canvas point (CSS px from its top-left) in world coordinates, for a `width` × `height` view. */
export function toWorld(camera, width, height, x, y) {
  return {
    x: (x - width / 2) / camera.k + camera.x,
    y: (y - height / 2) / camera.k + camera.y,
  };
}

/** A world point on the canvas (CSS px from its top-left). */
export function toScreen(camera, width, height, x, y) {
  return {
    x: (x - camera.x) * camera.k + width / 2,
    y: (y - camera.y) * camera.k + height / 2,
  };
}

/**
 * The box every node's footprint covers (matrix.js: position or home, plus its box), so labels at the edge count.
 * A node flung off to infinity is left out rather than lose the whole graph.
 * @param {import("./matrix.js").Matrix} m
 * @param {boolean} homes  where they're heading rather than where they are
 * @returns {Box}
 */
export function footprints(m, homes) {
  const xs = homes ? m.homeX : m.x,
    ys = homes ? m.homeY : m.y;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < m.count; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    minX = Math.min(minX, xs[i] + m.boxX0[i]);
    minY = Math.min(minY, ys[i] + m.boxY0[i]);
    maxX = Math.max(maxX, xs[i] + m.boxX1[i]);
    maxY = Math.max(maxY, ys[i] + m.boxY1[i]);
  }
  if (minX > maxX) minX = minY = maxX = maxY = 0;
  return { minX, minY, maxX, maxY };
}

/** The scale that fits `box` (world px), with padding, in a `width` × `height` view: at most FIT_MAX. */
function fitScale({ minX, minY, maxX, maxY }, width, height) {
  return Math.min(
    (width - FIT_PAD * 2) / Math.max(maxX - minX, 1),
    (height - FIT_PAD * 2) / Math.max(maxY - minY, 1),
    FIT_MAX,
  );
}

/**
 * A camera framing `box`. However wide the graph, it fits: no floor but a tiny one that keeps the arithmetic finite.
 * @returns {Camera}
 */
export function framing(box, width, height) {
  return {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    k: Math.max(fitScale(box, width, height), 1e-6),
  };
}

/**
 * How far a zoom may go: in to MAX_ZOOM, out to MIN_ZOOM or further if that's what it takes to see the whole graph
 * (`box`, its homes; half its fit, so there's room around it).
 */
export function zoomLimits(box, width, height) {
  const fit = box ? fitScale(box, width, height) : MIN_ZOOM;
  return { min: Math.min(MIN_ZOOM, fit / 2), max: MAX_ZOOM };
}

/**
 * `camera` zoomed by `factor` about canvas point (x, y), within `limits`, keeping the world point under (x, y) in
 * place. Changes `camera`.
 */
export function zoomAbout(camera, width, height, factor, x, y, { min, max }) {
  const before = toWorld(camera, width, height, x, y);
  camera.k = Math.min(Math.max(camera.k * factor, min), max);
  const after = toWorld(camera, width, height, x, y);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
}

/** `f` of the way from one camera to another (zoom in log space, so it feels even). */
export function between(from, to, f) {
  return {
    x: from.x + (to.x - from.x) * f,
    y: from.y + (to.y - from.y) * f,
    k: from.k * (to.k / from.k) ** f,
  };
}

/**
 * `camera` coasting at `glide` (world px/s) for `dt` s, slowed by `friction` (the physics mode's, so the camera
 * and the nodes slow alike). Changes both; returns false once it has stopped.
 */
export function coast(camera, glide, friction, dt) {
  const keep = Math.exp(-friction * dt);
  const speed = Math.hypot(glide.x, glide.y);
  const slowed = Math.max(speed * keep - friction * 6 * dt, 0);
  if (slowed < 2) return false;
  glide.x *= slowed / speed;
  glide.y *= slowed / speed;
  camera.x += glide.x * dt;
  camera.y += glide.y * dt;
  return true;
}
