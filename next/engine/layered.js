// A layered drawing of a directed graph (the Sugiyama framework), for graphs where a node can have several
// parents: a crafting tree with its shared ingredients merged, so each appears once.
//
//   1. Cycles: a depth-first search reverses any edge that closes a cycle (for layout only).
//   2. Layers: longest path from the sources, so every node sits just below the deepest thing that uses it and
//      depth reads as crafting steps. Or (ranking "simplex") network simplex (Gansner et al. 1993), which moves
//      nodes down next to what they're made from so long edges are fewer, keeping tree edges short where it can.
//      Then each node's tree edge (the one edge into it drawn as part of the tree) is one from a user a layer
//      above it, so tree edges are short and the long ones are cross-links.
//   3. Long edges: a dummy node on every layer an edge crosses, so edges bend between nodes, not through them.
//   4. Order within layers: barycenter sweeps down and up, from a depth-first order and from seeded shuffles of it;
//      then global sifting (sifting.js) moves each node and each long edge of the best as a whole to wherever it
//      crosses least. Big graphs, and ordering "barycenter", instead follow each sweep with transposition (swapping
//      neighbours while that removes crossings). All effort is counted, never timed: the same input always gives
//      the same layout.
//   5. Positions along each layer ("balanced"): every segment pulls its ends into line, weighted so long edges'
//      inner segments pull hardest and tree edges more than cross-links; each layer in turn goes exactly where its
//      segments' weighted travel is least (an L1 isotonic projection keeps it in order without overlaps), then long
//      edges are straightened where that doesn't add travel. This lands within 1–10% of the exact optimum
//      (Gansner's auxiliary-graph LP) at a fraction of the cost. Placement "median" is the older unweighted version.
//   6. Edges follow their dummy nodes ("bends"), recorded per edge for the edge geometry.
//
// References (step 2b, on by default): every cross-link into an ingredient used by `shareMin` or more recipes ends
// at a reference instead: a small chip one layer below its source, laid out like a little node (references.js draws
// it). Only the ingredient's tree edge stays a real edge. Busy ingredients are what make dense recipe graphs a
// tangle, and even their short edges cross everything between their users; on the crafting fixtures references
// remove 75–95% of crossings and over half the ink, and on real recipe data 96%.
//
// Pure: no DOM. Measured with `npm run bench:merged`.

import { TREE_LABEL_ANGLE, DEFAULT_SIZING } from "./layouts.js";
import { networkSimplex } from "./simplex.js";
import { globalSifting } from "./sifting.js";

const ORDER_SWEEPS = 12;
// Before global sifting, half as many sweeps give the same result: sifting does the rest.
const SIFT_SWEEPS = 6;
const PLACE_PASSES = 8;
const BALANCE_PASSES = 12;
const BALANCE_MIN_PASSES = 4; // then stop as soon as nothing moves more than half a pixel
const SIFT_ROUNDS = 4;
// Layering keeps tree edges (an ingredient's first recipe) this much harder to stretch than cross-links, so depth
// still reads as crafting steps and only shared ingredients' extra edges grow long.
const TREE_RANK_WEIGHT = 8;

/**
 * @param {import("./graph.js").Graph} graph
 * @param {{ direction?: string, levelGap?: number, nodeGap?: number }} [options]
 * @param {import("./layouts.js").Sizing} [sizing]
 * @returns {{ kind: "layered", direction: string, bends: Map<object, number[][]>, references: Reference[],
 *   crossings: number, initialCrossings: number, layerOf: Int32Array,
 *   simplex?: { pivots: number, optimal: boolean } }} `simplex` (ranking "simplex" only): how many exchanges the
 *   layering made, and whether it reached the fewest long edges or stopped at its work budget (very big graphs)
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
    references = "hubs",
    shareMin = 3,
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
  let simplex;
  if (ranking === "simplex") {
    // Network simplex stops after this much work (nodes and edges visited, simplex.js): crafting graphs of up to
    // about ten thousand nodes reach the fewest long edges; bigger ones stop with most of the gain, and say so
    // (`simplex.optimal`). Counted in work, never in time, so the layout doesn't depend on the machine.
    const SIMPLEX_WORK = 2e7;
    const kept = edges.flatMap((_, ei) => (from(ei) === to(ei) ? [] : [ei]));
    const ranked = networkSimplex(
      n,
      kept.map(from),
      kept.map(to),
      kept.map(() => 1),
      kept.map((ei) => (edges[ei].tree ? TREE_RANK_WEIGHT : 1)),
      { work: SIMPLEX_WORK },
    );
    layerOf = ranked.rank;
    simplex = { pivots: ranked.pivots, optimal: ranked.optimal };
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
  let layerCount = 0;
  for (let v = 0; v < n; v++) layerCount = Math.max(layerCount, layerOf[v] + 1);

  // ---- 2a. tree edges: each node's edge in from a user as few layers up as there is (one, after longest path),
  // the forest's own tree edge on a tie, else the first. The forest picks an ingredient's shallowest user (breadth
  // first), which is its longest edge in here: drawn as the tree edge, it would be both long and pulled straight
  // hardest, and never referenced.
  const tree = new Uint8Array(edges.length);
  {
    const best = new Int32Array(n).fill(-1);
    edges.forEach((e, ei) => {
      if (reversed[ei] || e.source === e.target) return;
      const v = e.target,
        b = best[v];
      const span = layerOf[v] - layerOf[e.source];
      if (b < 0) best[v] = ei;
      else {
        const spanB = layerOf[v] - layerOf[edges[b].source];
        if (span < spanB || (span === spanB && e.tree && !edges[b].tree))
          best[v] = ei;
      }
    });
    for (const ei of best) if (ei >= 0) tree[ei] = 1;
  }

  // ---- 2b. references: every cross-link into a busy shared ingredient (used by shareMin or more) ends instead at
  // a reference to it, one layer below its source; only the ingredient's tree edge reaches it. Even a one-layer edge
  // into a busy ingredient crosses everything between its users, so it gets one too. A reference is a compact chip
  // (REFERENCE_HALF either side of its centre, drawn without its ingredient's label), so a recipe with many of them
  // stays narrow. Layout nodes: real nodes, then references, then dummies.
  const REFERENCE_HALF = 6;
  const lay = Array.from(layerOf); // layer per layout node
  const endOf = edges.map((_, ei) => to(ei)); // where each edge ends in the layout: its target or a reference
  const refs = [];
  if (references === "hubs") {
    const uses = new Int32Array(n);
    edges.forEach((e) => uses[e.target]++);
    edges.forEach((e, ei) => {
      if (tree[ei] || reversed[ei] || e.source === e.target) return;
      if (uses[e.target] < shareMin) return;
      endOf[ei] = n + refs.length;
      lay.push(layerOf[e.source] + 1);
      refs.push({ edge: ei, source: e.source, target: e.target });
    });
  }
  const real = n + refs.length; // layout nodes that aren't dummies

  // ---- 3. dummies: every layer a long edge crosses gets one
  const upper = Array.from({ length: real }, () => []); // neighbours one layer up
  const lower = Array.from({ length: real }, () => []);
  // How much each segment wants to be straight, parallel to upper and lower: long edges' inner segments most,
  // then their ends, then short edges; a tree edge (an ingredient's first recipe) four times its kind.
  const upperWeight = Array.from({ length: real }, () => []);
  const lowerWeight = Array.from({ length: real }, () => []);
  const link = (a, b, w) => {
    lower[a].push(b);
    upper[b].push(a);
    lowerWeight[a].push(w);
    upperWeight[b].push(w);
  };
  const chains = edges.map(() => []); // layout nodes along each edge, top to bottom
  // For sifting: each node is a block of its own, and each long edge's dummies are one block.
  const blockOf = Array.from({ length: real }, (_, v) => v);
  edges.forEach((_, ei) => {
    const a = from(ei),
      b = endOf[ei];
    if (a === b) return;
    const chain = [a];
    const boost = tree[ei] ? 4 : 1;
    let prev = a;
    for (let k = lay[a] + 1; k < lay[b]; k++) {
      const d = lay.length;
      lay.push(k);
      blockOf.push(real + ei);
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
  const isDummy = (v) => v >= real;

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
  const ordered = orderLayers(
    layers,
    initialCrossings,
    {
      layer: lay,
      upper,
      lower,
      block: blockOf,
      blocks: real + edges.length,
      segments: total - real + edges.length,
    },
    ordering,
  );
  layers = ordered.layers;
  const bestCrossings = ordered.crossings;
  layers.forEach(index);

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
  refs.forEach(({ target }, k) => {
    // A reference is a chip with no label: REFERENCE_HALF each way, or less if its ingredient is smaller.
    left[n + k] = Math.min(REFERENCE_HALF, left[target]);
    right[n + k] = Math.min(REFERENCE_HALF, right[target]);
    near[n + k] = Math.max(-REFERENCE_HALF, near[target]);
    far[n + k] = Math.min(REFERENCE_HALF, far[target]);
  });
  const gap = nodeGap + sizing.gap;
  const dummyHalf = 2;
  for (let v = real; v < total; v++) left[v] = right[v] = dummyHalf;
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
  if (placement === "balanced")
    balance(
      layers,
      upper,
      lower,
      upperWeight,
      lowerWeight,
      x,
      separation,
      chains,
    );
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
  for (let v = 0; v < real; v++) {
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
    // Each reference: the edge it stands in for, where it sits, and the most its chip should reach from its centre
    // (the room the layout kept for it).
    references: refs.map(({ edge, source, target }, k) => {
      const [x, y] = place(n + k);
      const radius = Math.min(left[n + k], right[n + k]);
      return { edge: edges[edge], source, target, x, y, radius };
    }),
    crossings: bestCrossings,
    initialCrossings,
    layerOf,
    ...(simplex && { simplex }),
  };
}

// Global sifting tries every block at every place, so its cost grows with the square of the graph: above this many
// blocks (nodes and long edges), barycenter sweeps with transposition do better in the same time.
const SIFT_MAX_BLOCKS = 1000;
// Sifting's effort, in steps of work per block (edge pairs compared, places tried): a cap that a graph under
// SIFT_MAX_BLOCKS rarely reaches (the 642-node crafting fixture takes about a quarter of it), counted rather than
// timed so a layout comes out the same on every machine (and in a worker or not).
const SIFT_WORK_PER_BLOCK = 20000;
// Restarts from shuffled orders, for graphs small enough that a few more tries are cheap: as many as fit in this many
// nodes and segments' worth of sweeps, up to RESTARTS. Seeded, so the same graph always gets the same tries.
const RESTART_WORK = 20000;
const RESTARTS = 30;

/**
 * Order each layer to cut crossings, from a starting order (`start`, with `startCrossings` crossings). Never ends
 * with more crossings than it started with.
 *
 *   - Graphs up to SIFT_MAX_BLOCKS blocks: barycenter sweeps; restarts, each shuffling the starting order, sweeping
 *     and transposing; then global sifting of the best order found. Sweeps land in a local optimum that depends on
 *     where they start: on the crafting fixtures and real recipes, a few restarts find orders with 10–50% fewer
 *     crossings (Mjölnir's 8 nodes go from 2 to none).
 *   - Bigger graphs, or ordering "barycenter": barycenter sweeps, each followed by transposition. At this size one
 *     round of sifting costs more than a whole layout should, and the sweeps do better in the time.
 */
function orderLayers(start, startCrossings, graph, ordering) {
  const { layer, upper, lower, block, blocks, segments } = graph;
  const total = layer.length;
  const pos = new Float64Array(total);
  const key = new Float64Array(total); // each node's barycenter, for the sort
  const index = (list) => list.forEach((v, i) => (pos[v] = i));
  const crossingsOf = (layers) => {
    layers.forEach(index);
    return countCrossings(layers, lower, pos);
  };
  /** Barycenter sweeps down and up (each followed by transposition if asked), keeping the best order seen. */
  const sweep = (from, crossings, count, transposing) => {
    const layers = from.map((l) => l.slice());
    let best = { layers: from, crossings };
    layers.forEach(index);
    for (let s = 0; s < count && best.crossings > 0; s++) {
      const downward = s % 2 === 0;
      for (let step = 1; step < layers.length; step++) {
        const list = layers[downward ? step : layers.length - 1 - step];
        for (const v of list) {
          const near = downward ? upper[v] : lower[v];
          let sum = 0;
          for (const u of near) sum += pos[u];
          key[v] = near.length ? sum / near.length : pos[v];
        }
        // Stable: ties keep their current order.
        list.sort((a, b) => key[a] - key[b] || pos[a] - pos[b]);
        index(list);
      }
      if (transposing) transpose(layers, upper, lower, pos);
      const c = countCrossings(layers, lower, pos);
      if (c < best.crossings)
        best = { layers: layers.map((l) => l.slice()), crossings: c };
    }
    return best;
  };
  let used = 0; // blocks with something in them
  {
    const seen = new Uint8Array(blocks);
    for (let v = 0; v < total; v++)
      if (!seen[block[v]]) {
        seen[block[v]] = 1;
        used++;
      }
  }
  if (ordering !== "sifting" || used > SIFT_MAX_BLOCKS)
    return sweep(start, startCrossings, ORDER_SWEEPS, true);

  const sift = (from) => {
    if (!from.crossings) return from;
    const { layers } = globalSifting(
      { layers: from.layers, layer, upper, lower, block, blocks },
      { rounds: SIFT_ROUNDS, work: used * SIFT_WORK_PER_BLOCK },
    );
    const crossings = crossingsOf(layers);
    return crossings < from.crossings ? { layers, crossings } : from;
  };
  // The barycenter order from the given start, and restarts from shuffles of it, each swept and transposed; the
  // best of them is sifted (sifting the others too costs as much again and, on the fixtures and real recipes, never
  // finds anything better).
  let best = sweep(start, startCrossings, SIFT_SWEEPS, false);
  const restarts = Math.min(
    RESTARTS,
    Math.floor(RESTART_WORK / (total + segments)),
  );
  const random = seeded(1);
  for (let r = 0; r < restarts && best.crossings > 0; r++) {
    const shuffled = start.map((list) => {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    });
    let candidate = sweep(shuffled, crossingsOf(shuffled), ORDER_SWEEPS, false);
    const layers = candidate.layers.map((l) => l.slice());
    layers.forEach(index);
    transpose(layers, upper, lower, pos);
    const crossings = countCrossings(layers, lower, pos);
    if (crossings < candidate.crossings) candidate = { layers, crossings };
    if (candidate.crossings < best.crossings) best = candidate;
  }
  return sift(best);
}

/** A small seeded random number generator (mulberry32): the same seed gives the same numbers everywhere. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * @typedef {object} Reference A cross-link drawn to a chip under its source instead of to its ingredient.
 * @property {object} edge   the edge it stands in for
 * @property {number} source the edge's source (node index)
 * @property {number} target the ingredient (node index)
 * @property {number} x      where the chip sits
 * @property {number} y
 * @property {number} radius the most the chip should reach from its centre: the room the layout kept for it
 */

/**
 * Swap neighbouring nodes on each layer whenever that removes crossings with the layers above and below
 * (Gansner et al. 1993's transposition), until a whole pass changes nothing (or a bound on passes).
 */
function transpose(layers, upper, lower, pos) {
  // Each node's neighbours' places above and below, sorted, so the crossings between two nodes' edges are one merge
  // of their lists rather than every pair. Neighbours sit on other layers, so a layer's lists hold while it's worked.
  const total = upper.length;
  const upStart = new Int32Array(total + 1),
    downStart = new Int32Array(total + 1);
  for (let v = 0; v < total; v++) {
    upStart[v + 1] = upStart[v] + upper[v].length;
    downStart[v + 1] = downStart[v] + lower[v].length;
  }
  const upPlaces = new Float64Array(upStart[total]),
    downPlaces = new Float64Array(downStart[total]);
  const sorted = (places, start, near) => {
    if (near.length > 16) {
      for (let k = 0; k < near.length; k++) places[start + k] = pos[near[k]];
      places.subarray(start, start + near.length).sort();
      return;
    }
    for (let k = 0; k < near.length; k++) {
      const p = pos[near[k]];
      let i = start + k;
      for (; i > start && places[i - 1] > p; i--) places[i] = places[i - 1];
      places[i] = p;
    }
  };
  const fill = (list) => {
    for (const v of list) {
      sorted(upPlaces, upStart[v], upper[v]);
      sorted(downPlaces, downStart[v], lower[v]);
    }
  };
  /** Crossings between u's and v's edges on one side, with u to the left of v: pairs whose other ends are reversed. */
  const crossed = (places, start, u, v) => {
    let c = 0;
    const b0 = start[v],
      b1 = start[v + 1];
    let j = b0;
    for (let i = start[u]; i < start[u + 1]; i++) {
      while (j < b1 && places[j] < places[i]) j++;
      c += j - b0;
    }
    return c;
  };
  const between = (u, v) =>
    crossed(upPlaces, upStart, u, v) + crossed(downPlaces, downStart, u, v);
  for (let round = 0; round < 8; round++) {
    let improved = false;
    for (const list of layers) {
      fill(list);
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
 * Edge crossings between every pair of neighbouring layers, at places `pos` (each node's index on its layer): for
 * each pair, the edges are taken by their upper end, left to right, and each counts the edges before it whose lower
 * end is further right, with a Fenwick tree over the lower layer's places (Barth, Jünger & Mutzel 2002), O(E log V).
 */
export function countCrossings(layers, lower, pos) {
  let total = 0;
  let tree = new Int32Array(64),
    ends = new Float64Array(16);
  for (let k = 0; k + 1 < layers.length; k++) {
    let size = 0;
    for (const w of layers[k + 1]) size = Math.max(size, pos[w] + 1);
    if (tree.length < size + 1) tree = new Int32Array(2 * size + 1);
    tree.fill(0, 0, size + 1);
    let above = layers[k];
    for (let i = 1; i < above.length; i++)
      if (pos[above[i]] < pos[above[i - 1]]) {
        above = above.slice().sort((a, b) => pos[a] - pos[b]);
        break;
      }
    let inserted = 0;
    for (const v of above) {
      const near = lower[v],
        d = near.length;
      if (ends.length < d) ends = new Float64Array(2 * d);
      for (let j = 0; j < d; j++) ends[j] = pos[near[j]];
      // Edges already in with their lower end strictly right of each of v's (v's own never cross each other).
      for (let j = 0; j < d; j++) {
        let atOrLeft = 0;
        for (let i = ends[j] + 1; i > 0; i -= i & -i) atOrLeft += tree[i];
        total += inserted - atOrLeft;
      }
      for (let j = 0; j < d; j++)
        for (let i = ends[j] + 1; i <= size; i += i & -i) tree[i]++;
      inserted += d;
    }
  }
  return total;
}

// Straightening (see balance): rounds of trying each bent long edge; how many neighbours each side of a dummy a try
// may push aside (the ones beyond stay put, so a try costs the same on a layer of ten nodes or ten thousand); and its
// effort, in points the projector takes per layout node (counted, not timed, so every machine gets the same layout).
const STRAIGHTEN_ROUNDS = 3;
const STRAIGHTEN_REACH = 64;
const STRAIGHTEN_WORK = 200;

/**
 * Minimise the weighted sideways travel of every segment, layer by layer: each layer in turn goes exactly where the
 * weighted sum of its segments' sideways travel is least, keeping its order and gaps, with the layers above and
 * below held still (an exact L1 step: see makeProjector). The first two passes pull from one side at a time (a quick
 * start), the rest from both, until nothing moves more than half a pixel; from then on each step can only lower the
 * total.
 *
 * Then long edges are straightened (as Brandes & Köpf and Gansner et al. favour them). Layer by layer, a bent long
 * edge stays bent whenever lining it up would cost its neighbours more on that one layer, even when the edge saves
 * more over all its layers. So each long edge whose dummies (two or more) don't line up is tried dead straight. At
 * the place its two end segments travel least, if its layers have room there, it just moves. Otherwise it's tried
 * there and at each place one of its dummies already is, with each layer it crosses taking the exact step again
 * near it (STRAIGHTEN_REACH neighbours each side) with the dummy pinned in place, pushing its neighbours aside. The
 * best try is kept if the total travel doesn't grow. On the crafting fixtures this lands within 1–10% of the exact
 * optimum (Gansner's auxiliary-graph LP) and draws about as many long edges straight.
 *
 * Everything runs on flat typed arrays made once (neighbours, scratch space for each layer): with tens of thousands
 * of nodes, building little arrays per node per pass costs more than the arithmetic.
 */
function balance(
  layers,
  upper,
  lower,
  upperWeight,
  lowerWeight,
  x,
  separation,
  chains,
) {
  const flat = (lists, weights) => {
    const start = new Int32Array(lists.length + 1);
    for (let v = 0; v < lists.length; v++)
      start[v + 1] = start[v] + lists[v].length;
    const index = new Int32Array(start[lists.length]),
      weight = new Float64Array(start[lists.length]);
    for (let v = 0; v < lists.length; v++)
      for (let k = 0; k < lists[v].length; k++) {
        index[start[v] + k] = lists[v][k];
        weight[start[v] + k] = weights[v][k];
      }
    return { start, index, weight };
  };
  const up = flat(upper, upperWeight),
    down = flat(lower, lowerWeight);
  // Room for the widest layer, and for the most neighbours on one layer (plus one each for nodes with none).
  let widest = 1,
    busiest = 1;
  for (const list of layers) {
    widest = Math.max(widest, list.length);
    let points = list.length;
    for (const v of list) points += upper[v].length + lower[v].length;
    busiest = Math.max(busiest, points);
  }
  const start = new Int32Array(widest + 1),
    seps = new Float64Array(widest),
    placed = new Float64Array(widest);
  const values = new Float64Array(busiest),
    weights = new Float64Array(busiest);
  const projector = makeProjector(widest, busiest);
  const gather = (side, v, n) => {
    for (let k = side.start[v]; k < side.start[v + 1]; k++) {
      values[n] = x[side.index[k]];
      weights[n] = side.weight[k];
      n++;
    }
    return n;
  };
  const PIN = 1e9; // weight that holds a node where it's put
  let work = 0; // points the projector has taken (for the straightening budget)
  /**
   * The exact step for the nodes `from` … `to` - 1 of a layer, pulled from above, below or both. `pin`, if given, is
   * held at `pinAt`; so are the window's end nodes when the window doesn't reach the end of the layer, so nothing
   * outside it has to move. Returns how far the furthest node moved.
   */
  const step = (
    list,
    above,
    below,
    pin = -1,
    pinAt = 0,
    from = 0,
    to = list.length,
  ) => {
    const count = to - from;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const v = list[from + i];
      start[i] = n;
      if (
        v === pin ||
        (i === 0 && from > 0) ||
        (i === count - 1 && to < list.length)
      ) {
        values[n] = v === pin ? pinAt : x[v];
        weights[n++] = PIN;
      } else {
        if (above) n = gather(up, v, n);
        if (below) n = gather(down, v, n);
        if (n === start[i]) {
          // Nothing to pull it: it stays where it is unless its neighbours need the room.
          values[n] = x[v];
          weights[n++] = 0.01;
        }
      }
      if (i) seps[i - 1] = separation(list[from + i - 1], v);
    }
    start[count] = n;
    projector(count, start, values, weights, seps, placed);
    work += n;
    let moved = 0;
    for (let i = 0; i < count; i++) {
      const v = list[from + i];
      moved = Math.max(moved, Math.abs(placed[i] - x[v]));
      x[v] = placed[i];
    }
    return moved;
  };

  for (let pass = 0; pass < BALANCE_PASSES; pass++) {
    const downward = pass % 2 === 0;
    const both = pass >= 2;
    let moved = 0;
    for (let k = 0; k < layers.length; k++) {
      const list = layers[downward ? k : layers.length - 1 - k];
      moved = Math.max(moved, step(list, both || downward, both || !downward));
    }
    if (both && pass >= BALANCE_MIN_PASSES && moved < 0.5) break;
  }

  // ---- straightening
  const total = x.length;
  const layerOf = new Int32Array(total),
    at = new Int32Array(total);
  layers.forEach((list, k) =>
    list.forEach((v, i) => {
      layerOf[v] = k;
      at[v] = i;
    }),
  );
  const saved = new Float64Array(total);
  const inside = new Uint8Array(total); // the nodes a trial may move
  let chain = null,
    m = 0;
  /** The window of nodes on the layer of `chain[j]` that a trial may move. */
  const window = (j) => {
    const d = chain[j],
      list = layers[layerOf[d]];
    return [
      Math.max(0, at[d] - STRAIGHTEN_REACH),
      Math.min(list.length, at[d] + STRAIGHTEN_REACH + 1),
    ];
  };
  /** Travel of every segment with an end in a window (each counted once). */
  const travel = () => {
    let sum = 0;
    for (let j = 1; j <= m; j++) {
      const list = layers[layerOf[chain[j]]];
      const [from, to] = window(j);
      for (let i = from; i < to; i++) {
        const v = list[i];
        for (let k = down.start[v]; k < down.start[v + 1]; k++)
          sum += down.weight[k] * Math.abs(x[down.index[k]] - x[v]);
        for (let k = up.start[v]; k < up.start[v + 1]; k++)
          if (!inside[up.index[k]])
            sum += up.weight[k] * Math.abs(x[up.index[k]] - x[v]);
      }
    }
    return sum;
  };
  const mark = (on) => {
    for (let j = 1; j <= m; j++) {
      const list = layers[layerOf[chain[j]]];
      const [from, to] = window(j);
      for (let i = from; i < to; i++) {
        inside[list[i]] = on;
        if (on) saved[list[i]] = x[list[i]];
      }
    }
  };
  const restore = () => {
    for (let j = 1; j <= m; j++) {
      const list = layers[layerOf[chain[j]]];
      const [from, to] = window(j);
      for (let i = from; i < to; i++) x[list[i]] = saved[list[i]];
    }
  };
  /** Push the dummies to `X`, layer by layer; false if one couldn't get there. */
  const push = (X) => {
    for (let j = 1; j <= m; j++) {
      const [from, to] = window(j);
      const list = layers[layerOf[chain[j]]];
      step(list, true, true, chain[j], X, from, to);
      // Not enough room inside the window: the pins pulled against each other.
      if (
        Math.abs(x[chain[j]] - X) > 1e-6 ||
        (from > 0 && Math.abs(x[list[from]] - saved[list[from]]) > 1e-6) ||
        (to < list.length &&
          Math.abs(x[list[to - 1]] - saved[list[to - 1]]) > 1e-6)
      )
        return false;
    }
    return true;
  };
  const tries = [];
  let longest = 0;
  for (const c of chains) longest = Math.max(longest, c.length);
  const places = new Float64Array(longest);
  work = 0;
  const budget = STRAIGHTEN_WORK * total;
  for (let round = 0; round < STRAIGHTEN_ROUNDS && work <= budget; round++) {
    let changed = false;
    for (chain of chains) {
      m = chain.length - 2; // dummies
      if (m < 2) continue;
      let bent = false;
      for (let j = 2; j <= m; j++)
        if (Math.abs(x[chain[j]] - x[chain[1]]) > 1e-6) bent = true;
      if (!bent) continue;
      const a = x[chain[0]],
        b = x[chain[m + 1]];
      const first = up.weight[up.start[chain[1]]],
        last = down.weight[down.start[chain[m]]];
      // Where its end segments travel least: the heavier end's place, or anywhere between when they weigh the same
      // (then nearest the dummies' mean).
      let mean = 0;
      for (let j = 1; j <= m; j++) mean += x[chain[j]] / m;
      const target =
        first > last
          ? a
          : first < last
            ? b
            : Math.min(Math.max(mean, Math.min(a, b)), Math.max(a, b));
      // A dummy has one segment up and one down, so the edge's own travel is easy to add up; with room on every
      // layer, nothing else changes.
      let lo = -Infinity,
        hi = Infinity,
        now = last * Math.abs(b - x[chain[m]]);
      for (let j = 1; j <= m; j++) {
        const d = chain[j],
          list = layers[layerOf[d]],
          i = at[d];
        now += up.weight[up.start[d]] * Math.abs(x[d] - x[chain[j - 1]]);
        if (i > 0)
          lo = Math.max(lo, x[list[i - 1]] + separation(list[i - 1], d));
        if (i + 1 < list.length)
          hi = Math.min(hi, x[list[i + 1]] - separation(d, list[i + 1]));
      }
      const room = Math.min(Math.max(target, lo), hi);
      if (
        lo <= hi &&
        first * Math.abs(room - a) + last * Math.abs(b - room) <= now
      ) {
        for (let j = 1; j <= m; j++) x[chain[j]] = room;
        changed = true;
        continue;
      }
      // No room: try pushing the neighbours aside, there and at each place one of its dummies already is.
      if (work > budget) break;
      tries.length = 0;
      tries.push(target);
      for (let j = 1; j <= m; j++) places[j - 1] = x[chain[j]];
      places.subarray(0, m).sort();
      for (let j = 0; j < m; j++)
        if (Math.abs(places[j] - tries[tries.length - 1]) > 1e-6)
          tries.push(places[j]);
      mark(1);
      const before = travel();
      let best = NaN,
        least = before + 1e-9;
      for (const X of tries) {
        if (push(X)) {
          const after = travel();
          if (after <= least) {
            least = after;
            best = X;
          }
        }
        restore();
      }
      if (!Number.isNaN(best)) {
        push(best);
        changed = true;
      }
      mark(0);
    }
    if (!changed) break;
  }
}

/**
 * The exact L1 step for one layer, with its own scratch space for up to `capacity` positions and `points` points:
 * `(count, start, values, weights, seps, out)` writes into `out` the positions that keep the order, at least
 * `seps[i]` between neighbours i and i + 1, and make the weighted sum of distances from each position i to its points
 * (`values[k]` with `weights[k]`, k from `start[i]` to `start[i + 1]`) least. Weights must be positive.
 *
 * Shifting each position by the separations before it leaves positions that only have to be in order: isotonic
 * regression with L1 costs. Solved left to right as a running cost (the "slope trick"): the least cost of the
 * positions so far, as a function of where the last one sits, is convex and piecewise linear, kept as a max-heap of
 * its breakpoints, each with how much the slope changes there. A position's points add their breakpoints; letting
 * the next position sit anywhere further right takes the top breakpoints off, as much weight as the points brought,
 * which leaves the function flat beyond its lowest point. Then right to left, each position takes the middle of
 * where its running cost is least, or the next one's place if that's further left. O(points log points).
 */
function makeProjector(capacity, points) {
  const heapValue = new Float64Array(points),
    heapWeight = new Float64Array(points),
    offset = new Float64Array(capacity),
    middle = new Float64Array(capacity);
  return (count, start, values, weights, seps, out) => {
    let size = 0;
    const push = (value, weight) => {
      let i = size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapValue[parent] >= value) break;
        heapValue[i] = heapValue[parent];
        heapWeight[i] = heapWeight[parent];
        i = parent;
      }
      heapValue[i] = value;
      heapWeight[i] = weight;
    };
    const pop = () => {
      const value = heapValue[--size],
        weight = heapWeight[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && heapValue[c + 1] > heapValue[c]) c++;
        if (heapValue[c] <= value) break;
        heapValue[i] = heapValue[c];
        heapWeight[i] = heapWeight[c];
        i = c;
      }
      heapValue[i] = value;
      heapWeight[i] = weight;
    };
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (i) at += seps[i - 1];
      offset[i] = at;
      // Each point adds |y - p| times its weight: the slope steps up by twice the weight at p.
      let pull = 0;
      for (let k = start[i]; k < start[i + 1]; k++) {
        push(values[k] - at, 2 * weights[k]);
        pull += weights[k];
      }
      // Where the cost is least: walking down from the top breakpoint, where the slope reaches zero. When it reaches
      // it exactly on a breakpoint, the cost is flat from the next one down to that one, and the middle is taken.
      let rest = pull,
        edge = NaN;
      const tiny = pull * 1e-12;
      while (rest > tiny) {
        if (heapWeight[0] <= rest + tiny && size > 1) {
          rest -= heapWeight[0];
          edge = heapValue[0];
          pop();
        } else {
          heapWeight[0] -= rest;
          rest = 0;
          edge = NaN;
        }
      }
      const low = heapValue[0];
      middle[i] = Number.isNaN(edge) ? low : (low + edge) / 2;
    }
    let y = Infinity;
    for (let i = count - 1; i >= 0; i--) {
      y = Math.min(y, middle[i]);
      out[i] = y + offset[i];
    }
    return out;
  };
}

/**
 * The exact L1 step on its own (for tests and other callers): positions in order, at least `seps[i]` between
 * neighbours i and i + 1, with the least weighted sum of distances to what each wants. `desired[i]` is one position
 * or a list of them, with `weights[i]` the matching weight or list of weights (positive).
 *
 * @param {(number | number[])[]} desired
 * @param {ArrayLike<number>} seps
 * @param {(number | number[])[]} weights
 * @returns {Float64Array}
 */
export function project(desired, seps, weights) {
  const count = desired.length;
  const start = new Int32Array(count + 1);
  const values = [],
    pulls = [];
  for (let i = 0; i < count; i++) {
    const many = Array.isArray(desired[i]);
    for (let k = 0; k < (many ? desired[i].length : 1); k++) {
      values.push(many ? desired[i][k] : desired[i]);
      pulls.push(many ? weights[i][k] : weights[i]);
    }
    start[i + 1] = values.length;
  }
  return makeProjector(Math.max(count, 1), Math.max(values.length, 1))(
    count,
    start,
    Float64Array.from(values),
    Float64Array.from(pulls),
    Float64Array.from(seps),
    new Float64Array(count),
  );
}
