export declare const MAX_ZOOM = 8;
export declare const MIN_ZOOM = 0.05;
export type Camera = {
  x: number;
  y: number;
  k: number;
};
export type Box = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
/**
 * @typedef {{ x: number, y: number, k: number }} Camera
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Box
 */
/** A canvas point (CSS px from its top-left) in world coordinates, for a `width` × `height` view. */
export declare function toWorld(
  camera: any,
  width: any,
  height: any,
  x: any,
  y: any,
): {
  x: any;
  y: any;
};
/** A world point on the canvas (CSS px from its top-left). */
export declare function toScreen(
  camera: any,
  width: any,
  height: any,
  x: any,
  y: any,
): {
  x: number;
  y: number;
};
/**
 * The box every node's footprint covers (matrix.js: position or home, plus its box), so labels at the edge count.
 * A node flung off to infinity is left out rather than lose the whole graph.
 * @param {import("./matrix.js").Matrix} m
 * @param {boolean} homes  where they're heading rather than where they are
 * @returns {Box}
 */
export declare function footprints(
  m: import("./matrix.js").Matrix,
  homes: boolean,
): Box;
/** The scale that fits `box` (world px), with padding, in a `width` × `height` view: at most FIT_MAX. */
export declare function fitScale(
  {
    minX,
    minY,
    maxX,
    maxY,
  }: {
    maxX: any;
    maxY: any;
    minX: any;
    minY: any;
  },
  width: any,
  height: any,
): number;
/**
 * A camera framing `box`. However wide the graph, it fits: no floor but a tiny one that keeps the arithmetic finite.
 * @returns {Camera}
 */
export declare function framing(box: any, width: any, height: any): Camera;
/**
 * How far a zoom may go: in to MAX_ZOOM, out to MIN_ZOOM or further if that's what it takes to see the whole graph
 * (`box`, its homes; half its fit, so there's room around it).
 */
export declare function zoomLimits(
  box: any,
  width: any,
  height: any,
): {
  min: number;
  max: number;
};
/**
 * `camera` zoomed by `factor` about canvas point (x, y), within `limits`, keeping the world point under (x, y) in
 * place. Changes `camera`.
 */
export declare function zoomAbout(
  camera: any,
  width: any,
  height: any,
  factor: any,
  x: any,
  y: any,
  {
    min,
    max,
  }: {
    max: any;
    min: any;
  },
): void;
/** `f` of the way from one camera to another (zoom in log space, so it feels even). */
export declare function between(
  from: any,
  to: any,
  f: any,
): {
  x: any;
  y: any;
  k: number;
};
/**
 * `camera` coasting at `glide` (world px/s) for `dt` s, slowed by `friction` (the physics mode's, so the camera
 * and the nodes slow alike). Changes both; returns false once it has stopped.
 */
export declare function coast(
  camera: any,
  glide: any,
  friction: any,
  dt: any,
): boolean;
