/**
 * Tether's physics: a force simulation behind every layout, Four forces,
 * one setting each, all acting in every direction:
 *
 *  - center:   pulls nodes toward the graph's own middle (keeps it compact without moving it)
 *  - repel:    pushes nodes away from each other (Barnes-Hut, O(n log n))
 *  - link:     how strongly links pull their ends toward the link distance (0 = links don't pull at all)
 *  - distance: the length links settle at
 *
 * Plus a structure force for the layout, and collision so nodes (and their labels) don't overlap:
 *  - "layered": each node is pulled toward the line for its level, `distance` apart along the flow axis;
 *  - "radial":  the result is pinned in the centre; each node is pulled toward the ring for its depth;
 *  - "none":    no structure (layouts of your own that only want the forces).
 * Center also sets how firmly nodes hold their level or ring (0 loose, 1 crisp).
 *
 * Extra forces (forces.js, or any object with apply(simulation, alpha)) run after the built-in ones, every tick.
 * They read and write the public arrays: x, y (positions), vx, vy (velocities: add to these), fx, fy (NaN unless
 * held), halfW, halfH (collision half-sizes), linkSources, linkTargets, degree, and ids / indexById / count.
 *
 * The simulation keeps running while a node is dragged: the dragged node is held under the pointer and everything
 * else reacts (neighbours follow, others make room), then it cools down and settles.
 * Deterministic: the same input gives the same layout (no random starts; ties are broken by index).
 * Works on plain arrays (see layout-graph.js) and allocates nothing per tick beyond its first.
 */
import { PHYSICS_TUNING, ticksFor } from "./tuning.js";
export { ticksFor };
export type SimulationOptions = {
  /**
   * the structure force
   */
  mode: "layered" | "radial" | "none";
  /**
   * layered only: the flow axis levels are spread along
   */
  axis?: "x" | "y";
  /**
   * the four force settings
   */
  center: number;
  repel: number;
  link: number;
  distance: number;
  /**
   * radial: each node's ring
   */
  depthById?: Map<string, number>;
  rootId?: string;
  tuning?: Partial<typeof PHYSICS_TUNING>;
  /**
   * collision box (default: the node box)
   */
  sizeOf?: (graphIndex: number) => {
    w: number;
    h: number;
  };
  /**
   * extra forces, applied after the built-in ones
   */
  forces?: import("./forces.js").Force[];
  /**
   * push overlaps apart through velocities (Floating) instead of outright
   */
  softCollisions?: boolean;
  /**
   * simulateForces: resolve overlaps exactly at the end (default true)
   */
  polish?: boolean;
  /**
   * simulateForces: bring the result truly to rest (Floating)
   */
  equilibrate?: boolean;
  /**
   * simulateForces: how long to settle (default: ticksFor(count))
   */
  ticks?: number;
};
/**
 * @typedef {object} SimulationOptions
 * @property {"layered" | "radial" | "none"} mode  the structure force
 * @property {"x" | "y"} [axis]  layered only: the flow axis levels are spread along
 * @property {number} center  the four force settings
 * @property {number} repel
 * @property {number} link
 * @property {number} distance
 * @property {Map<string, number>} [depthById]  radial: each node's ring
 * @property {string} [rootId]
 * @property {Partial<typeof PHYSICS_TUNING>} [tuning]
 * @property {(graphIndex: number) => { w: number, h: number }} [sizeOf]  collision box (default: the node box)
 * @property {import('./forces.js').Force[]} [forces]  extra forces, applied after the built-in ones
 * @property {boolean} [softCollisions]  push overlaps apart through velocities (Floating) instead of outright
 * @property {boolean} [polish]  simulateForces: resolve overlaps exactly at the end (default true)
 * @property {boolean} [equilibrate]  simulateForces: bring the result truly to rest (Floating)
 * @property {number} [ticks]  simulateForces: how long to settle (default: ticksFor(count))
 */
export declare class ForceSimulation {
  #private;
  options: SimulationOptions;
  /** The constants (tuning.js), editable while it runs. */
  tuning: {
    repelScale: number;
    centerScale: number;
    linkScale: number;
    structureScale: number;
    structureBase: number;
    structurePerCenter: number;
    velocityDecay: number;
    theta: number;
    maxTreeDepth: number;
    alphaMin: number;
    levelGap: number;
    ticksSmall: number;
    ticksMedium: number;
    ticksLarge: number;
    seedNodeSize: number;
    referenceRepel: number;
    siblingGapPerRepel: number;
    edgeGap: number;
    crossingSweeps: number;
    transposePasses: number;
    alignRounds: number;
    rankPasses: number;
    longEdgeWeight: number;
    dragHeat: number;
    cooling: number;
    floatIn: boolean;
    floatInTicks: number;
    stillness: number;
    settleTicks: number;
    settleWork: number;
    releaseTicks: number;
    liveAnchor: number;
    wakeDistance: number;
    deadZone: number;
    softCollision: number;
    elasticStiffnessBase: number;
    elasticStiffnessPerLink: number;
    elasticAnchorBase: number;
    elasticAnchorPerCenter: number;
    elasticDamping: number;
    elasticAlongHold: number;
    elasticWake: number;
    elasticRest: number;
  };
  /** Graph index of each simulated node. */
  members: number[];
  count: number;
  ids: string[];
  indexById: Map<string, number>;
  x: Float64Array<ArrayBuffer>;
  y: Float64Array<ArrayBuffer>;
  vx: Float64Array<ArrayBuffer>;
  vy: Float64Array<ArrayBuffer>;
  /** Fixed (dragged / pinned) positions, NaN when free. */
  fx: Float64Array<ArrayBuffer>;
  fy: Float64Array<ArrayBuffer>;
  halfW: Float64Array<ArrayBuffer>;
  halfH: Float64Array<ArrayBuffer>;
  degree: Uint32Array<ArrayBuffer>;
  linkSources: Int32Array<ArrayBuffer>;
  linkTargets: Int32Array<ArrayBuffer>;
  neighbourStart: Int32Array<ArrayBuffer>;
  neighbours: Int32Array<ArrayBuffer>;
  root: number;
  structureTarget: Float64Array<ArrayBuffer>;
  restLength: Float64Array<ArrayBuffer>;
  /** Extra forces (forces.js), applied every tick after the built-in ones. */
  forces: import("./forces.js").Force[];
  centerX: number;
  centerY: number;
  alpha: number;
  alphaTarget: number;
  motion: number;
  /**
   * @param {import('./layout-graph.js').LayoutGraph} graph  current positions are the starting point; ghosts sit out
   * @param {SimulationOptions} options
   *   axis: layered only, the flow axis levels are spread along
   *   depthById / rootId: radial rings
   *   sizeOf: collision box per node, including its label (default: the node box)
   */
  constructor(
    graph: import("./layout-graph.js").LayoutGraph,
    options: SimulationOptions,
  );
  /** Settle synchronously (a fresh layout). */
  run(ticks?: number): this;
  /** Still moving? (the live, animated mode stops when this turns false) */
  get isActive(): boolean;
  /**
   * Bring the graph truly to rest at `heat` (floating graphs: the drag heat), so waking it at that heat later only
   * moves what's disturbed. Cooling alone freezes the graph once its forces get too weak to move anything, before it
   * has reached balance; waking it then sends everything toward the balance it never reached. Ends cold (alpha 0).
   * The work is capped in node-ticks (settleWork), not time, so the same graph settles the same on any machine.
   */
  equilibrate(heat?: number): this;
  /** Warm up again (a node was grabbed) and stay warm while `alphaTarget` > 0. */
  reheat(alphaTarget?: number): void;
  /** Hold a node at a position (while dragged). */
  fix(id: any, position: any): void;
  /** Let a dragged node move freely again (the pinned radial root stays pinned). */
  release(id: any): void;
  /** Start again from these positions (id → { x, y }; nodes moved by hand since), at rest. */
  setPositions(positionOf: any): void;
  /** Copy positions into the graph's arrays (the simulated nodes only). */
  writeTo(graph: any): void;
  /** One step. `decay` sets how fast alpha moves toward alphaTarget (≈300 ticks to settle by default). */
  tick(decay?: number): void;
  /** Add a force while it runs (see forces.js). Returns a function that takes it out again. */
  addForce(force: any): () => void;
  /**
   * Treat where things are now as rest: record the push every node already feels here, and subtract it from then on
   * (until setPositions). A big graph never reaches perfect balance (the Barnes-Hut approximation leaves a little
   * noise), and without this, waking it for a drag let every node act on those leftovers: the whole graph drifted.
   * With it, only what the drag changes moves anything, spreading through the forces like a ripple.
   */
  holdRest(): void;
  /** Stop treating a position as rest (the forces act in full again). */
  releaseRest(): void;
  /**
   * Collision passes on their own, until nothing overlaps (or the budget runs out). One pass per tick can leave a
   * dense stack overlapping: each push can create a new overlap further along.
   */
  resolveOverlaps(maxPasses?: number): void;
}
/**
 * Build, settle and write back a layout in one go. Returns the simulation (kept for live dragging), or null for
 * fewer than two nodes.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 */
export declare function simulateForces(
  graph: import("./layout-graph.js").LayoutGraph,
  options: any,
): ForceSimulation;
/**
 * A quadtree over points in flat typed arrays, rebuilt every tick without allocating. Cell 0 is the root; a cell is
 * a leaf holding one point (index ≥ 0), an internal cell with up to four children, or empty. Coincident points past
 * `maxDepth` (tuning: maxTreeDepth) merge into one leaf's mass.
 */
export declare class Quadtree {
  #private;
  maxDepth: number;
  left: any;
  top: any;
  size: any;
  mass: any;
  cx: any;
  cy: any;
  index: any;
  internal: any;
  child: any;
  stack: Int32Array<any>;
  capacity: any;
  cells: number;
  flatX: Float64Array<any>;
  flatY: Float64Array<any>;
  flatMass: Float64Array<any>;
  flatSize2: Float64Array<any>;
  flatPoint: Int32Array<any>;
  flatSkip: Int32Array<any>;
  subtree: Int32Array<any>;
  /** @param {number} points  expected point count (it grows as needed) */
  constructor(points: number, maxDepth?: number);
  build(x: any, y: any, count: any): void;
  /**
   * Lay the cells out in the order a depth-first walk visits them (children last to first, as a stack pops them), in
   * flat arrays: centre (flatX, flatY), mass, size squared, the leaf's point (or -1 empty, -2 internal) and flatSkip,
   * the position just past the cell's subtree. Returns the number of cells.
   */
  flatten(): number;
}
/**
 * A uniform grid of linked lists over points, rebuilt every tick: `first(gx, gy)` then follow `next`. Cells live in
 * an open-addressing hash table of typed arrays (stamped per build, so nothing is cleared or allocated per tick).
 */
export declare class CollisionGrid {
  next: Int32Array<ArrayBuffer>;
  mask: number;
  cellX: Int32Array<ArrayBuffer>;
  cellY: Int32Array<ArrayBuffer>;
  head: Int32Array<ArrayBuffer>;
  stamp: Uint32Array<ArrayBuffer>;
  build_: number;
  constructor(points: any);
  build(x: any, y: any, count: any, cellSize: any): void;
  first(gx: any, gy: any): number;
}
