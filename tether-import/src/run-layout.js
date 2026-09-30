import { createForces } from "./forces.js";
import { getLayout, layoutNameOf } from "./layouts.js";
import { ForceSimulation, simulateForces } from "./physics.js";
import { resolveSettings } from "./settings.js";
import { resolveTuning } from "./tuning.js";

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
export function runLayout(
  graph,
  settings,
  { tuning, settle = true, strict = false } = {},
) {
  const s = resolveSettings(settings, { strict });
  const t = resolveTuning(tuning, { strict });
  const name = layoutNameOf(s);
  let layout = getLayout(name);
  if (!layout) {
    const message = `Tether: unknown layout "${name}"; using "tree"`;
    if (strict) throw new TypeError(message);
    console.warn(message);
    layout = getLayout("tree");
  }
  // Seeds space siblings in proportion to repel; collision boxes reserve that share of each label's width
  // (low repel packs tighter and lets labels overlap).
  const labelShare = Math.min(1, s.repelForce / t.referenceRepel);
  const sizeOf = (i) => graph.footprint(i, labelShare, 1);
  const context = {
    tuning: t,
    labelShare,
    siblingGap: s.repelForce * t.siblingGapPerRepel,
    levelGap: Math.max(0, s.linkDistance - t.seedNodeSize),
    sizeOf,
  };
  let setup;
  try {
    setup = layout.seed(graph, s, context);
  } catch (error) {
    // A layout of someone else's that throws: fall back to the tree, like an unknown one (the built-ins don't).
    if (strict || layout === getLayout("tree")) throw error;
    console.warn(
      `Tether: layout "${name}" threw (${error?.message ?? error}); using "tree"`,
    );
    setup = getLayout("tree").seed(graph, s, context);
  }
  if (!setup) return null;
  if (!["layered", "radial", "none"].includes(setup.mode)) {
    const message = `Tether: layout "${name}" returned mode ${JSON.stringify(setup.mode)}; expected "layered", "radial" or "none" (using "none")`;
    if (strict) throw new TypeError(message);
    console.warn(message);
    setup = { ...setup, mode: "none" };
  }
  const floating = s.physicsMode === "floating";
  const options = {
    ...setup,
    center: s.centerForce,
    repel: s.repelForce,
    link: s.linkForce,
    distance: s.linkDistance,
    tuning: t,
    sizeOf,
    forces: createForces(s.forces),
    // Floating graphs start truly at rest (see ForceSimulation.equilibrate), with no final polish to unbalance them.
    polish: !floating,
    equilibrate: floating,
    softCollisions: floating,
  };
  return settle
    ? simulateForces(graph, options)
    : new ForceSimulation(graph, options);
}
