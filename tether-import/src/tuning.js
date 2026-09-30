import { defaultsOf, describeSchema, resolve } from "./schema.js";

/**
 * Tether's tuning: every constant behind the layouts and the physics, in one schema. Use the defaults, or override
 * any of them (runLayout's `tuning`, LivePhysics.tuning); developer tools can edit them live. The four force
 * settings (center, repel, link strength, link distance) multiply into these.
 */

/** @returns {import('./schema.js').Field} */
const number = (group, label, value, min, max, step, hint) => ({
  type: "number",
  group,
  label,
  default: value,
  min,
  max,
  step,
  hint,
});
/** @returns {import('./schema.js').Field} */
const integer = (
  /** @type {[any, any, any, any, any, any, any]} */ ...args
) => ({ ...number(...args), type: "integer" });

/** @type {Readonly<import('./schema.js').Schema>} */
export const TUNING_SCHEMA = Object.freeze({
  // ---------------------------------------------------------------- the force simulation
  repelScale: number(
    "Simulation",
    "Repel scale",
    70,
    0,
    300,
    1,
    "Repel setting → force. Many-body push between every pair (Barnes-Hut).",
  ),
  centerScale: number(
    "Simulation",
    "Center scale",
    0.03,
    0,
    0.2,
    0.001,
    "Center setting → pull toward the graph's own middle.",
  ),
  linkScale: number(
    "Simulation",
    "Link scale",
    0.9,
    0,
    3,
    0.01,
    "Link setting → spring toward the link distance.",
  ),
  structureScale: number(
    "Simulation",
    "Structure scale",
    1.1,
    0,
    5,
    0.05,
    "Pull toward each node's level (tree) or ring (radial).",
  ),
  structureBase: number(
    "Simulation",
    "Structure base",
    0.15,
    0,
    2,
    0.01,
    "Structure pull at Center 0 (how loosely levels and rings hold).",
  ),
  structurePerCenter: number(
    "Simulation",
    "Structure × center",
    4.25,
    0,
    10,
    0.05,
    "Structure pull added per unit of the Center setting.",
  ),
  velocityDecay: number(
    "Simulation",
    "Velocity decay",
    0.4,
    0.05,
    0.95,
    0.01,
    "Friction: share of speed lost per tick.",
  ),
  theta: number(
    "Simulation",
    "Barnes-Hut θ",
    0.9,
    0.2,
    2,
    0.05,
    "Accuracy vs speed of the repulsion: lower is exact and slower.",
  ),
  maxTreeDepth: integer(
    "Simulation",
    "Quadtree depth",
    24,
    4,
    40,
    1,
    "Deepest quadtree level: points closer than this resolves merge into one mass.",
  ),
  alphaMin: number(
    "Simulation",
    "Alpha min",
    0.001,
    0.0001,
    0.05,
    0.0001,
    "The simulation stops when its temperature falls below this.",
  ),
  levelGap: number(
    "Simulation",
    "Level gap",
    24,
    0,
    120,
    1,
    "Minimum clear space between neighbouring levels (px).",
  ),
  ticksSmall: integer(
    "Simulation",
    "Ticks < 300",
    300,
    10,
    1000,
    10,
    "Ticks to settle a new layout under 300 nodes.",
  ),
  ticksMedium: integer(
    "Simulation",
    "Ticks < 1000",
    200,
    10,
    1000,
    10,
    "… under 1,000 nodes.",
  ),
  ticksLarge: integer(
    "Simulation",
    "Ticks ≥ 1000",
    120,
    10,
    1000,
    10,
    "… 1,000 nodes and over.",
  ),

  // ---------------------------------------------------------------- seed layouts
  seedNodeSize: number(
    "Layout",
    "Node size",
    48,
    0,
    400,
    1,
    "The node size seed layouts measure level gaps against: the gap between levels is link distance minus this.",
  ),
  referenceRepel: number(
    "Layout",
    "Label room at",
    8,
    0.1,
    100,
    0.1,
    "The Repel setting at which layouts leave full room for labels; lower Repel packs labels tighter.",
  ),
  siblingGapPerRepel: number(
    "Layout",
    "Sibling gap × repel",
    3,
    0,
    20,
    0.1,
    "Space between siblings in the seed layouts, per unit of Repel.",
  ),
  edgeGap: number(
    "Layout",
    "Edge gap",
    6,
    0,
    60,
    1,
    "Layered: space between long edges passing through a level.",
  ),
  crossingSweeps: integer(
    "Layout",
    "Crossing sweeps",
    12,
    0,
    60,
    1,
    "Layered: up-and-down passes that reorder each level to cut edge crossings.",
  ),
  transposePasses: integer(
    "Layout",
    "Transpose passes",
    6,
    0,
    30,
    1,
    "Layered: passes swapping neighbours on a level while that cuts crossings.",
  ),
  alignRounds: integer(
    "Layout",
    "Align rounds",
    6,
    0,
    30,
    1,
    "Layered: passes lining nodes up with their neighbours on the next level.",
  ),
  rankPasses: integer(
    "Layout",
    "Rank passes",
    24,
    0,
    100,
    1,
    "Layered: passes shortening edges by moving nodes between levels.",
  ),
  longEdgeWeight: number(
    "Layout",
    "Long edge weight",
    8,
    1,
    50,
    1,
    "Layered: how much straighter long edges are kept than short ones.",
  ),

  // ---------------------------------------------------------------- Floating
  dragHeat: number(
    "Floating",
    "Drag heat",
    0.3,
    0,
    1,
    0.01,
    "Temperature held while a node is dragged: how much the rest of the graph sways.",
  ),
  cooling: number(
    "Floating",
    "Cooling",
    0.0228,
    0.001,
    0.2,
    0.001,
    "How fast it cools after you let go (per tick).",
  ),
  floatIn: {
    type: "boolean",
    group: "Floating",
    label: "Float into place",
    default: true,
    hint: "New graphs settle live from their seed layout instead of appearing settled.",
  },
  // Floating in stops after this many ticks (about 4 s at 60 fps) even if the graph hasn't gone still: crowded
  // graphs can jitter at the drag heat for good, and the animation would never end.
  floatInTicks: integer(
    "Floating",
    "Float-in ticks",
    240,
    0,
    3600,
    30,
    "The most ticks a new floating graph spends floating into place before it's brought to rest.",
  ),
  // Floating graphs are run at the drag heat until they're still (moving less than this per tick, or for at most
  // this many ticks, or this much work: node count × ticks), so grabbing a node disturbs only what's near it. Work,
  // not time, so the result doesn't depend on the machine.
  stillness: number(
    "Floating",
    "Stillness",
    0.02,
    0,
    2,
    0.001,
    "A floating graph counts as settled once no node moves more than this per tick (at the drag heat).",
  ),
  settleTicks: integer(
    "Floating",
    "Settle ticks",
    4000,
    0,
    5000,
    50,
    "The most ticks spent bringing a floating graph to rest.",
  ),
  settleWork: integer(
    "Floating",
    "Settle work",
    100000,
    0,
    10000000,
    50000,
    "The most work (nodes × ticks) spent bringing a floating graph to rest before showing it (very big graphs may still drift a little when grabbed).",
  ),
  releaseTicks: integer(
    "Floating",
    "Release ticks",
    300,
    0,
    3600,
    30,
    "After a drag, the most ticks the graph spends settling (at the drag heat) before it stops.",
  ),
  deadZone: number(
    "Floating",
    "Dead zone",
    0.2,
    0,
    2,
    0.005,
    "While live, a node pushed less than this per tick stays put, so a grab or release disturbs only what it reaches.",
  ),
  liveAnchor: number(
    "Floating",
    "Live anchor",
    0.02,
    0,
    1,
    0.005,
    "While live, how firmly each node is pulled back toward where it rested (per unit of heat): keeps the graph from turning or sliding as a whole.",
  ),
  wakeDistance: number(
    "Floating",
    "Wake distance",
    2,
    0,
    50,
    0.1,
    "While live, a node that has moved this far wakes its linked neighbours: the dead zone stops holding them.",
  ),
  softCollision: number(
    "Floating",
    "Soft collision",
    0.3,
    0,
    1,
    0.01,
    "How hard overlapping nodes push apart while floating (as a push on their speed, so the graph can rest).",
  ),

  // ---------------------------------------------------------------- Elastic
  // stiffness = base + per-link × Link strength; anchor = base + per-center × Center.
  elasticStiffnessBase: number(
    "Elastic",
    "Stiffness base",
    0.3,
    0,
    2,
    0.01,
    "How firmly links keep their shape, before Link strength.",
  ),
  elasticStiffnessPerLink: number(
    "Elastic",
    "Stiffness × link",
    1,
    0,
    3,
    0.05,
    "Added per unit of the link force setting.",
  ),
  elasticAnchorBase: number(
    "Elastic",
    "Anchor base",
    0.05,
    0,
    1,
    0.01,
    "How firmly nodes hold their place, before Center.",
  ),
  elasticAnchorPerCenter: number(
    "Elastic",
    "Anchor × center",
    0.5,
    0,
    2,
    0.05,
    "Added per unit of the center force setting.",
  ),
  elasticDamping: number(
    "Elastic",
    "Damping",
    0.35,
    0.02,
    0.95,
    0.01,
    "Share of speed lost per step: low wobbles, high is sluggish.",
  ),
  elasticAlongHold: number(
    "Elastic",
    "Level hold",
    2,
    1,
    10,
    0.1,
    "Trees: how much more firmly nodes keep their level than their place along it.",
  ),
  elasticWake: number(
    "Elastic",
    "Wake distance",
    0.05,
    0.001,
    5,
    0.001,
    "How far a node must be displaced before it disturbs its neighbours.",
  ),
  elasticRest: number(
    "Elastic",
    "Rest threshold",
    0.01,
    0.0005,
    1,
    0.0005,
    "Below this speed and force a node is settled (and sleeps).",
  ),
});

/**
 * @typedef {object} Tuning
 * @property {number} repelScale  Repel setting → force. Many-body push between every pair (Barnes-Hut).
 * @property {number} centerScale  Center setting → pull toward the graph's own middle.
 * @property {number} linkScale  Link setting → spring toward the link distance.
 * @property {number} structureScale  Pull toward each node's level (tree) or ring (radial).
 * @property {number} structureBase  Structure pull at Center 0 (how loosely levels and rings hold).
 * @property {number} structurePerCenter  Structure pull added per unit of the Center setting.
 * @property {number} velocityDecay  Friction: share of speed lost per tick.
 * @property {number} theta  Accuracy vs speed of the repulsion: lower is exact and slower.
 * @property {number} maxTreeDepth  Deepest quadtree level: points closer than this resolves merge into one mass.
 * @property {number} alphaMin  The simulation stops when its temperature falls below this.
 * @property {number} levelGap  Minimum clear space between neighbouring levels (px).
 * @property {number} ticksSmall  Ticks to settle a new layout under 300 nodes.
 * @property {number} ticksMedium  … under 1,000 nodes.
 * @property {number} ticksLarge  … 1,000 nodes and over.
 * @property {number} seedNodeSize  The node size seed layouts measure level gaps against: the gap between levels is link distance minus this.
 * @property {number} referenceRepel  The Repel setting at which layouts leave full room for labels; lower Repel packs labels tighter.
 * @property {number} siblingGapPerRepel  Space between siblings in the seed layouts, per unit of Repel.
 * @property {number} edgeGap  Layered: space between long edges passing through a level.
 * @property {number} crossingSweeps  Layered: up-and-down passes that reorder each level to cut edge crossings.
 * @property {number} transposePasses  Layered: passes swapping neighbours on a level while that cuts crossings.
 * @property {number} alignRounds  Layered: passes lining nodes up with their neighbours on the next level.
 * @property {number} rankPasses  Layered: passes shortening edges by moving nodes between levels.
 * @property {number} longEdgeWeight  Layered: how much straighter long edges are kept than short ones.
 * @property {number} dragHeat  Temperature held while a node is dragged: how much the rest of the graph sways.
 * @property {number} cooling  How fast it cools after you let go (per tick).
 * @property {boolean} floatIn  New graphs settle live from their seed layout instead of appearing settled.
 * @property {number} floatInTicks  The most ticks a new floating graph spends floating into place before it's brought to rest.
 * @property {number} stillness  A floating graph counts as settled once no node moves more than this per tick (at the drag heat).
 * @property {number} settleTicks  The most ticks spent bringing a floating graph to rest.
 * @property {number} settleWork  The most work (nodes × ticks) spent bringing a floating graph to rest before showing it (very big graphs may still drift a little when grabbed).
 * @property {number} releaseTicks  After a drag, the most ticks the graph spends settling (at the drag heat) before it stops.
 * @property {number} liveAnchor  While live, how firmly each node is pulled back toward where it rested.
 * @property {number} wakeDistance  While live, a node that has moved this far wakes its linked neighbours.
 * @property {number} deadZone  While live, a node pushed less than this per tick stays put.
 * @property {number} softCollision  How hard overlapping nodes push apart while floating (as a push on their speed, so the graph can rest).
 * @property {number} elasticStiffnessBase  How firmly links keep their shape, before Link strength.
 * @property {number} elasticStiffnessPerLink  Added per unit of the link force setting.
 * @property {number} elasticAnchorBase  How firmly nodes hold their place, before Center.
 * @property {number} elasticAnchorPerCenter  Added per unit of the center force setting.
 * @property {number} elasticDamping  Share of speed lost per step: low wobbles, high is sluggish.
 * @property {number} elasticAlongHold  Trees: how much more firmly nodes keep their level than their place along it.
 * @property {number} elasticWake  How far a node must be displaced before it disturbs its neighbours.
 * @property {number} elasticRest  Below this speed and force a node is settled (and sleeps).
 */

/**
 * The default tuning.
 * @type {Readonly<Tuning>}
 */
export const PHYSICS_TUNING = Object.freeze(defaultsOf(TUNING_SCHEMA));
export { PHYSICS_TUNING as DEFAULT_TUNING };

/**
 * Controls for developer tools: { key, label, group, type, default, min, max, step, hint } in schema order (a
 * boolean when type is "boolean").
 */
export const TUNING_OPTIONS = Object.freeze(describeSchema(TUNING_SCHEMA));

/**
 * The default tuning with `overrides` checked and applied (out of range values are clamped, unknown keys and wrong
 * types warned about and ignored).
 * @param {Partial<Tuning>} [overrides]
 * @param {import('./schema.js').ResolveOptions} [options]
 * @returns {Tuning}
 */
export function resolveTuning(overrides, options = {}) {
  return resolve(TUNING_SCHEMA, overrides, {
    scope: "Tether tuning",
    ...options,
  });
}

/** Ticks to settle a new layout: fewer for big graphs (repel is O(n log n) per tick). */
export function ticksFor(nodeCount, tuning = PHYSICS_TUNING) {
  return nodeCount < 300
    ? tuning.ticksSmall
    : nodeCount < 1000
      ? tuning.ticksMedium
      : tuning.ticksLarge;
}
