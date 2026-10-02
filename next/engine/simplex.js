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
// the tree and the non-tree edge that can take its place with the least slack enters; the ranks are re-derived from
// the new tree. Repeat until no cut value is negative (optimal) or the pivot budget runs out (still feasible, just not
// optimal).
//
// Pure: no DOM.

/**
 * @param {number} count             nodes 0 … count - 1
 * @param {Int32Array | number[]} tail  per edge, its start
 * @param {Int32Array | number[]} head  per edge, its end
 * @param {ArrayLike<number>} minLength per edge, ≥ 0
 * @param {ArrayLike<number>} weight    per edge, ≥ 0
 * @param {{ maxPivots?: number, budget?: number }} [options] budget: stop pivoting after this many ms (every pivot
 *   leaves a feasible ranking, so stopping early gives a good one, just not the best)
 * @returns {{ rank: Int32Array, pivots: number, optimal: boolean }} ranks start at 0
 *
 * The edges must form a DAG; nodes in separate components are joined internally, so the graph needn't be connected.
 */
export function networkSimplex(
  count,
  tail,
  head,
  minLength,
  weight,
  { maxPivots = Infinity, budget = Infinity } = {},
) {
  // A virtual node joined to every node by a weightless edge makes the graph connected without changing the
  // objective. Edges from it have minimum length 0 so it never forces anything.
  const deadline = performance.now() + budget;
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
  const incident = Array.from({ length: n }, () => []);
  for (let e = 0; e < m; e++) {
    incident[eu[e]].push(e);
    incident[ev[e]].push(e);
  }

  // 1. A feasible ranking: longest path from the sources (Kahn's order).
  const rank = new Float64Array(n);
  {
    const indegree = new Int32Array(n);
    for (let e = 0; e < m; e++) indegree[ev[e]]++;
    const queue = [];
    for (let v = 0; v < n; v++) if (!indegree[v]) queue.push(v);
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h];
      for (const e of incident[v])
        if (eu[e] === v) {
          const x = ev[e];
          rank[x] = Math.max(rank[x], rank[v] + len[e]);
          if (--indegree[x] === 0) queue.push(x);
        }
    }
    if (queue.length < n)
      throw new Error("networkSimplex: the graph has a cycle");
  }
  const slack = (e) => rank[ev[e]] - rank[eu[e]] - len[e];

  // 2. A spanning tree of tight edges: grow from the root over tight edges; when stuck, shift the tree's ranks so
  // the least-slack edge leaving it becomes tight, and grow again.
  const inTree = new Uint8Array(n);
  const isTree = new Uint8Array(m);
  const treeAdj = Array.from({ length: n }, () => []);
  let size = 0;
  const stack = [];
  const grow = () => {
    while (stack.length) {
      const v = stack.pop();
      for (const e of incident[v]) {
        const x = eu[e] === v ? ev[e] : eu[e];
        if (!inTree[x] && slack(e) === 0) {
          inTree[x] = 1;
          size++;
          isTree[e] = 1;
          treeAdj[v].push(e);
          treeAdj[x].push(e);
          stack.push(x);
        }
      }
    }
  };
  inTree[root] = 1;
  size = 1;
  stack.push(root);
  grow();
  const members = [];
  while (size < n) {
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
    members.length = 0;
    for (let v = 0; v < n; v++)
      if (inTree[v]) {
        rank[v] += delta;
        members.push(v);
      }
    for (const v of members) stack.push(v);
    grow();
  }

  // 3. Post-order numbering (low, lim) to tell which side of a tree edge a node is on, and cut values.
  const low = new Int32Array(n),
    lim = new Int32Array(n),
    parentEdge = new Int32Array(n);
  const postorder = new Int32Array(n);
  const cut = new Float64Array(m);
  const number = () => {
    let next = 1;
    parentEdge[root] = -1;
    const frames = [[root, 0, 1]];
    while (frames.length) {
      const f = frames[frames.length - 1];
      const v = f[0];
      if (f[1] < treeAdj[v].length) {
        const e = treeAdj[v][f[1]++];
        if (e === parentEdge[v]) continue;
        const x = eu[e] === v ? ev[e] : eu[e];
        parentEdge[x] = e;
        frames.push([x, 0, next]);
      } else {
        low[v] = f[2];
        lim[v] = next;
        postorder[next - 1] = v;
        next++;
        frames.pop();
      }
    }
  };
  const below = (v, top) => low[top] <= lim[v] && lim[v] <= lim[top];
  // Cut value of each node's parent edge, children first (dagre's formulation).
  const cuts = () => {
    for (let k = 0; k < n; k++) {
      const child = postorder[k];
      const pe = parentEdge[child];
      if (pe < 0) continue;
      const childIsTail = eu[pe] === child;
      let value = w[pe];
      for (const e of incident[child]) {
        if (e === pe) continue;
        const outward = eu[e] === child;
        const same = outward === childIsTail;
        value += same ? w[e] : -w[e];
        if (isTree[e]) value += same ? -cut[e] : cut[e];
      }
      cut[pe] = value;
    }
  };
  number();
  cuts();

  let pivots = 0;
  let optimal = false;
  for (;;) {
    let leave = -1;
    for (let e = 0; e < m; e++)
      if (isTree[e] && cut[e] < 0) {
        leave = e;
        break;
      }
    if (leave < 0) {
      optimal = true;
      break;
    }
    if (pivots >= maxPivots || performance.now() > deadline) break;
    const child = parentEdge[eu[leave]] === leave ? eu[leave] : ev[leave];
    const childIsTail = child === eu[leave];
    let enter = -1,
      least = Infinity;
    for (let e = 0; e < m; e++) {
      if (isTree[e]) continue;
      const a = below(eu[e], child),
        b = below(ev[e], child);
      if (childIsTail ? !a && b : a && !b) {
        const s = slack(e);
        if (s < least) {
          least = s;
          enter = e;
        }
      }
    }
    if (enter < 0) break; // can't happen for a valid input; keep the feasible ranking
    isTree[leave] = 0;
    for (const v of [eu[leave], ev[leave]]) {
      const list = treeAdj[v];
      list.splice(list.indexOf(leave), 1);
    }
    isTree[enter] = 1;
    treeAdj[eu[enter]].push(enter);
    treeAdj[ev[enter]].push(enter);
    // Ranks from the new tree: every tree edge tight.
    const seen = new Uint8Array(n);
    const todo = [root];
    seen[root] = 1;
    while (todo.length) {
      const v = todo.pop();
      for (const e of treeAdj[v]) {
        const x = eu[e] === v ? ev[e] : eu[e];
        if (seen[x]) continue;
        seen[x] = 1;
        rank[x] = eu[e] === v ? rank[v] + len[e] : rank[v] - len[e];
        todo.push(x);
      }
    }
    number();
    cuts();
    pivots++;
  }

  let least = Infinity;
  for (let v = 0; v < count; v++) least = Math.min(least, rank[v]);
  const out = new Int32Array(count);
  for (let v = 0; v < count; v++) out[v] = Math.round(rank[v] - least);
  return { rank: out, pivots, optimal };
}
