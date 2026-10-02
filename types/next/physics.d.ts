export type StaticPhysicsOptions = {
  /**
   * dragging a node carries everything below it
   */
  dragSubtree: boolean;
  /**
   * a released node keeps the speed it was thrown with
   */
  fling: boolean;
  /**
   * how quickly anything moving eases to a stop
   */
  friction: number;
};
export type ElasticPhysicsOptions = {
  /**
   * how hard each node is pulled back to its home
   */
  anchor: number;
  /**
   * how hard edges hold their laid-out length
   */
  links: number;
  friction: number;
  /**
   * nodes (and their labels, with label collision) push each other out of the way
   */
  collide: boolean;
  fling: boolean;
  /**
   * tree and merged: nodes only slide along their level
   */
  levelLock?: boolean;
  /**
   * radial: nodes only slide around their ring
   */
  ringLock?: boolean;
};
export type FloatingPhysicsOptions = {
  /**
   * how hard nodes push each other apart
   */
  repulsion: number;
  /**
   * how hard edges hold their length
   */
  links: number;
  /**
   * edge length relative to the layout's
   */
  linkLength: number;
  /**
   * a faint pull back to the layout (0 forgets it)
   */
  memory: number;
  friction: number;
  /**
   * seconds the graph keeps rearranging after it's disturbed
   */
  settle: number;
  /**
   * gentle wandering (above 0 it never quite stops)
   */
  drift: number;
  collide: boolean;
  fling: boolean;
};
export type PhysicsOptions =
  | Partial<StaticPhysicsOptions>
  | Partial<ElasticPhysicsOptions>
  | Partial<FloatingPhysicsOptions>;
/**
 * @typedef {object} StaticPhysicsOptions
 * @property {boolean} dragSubtree dragging a node carries everything below it
 * @property {boolean} fling       a released node keeps the speed it was thrown with
 * @property {number} friction     how quickly anything moving eases to a stop
 *
 * @typedef {object} ElasticPhysicsOptions
 * @property {number} anchor       how hard each node is pulled back to its home
 * @property {number} links        how hard edges hold their laid-out length
 * @property {number} friction
 * @property {boolean} collide     nodes (and their labels, with label collision) push each other out of the way
 * @property {boolean} fling
 * @property {boolean} [levelLock] tree and merged: nodes only slide along their level
 * @property {boolean} [ringLock]  radial: nodes only slide around their ring
 *
 * @typedef {object} FloatingPhysicsOptions
 * @property {number} repulsion    how hard nodes push each other apart
 * @property {number} links        how hard edges hold their length
 * @property {number} linkLength   edge length relative to the layout's
 * @property {number} memory       a faint pull back to the layout (0 forgets it)
 * @property {number} friction
 * @property {number} settle       seconds the graph keeps rearranging after it's disturbed
 * @property {number} drift        gentle wandering (above 0 it never quite stops)
 * @property {boolean} collide
 * @property {boolean} fling
 *
 * @typedef {Partial<StaticPhysicsOptions> | Partial<ElasticPhysicsOptions> | Partial<FloatingPhysicsOptions>}
 *   PhysicsOptions Options for one of the physics modes (all or some)
 */
/**
 * The physics modes and their options. A layout offers some of them, with its own extra options and defaults
 * (LAYOUTS[layout].physics); physicsSchema gives a mode's full schema within a layout.
 * @type {Record<"static" | "elastic" | "floating", { label: string, options: import("./schema.js").OptionSpec[] }>}
 */
export declare const PHYSICS: Record<
  "static" | "elastic" | "floating",
  {
    label: string;
    options: import("./schema.js").OptionSpec[];
  }
>;
/** The full option schema for a mode within a layout: the mode's own, the layout's extras, its defaults. */
export declare function physicsSchema(layout: any, mode: any): any[];
export declare function physicsOptions(
  layout: any,
  mode: any,
  values: any,
): Record<string, any>;
export type Collision = {
  /**
   * collide footprints (node and label) rather than circles
   */
  boxes: boolean;
  /**
   * clearance kept around every node
   */
  padding: number;
};
/**
 * @typedef {object} Collision
 * @property {boolean} boxes   collide footprints (node and label) rather than circles
 * @property {number} padding  clearance kept around every node
 */
/**
 * Per edge of `graph`, 1 where the edge is drawn as a reference (a chip by the recipe, not a line to the
 * ingredient), for `Simulation.configure`: those edges get no spring, so dragging a recipe doesn't tug an ingredient
 * that's drawn far away. Null when there are no references.
 * @param {import("./graph.js").Graph} graph
 * @param {import("./layered.js").Reference[] | undefined} references the layout's (`routing.references`)
 * @returns {Uint8Array | null}
 */
export declare function referencedEdges(
  graph: import("./graph.js").Graph,
  references: import("./layered.js").Reference[] | undefined,
): Uint8Array | null;
export declare class Simulation {
  #private;
  graph: any;
  /** The working graph's matrix: physics moves x, y, vx, vy and reads homes and footprints. */
  matrix: any;
  ax: Float64Array<any>;
  ay: Float64Array<any>;
  phase: Float64Array<ArrayBuffer>;
  from: Int32Array<ArrayBuffer>;
  to: Int32Array<ArrayBuffer>;
  rest: Float64Array<any>;
  /** @type {Uint8Array | null} per edge, 1 where it has no spring (see referencedEdges); null: every edge has one */
  loose: Uint8Array | null;
  /** Per node, 1 / its mass (see #weigh). */
  inverseMass: Float64Array<any>;
  heavy: boolean;
  pinned: Uint8Array<any>;
  cx: Float64Array<any>;
  cy: Float64Array<any>;
  offX: Float64Array<any>;
  offY: Float64Array<any>;
  hw: Float64Array<any>;
  hh: Float64Array<any>;
  placeHW: Float64Array<any>;
  placeHH: Float64Array<any>;
  shoved: Uint8Array<any>;
  away: Uint8Array<any>;
  lastX: Float64Array<any>;
  lastY: Float64Array<any>;
  level: Uint8Array<any>;
  huge: Int32Array<any>;
  members: Int32Array<ArrayBuffer>;
  sizes: Int32Array<ArrayBuffer>;
  collisionGrids: NearGrid[];
  repulsionGrid: NearGrid;
  target: number;
  withTarget: (j: any) => void;
  pushX: Float64Array<any>;
  pushY: Float64Array<any>;
  /** @type {(a: number, b: number) => void} pushes a pair apart, the way `collision` says */
  separate: (a: number, b: number) => void;
  time: number;
  carry: number;
  energy: number;
  moved: boolean;
  pushed: boolean;
  quiet: number;
  since: number;
  /** @type {Set<number>} nodes held by the pointer: forces don't move them */
  held: Set<number>;
  mode: string;
  /** @type {Record<string, any>} the mode's options */
  opts: Record<string, any>;
  /** @type {((m: import("./matrix.js").Matrix, i: number) => void) | null} keeps row i on its level or ring */
  constrain: ((m: import("./matrix.js").Matrix, i: number) => void) | null;
  /** @type {Collision | null} */
  collision: Collision | null;
  reach: number;
  constructor(graph: any);
  /**
   * @param {string} mode
   * @param {Record<string, any>} opts
   * @param {((m: import("./matrix.js").Matrix, i: number) => void) | null} [constrain]
   * @param {Collision | null} [collision] how nodes collide, when the mode's `collide` option is on
   * @param {Uint8Array | null} [loose] per edge, 1 for an edge with no spring (see referencedEdges)
   */
  configure(
    mode: string,
    opts: Record<string, any>,
    constrain?: ((m: import("./matrix.js").Matrix, i: number) => void) | null,
    collision?: Collision | null,
    loose?: Uint8Array | null,
  ): void;
  /**
   * Something changed from outside (a release, new settings, a reset): run until it's settled again, even if
   * nothing is moving yet. A node released at a standstill away from its home has no speed, but it has a spring.
   */
  wake(): void;
  /** True once nothing has moved for a while, and nothing will unless touched. */
  get asleep(): boolean;
  /**
   * Advance by `dt` seconds of wall time in fixed steps (`energy`: the mean squared speed). Asleep, it does nothing
   * at all (no forces, no collisions) until something wakes it.
   */
  advance(dt: any): void;
  step(h: any): number;
  /** Floating's force strength: full after a wake, easing to nothing over the settle time. */
  get heat(): number;
}
/**
 * Square cells over a set of points, for finding the pairs that are near each other without looking at all n² of
 * them. Cells are hashed into a table of slots about twice the number of points, so any spread of points (a node
 * thrown 100,000 px away) costs the same memory; two cells sharing a slot only cost a few extra candidates. Each row
 * of cells starts at a hashed slot and runs on through consecutive ones, so neighbours along a row are neighbours in
 * memory, while lines of points in any direction still spread over the table.
 *
 * Built by counting sort into typed arrays that are kept from one build to the next (and grown only when there are
 * more points), so a physics step allocates nothing for it. Points in a slot are in ascending order.
 */
export declare class NearGrid {
  cell: number;
  mask: number;
  /** Slot s holds items[start[s]] up to (not including) items[start[s + 1]]. */
  start: Int32Array<ArrayBuffer>;
  items: Int32Array<ArrayBuffer>;
  cellX: Int32Array<ArrayBuffer>;
  cellY: Int32Array<ArrayBuffer>;
  placeX: Float64Array<ArrayBuffer>;
  placeY: Float64Array<ArrayBuffer>;
  gx: Int32Array<ArrayBuffer>;
  gy: Int32Array<ArrayBuffer>;
  slot: Int32Array<ArrayBuffer>;
  seen: Int32Array<ArrayBuffer>;
  search: number;
  constructor();
  /**
   * Put points 0 to count - 1, at (px[i], py[i]), into cells of side `cell`. With `groups`, only the points with
   * groups[i] === group go in (so a 0/1 array of points to skip leaves out the 1s).
   * @param {ArrayLike<number>} px
   * @param {ArrayLike<number>} py
   * @param {number} count
   * @param {number} cell
   * @param {ArrayLike<number> | null} [groups]
   * @param {number} [group]
   */
  build(
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    count: number,
    cell: number,
    groups?: ArrayLike<number> | null,
    group?: number,
  ): void;
  /**
   * Every pair of points in the same or neighbouring cells, once each: that is every pair closer than a cell on both
   * axes, and some a little further. Each point looks at the points after it in its own cell, at the cell to its
   * right and at the three cells of the row below; the other neighbours find it from their side. Cells in a row
   * have consecutive slots, so those are two short runs of memory. A slot can hold cells of other rows too: only
   * points of the cells being looked at count.
   * @param {(i: number, j: number) => void} visit called with i < j
   */
  eachPair(visit: (i: number, j: number) => void): void;
  /**
   * The same pairs as eachPair, by place in `items` rather than by point: point items[p] is at (placeX[p],
   * placeY[p]). Places near each other in space are near each other in memory, so work done by place (repulsion
   * adds up its forces this way) reads and writes memory mostly in order instead of all over the node columns.
   * @param {(p: number, q: number) => void} visit
   */
  eachPlacePair(visit: (p: number, q: number) => void): void;
  /**
   * Every point with x0 ≤ x ≤ x1 and y0 ≤ y ≤ y1, once each.
   * @param {(i: number) => void} visit
   */
  eachIn(x0: any, y0: any, x1: any, y1: any, visit: (i: number) => void): void;
}
