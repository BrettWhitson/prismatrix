// A layered drawing of a directed graph (the Sugiyama framework), for graphs where a node can have several
// parents: a crafting tree with its shared ingredients merged, so each appears once.
//
//   1. Cycles: a depth-first search reverses any edge that closes a cycle (for layout only).
//   2. Layers: longest path from the sources, so every node sits just below the deepest thing that uses it and
//      depth reads as crafting steps. Or (ranking "simplex") network simplex (Gansner et al. 1993), which moves
//      nodes down next to what they're made from so long edges are fewer, keeping tree edges short where it can.
//   3. Long edges: a dummy node on every layer an edge crosses, so edges bend between nodes, not through them.
//   4. Order within layers: barycenter sweeps down and up; then global sifting (sifting.js) moves each node and
//      each long edge as a whole to wherever it crosses least. Ordering "barycenter" instead follows each sweep
//      with transposition (swapping neighbours while that removes crossings).
//   5. Positions along each layer ("balanced"): every segment pulls its ends into line, weighted so long edges'
//      inner segments pull hardest and tree edges more than cross-links; each node goes to the weighted median of
//      its neighbours and a 1-D projection (isotonic regression) keeps each layer in order without overlaps. This
//      lands within a few percent of the exact optimum (Gansner's auxiliary-graph LP) at a tenth of the cost.
//      Placement "median" is the older unweighted version.
//   6. Edges follow their dummy nodes ("bends"), recorded per edge for the edge geometry.
//
// Pure: no DOM. Measured with `npm run bench:merged`.

import { TREE_LABEL_ANGLE, DEFAULT_SIZING } from "./layouts.js";
import { networkSimplex } from "./simplex.js";
import { globalSifting } from "./sifting.js";

const ORDER_SWEEPS = 12;
const PLACE_PASSES = 8;
const BALANCE_PASSES = 12;
const SIFT_ROUNDS = 4;
// Layering keeps tree edges (an ingredient's first recipe) this much harder to stretch than cross-links, so depth
// still reads as crafting steps and only shared ingredients' extra edges grow long.
const TREE_RANK_WEIGHT = 8;
const SIFT_BUDGET = 60; // ms: a very large graph stops sifting early rather than stalling

/**
 * @param {import("./graph.js").Graph} graph
 * @param {{ direction?: string, levelGap?: number, nodeGap?: number }} [options]
 * @param {import("./layouts.js").Sizing} [sizing]
 * @returns {{ kind: "layered", direction: string, bends: Map<object, number[][]>, crossings: number,
 *   initialCrossings: number, layerOf: Int32Array }}
 */
export function layeredLayout(
  graph,
  {
    direction = "TB",
    levelGap = 90,
    nodeGap = 16,
    ranking = "longest",
    ordering = "sifting",
    placement = "balanced",
  } = {},
  sizing = DEFAULT_SIZING,
) {
  const { nodes, edges } = graph;
  const n = nodes.length;
  const flip = direction === "BT" || direction === "RL";
  const across = direction === "LR" || direction === "RL";

  // ---- 1. cycles: reverse back edges found by a depth-first search from the forest's roots, then the rest
  const out = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => out[e.source].push(i));
  const reversed = new Uint8Array(edges.length);
  {
    const state = new Uint8Array(n); // 0 new, 1 on the stack, 2 done
    const visit = (start) => {
      const stack = [[start, 0]];
      state[start] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, k] = top;
        if (k < out[v].length) {
          top[1]++;
          const ei = out[v][k];
          const w = edges[ei].target;
          if (state[w] === 1) reversed[ei] = 1;
          else if (state[w] === 0) {
            state[w] = 1;
            stack.push([w, 0]);
          }
        } else {
          state[v] = 2;
          stack.pop();
        }
      }
    };
    for (const r of graph.roots) if (!state[r]) visit(r);
    for (let v = 0; v < n; v++) if (!state[v]) visit(v);
  }
  const from = (ei) => (reversed[ei] ? edges[ei].target : edges[ei].source);
  const to = (ei) => (reversed[ei] ? edges[ei].source : edges[ei].target);

  // ---- 2. layers: network simplex (fewest layers crossed in all), or longest path from the sources
  let layerOf = new Int32Array(n);
  if (ranking === "simplex") {
    const kept = edges.flatMap((_, ei) => (from(ei) === to(ei) ? [] : [ei]));
    layerOf = networkSimplex(
      n,
      kept.map(from),
      kept.map(to),
      kept.map(() => 1),
      kept.map((ei) => (edges[ei].tree ? TREE_RANK_WEIGHT : 1)),
      { maxPivots: 20 * n + 100 },
    ).rank;
  } else {
    const indegree = new Int32Array(n);
    const down = Array.from({ length: n }, () => []);
    edges.forEach((_, ei) => {
      indegree[to(ei)]++;
      down[from(ei)].push(to(ei));
    });
    const queue = [];
    for (let v = 0; v < n; v++) if (!indegree[v]) queue.push(v);
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      for (const w of down[v]) {
        layerOf[w] = Math.max(layerOf[w], layerOf[v] + 1);
        if (--indegree[w] === 0) queue.push(w);
      }
    }
  }
  const layerCount = n ? Math.max(...layerOf) + 1 : 0;

  // ---- 3. dummies: every layer a long edge crosses gets one; layout nodes are the real ones then dummies
  const lay = Array.from(layerOf); // layer per layout node
  const upper = Array.from({ length: n }, () => []); // neighbours one layer up
  const lower = Array.from({ length: n }, () => []);
  // How much each segment wants to be straight, parallel to upper and lower: long edges' inner segments most,
  // then their ends, then short edges; a tree edge (an ingredient's first recipe) four times its kind.
  const upperWeight = Array.from({ length: n }, () => []);
  const lowerWeight = Array.from({ length: n }, () => []);
  const link = (a, b, w) => {
    lower[a].push(b);
    upper[b].push(a);
    lowerWeight[a].push(w);
    upperWeight[b].push(w);
  };
  const chains = edges.map(() => []); // layout nodes along each edge, top to bottom
  // For sifting: each node is a block of its own, and each long edge's dummies are one block.
  const blockOf = Array.from({ length: n }, (_, v) => v);
  edges.forEach((_, ei) => {
    const a = from(ei),
      b = to(ei);
    if (a === b) return;
    const chain = [a];
    const boost = edges[ei].tree ? 4 : 1;
    let prev = a;
    for (let k = layerOf[a] + 1; k < layerOf[b]; k++) {
      const d = lay.length;
      lay.push(k);
      blockOf.push(n + ei);
      upper.push([]);
      lower.push([]);
      upperWeight.push([]);
      lowerWeight.push([]);
      link(prev, d, (prev === a ? 2 : 8) * boost);
      chain.push(d);
      prev = d;
    }
    link(prev, b, (prev === a ? 1 : 2) * boost);
    chain.push(b);
    chains[ei] = chain;
  });
  const total = lay.length;
  const isDummy = (v) => v >= n;

  // ---- 4. order: depth-first from the sources for a tree-like start, then barycenter sweeps
  let layers = Array.from({ length: layerCount }, () => []);
  {
    const seen = new Uint8Array(total);
    const visit = (start) => {
      const stack = [start];
      while (stack.length) {
        const v = stack.pop();
        if (seen[v]) continue;
        seen[v] = 1;
        layers[lay[v]].push(v);
        for (let k = lower[v].length - 1; k >= 0; k--)
          if (!seen[lower[v][k]]) stack.push(lower[v][k]);
      }
    };
    for (const r of graph.roots) visit(r);
    for (let v = 0; v < total; v++) if (!seen[v]) visit(v);
  }
  const pos = new Float64Array(total);
  const index = (list) => list.forEach((v, i) => (pos[v] = i));
  layers.forEach(index);
  const initialCrossings = countCrossings(layers, lower, pos);
  let best = layers.map((l) => l.slice());
  let bestCrossings = initialCrossings;
  // Sifting does better from the depth-first order alone; barycenter sweeps are the cheaper alternative.
  const sweeps = ORDER_SWEEPS;
  for (let sweep = 0; sweep < sweeps && bestCrossings > 0; sweep++) {
    const downward = sweep % 2 === 0;
    const range = downward
      ? [...Array(layerCount).keys()].slice(1)
      : [...Array(layerCount).keys()].reverse().slice(1);
    for (const k of range) {
      const list = layers[k];
      const key = new Map();
      for (const v of list) {
        const near = downward ? upper[v] : lower[v];
        key.set(
          v,
          near.length
            ? near.reduce((sum, u) => sum + pos[u], 0) / near.length
            : pos[v],
        );
      }
      // Stable: ties keep their current order.
      list.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
      index(list);
    }
    if (ordering !== "sifting") transpose(layers, upper, lower, pos);
    const crossings = countCrossings(layers, lower, pos);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = layers.map((l) => l.slice());
    }
  }
  layers = best;
  layers.forEach(index);
  if (ordering === "sifting" && bestCrossings > 0) {
    const sifted = globalSifting(
      {
        layers,
        layer: lay,
        upper,
        lower,
        block: blockOf,
        blocks: n + edges.length,
      },
      { rounds: SIFT_ROUNDS, budget: SIFT_BUDGET },
    ).layers;
    sifted.forEach(index);
    const crossings = countCrossings(sifted, lower, pos);
    if (crossings <= bestCrossings) {
      layers = sifted;
      bestCrossings = crossings;
    } else layers.forEach(index);
  }

  // ---- 5. positions along each layer
  const left = new Float64Array(total),
    right = new Float64Array(total),
    near = new Float64Array(total),
    far = new Float64Array(total);
  const angle = TREE_LABEL_ANGLE[direction];
  for (const node of nodes) {
    const box = sizing.box(node.index, angle);
    const [lo, hi, a, b] = across
      ? [box.y0, box.y1, box.x0, box.x1]
      : [box.x0, box.x1, box.y0, box.y1];
    left[node.index] = Math.max(0, -lo);
    right[node.index] = Math.max(0, hi);
    near[node.index] = flip ? -b : a;
    far[node.index] = flip ? -a : b;
  }
  const gap = nodeGap + sizing.gap;
  const dummyHalf = 2;
  for (let v = n; v < total; v++) left[v] = right[v] = dummyHalf;
  const separation = (a, b) =>
    right[a] + left[b] + (isDummy(a) && isDummy(b) ? gap / 2 : gap);
  const weight = (v) => (isDummy(v) ? 4 : 1); // long edges like to stay straight

  const x = new Float64Array(total);
  for (const list of layers) {
    let at = 0;
    list.forEach((v, i) => {
      if (i) at += separation(list[i - 1], v);
      x[v] = at;
    });
  }
  const median = (list) => {
    const values = list.map((u) => x[u]).sort((a, b) => a - b);
    const m = values.length >> 1;
    return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
  };
  /** The weighted median of neighbours' positions: where the weighted sum of distances to them is least. */
  const weightedMedian = (list, weights) => {
    const order = list.map((_, i) => i).sort((i, j) => x[list[i]] - x[list[j]]);
    let total = 0;
    for (const w of weights) total += w;
    let run = 0;
    for (let k = 0; k < order.length; k++) {
      run += weights[order[k]];
      if (run * 2 > total + 1e-9) return x[list[order[k]]];
      if (Math.abs(run * 2 - total) <= 1e-9)
        return (x[list[order[k]]] + x[list[order[k + 1]]]) / 2;
    }
    return x[list[order[order.length - 1]]];
  };
  if (placement === "balanced") {
    // Minimise the weighted sideways travel of every segment, layer by layer: each node wants the weighted median
    // of its neighbours; the projection keeps the layer in order with its gaps, giving way where the weight is
    // least. The first passes pull from one side at a time (a quick start), the rest from both.
    for (let pass = 0; pass < BALANCE_PASSES; pass++) {
      const downward = pass % 2 === 0;
      const both = pass >= 2;
      const order = downward
        ? [...Array(layerCount).keys()]
        : [...Array(layerCount).keys()].reverse();
      for (const k of order) {
        const list = layers[k];
        const pull = new Float64Array(list.length);
        const desired = list.map((v, i) => {
          const near = both
            ? [...upper[v], ...lower[v]]
            : downward
              ? upper[v]
              : lower[v];
          const weights = both
            ? [...upperWeight[v], ...lowerWeight[v]]
            : downward
              ? upperWeight[v]
              : lowerWeight[v];
          for (const w of weights) pull[i] += w;
          if (!near.length) {
            pull[i] = 0.01;
            return x[v];
          }
          return weightedMedian(near, weights);
        });
        const seps = list.slice(1).map((v, i) => separation(list[i], v));
        const placed = project(desired, seps, pull);
        list.forEach((v, i) => (x[v] = placed[i]));
      }
    }
  }
  for (let pass = 0; placement === "median" && pass < PLACE_PASSES; pass++) {
    const last = pass === PLACE_PASSES - 1;
    const downward = pass % 2 === 0;
    const order = downward
      ? [...Array(layerCount).keys()]
      : [...Array(layerCount).keys()].reverse();
    for (const k of order) {
      const list = layers[k];
      const desired = list.map((v) => {
        // The last pass balances between both sides; the others pull from one side at a time.
        const neighbours = last
          ? [...upper[v], ...lower[v]]
          : downward
            ? upper[v]
            : lower[v];
        return neighbours.length ? median(neighbours) : x[v];
      });
      const seps = list.slice(1).map((v, i) => separation(list[i], v));
      const placed = project(desired, seps, list.map(weight));
      list.forEach((v, i) => (x[v] = placed[i]));
    }
  }
  // Centre the drawing on 0.
  let lo = Infinity,
    hi = -Infinity;
  for (let v = 0; v < total; v++) {
    lo = Math.min(lo, x[v] - left[v]);
    hi = Math.max(hi, x[v] + right[v]);
  }
  const middle = total ? (lo + hi) / 2 : 0;

  // Layer positions along depth: at least levelGap apart, further where footprints need it.
  const farOf = new Array(layerCount).fill(0),
    nearOf = new Array(layerCount).fill(0);
  for (let v = 0; v < n; v++) {
    farOf[lay[v]] = Math.max(farOf[lay[v]], far[v]);
    nearOf[lay[v]] = Math.min(nearOf[lay[v]], near[v]);
  }
  const level = [0];
  for (let k = 1; k < layerCount; k++)
    level[k] =
      level[k - 1] + Math.max(levelGap, farOf[k - 1] - nearOf[k] + gap);
  const place = (v) => {
    const b = x[v] - middle;
    const d = level[lay[v]] * (flip ? -1 : 1);
    return across ? [d, b] : [b, d];
  };
  for (const node of nodes) [node.homeX, node.homeY] = place(node.index);

  // ---- 6. bends: each edge's dummies, in the edge's own direction (source to target)
  const bends = new Map();
  edges.forEach((e, ei) => {
    const inner = chains[ei].slice(1, -1).map(place);
    if (reversed[ei]) inner.reverse();
    bends.set(e, inner);
  });

  return {
    kind: "layered",
    direction,
    bends,
    crossings: bestCrossings,
    initialCrossings,
    layerOf,
  };
}

/**
 * Swap neighbouring nodes on each layer whenever that removes crossings with the layers above and below
 * (Gansner et al. 1993's transposition), until a whole pass changes nothing (or a bound on passes).
 */
function transpose(layers, upper, lower, pos) {
  /** Crossings between u's edges and v's edges, with u to the left of v. */
  const between = (u, v) => {
    let c = 0;
    for (const side of [upper, lower])
      for (const a of side[u])
        for (const b of side[v]) if (pos[a] > pos[b]) c++;
    return c;
  };
  for (let round = 0; round < 8; round++) {
    let improved = false;
    for (const list of layers) {
      for (let i = 0; i + 1 < list.length; i++) {
        const u = list[i],
          v = list[i + 1];
        if (between(v, u) < between(u, v)) {
          list[i] = v;
          list[i + 1] = u;
          pos[u] = i + 1;
          pos[v] = i;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

/**
 * Edge crossings between every pair of neighbouring layers, at positions `pos`: for each pair, the edges sorted by
 * their upper end, then counted as inversions of their lower ends (merge sort), O(E log E).
 */
export function countCrossings(layers, lower, pos) {
  let total = 0;
  for (let k = 0; k + 1 < layers.length; k++) {
    const pairs = [];
    for (const v of layers[k])
      for (const w of lower[v]) pairs.push([pos[v], pos[w]]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    total += inversions(pairs.map((p) => p[1]));
  }
  return total;
}

function inversions(values) {
  if (values.length < 2) return 0;
  const mid = values.length >> 1;
  const a = values.slice(0, mid),
    b = values.slice(mid);
  let count = inversions(a) + inversions(b);
  let i = 0,
    j = 0,
    k = 0;
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) values[k++] = a[i++];
    else {
      values[k++] = b[j++];
      count += a.length - i;
    }
  }
  while (i < a.length) values[k++] = a[i++];
  while (j < b.length) values[k++] = b[j++];
  return count;
}

/**
 * The positions closest to `desired` (weighted least squares) that keep the order and at least `seps[i]` between
 * neighbours i and i + 1. Shifting each by the separations before it turns this into isotonic regression, solved
 * by pool-adjacent-violators in linear time.
 */
export function project(desired, seps, weights) {
  const count = desired.length;
  const offset = new Float64Array(count);
  for (let i = 1; i < count; i++) offset[i] = offset[i - 1] + seps[i - 1];
  // Blocks of pooled values: [weighted sum, weight, size].
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push([(desired[i] - offset[i]) * weights[i], weights[i], 1]);
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1],
        a = blocks[blocks.length - 2];
      if (a[0] / a[1] <= b[0] / b[1]) break;
      blocks.pop();
      a[0] += b[0];
      a[1] += b[1];
      a[2] += b[2];
    }
  }
  const out = new Float64Array(count);
  let i = 0;
  for (const [sum, w, size] of blocks)
    for (let k = 0; k < size; k++, i++) out[i] = sum / w + offset[i];
  return out;
}
