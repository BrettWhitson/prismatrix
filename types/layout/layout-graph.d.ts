/**
 * The graph as the layouts and the physics see it: plain arrays, no renderer. Each node has its own box (w × h) and
 * its footprint with the label (fullW × fullH, the box they make together); edges run parent → child, from the root outward.
 * Positions live in `x` / `y` (centres) and are what every layout reads and writes.
 *
 *   const graph = new LayoutGraph(
 *     [{ id: "result", w: 58, h: 58, fullW: 200, fullH: 58, root: true }, { id: "ore", w: 48, h: 48 }],
 *     [{ source: "result", target: "ore" }],
 *   );
 */
export declare class LayoutGraph {
  count: number;
  ids: string[];
  indexById: Map<string, number>;
  x: Float64Array<ArrayBuffer>;
  y: Float64Array<ArrayBuffer>;
  w: Float64Array<ArrayBuffer>;
  h: Float64Array<ArrayBuffer>;
  fullW: Float64Array<ArrayBuffer>;
  fullH: Float64Array<ArrayBuffer>;
  ghost: Uint8Array<ArrayBuffer>;
  rootIndex: number;
  /** Edges as index pairs (both ends present, no self-loops). */
  sources: number[];
  targets: number[];
  /**
   * @param {{ id: string, w: number, h: number, fullW?: number, fullH?: number, x?: number, y?: number,
   *           root?: boolean, ghost?: boolean }[]} nodes  ghosts are leaving: laid out, but not simulated
   * @param {{ id?: string, source: string, target: string }[]} edges
   *   Ids must be unique: of nodes sharing an id, the first is kept and the rest dropped, with a warning. The same
   *   goes for edges, whose id is their `id` or "source->target" (so an edge given twice pulls once).
   */
  constructor(
    nodes: {
      id: string;
      w: number;
      h: number;
      fullW?: number;
      fullH?: number;
      x?: number;
      y?: number;
      root?: boolean;
      ghost?: boolean;
    }[],
    edges: {
      id?: string;
      source: string;
      target: string;
    }[],
  );
  get rootId(): string;
  /**
   * Space node `i` takes up: its box plus a share (0..1) of the label's overhang on each axis. Low shares let labels
   * overlap their neighbours' (tighter packing).
   */
  footprint(
    i: any,
    widthLabelShare?: number,
    heightLabelShare?: number,
  ): {
    w: number;
    h: number;
  };
  positionOf(id: any): {
    x: number;
    y: number;
  };
  /** Every node's position, as a Map: id → { x, y }. */
  positions(): Map<
    string,
    {
      x: number;
      y: number;
    }
  >;
}
/**
 * `items` with one per id: the first of each id is kept, later ones are dropped, with one warning per call that
 * found any (naming a few of the ids). Returns `items` itself when every id is unique.
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {string} [scope]  who is asking, for the warning
 * @returns {T[]}
 */
export declare function uniqueById<
  T extends {
    id: string;
  },
>(items: T[], scope?: string): T[];
