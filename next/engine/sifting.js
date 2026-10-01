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
// Pure: no DOM.

/**
 * @param {object} graph the proper layered graph
 * @param {number[][]} graph.layers  starting order: layout nodes per layer, left to right
 * @param {ArrayLike<number>} graph.layer  per layout node, its layer
 * @param {number[][]} graph.upper   per layout node, its neighbours one layer up
 * @param {number[][]} graph.lower   per layout node, its neighbours one layer down
 * @param {ArrayLike<number>} graph.block per layout node, the block it belongs to (0 … blocks - 1)
 * @param {number} graph.blocks
 * @param {{ rounds?: number, budget?: number }} [options] budget: stop starting new blocks after this many ms
 * @returns {{ layers: number[][], rounds: number }}
 */
export function globalSifting(
  { layers, layer, upper, lower, block, blocks },
  { rounds = 6, budget = 80 } = {},
) {
  const started = performance.now();
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

  // The starting order of blocks: by mean relative place across the layers they're on.
  const order = [];
  {
    const sum = new Float64Array(blocks),
      seen = new Int32Array(blocks);
    for (const list of layers)
      list.forEach((v, i) => {
        sum[block[v]] += (i + 0.5) / list.length;
        seen[block[v]]++;
      });
    for (let b = 0; b < blocks; b++) if (hi[b] >= 0) order.push(b);
    order.sort((a, b) => sum[a] / seen[a] - sum[b] / seen[b] || a - b);
  }
  // Each block's index in the order. A block being tried elsewhere sits half a place to one side of a neighbour.
  const place = new Float64Array(blocks);
  order.forEach((b, i) => (place[b] = i));

  /**
   * Pairs of edges, one from each run of `ids`, that cross with the first run's block on the left: their other ends
   * are the other way round. A and B are read at places pa and pb, wherever they appear.
   */
  const crossingsOf = (ids, l0, l1, r0, r1, A, pa, B, pb) => {
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

  let round = 0;
  for (; round < rounds; round++) {
    let improved = false;
    const queue = order.slice().sort((a, b) => degree(b) - degree(a) || a - b);
    for (const A of queue) {
      if (performance.now() - started > budget) break;
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
    if (!improved || performance.now() - started > budget) {
      round++;
      break;
    }
  }

  const out = layers.map(() => []);
  for (const b of order)
    for (let s = at[b]; s < at[b + 1]; s++) {
      const v = vertexAt[s];
      out[layer[v]].push(v);
    }
  return { layers: out, rounds: round };
}
