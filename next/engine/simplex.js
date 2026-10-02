// Network simplex for layered drawings (Gansner, Koutsofios, North & Vo 1993, "A technique for drawing directed
// graphs"): given edges u → v, each with a minimum length and a weight, find integer ranks that keep every edge at
// least its minimum length and make the weighted total length as small as possible.
//
// For layering, every edge has minimum length 1 and weight 1: nodes sit as close to their neighbours as the edges
// allow, so long edges (and the dummy nodes they need) are as few as possible. Unlike longest path, a source with
// all its children deep down moves down to meet them.
//
// The method keeps a spanning tree of tight edges (length exactly its minimum). Each tree edge has a cut value: how
// much the total would change if that edge were lengthened. A negative one means lengthening it helps, so it leaves
// the tree and the non-tree edge that can take its place with the least slack enters. Repeat until no cut value is
// negative (optimal) or the work budget runs out (still feasible, just not optimal).
//
// Each exchange is incremental, as in Graphviz: only the side of the tree below the leaving edge moves, only the cut
// values on the cycle the entering edge closes change, and only the subtree around that cycle is renumbered. So a
// pivot costs about the size of what it changes, not the whole graph, and graphs of tens of thousands of nodes reach
// the optimum.
//
// The budget is counted in work (nodes and edges visited), never in time, so the same input always gives the same
// ranks, on any machine and in a worker or not.
//
// Pure: no DOM.

/** Negative cut values looked at before taking the most negative of them (Graphviz's search size). */
const SEARCH_SIZE = 30;

/**
 * @param {number} count             nodes 0 … count - 1
 * @param {Int32Array | number[]} tail  per edge, its start
 * @param {Int32Array | number[]} head  per edge, its end
 * @param {ArrayLike<number>} minLength per edge, ≥ 0
 * @param {ArrayLike<number>} weight    per edge, ≥ 0
 * @param {{ work?: number }} [options] work: stop pivoting once about this many nodes and edges
 *   have been visited (every pivot leaves a feasible ranking, so stopping early gives a good one, just not the best)
 * @returns {{ rank: Int32Array, pivots: number, optimal: boolean, work: number }} ranks start at 0; `work` is what
 *   the run used, setup included
 *
 * The edges must form a DAG; nodes in separate components are joined internally, so the graph needn't be connected.
 */
export function networkSimplex(
  count,
  tail,
  head,
  minLength,
  weight,
  { work: budget = Infinity } = {},
) {
  // A virtual node joined to every node by a weightless edge makes the graph connected without changing the
  // objective. Edges from it have minimum length 0 so it never forces anything.
  const n = count + 1;
  const root = count;
  const m = tail.length + count;
  const eu = new Int32Array(m),
    ev = new Int32Array(m),
    len = new Float64Array(m),
    w = new Float64Array(m);
  for (let e = 0; e < tail.length; e++) {
    eu[e] = tail[e];
    ev[e] = head[e];
    len[e] = minLength[e];
    w[e] = weight[e];
  }
  for (let v = 0; v < count; v++) {
    const e = tail.length + v;
    eu[e] = root;
    ev[e] = v;
  }
  // Each node's edges out and in, as flat lists (start offsets per node).
  const outStart = new Int32Array(n + 1),
    inStart = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    outStart[eu[e] + 1]++;
    inStart[ev[e] + 1]++;
  }
  for (let v = 0; v < n; v++) {
    outStart[v + 1] += outStart[v];
    inStart[v + 1] += inStart[v];
  }
  const outList = new Int32Array(m),
    inList = new Int32Array(m);
  {
    const o = outStart.slice(0, n),
      i = inStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      outList[o[eu[e]]++] = e;
      inList[i[ev[e]]++] = e;
    }
  }
  let work = n + m;

  // 1. A feasible ranking: longest path from the sources (Kahn's order).
  const rank = new Float64Array(n);
  {
    const indegree = new Int32Array(n);
    for (let e = 0; e < m; e++) indegree[ev[e]]++;
    const queue = new Int32Array(n);
    let tailAt = 0;
    for (let v = 0; v < n; v++) if (!indegree[v]) queue[tailAt++] = v;
    for (let h = 0; h < tailAt; h++) {
      const v = queue[h];
      for (let k = outStart[v]; k < outStart[v + 1]; k++) {
        const e = outList[k],
          x = ev[e];
        rank[x] = Math.max(rank[x], rank[v] + len[e]);
        if (--indegree[x] === 0) queue[tailAt++] = x;
      }
    }
    if (tailAt < n) throw new Error("networkSimplex: the graph has a cycle");
  }
  work += m;
  const slack = (e) => rank[ev[e]] - rank[eu[e]] - len[e];

  // 2. A spanning tree of tight edges: grow from the root over tight edges; when stuck, shift the tree's ranks so
  // the least-slack edge leaving it becomes tight, and grow again. (From a longest-path ranking every node has a
  // tight edge in, so the first growth usually reaches everything.)
  const inTree = new Uint8Array(n);
  const isTree = new Uint8Array(m);
  /** @type {number[][]} per node, its tree edges */
  const treeAdj = Array.from({ length: n }, () => []);
  let reached = 0;
  const stack = [];
  const grow = () => {
    while (stack.length) {
      const v = stack.pop();
      for (const [start, list] of [
        [outStart, outList],
        [inStart, inList],
      ])
        for (let k = start[v]; k < start[v + 1]; k++) {
          const e = list[k];
          const x = eu[e] === v ? ev[e] : eu[e];
          if (!inTree[x] && slack(e) === 0) {
            inTree[x] = 1;
            reached++;
            isTree[e] = 1;
            treeAdj[v].push(e);
            treeAdj[x].push(e);
            stack.push(x);
          }
        }
    }
  };
  inTree[root] = 1;
  reached = 1;
  stack.push(root);
  grow();
  work += m;
  while (reached < n) {
    let best = -1,
      bestSlack = Infinity;
    for (let e = 0; e < m; e++)
      if (inTree[eu[e]] !== inTree[ev[e]]) {
        const s = slack(e);
        if (s < bestSlack) {
          bestSlack = s;
          best = e;
        }
      }
    const delta = inTree[eu[best]] ? bestSlack : -bestSlack;
    for (let v = 0; v < n; v++)
      if (inTree[v]) {
        rank[v] += delta;
        stack.push(v);
      }
    grow();
    work += n + 2 * m;
  }

  // 3. The tree hangs from the root: each node's edge to its parent, and the size of its subtree.
  const parentEdge = new Int32Array(n).fill(-1),
    size = new Int32Array(n).fill(1);
  const parentOf = (v) => {
    const e = parentEdge[v];
    return eu[e] === v ? ev[e] : eu[e];
  };
  const order = new Int32Array(n); // parents before children
  {
    let count = 0;
    order[count++] = root;
    for (let k = 0; k < count; k++) {
      const v = order[k];
      for (const e of treeAdj[v]) {
        if (e === parentEdge[v]) continue;
        const x = eu[e] === v ? ev[e] : eu[e];
        parentEdge[x] = e;
        order[count++] = x;
      }
    }
    for (let k = n - 1; k > 0; k--) size[parentOf(order[k])] += size[order[k]];
  }

  // 4. Cut values of every tree edge, children first (dagre's formulation): the weight of edges from the tail's side
  // of it to the head's side, less the weight going the other way.
  const cut = new Float64Array(m);
  for (let k = n - 1; k > 0; k--) {
    const child = order[k];
    const pe = parentEdge[child];
    const childIsTail = eu[pe] === child;
    let value = w[pe];
    for (const [start, list, outward] of [
      [outStart, outList, true],
      [inStart, inList, false],
    ])
      for (let j = start[child]; j < start[child + 1]; j++) {
        const e = list[j];
        if (e === pe) continue;
        const same = outward === childIsTail;
        value += same ? w[e] : -w[e];
        if (isTree[e]) value += same ? -cut[e] : cut[e];
      }
    cut[pe] = value;
  }
  work += 3 * m;

  // The tree edges as a list, searched cyclically for negative cut values (each pivot swaps one in place).
  const treeEdges = new Int32Array(n - 1),
    slot = new Int32Array(m).fill(-1);
  {
    let k = 0;
    for (let e = 0; e < m; e++)
      if (isTree[e]) {
        slot[e] = k;
        treeEdges[k++] = e;
      }
  }
  let cursor = 0;
  /** A tree edge with a negative cut value: the most negative of the next few found, going round the list. */
  const leaving = () => {
    let found = -1,
      seen = 0;
    for (let step = 0; step < treeEdges.length; step++) {
      const e = treeEdges[cursor];
      work++;
      if (cut[e] < 0) {
        if (found < 0 || cut[e] < cut[found]) found = e;
        if (++seen >= SEARCH_SIZE) return found;
      }
      cursor = cursor + 1 === treeEdges.length ? 0 : cursor + 1;
    }
    return found;
  };

  // Scratch for one pivot: the nodes of the side being worked on, marked with the pivot's number; and the marks of
  // the two climbs that find where the cycle closes.
  const side = new Int32Array(n),
    mark = new Int32Array(n),
    markA = new Int32Array(n),
    markB = new Int32Array(n);
  /** Collect the subtree of `top` that doesn't cross `skip` into `side`, marked `stamp`; returns how many. */
  const gather = (top, skip, stamp) => {
    let count = 0;
    side[count++] = top;
    mark[top] = stamp;
    for (let k = 0; k < count; k++) {
      const v = side[k];
      const adj = treeAdj[v];
      for (let j = 0; j < adj.length; j++) {
        const e = adj[j];
        if (e === parentEdge[v] || e === skip) continue;
        const x = eu[e] === v ? ev[e] : eu[e];
        mark[x] = stamp;
        side[count++] = x;
      }
      work += 1 + adj.length;
    }
    return count;
  };

  let pivots = 0;
  let optimal = false;
  for (;;) {
    const leave = leaving();
    if (leave < 0) {
      optimal = true;
      break;
    }
    if (work >= budget) break;
    const stamp = pivots + 1;
    // Removing the leaving edge splits the tree in two: the part below it (`child`'s subtree) and the rest. The
    // entering edge crosses between them the same way as the leaving edge, with the least slack. Either part will do
    // to look for it from, so take the smaller.
    const child = parentEdge[eu[leave]] === leave ? eu[leave] : ev[leave];
    const childIsTail = child === eu[leave];
    const below = size[child];
    const fromBelow = below * 2 <= n;
    const count = fromBelow
      ? gather(child, -1, stamp)
      : gather(root, leave, stamp);
    // From the part below, edges in (child is the tail) or out; from the rest, the same edges seen from their
    // other end.
    const lookIn = childIsTail === fromBelow;
    const [start, list] = lookIn ? [inStart, inList] : [outStart, outList];
    let enter = -1,
      least = Infinity;
    for (let k = 0; k < count && least > 0; k++) {
      const v = side[k];
      for (let j = start[v]; j < start[v + 1]; j++) {
        const e = list[j];
        if (isTree[e]) continue;
        if (mark[lookIn ? eu[e] : ev[e]] === stamp) continue;
        const s = slack(e);
        if (s < least) {
          least = s;
          enter = e;
          if (s === 0) break;
        }
      }
      work += 1 + start[v + 1] - start[v];
    }
    if (enter < 0) break; // can't happen for a valid input; keep the feasible ranking

    // Ranks: the part below moves (up if the entering edge comes into it, down if it leaves it) until the entering
    // edge is tight, or the rest moves the other way. Every other edge across keeps its length or more, as it had
    // at least this much slack.
    if (least > 0) {
      const shift = childIsTail === fromBelow ? -least : least;
      for (let k = 0; k < count; k++) rank[side[k]] += shift;
      work += count;
    }

    // Where the cycle the entering edge closes turns: climb from both its ends at once until one reaches a node the
    // other has passed.
    let a = eu[enter],
      b = ev[enter],
      top = -1;
    markA[a] = stamp;
    markB[b] = stamp;
    while (top < 0) {
      if (markB[a] === stamp) top = a;
      else if (markA[b] === stamp) top = b;
      else {
        if (a !== root) markA[(a = parentOf(a))] = stamp;
        if (b !== root) markB[(b = parentOf(b))] = stamp;
        work++;
      }
    }

    // Cut values: only the tree edges on that cycle change, by the leaving edge's cut value (Graphviz's
    // treeupdate), each depending on which way it points along the cycle.
    const value = cut[leave];
    for (const [end, sign] of [
      [eu[enter], 1],
      [ev[enter], -1],
    ])
      for (let v = end; v !== top; v = parentOf(v)) {
        const e = parentEdge[v];
        cut[e] += v === eu[e] ? sign * value : -sign * value;
        work++;
      }
    cut[enter] = -value;
    cut[leave] = 0;

    // Subtree sizes: the part below leaves the path from its old parent up to the turn, and joins the path from the
    // entering edge's outer end up to it.
    const inner = childIsTail ? ev[enter] : eu[enter]; // where the part below now hangs from the entering edge
    const outer = childIsTail ? eu[enter] : ev[enter];
    for (let v = parentOf(child); v !== top; v = parentOf(v)) size[v] -= below;
    for (let v = outer; v !== top; v = parentOf(v)) size[v] += below;
    // The part below now hangs from `inner`: parent edges on the path from it up to `child` turn round, and each
    // node on it gets what its old child on the path didn't have.
    {
      let v = inner,
        up = enter,
        under = 0;
      for (;;) {
        const old = parentEdge[v],
          had = size[v];
        parentEdge[v] = up;
        size[v] = below - under;
        under = had;
        work++;
        if (v === child) break;
        up = old;
        v = eu[old] === v ? ev[old] : eu[old];
      }
    }

    // Swap the edges in the tree.
    isTree[leave] = 0;
    for (const v of [eu[leave], ev[leave]]) {
      const adj = treeAdj[v];
      const at = adj.indexOf(leave);
      adj[at] = adj[adj.length - 1];
      adj.pop();
      work += adj.length;
    }
    isTree[enter] = 1;
    treeAdj[eu[enter]].push(enter);
    treeAdj[ev[enter]].push(enter);
    slot[enter] = slot[leave];
    treeEdges[slot[leave]] = enter;
    slot[leave] = -1;
    pivots++;
  }

  let least = Infinity;
  for (let v = 0; v < count; v++) least = Math.min(least, rank[v]);
  const out = new Int32Array(count);
  for (let v = 0; v < count; v++) out[v] = Math.round(rank[v] - least);
  return { rank: out, pivots, optimal, work };
}
