export type AnimationOptions = {
  /**
   * ms a morph to a new layout takes
   */
  transition: number;
  easing: "smooth" | "out" | "back" | "linear";
  /**
   * ms the camera takes to frame or focus
   */
  camera: number;
  /**
   * how new nodes arrive
   */
  enter: "grow" | "fade" | "none";
  /**
   * ms the hover's emphasis takes to change
   */
  hoverFade: number;
  /**
   * 0–1: how far everything outside the hovered lineage fades
   */
  hoverDim: number;
};
/**
 * @typedef {object} AnimationOptions How the view moves between states (ANIMATION_OPTIONS), resolved.
 * @property {number} transition  ms a morph to a new layout takes
 * @property {"smooth" | "out" | "back" | "linear"} easing
 * @property {number} camera      ms the camera takes to frame or focus
 * @property {"grow" | "fade" | "none"} enter how new nodes arrive
 * @property {number} hoverFade   ms the hover's emphasis takes to change
 * @property {number} hoverDim    0–1: how far everything outside the hovered lineage fades
 */
/** @type {import("./schema.js").OptionSpec[]} */
export declare const ANIMATION_OPTIONS: import("./schema.js").OptionSpec[];
/**
 * Easing curves: progress 0–1 in, eased progress out.
 * @type {Record<AnimationOptions["easing"], (t: number) => number>}
 */
export declare const EASINGS: Record<
  AnimationOptions["easing"],
  (t: number) => number
>;
/**
 * Move `value` toward `target` over about `ms` milliseconds, `dt` seconds at a time: quick at first, settling in
 * (exponential, so a target that changes midway is picked up smoothly). Snaps when within a hair.
 */
export declare function approach(
  value: any,
  target: any,
  dt: any,
  ms: any,
): any;
