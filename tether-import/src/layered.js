import { placeAlong } from "./trees.js";

/**
 * Layered (Sugiyama-style) layout for graphs that aren't trees (DAGs, where shared nodes have
 * several parents, and graphs with cycles). In five steps:
 *
 *  1. cycles: edges that close a cycle (found depth-first from the root) are treated as reversed;
 *  2. ranks: every edge goes down at least one rank, and each node sits between its parents and children so edges
 *     stay short (a local optimum of the total edge length, like network simplex);
 *  3. long edges get a chain of dummy nodes, one per rank they cross, so they can bend around nodes;
 *  4. order within each rank: barycentre sweeps down and up, keeping the order with the fewest crossings, then
 *     swapping neighbours while that removes crossings. The starting order is the graph's own (depth-first,
 *     children in edge order), so the caller's child order carries over;
 *  5. coordinates: each rank is placed as close as possible to the median of its neighbours on the rank just placed,
 *     keeping every pair at least its separation apart. Each placement is an exact weighted isotonic regression (pool
 *     adjacent violators); dummies weigh more, so long edges run straight.
 *
 * Deterministic: ties are broken by index.
 *
 * @param {import('./layout-graph.js').LayoutGraph} graph  positions are written to graph.x / graph.y
 * @param {{ direction: 'TB'|'BT'|'LR'|'RL', nodeSep: number, rankSep: number, edgeSep?: number,
 *           sweeps?: number, transposePasses?: number, alignRounds?: number, rankPasses?: number,
 *           longEdgeWeight?: number,
 *           widthLabelShare?: number, heightLabelShare?: number }} options
 *   direction: root → leaves
 * @returns {{ ranks: number[][], crossings: number }} for tests and diagnostics (dummies included, as indexes ≥ count)
 */
export function layeredLayout(
  graph,
  {
    direction = "TB",
    nodeSep = 24,
    rankSep = 50,
    edgeSep = 6,
    sweeps = 12,
    transposePasses = 6,
    alignRounds = 6,
    rankPasses = 24,
    longEdgeWeight = 8,
    widthLabelShare = 1,
    heightLabelShare = 1,
  },
) {
  const n = graph.count;
  if (!n) return { ranks: [], crossings: 0 };
  const horizontal = direction === "LR" || direction === "RL";
  const breadth = new Float64Array(n),
    extent = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const { w, h } = graph.footprint(i, widthLabelShare, heightLabelShare);
    breadth[i] = horizontal ? h : w;
    extent[i] = horizontal ? w : h;
  }

  const { order: dfsOrder, edges } = acyclicEdges(graph);
  const rank = assignRanks(n, edges, dfsOrder, rankPasses);

  // Dummies: node indexes n, n+1, … along every edge that spans more than one rank.
  const down = []; // node → nodes on the next rank
  const up = [];
  for (let i = 0; i < n; i++) {
    down.push([]);
    up.push([]);
  }
  const rankOf = Array.from(rank);
  const link = (a, b) => {
    down[a].push(b);
    up[b].push(a);
  };
  for (const [s, t] of edges) {
    let previous = s;
    for (let r = rank[s] + 1; r < rank[t]; r++) {
      const dummy = rankOf.length;
      rankOf.push(r);
      down.push([]);
      up.push([]);
      link(previous, dummy);
      previous = dummy;
    }
    link(previous, t);
  }
  const total = rankOf.length;
  const isDummy = (i) => i >= n;
  const sizeOf = (i) => (isDummy(i) ? 0 : breadth[i]);
  const halfGap = (i) => (isDummy(i) ? edgeSep : nodeSep) / 2;

  // Starting order: depth-first from the root along `down`, children in their own order.
  const rankCount = largest(rankOf) + 1;
  const ranks = Array.from({ length: rankCount }, () => []);
  const seen = new Uint8Array(total);
  const visit = (start) => {
    for (const stack = [start]; stack.length;) {
      const i = stack.pop();
      if (seen[i]) continue;
      seen[i] = 1;
      ranks[rankOf[i]].push(i);
      for (let k = down[i].length - 1; k >= 0; k--) stack.push(down[i][k]);
    }
  };
  for (const i of dfsOrder) visit(i);
  for (let i = 0; i < total; i++) if (!seen[i]) visit(i);

  const crossings = minimiseCrossings(ranks, up, down, sweeps, transposePasses);

  // Coordinates across the ranks.
  const across = new Float64Array(total);
  const separation = (a, b) =>
    sizeOf(a) / 2 + halfGap(a) + halfGap(b) + sizeOf(b) / 2;
  for (const members of ranks) {
    let cursor = 0;
    members.forEach((i, k) => {
      if (k) cursor += separation(members[k - 1], i);
      across[i] = cursor;
    });
  }
  const weightOf = (i) => (isDummy(i) ? longEdgeWeight : 1);
  for (let round = 0; round < alignRounds; round++) {
    // Down sweeps follow parents, up sweeps follow children.
    const downward = round % 2 === 0;
    const order = downward
      ? ranks.map((_, r) => r)
      : ranks.map((_, r) => rankCount - 1 - r);
    for (const r of order) {
      const members = ranks[r];
      const desired = members.map((i) => {
        const neighbours = downward ? up[i] : down[i];
        if (!neighbours.length) return across[i];
        return median(neighbours.map((j) => across[j]).sort((a, b) => a - b));
      });
      placeRank(members, desired, separation, weightOf, across);
    }
  }

  // Along the flow: each rank as deep as its deepest node, rankSep apart.
  const rankExtent = new Float64Array(rankCount);
  for (let i = 0; i < n; i++)
    rankExtent[rank[i]] = Math.max(rankExtent[rank[i]], extent[i]);
  const rankCenter = new Float64Array(rankCount);
  let offset = 0;
  for (let r = 0; r < rankCount; r++) {
    rankCenter[r] = offset + rankExtent[r] / 2;
    offset += rankExtent[r] + rankSep;
  }
  // Centre the root's rank on its own position across (the physics expects the root near the middle).
  const rootShift = graph.rootIndex >= 0 ? across[graph.rootIndex] : 0;
  for (let i = 0; i < n; i++)
    placeAlong(graph, i, direction, rankCenter[rank[i]], across[i] - rootShift);
  return { ranks, crossings };
}

/**
 * Depth-first from the root (then any node not yet reached, by index): edges back to a node still on the stack
 * close a cycle and are reversed. Returns the visit order and the edges as [from, to] pairs, now acyclic.
 */
function acyclicEdges(graph) {
  const n = graph.count;
  const out = Array.from({ length: n }, () => []);
  for (let e = 0; e < graph.sources.length; e++)
    out[graph.sources[e]].push(graph.targets[e]);
  const state = new Uint8Array(n); // 0 new, 1 on stack, 2 done
  const order = [];
  const edges = [];
  const starts = graph.rootIndex >= 0 ? [graph.rootIndex] : [];
  for (let i = 0; i < n; i++) starts.push(i);
  for (const start of starts) {
    if (state[start]) continue;
    const stack = [[start, 0]];
    state[start] = 1;
    order.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [i, k] = top;
      if (k === out[i].length) {
        state[i] = 2;
        stack.pop();
        continue;
      }
      top[1]++;
      const j = out[i][k];
      if (state[j] === 1)
        edges.push([j, i]); // closes a cycle: reverse it
      else {
        edges.push([i, j]);
        if (!state[j]) {
          state[j] = 1;
          order.push(j);
          stack.push([j, 0]);
        }
      }
    }
  }
  return { order, edges: dedupe(edges) };
}

function dedupe(edges) {
  const seen = new Set();
  return edges.filter(([a, b]) => {
    const key = a * 1e7 + b;
    if (a === b || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Ranks such that every edge goes down ≥ 1 rank and edges stay short; lowest rank 0. */
function assignRanks(n, edges, order, passes) {
  const parents = Array.from({ length: n }, () => []);
  const children = Array.from({ length: n }, () => []);
  for (const [s, t] of edges) {
    parents[t].push(s);
    children[s].push(t);
  }
  const topological = topologicalOrder(n, parents, children, order);
  const rank = new Int32Array(n);
  // As close to the root as possible: one below the deepest parent.
  for (const i of topological)
    for (const p of parents[i]) rank[i] = Math.max(rank[i], rank[p] + 1);

  // Short edges: move each node to the median of where its neighbours want it, within the ranks its parents and
  // children allow, until nothing moves (a local optimum of the total edge length, like network simplex).
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const i of topological) {
      if (!parents[i].length) continue; // roots stay put
      let low = 0,
        high = Infinity;
      for (const p of parents[i]) low = Math.max(low, rank[p] + 1);
      for (const c of children[i]) high = Math.min(high, rank[c] - 1);
      const wants = [
        ...parents[i].map((p) => rank[p] + 1),
        ...children[i].map((c) => rank[c] - 1),
      ].sort((a, b) => a - b);
      const target = Math.min(high, Math.max(low, Math.round(median(wants))));
      if (target !== rank[i]) {
        rank[i] = target;
        moved = true;
      }
    }
    if (!moved) break;
  }
  normalise(rank);
  return rank;
}

// Loops rather than Math.max(...list): big graphs would overflow the argument limit.
function largest(list) {
  let value = -Infinity;
  for (const item of list) if (item > value) value = item;
  return value;
}

function normalise(rank) {
  let lowest = Infinity;
  for (const item of rank) if (item < lowest) lowest = item;
  if (lowest) for (let i = 0; i < rank.length; i++) rank[i] -= lowest;
}

/** Kahn's algorithm, preferring the depth-first order among ready nodes (keeps the graph's own order). */
function topologicalOrder(n, parents, children, preferred) {
  const position = new Int32Array(n);
  preferred.forEach((i, k) => (position[i] = k));
  const waiting = parents.map((list) => list.length);
  const ready = preferred.filter((i) => !waiting[i]);
  const result = [];
  while (ready.length) {
    // Small graphs, so a linear pick of the earliest ready node is fine and keeps it deterministic.
    let best = 0;
    for (let k = 1; k < ready.length; k++)
      if (position[ready[k]] < position[ready[best]]) best = k;
    const [i] = ready.splice(best, 1);
    result.push(i);
    for (const c of children[i]) if (--waiting[c] === 0) ready.push(c);
  }
  return result;
}

function median(sorted) {
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ---------------------------------------------------------------- crossings

/**
 * Barycentre sweeps: each rank sorted by the mean position of its neighbours on the rank just placed, alternating
 * down and up. Keeps the best ordering seen, then transposes. Returns its crossing count.
 */
function minimiseCrossings(ranks, up, down, sweeps, transposePasses) {
  const position = new Map();
  const index = () =>
    ranks.forEach((members) => members.forEach((i, k) => position.set(i, k)));
  index();
  let best = ranks.map((members) => [...members]);
  let bestCount = countCrossings(ranks, down, position);
  for (let sweep = 0; sweep < sweeps && bestCount > 0; sweep++) {
    const downward = sweep % 2 === 0;
    const order = downward
      ? ranks.map((_, r) => r).slice(1)
      : ranks.map((_, r) => ranks.length - 1 - r).slice(1);
    for (const r of order) {
      const members = ranks[r];
      const keyed = members.map((i, k) => {
        const neighbours = downward ? up[i] : down[i];
        if (!neighbours.length) return { i, key: k, k };
        let sum = 0;
        for (const j of neighbours) sum += position.get(j);
        return { i, key: sum / neighbours.length, k };
      });
      keyed.sort((a, b) => a.key - b.key || a.k - b.k);
      ranks[r] = keyed.map(({ i }) => i);
      ranks[r].forEach((i, k) => position.set(i, k));
    }
    const count = countCrossings(ranks, down, position);
    if (count < bestCount) {
      bestCount = count;
      best = ranks.map((members) => [...members]);
    }
  }
  best.forEach((members, r) => (ranks[r] = members));
  index();
  transpose(ranks, up, down, position, transposePasses);
  return countCrossings(ranks, down, position);
}

/** Swap neighbours on a rank while that removes crossings with the ranks above and below. */
function transpose(ranks, up, down, position, passes) {
  // Crossings among u's and v's edges (both sides) with u to the left of v.
  const crossings = (u, v) => {
    let count = 0;
    for (const side of [up, down])
      for (const a of side[u])
        for (const b of side[v]) if (position.get(a) > position.get(b)) count++;
    return count;
  };
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const members of ranks)
      for (let k = 0; k + 1 < members.length; k++) {
        const u = members[k],
          v = members[k + 1];
        if (crossings(v, u) >= crossings(u, v)) continue;
        members[k] = v;
        members[k + 1] = u;
        position.set(v, k);
        position.set(u, k + 1);
        improved = true;
      }
    if (!improved) break;
  }
}

/** Crossings between every pair of neighbouring ranks, counted with a Fenwick tree (O(E log V) per pair). */
export function countCrossings(ranks, down, position) {
  let total = 0;
  for (let r = 0; r + 1 < ranks.length; r++) {
    const pairs = [];
    for (const i of ranks[r])
      for (const j of down[i]) pairs.push([position.get(i), position.get(j)]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const size = ranks[r + 1].length;
    const tree = new Int32Array(size + 1);
    let seen = 0;
    for (const [, target] of pairs) {
      // Edges already seen that end to the right of this one cross it.
      let atOrBefore = 0;
      for (let k = target + 1; k > 0; k -= k & -k) atOrBefore += tree[k];
      total += seen - atOrBefore;
      for (let k = target + 1; k <= size; k += k & -k) tree[k]++;
      seen++;
    }
  }
  return total;
}

// ---------------------------------------------------------------- coordinates

/**
 * Place one rank's `members` (in order) as near their `desired` positions as possible, weighted, with each pair at
 * least `separation(a, b)` apart. Subtracting each member's minimum offset from the first turns the gaps into
 * "non-decreasing", which pool-adjacent-violators solves exactly.
 */
function placeRank(members, desired, separation, weightOf, across) {
  const count = members.length;
  if (!count) return;
  const offset = new Float64Array(count);
  for (let k = 1; k < count; k++)
    offset[k] = offset[k - 1] + separation(members[k - 1], members[k]);
  // Blocks of merged nodes: [mean, weight, size].
  const means = [],
    weights = [],
    sizes = [];
  for (let k = 0; k < count; k++) {
    let mean = desired[k] - offset[k],
      weight = weightOf(members[k]),
      size = 1;
    while (means.length && means[means.length - 1] > mean) {
      const w = weights.pop();
      mean = (means.pop() * w + mean * weight) / (w + weight);
      weight += w;
      size += sizes.pop();
    }
    means.push(mean);
    weights.push(weight);
    sizes.push(size);
  }
  let k = 0;
  means.forEach((mean, block) => {
    for (let m = 0; m < sizes[block]; m++, k++)
      across[members[k]] = mean + offset[k];
  });
}
