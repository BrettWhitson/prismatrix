/**
 * Tether's drag physics: the graph as an elastic net around where it rests. Grabbing a node doesn't re-run the
 * layout; the held node pulls on its links, those nodes pull on theirs, and the pull fades with every hop:
 *
 *  - every node rests where it was when the drag began (anchored there, lightly);
 *  - every link wants to keep the offset between its ends that it had then;
 *  - a node moves toward the average movement of its neighbours, less its anchor's hold, so a neighbour of the
 *    held node follows most of the way, its own neighbours less, and a busy hub (many neighbours, one moving)
 *    hardly at all.
 *
 * Only nodes that have been disturbed are simulated ("awake"); a node wakes its neighbours once it has moved
 * noticeably, and sleeps again when it has settled. Everything else stays exactly where it is, however big the
 * graph. Letting go keeps the shape you pulled the graph into: it becomes the new rest, and what was still moving
 * coasts to a stop.
 */
export declare class ElasticNetwork {
  #private;
  count: number;
  ids: string[];
  indexById: Map<string, number>;
  restX: Float64Array<ArrayBuffer>;
  restY: Float64Array<ArrayBuffer>;
  x: Float64Array<ArrayBuffer>;
  y: Float64Array<ArrayBuffer>;
  vx: Float64Array<ArrayBuffer>;
  vy: Float64Array<ArrayBuffer>;
  held: Uint8Array<ArrayBuffer>;
  stiffness: number;
  wake: number;
  rest: number;
  damping: number;
  anchorX: number;
  anchorY: number;
  start: Uint32Array<ArrayBuffer>;
  neighbours: Uint32Array<ArrayBuffer>;
  awake: Uint8Array<ArrayBuffer>;
  /** Indices of the awake nodes (the ones step() moves). */
  active: any[];
  /** The nodes the last step moved (settling ones included): what a renderer has to redraw. */
  changed: any[];
  /**
   * @param {{ ids: string[], x: ArrayLike<number>, y: ArrayLike<number>, sources: number[], targets: number[] }} graph
   *   positions now (they become the rest positions); links as index pairs
   * @param {{ stiffness?: number, anchor?: number, damping?: number, alongAxis?: "x" | "y" | null,
   *           alongHold?: number, wake?: number, rest?: number }} options
   *   stiffness: how firmly links keep their shape; anchor: how firmly nodes hold their rest positions (together they
   *   set how far a pull travels: per hop along a chain, roughly stiffness / (stiffness + anchor)); damping: 0..1,
   *   how much speed is lost per step; alongAxis / alongHold: layered layouts hold their levels this much more firmly;
   *   wake: how far (world units) a node must be displaced before it disturbs its neighbours; rest: below this speed
   *   and force a node has settled
   */
  constructor(
    {
      ids,
      x,
      y,
      sources,
      targets,
    }: {
      ids: string[];
      x: ArrayLike<number>;
      y: ArrayLike<number>;
      sources: number[];
      targets: number[];
    },
    {
      stiffness,
      anchor,
      damping,
      alongAxis,
      alongHold,
      wake,
      rest,
    }?: {
      stiffness?: number;
      anchor?: number;
      damping?: number;
      alongAxis?: "x" | "y" | null;
      alongHold?: number;
      wake?: number;
      rest?: number;
    },
  );
  /** Hold a node at a point (it's grabbed). */
  grab(id: any, point: any): void;
  /** Move a held node. */
  move(id: any, point: any): void;
  /**
   * Let go: the graph keeps the shape it was pulled into (it becomes the new rest, so neighbours don't spring back),
   * and what's still moving coasts to a stop.
   */
  release(id: any): void;
  /** Is anything still moving? (A node held still doesn't count: nothing needs stepping until it moves.) */
  get isActive(): boolean;
  /**
   * One step for the awake nodes. Forces are all worked out from where things are before anything moves, so the
   * order nodes are visited in doesn't matter. Returns whether anything is still moving.
   */
  step(): boolean;
}
