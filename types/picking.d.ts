/** How far past its drawn radius a node still counts as hit, as a factor of the radius. */
export declare const HIT_SCALE = 1.15;
export declare class HitGrid {
  x: Float64Array<ArrayBufferLike>;
  y: Float64Array<ArrayBufferLike>;
  radius: Float64Array<ArrayBufferLike>;
  boxes: {
    x0: Float64Array<ArrayBufferLike>;
    y0: Float64Array<ArrayBufferLike>;
    x1: Float64Array<ArrayBufferLike>;
    y1: Float64Array<ArrayBufferLike>;
  };
  /** The furthest any node reaches from its centre and still counts as hit. */
  reach: number;
  cols: any;
  rows: any;
  start: Int32Array<ArrayBuffer>;
  items: Int32Array<ArrayBuffer>;
  minX: number;
  minY: number;
  cell: number;
  /**
   * @param {{ x: Float64Array, y: Float64Array, radius: Float64Array, count: number, boxX0?: Float64Array,
   *   boxY0?: Float64Array, boxX1?: Float64Array, boxY1?: Float64Array }} matrix positions and reaches (and
   *   footprints)
   * @param {boolean} [boxes] a node is hit anywhere in its footprint (cards: the whole card), not just its circle
   */
  constructor(
    {
      x,
      y,
      radius,
      count,
      boxX0,
      boxY0,
      boxX1,
      boxY1,
    }: {
      x: Float64Array;
      y: Float64Array;
      radius: Float64Array;
      count: number;
      boxX0?: Float64Array;
      boxY0?: Float64Array;
      boxX1?: Float64Array;
      boxY1?: Float64Array;
    },
    boxes?: boolean,
  );
  /**
   * The topmost node (highest index, drawn last) whose hit circle (or footprint), grown by `slack` world px, holds
   * (px, py); or -1.
   */
  at(px: any, py: any, slack?: number): number;
}
/**
 * Node `index`'s lineage in `graph`: itself, everything it leads to and everything that leads to it, as a flag per
 * node (non-zero: in the lineage). Two walks, up the incoming edges and down the outgoing ones, each node visited
 * at most once per walk.
 * @param {{ nodes: unknown[], edges: { source: number, target: number }[], incoming: ReadonlyArray<ReadonlyArray<number>>,
 *   outgoing: ReadonlyArray<ReadonlyArray<number>> }} graph
 * @returns {Uint8Array}
 */
export declare function lineageMask(
  graph: {
    nodes: unknown[];
    edges: {
      source: number;
      target: number;
    }[];
    incoming: ReadonlyArray<ReadonlyArray<number>>;
    outgoing: ReadonlyArray<ReadonlyArray<number>>;
  },
  index: any,
  into?: any,
): Uint8Array;
/**
 * Part of a lineage mask: "both" is all of it; "ancestors" only what was reached going up (bit 2), "descendants"
 * only going down (bit 4). The node itself is in both. Flags keep their bits.
 * @param {Uint8Array} mask
 * @param {"both" | "ancestors" | "descendants"} part
 */
export declare function lineagePart(
  mask: Uint8Array,
  part: "both" | "ancestors" | "descendants",
): Uint8Array<ArrayBufferLike>;
/** The last few lineages worked out, for one working graph (hovering back and forth costs nothing). */
export declare class LineageCache {
  graph: any;
  /** @type {Map<string, Uint8Array>} by part and node, newest last */
  masks: Map<string, Uint8Array>;
  constructor();
  /**
   * Node `index`'s lineage in `graph` (lineageMask), or the part of it going one way (lineagePart).
   * @param {"both" | "ancestors" | "descendants"} [part]
   */
  get(
    graph: any,
    index: any,
    part?: "both" | "ancestors" | "descendants",
  ): Uint8Array<ArrayBufferLike>;
}
