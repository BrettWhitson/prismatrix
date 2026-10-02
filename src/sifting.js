// Global sifting (Bachmaier, Brandenburg, Brunner & Hübner 2011, "Global k-level crossing reduction"): crossing
// reduction over all layers at once.
//
// Every node and every long edge's chain of dummy nodes is a block: something that occupies one place in a single
// left-to-right order, on every layer it spans. The layers' orders are read off that one order, so a long edge
// keeps its place relative to everything else all the way down and never zig-zags between layers.
//
// Sifting takes each block in turn (busiest first), tries it at every place in the order, and leaves it where it
// causes fewest crossings. Moving a block one place right swaps it with its neighbour, and the change in crossings
// from that swap only involves the edges of those two blocks, so trying every place costs one pass along the order.
//
// The one order starts as the layers given, exactly, whenever they can be read off a single order (every block keeps
// the same neighbours to its left and right on each layer it spans): then sifting only ever removes crossings. Its
// effort is counted in steps of work (edge pairs compared, places tried), not time, so the same input always gives
// the same order on any machine.
//
// Pure: no DOM.

/**
 * @param {object} graph the proper layered graph
 * @param {number[][]} graph.layers  starting order: layout nodes per layer, left to right
 * @param {ArrayLike<number>} graph.layer  per layout node, its layer
 * @param {number[][]} graph.upper   per layout node, its neighbours one layer up
 * @param {number[][]} graph.lower   per layout node, its neighbours one layer down
 * @param {ArrayLike<number>} graph.block per layout node, the block it belongs to (0 … blocks - 1)
 * @param {number} graph.blocks
 * @param {{ rounds: number, work: number, movable?: ArrayLike<number> | null }} options work: stop starting new
 *   blocks after this many steps; movable: per block, nonzero if it may be moved (the others keep their order among
 *   themselves, so a layout that's mostly as it was stays so: see layered.js's hint); all of them when left out
 * @returns {{ layers: number[][] }}
 */
export function globalSifting(
  { layers, layer, upper, lower, block, blocks },
  { rounds, work, movable = null },
) {
  const vertices = layer.length;
  // Each block's span of layers and its vertex on each.
  const lo = new Int32Array(blocks).fill(0x7fffffff),
    hi = new Int32Array(blocks).fill(-1);
  for (let v = 0; v < vertices; v++) {
    const b = block[v];
    lo[b] = Math.min(lo[b], layer[v]);
    hi[b] = Math.max(hi[b], layer[v]);
  }
  // Per block and layer, its neighbours' blocks above and below, as flat runs: [start, end) into `ids`.
  const at = new Int32Array(blocks + 1);
  for (let b = 0; b < blocks; b++)
    at[b + 1] = at[b] + (hi[b] >= 0 ? hi[b] - lo[b] + 1 : 0);
  const vertexAt = new Int32Array(at[blocks]);
  for (let v = 0; v < vertices; v++)
    vertexAt[at[block[v]] + layer[v] - lo[block[v]]] = v;
  const upStart = new Int32Array(at[blocks] + 1),
    downStart = new Int32Array(at[blocks] + 1);
  let upCount = 0,
    downCount = 0;
  for (let s = 0; s < at[blocks]; s++) {
    upStart[s] = upCount;
    downStart[s] = downCount;
    upCount += upper[vertexAt[s]].length;
    downCount += lower[vertexAt[s]].length;
  }
  upStart[at[blocks]] = upCount;
  downStart[at[blocks]] = downCount;
  const upIds = new Int32Array(upCount),
    downIds = new Int32Array(downCount);
  for (let s = 0; s < at[blocks]; s++) {
    const v = vertexAt[s];
    upper[v].forEach((u, i) => (upIds[upStart[s] + i] = block[u]));
    lower[v].forEach((u, i) => (downIds[downStart[s] + i] = block[u]));
  }

  const order = startingOrder(layers, block, blocks, hi);
  // Each block's index in the order. A block being tried elsewhere sits half a place to one side of a neighbour.
  const place = new Float64Array(blocks);
  order.forEach((b, i) => (place[b] = i));

  let spent = 0; // steps of work so far
  /**
   * Pairs of edges, one from each run of `ids`, that cross with the first run's block on the left: their other ends
   * are the other way round. A and B are read at places pa and pb, wherever they appear.
   */
  const crossingsOf = (ids, l0, l1, r0, r1, A, pa, B, pb) => {
    spent += (l1 - l0) * (r1 - r0);
    let c = 0;
    for (let i = l0; i < l1; i++) {
      const x = ids[i];
      const px = x === A ? pa : x === B ? pb : place[x];
      for (let j = r0; j < r1; j++) {
        const y = ids[j];
        if (x === y) continue;
        if (px > (y === A ? pa : y === B ? pb : place[y])) c++;
      }
    }
    return c;
  };
  /** One side (neighbours above or below) of A's and B's vertices on one layer. */
  const sideDelta = (start, ids, sa, sb, A, B) => {
    const a0 = start[sa],
      a1 = start[sa + 1],
      b0 = start[sb],
      b1 = start[sb + 1];
    if (a0 === a1 || b0 === b1) return 0;
    const pb = place[B];
    // Before: A just left of B. After: just right of it.
    return (
      crossingsOf(ids, b0, b1, a0, a1, A, pb + 0.5, B, pb) -
      crossingsOf(ids, a0, a1, b0, b1, A, pb - 0.5, B, pb)
    );
  };
  /** The change in crossings from swapping A with B, its right-hand neighbour in the order. */
  const swapDelta = (A, B) => {
    const from = Math.max(lo[A], lo[B]),
      to = Math.min(hi[A], hi[B]);
    let delta = 0;
    for (let l = from; l <= to; l++) {
      const sa = at[A] + l - lo[A],
        sb = at[B] + l - lo[B];
      delta +=
        sideDelta(upStart, upIds, sa, sb, A, B) +
        sideDelta(downStart, downIds, sa, sb, A, B);
    }
    return delta;
  };
  const degree = (b) =>
    upStart[at[b + 1]] -
    upStart[at[b]] +
    downStart[at[b + 1]] -
    downStart[at[b]];

  for (let round = 0; round < rounds && spent < work; round++) {
    let improved = false;
    const queue = order
      .filter((b) => !movable || movable[b])
      .sort((a, b) => degree(b) - degree(a) || a - b);
    for (const A of queue) {
      if (spent >= work) break;
      spent += order.length;
      const home = place[A];
      // Walk A from the far left rightwards past each other block, keeping the best place (ties: nearest where it
      // was). Only blocks that share a layer with A change anything.
      let total = 0,
        best = 0,
        bestAt = -0.5,
        atHome = home === 0 ? 0 : NaN;
      for (let i = 0; i < order.length; i++) {
        const B = order[i];
        if (B === A) {
          atHome = total;
          continue;
        }
        if (lo[B] <= hi[A] && lo[A] <= hi[B]) total += swapDelta(A, B);
        const here = i + 0.5;
        if (
          total < best ||
          (total === best && Math.abs(here - home) < Math.abs(bestAt - home))
        ) {
          best = total;
          bestAt = here;
        }
      }
      if (best < atHome) {
        improved = true;
        // Move A, renumbering only the blocks it passes.
        order.splice(home, 1);
        const to = bestAt > home ? Math.floor(bestAt) : Math.ceil(bestAt);
        order.splice(to, 0, A);
        for (let i = Math.min(home, to); i <= Math.max(home, to); i++)
          place[order[i]] = i;
      }
    }
    if (!improved) break;
  }

  const out = layers.map(() => []);
  for (const b of order)
    for (let s = at[b]; s < at[b + 1]; s++) {
      const v = vertexAt[s];
      out[layer[v]].push(v);
    }
  return { layers: out };
}

/**
 * One left-to-right order of blocks that reads back as the layers given: each layer's neighbours in order are
 * constraints (left one first), and the blocks are taken in topological order of them, the one furthest left on
 * average first among those free to go. When the constraints go round in a circle (two long edges swap sides
 * between layers), the block furthest left on average that's still waiting goes next anyway, and the order no
 * longer reads back as the layers given.
 */
function startingOrder(layers, block, blocks, hi) {
  const mean = new Float64Array(blocks),
    seen = new Int32Array(blocks);
  const waiting = new Int32Array(blocks); // constraints still to be met before a block can go
  let edges = 0;
  for (const list of layers) edges += Math.max(0, list.length - 1);
  // The constraints as a flat list of right-hand blocks per left-hand block.
  const start = new Int32Array(blocks + 1),
    next = new Int32Array(edges);
  for (const list of layers)
    for (let i = 0; i < list.length; i++) {
      const b = block[list[i]];
      mean[b] += (i + 0.5) / list.length;
      seen[b]++;
      if (i + 1 < list.length) start[b + 1]++;
    }
  for (let b = 0; b < blocks; b++) {
    start[b + 1] += start[b];
    if (seen[b]) mean[b] /= seen[b];
  }
  const fill = start.slice(0, blocks);
  for (const list of layers)
    for (let i = 0; i + 1 < list.length; i++) {
      const b = block[list[i + 1]];
      next[fill[block[list[i]]]++] = b;
      waiting[b]++;
    }
  const before = (a, b) => mean[a] - mean[b] || a - b;
  // Blocks free to go, as a binary heap by mean place.
  const heap = [];
  const push = (b) => {
    let i = heap.length;
    heap.push(b);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(heap[p], b) <= 0) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = b;
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1], heap[c]) < 0) c++;
        if (before(last, heap[c]) <= 0) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  const used = [];
  for (let b = 0; b < blocks; b++) if (hi[b] >= 0) used.push(b);
  // For breaking a circle: every block by mean place, and how far along that list nothing is left waiting.
  const byMean = used.slice().sort(before);
  let scan = 0;
  const done = new Uint8Array(blocks);
  for (const b of used) if (!waiting[b]) push(b);
  const order = [];
  while (order.length < used.length) {
    let b;
    if (heap.length) b = pop();
    else {
      while (done[byMean[scan]]) scan++;
      b = byMean[scan];
    }
    if (done[b]) continue;
    done[b] = 1;
    order.push(b);
    for (let k = start[b]; k < start[b + 1]; k++) {
      const c = next[k];
      if (--waiting[c] === 0 && !done[c]) push(c);
    }
  }
  return order;
}
