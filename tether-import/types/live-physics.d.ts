import { Emitter } from "./emitter.js";
/**
 * Tether's physics after the layout: dragging, shaking, floating into place. A renderer tells it what the pointer
 * does and calls step() once per frame while `active`, drawing the positions it returns; everything that moves
 * (and how) is decided here, in the chosen physics mode:
 *
 *  - elastic: the graph is an elastic net around where it rests (elastic.js). The held node's neighbours follow,
 *    theirs less, fading with every link; what isn't connected, or is far enough away, stays still. Letting go keeps
 *    the pulled shape. Link force sets how far a pull reaches, center force how firmly nodes hold on.
 *  - floating: the whole graph is live (the layout's force simulation, physics.js): the held node drags its
 *    neighbours, the rest sways and makes room, and it all settles again after you let go.
 *  - none: the held node moves alone.
 *
 *   const physics = new LivePhysics(settings);
 *   physics.simulation = runLayout(graph, settings);
 *   physics.grab(id, { ids, links, positionOf });   // then physics.drag(id, point) as the pointer moves
 *   while (physics.active) draw(physics.step().moved);
 *
 * Positions are read through `positionOf(id)`, so the physics starts from what's on screen (a transition may still
 * be under way). A drag stays in the mode it started in, even if the mode setting changes before it ends.
 *
 * Events (physics.on(type, listener) returns an unsubscribe function):
 *  - "grab" ({ id, mode }), "release" ({ id, mode }): a node was grabbed or let go;
 *  - "start" ({ reason }): step() has something to move again ("drag", "shake" or "float-in");
 *  - "settle" (): everything is still again (step() went quiet, or stop()).
 * @extends {Emitter<{ grab: [{ id: string, mode: string }], release: [{ id: string, mode: string }],
 *                     start: [{ reason: string }], settle: [] }>}
 */
export declare class LivePhysics extends Emitter<{
  grab: [
    {
      id: string;
      mode: string;
    },
  ];
  release: [
    {
      id: string;
      mode: string;
    },
  ];
  start: [
    {
      reason: string;
    },
  ];
  settle: [];
}> {
  #private;
  /**
   * @param {{ physicsMode?: string, linkForce: number, centerForce: number, direction: string, layout?: string }} settings
   *   read on every grab, so the caller may change them in place
   */
  constructor(settings: {
    physicsMode?: string;
    linkForce: number;
    centerForce: number;
    direction: string;
    layout?: string;
  });
  /** The layout's force simulation (from runLayout), or null. Floating mode, shake() and floatIn() need one. */
  get simulation(): any;
  /** A new layout's simulation: whatever the old one was doing stops (and lets go of a held node). */
  set simulation(simulation: any);
  get tuning(): {
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
  /**
   * PHYSICS_TUNING (tuning.js) with these overrides, checked (see resolveTuning); every other constant goes back to
   * its default. Applies to the running simulation too.
   */
  set tuning(tuning: {
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
  });
  /** Does step() have anything to move? */
  get active(): boolean;
  /** The node being dragged, or null. */
  get heldId(): any;
  /** The elastic net while a node is held and until it settles, or null (for developer tools). */
  get elasticNet(): any;
  /**
   * A node is grabbed. Nodes `positionOf` knows nothing about (on their way out, say) sit the drag out.
   * @param {string} id
   * @param {{ ids: string[], links: { source: string, target: string }[],
   *           positionOf: (id: string) => { x: number, y: number } | null | undefined }} graph  what's on screen
   */
  grab(
    id: string,
    {
      ids,
      links,
      positionOf,
    }: {
      ids: string[];
      links: {
        source: string;
        target: string;
      }[];
      positionOf: (id: string) =>
        | {
            x: number;
            y: number;
          }
        | null
        | undefined;
    },
  ): void;
  /** The held node moved to `point`. */
  drag(id: any, point: any): void;
  /** The held node was let go. */
  release(id: any): void;
  /**
   * Shake the physics and let it settle: optionally scatter every node by up to `scatter` world units (the same way
   * each time), heat the simulation to `heat` (0..1) and let it cool. Returns false without a simulation.
   */
  shake(
    positionOf: any,
    {
      heat,
      scatter,
    }?: {
      heat?: number;
      scatter?: number;
    },
  ): boolean;
  /**
   * A new layout floats into place from its seed (runLayout with `settle: false`), cooling to the drag heat and
   * stopping once still there (or after floatInTicks: crowded graphs can jitter at that heat for good), so a node
   * grabbed later only moves what's near it. Returns false without a simulation.
   */
  floatIn(): boolean;
  /** Stop whatever is moving (a drag settling, a shake, floating in), and let go of a held node. */
  stop(): void;
  /**
   * Advance one frame. `moved` lists [id, x, y] for every node that moved (for a simulation run the same array is
   * reused next frame, so read it before calling step() again); `moving` is false once everything is still (then
   * `active` is false too, until the next grab, drag, release or shake).
   * @returns {{ moving: boolean, moved: [string, number, number][] }}
   */
  step(): {
    moving: boolean;
    moved: [string, number, number][];
  };
}
