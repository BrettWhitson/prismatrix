/** @type {Readonly<import('./schema.js').Schema>} */
export declare const TUNING_SCHEMA: Readonly<import("./schema.js").Schema>;
export type Tuning = {
  /**
   * Repel setting → force. Many-body push between every pair (Barnes-Hut).
   */
  repelScale: number;
  /**
   * Center setting → pull toward the graph's own middle.
   */
  centerScale: number;
  /**
   * Link setting → spring toward the link distance.
   */
  linkScale: number;
  /**
   * Pull toward each node's level (tree) or ring (radial).
   */
  structureScale: number;
  /**
   * Structure pull at Center 0 (how loosely levels and rings hold).
   */
  structureBase: number;
  /**
   * Structure pull added per unit of the Center setting.
   */
  structurePerCenter: number;
  /**
   * Friction: share of speed lost per tick.
   */
  velocityDecay: number;
  /**
   * Accuracy vs speed of the repulsion: lower is exact and slower.
   */
  theta: number;
  /**
   * Deepest quadtree level: points closer than this resolves merge into one mass.
   */
  maxTreeDepth: number;
  /**
   * The simulation stops when its temperature falls below this.
   */
  alphaMin: number;
  /**
   * Minimum clear space between neighbouring levels (px).
   */
  levelGap: number;
  /**
   * Ticks to settle a new layout under 300 nodes.
   */
  ticksSmall: number;
  /**
   * … under 1,000 nodes.
   */
  ticksMedium: number;
  /**
   * … 1,000 nodes and over.
   */
  ticksLarge: number;
  /**
   * The node size seed layouts measure level gaps against: the gap between levels is link distance minus this.
   */
  seedNodeSize: number;
  /**
   * The Repel setting at which layouts leave full room for labels; lower Repel packs labels tighter.
   */
  referenceRepel: number;
  /**
   * Space between siblings in the seed layouts, per unit of Repel.
   */
  siblingGapPerRepel: number;
  /**
   * Layered: space between long edges passing through a level.
   */
  edgeGap: number;
  /**
   * Layered: up-and-down passes that reorder each level to cut edge crossings.
   */
  crossingSweeps: number;
  /**
   * Layered: passes swapping neighbours on a level while that cuts crossings.
   */
  transposePasses: number;
  /**
   * Layered: passes lining nodes up with their neighbours on the next level.
   */
  alignRounds: number;
  /**
   * Layered: passes shortening edges by moving nodes between levels.
   */
  rankPasses: number;
  /**
   * Layered: how much straighter long edges are kept than short ones.
   */
  longEdgeWeight: number;
  /**
   * Temperature held while a node is dragged: how much the rest of the graph sways.
   */
  dragHeat: number;
  /**
   * How fast it cools after you let go (per tick).
   */
  cooling: number;
  /**
   * New graphs settle live from their seed layout instead of appearing settled.
   */
  floatIn: boolean;
  /**
   * The most ticks a new floating graph spends floating into place before it's brought to rest.
   */
  floatInTicks: number;
  /**
   * A floating graph counts as settled once no node moves more than this per tick (at the drag heat).
   */
  stillness: number;
  /**
   * The most ticks spent bringing a floating graph to rest.
   */
  settleTicks: number;
  /**
   * The most work (nodes × ticks) spent bringing a floating graph to rest before showing it (very big graphs may still drift a little when grabbed).
   */
  settleWork: number;
  /**
   * After a drag, the most ticks the graph spends settling (at the drag heat) before it stops.
   */
  releaseTicks: number;
  /**
   * While live, how firmly each node is pulled back toward where it rested.
   */
  liveAnchor: number;
  /**
   * While live, a node that has moved this far wakes its linked neighbours.
   */
  wakeDistance: number;
  /**
   * While live, a node pushed less than this per tick stays put.
   */
  deadZone: number;
  /**
   * How hard overlapping nodes push apart while floating (as a push on their speed, so the graph can rest).
   */
  softCollision: number;
  /**
   * How firmly links keep their shape, before Link strength.
   */
  elasticStiffnessBase: number;
  /**
   * Added per unit of the link force setting.
   */
  elasticStiffnessPerLink: number;
  /**
   * How firmly nodes hold their place, before Center.
   */
  elasticAnchorBase: number;
  /**
   * Added per unit of the center force setting.
   */
  elasticAnchorPerCenter: number;
  /**
   * Share of speed lost per step: low wobbles, high is sluggish.
   */
  elasticDamping: number;
  /**
   * Trees: how much more firmly nodes keep their level than their place along it.
   */
  elasticAlongHold: number;
  /**
   * How far a node must be displaced before it disturbs its neighbours.
   */
  elasticWake: number;
  /**
   * Below this speed and force a node is settled (and sleeps).
   */
  elasticRest: number;
};
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
export declare const PHYSICS_TUNING: Readonly<Tuning>;
export { PHYSICS_TUNING as DEFAULT_TUNING };
/**
 * Controls for developer tools: { key, label, group, type, default, min, max, step, hint } in schema order (a
 * boolean when type is "boolean").
 */
export declare const TUNING_OPTIONS: readonly (import("./schema.js").Field & {
  key: string;
})[];
/**
 * The default tuning with `overrides` checked and applied (out of range values are clamped, unknown keys and wrong
 * types warned about and ignored).
 * @param {Partial<Tuning>} [overrides]
 * @param {import('./schema.js').ResolveOptions} [options]
 * @returns {Tuning}
 */
export declare function resolveTuning(
  overrides?: Partial<Tuning>,
  options?: import("./schema.js").ResolveOptions,
): Tuning;
/** Ticks to settle a new layout: fewer for big graphs (repel is O(n log n) per tick). */
export declare function ticksFor(
  nodeCount: any,
  tuning?: Readonly<Tuning>,
): number;
