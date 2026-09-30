import { ForceSimulation } from "./physics.js";
/**
 * Tether's entry point: position every node for the layout settings, synchronously (the renderer animates).
 *
 * Every layout runs in two stages: its seed (layouts.js: "tree", "radial", or one you registered), then the physics
 * (physics.js), with the four force settings, the tuning (tuning.js) and any extra forces (forces.js). For the
 * Floating physics mode the result is left exactly at rest (no final polish), so waking it only moves what's
 * disturbed.
 * Positions end up in graph.x / graph.y. Returns the simulation (kept for floating drags and for waking the physics
 * later), or null when the layout can't place this graph (the radial layout without a root).
 *
 * Settings and tuning are checked (settings.js, tuning.js): bad values are clamped or replaced by their defaults,
 * with a warning, or throw with `strict: true`.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 * @param {Partial<import('./settings.js').LayoutSettings>} settings
 * @param {{ tuning?: Partial<typeof import('./tuning.js').PHYSICS_TUNING>, settle?: boolean, strict?: boolean }} [context]
 *   settle: false returns the seed layout with its simulation not yet run (to animate it live)
 * @returns {ForceSimulation | null}
 */
export declare function runLayout(
  graph: import("./layout-graph.js").LayoutGraph,
  settings: Partial<import("./settings.js").LayoutSettings>,
  {
    tuning,
    settle,
    strict,
  }?: {
    tuning?: Partial<typeof import("./tuning.js").PHYSICS_TUNING>;
    settle?: boolean;
    strict?: boolean;
  },
): ForceSimulation | null;
