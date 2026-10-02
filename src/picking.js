// Picking: which node is under the pointer, and which nodes light up with it, fast at any size.
//
//   - HitGrid: a uniform grid over node positions, built in one pass (a counting sort into cells), so finding the
//     node under a point looks at a handful of nodes instead of all of them. The controller builds one lazily, at
//     most once per frame that moved something, and keeps it while nothing moves.
//   - lineageMask: a node's lineage (everything above it and everything below it) as a flag per node, the set the
//     hover lights up. LineageCache keeps the last few, per working graph.
//
// Pure: no DOM, no GL.

/** How far past its drawn radius a node still counts as hit, as a factor of the radius. */
export const HIT_SCALE = 1.15;

export class HitGrid {
  /**
   * @param {{ x: Float64Array, y: Float64Array, radius: Float64Array, count: number }} matrix positions and reaches
   */
  constructor({ x, y, radius, count }) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      reach = 0;
    for (let i = 0; i < count; i++) {
      // A node that has flown off to infinity (or NaN) can't be under anything: it isn't filed.
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
      if (radius[i] > reach) reach = radius[i];
    }
    /** The furthest any node reaches from its centre and still counts as hit. */
    this.reach = reach * HIT_SCALE;
    if (minX > maxX) {
      this.cols = this.rows = 0;
      this.start = new Int32Array(1);
      this.items = new Int32Array(0);
      return;
    }
    // Cells about a node's spacing across (a few nodes each), never smaller than a node, and never more than a few
    // per node, so a sparse graph or one huge node can't make the grid itself the cost.
    const w = maxX - minX,
      h = maxY - minY;
    let cell = Math.max(Math.sqrt((w * h) / count) * 1.5, this.reach, 1e-6);
    let cols, rows;
    for (;;) {
      cols = Math.floor(w / cell) + 1;
      rows = Math.floor(h / cell) + 1;
      if (cols * rows <= count * 2 + 64) break;
      cell *= 1.5;
    }
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    const cellOf = new Int32Array(count).fill(-1);
    const start = new Int32Array(cols * rows + 1);
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
      const c =
        Math.floor((y[i] - minY) / cell) * cols +
        Math.floor((x[i] - minX) / cell);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
    const fill = start.slice(0, cols * rows);
    const items = new Int32Array(start[cols * rows]);
    // In index order within each cell, so the last match found is the topmost (drawn last).
    for (let i = 0; i < count; i++)
      if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i;
    this.start = start;
    this.items = items;
  }

  /**
   * The topmost node (highest index, drawn last) whose hit circle, grown by `slack` world px, holds (px, py); or -1.
   */
  at(px, py, slack = 0) {
    if (!this.cols) return -1;
    const { x, y, radius, cell, cols, rows, minX, minY, start, items } = this;
    const r = this.reach + slack;
    const c0 = Math.max(Math.floor((px - r - minX) / cell), 0),
      c1 = Math.min(Math.floor((px + r - minX) / cell), cols - 1),
      r0 = Math.max(Math.floor((py - r - minY) / cell), 0),
      r1 = Math.min(Math.floor((py + r - minY) / cell), rows - 1);
    let best = -1;
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const c = row * cols + col;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const i = items[k];
          if (
            i > best &&
            Math.hypot(x[i] - px, y[i] - py) <= radius[i] * HIT_SCALE + slack
          )
            best = i;
        }
      }
    return best;
  }
}

/**
 * Node `index`'s lineage in `graph`: itself, everything it leads to and everything that leads to it, as a flag per
 * node (non-zero: in the lineage). Two walks, up the incoming edges and down the outgoing ones, each node visited
 * at most once per walk.
 * @param {{ nodes: unknown[], edges: { source: number, target: number }[], incoming: ReadonlyArray<ReadonlyArray<number>>,
 *   outgoing: ReadonlyArray<ReadonlyArray<number>> }} graph
 * @returns {Uint8Array}
 */
export function lineageMask(graph, index, into = null) {
  const n = graph.nodes.length;
  const mask = into ?? new Uint8Array(n);
  const stack = new Int32Array(n);
  // Bit 1: in the lineage; bit 2: reached going up; bit 4: reached going down.
  /** @type {[ReadonlyArray<ReadonlyArray<number>>, "source" | "target", number][]} */
  const walks = [
    [graph.incoming, "source", 2],
    [graph.outgoing, "target", 4],
  ];
  for (const [lists, end, bit] of walks) {
    let top = 0;
    stack[top++] = index;
    mask[index] |= 1 | bit;
    while (top) {
      for (const ei of lists[stack[--top]]) {
        const next = graph.edges[ei][end];
        if (mask[next] & bit) continue;
        mask[next] |= 1 | bit;
        stack[top++] = next;
      }
    }
  }
  return mask;
}

/** How many lineages LineageCache keeps. */
const LINEAGES_KEPT = 32;

/** The last few lineages worked out, for one working graph (hovering back and forth costs nothing). */
export class LineageCache {
  constructor() {
    this.graph = null;
    /** @type {Map<number, Uint8Array>} newest last */
    this.masks = new Map();
  }

  get(graph, index) {
    if (graph !== this.graph) {
      this.graph = graph;
      this.masks.clear();
    }
    let mask = this.masks.get(index);
    if (mask) this.masks.delete(index);
    else mask = lineageMask(graph, index);
    this.masks.set(index, mask);
    if (this.masks.size > LINEAGES_KEPT)
      this.masks.delete(this.masks.keys().next().value);
    return mask;
  }
}
