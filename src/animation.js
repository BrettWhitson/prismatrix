// How the view moves between states: layout morphs, the camera, hover emphasis, nodes arriving. Durations are in
// milliseconds; 0 means instant.

import { bool, range, select } from "./schema.js";

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
export const ANIMATION_OPTIONS = [
  range(
    "transition",
    "Morph time",
    0,
    2000,
    25,
    650,
    "How long nodes take to glide to a new layout: a new graph, a layout change, Reset.",
  ),
  select(
    "easing",
    "Easing",
    [
      { value: "smooth", label: "Smooth (slow in and out)" },
      { value: "out", label: "Ease out (quick start, soft landing)" },
      { value: "back", label: "Overshoot (a little past, then back)" },
      { value: "linear", label: "Linear" },
    ],
    "smooth",
  ),
  range(
    "camera",
    "Camera time",
    0,
    2000,
    25,
    650,
    "How long the camera takes to frame the graph.",
  ),
  select(
    "enter",
    "New nodes",
    [
      { value: "grow", label: "Grow out of their parent" },
      { value: "fade", label: "Fade in where they land" },
      { value: "none", label: "Appear at once" },
    ],
    "grow",
  ),
  range(
    "hoverFade",
    "Hover fade",
    0,
    1000,
    10,
    180,
    "How long nodes and edges take to brighten or dim when the hover moves.",
  ),
  range(
    "hoverDim",
    "Hover dims others",
    0,
    1,
    0.05,
    0.75,
    "How far everything outside the hovered node's lineage fades: 0 not at all, 1 to nothing.",
  ),
  select(
    "hoverLineage",
    "Hover lights",
    [
      { value: "both", label: "Its whole lineage" },
      { value: "ancestors", label: "What leads to it" },
      { value: "descendants", label: "What it leads to" },
      { value: "none", label: "Nothing" },
    ],
    "both",
    "Hovering a node lights it and its lineage and dims the rest: all of it, only up (its sources), only down, or not at all.",
  ),
  bool(
    "selectionLineage",
    "Selection keeps its lineage lit",
    true,
    "With nothing hovered, selected nodes light their lineage (as hover would) and dim the rest.",
  ),
  select(
    "lineageColor",
    "Lineage colours",
    [
      { value: "off", label: "Edges keep their colour" },
      { value: "direction", label: "By direction" },
    ],
    "off",
    "A lit lineage's edges in the theme's ancestors colour going up and its descendants colour going down.",
  ),
  select(
    "flow",
    "Flow",
    [
      { value: "off", label: "Off" },
      { value: "target", label: "Toward the target" },
      { value: "source", label: "Toward the source" },
    ],
    "off",
    "Pulses running along a lit lineage's edges.",
  ),
  range("flowSpeed", "Flow speed", 0.1, 4, 0.1, 1),
];

/**
 * Easing curves: progress 0–1 in, eased progress out.
 * @type {Record<AnimationOptions["easing"], (t: number) => number>}
 */
export const EASINGS = {
  smooth: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t) => 1 - (1 - t) ** 3,
  back: (t) => {
    const c = 1.4;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
  linear: (t) => t,
};

/**
 * Move `value` toward `target` over about `ms` milliseconds, `dt` seconds at a time: quick at first, settling in
 * (exponential, so a target that changes midway is picked up smoothly). Snaps when within a hair.
 */
export function approach(value, target, dt, ms) {
  if (ms <= 0) return target;
  const next = value + (target - value) * (1 - Math.exp((-dt * 1000 * 4) / ms));
  return Math.abs(next - target) < 0.004 ? target : next;
}
