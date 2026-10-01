// How the view moves between states: layout morphs, the camera, hover emphasis, nodes arriving. Durations are in
// milliseconds; 0 means instant.

import { range, select } from "./schema.js";

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
];

/** Easing curves: progress 0–1 in, eased progress out. */
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
