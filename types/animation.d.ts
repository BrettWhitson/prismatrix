export type AnimationOptions = {
  /**
   * ms a morph to a new layout takes
   */
  transition: number;
  /**
   * the curve morphs and camera moves follow (EASINGS)
   */
  easing: "smooth" | "out" | "back" | "linear";
  /**
   * ms the camera takes to frame or focus
   */
  camera: number;
  /**
   * how new nodes arrive: growing out of their parent, fading in where they
   * land, or at once
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
  /**
   * what hovering a node lights: its whole
   * lineage, what leads to it, what it leads to, or nothing
   */
  hoverLineage: "both" | "ancestors" | "descendants" | "none";
  /**
   * selected nodes keep their lineage lit
   */
  selectionLineage: boolean;
  /**
   * lit lineage edges keep their colour, or take the theme's `ancestors`
   * and `descendants` colours by which way they run
   */
  lineageColor: "off" | "direction";
  /**
   * pulses running along a lit lineage's edges, toward the source or the
   * target
   */
  flow: "off" | "source" | "target";
  /**
   * how fast the pulses run (1: about 70 world px a second)
   */
  flowSpeed: number;
};
/**
 * @typedef {object} AnimationOptions How the view moves between states (ANIMATION_OPTIONS), resolved.
 * @property {number} transition  ms a morph to a new layout takes
 * @property {"smooth" | "out" | "back" | "linear"} easing the curve morphs and camera moves follow (EASINGS)
 * @property {number} camera      ms the camera takes to frame or focus
 * @property {"grow" | "fade" | "none"} enter how new nodes arrive: growing out of their parent, fading in where they
 *   land, or at once
 * @property {number} hoverFade   ms the hover's emphasis takes to change
 * @property {number} hoverDim    0–1: how far everything outside the hovered lineage fades
 * @property {"both" | "ancestors" | "descendants" | "none"} hoverLineage what hovering a node lights: its whole
 *   lineage, what leads to it, what it leads to, or nothing
 * @property {boolean} selectionLineage selected nodes keep their lineage lit
 * @property {"off" | "direction"} lineageColor lit lineage edges keep their colour, or take the theme's `ancestors`
 *   and `descendants` colours by which way they run
 * @property {"off" | "source" | "target"} flow pulses running along a lit lineage's edges, toward the source or the
 *   target
 * @property {number} flowSpeed   how fast the pulses run (1: about 70 world px a second)
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
