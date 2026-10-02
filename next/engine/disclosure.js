// Progressive disclosure: the part of a model a view shows when some of its nodes are collapsed. Collapsing is view
// state (the controller keeps a set of collapsed ids); the model always holds the whole graph.
//
// The rule:
//
//   - Roots are always shown: the nodes nothing points to, and the node the model's forest starts each cycle from.
//   - A shown node that isn't collapsed shows everything it points to.
//   - Nothing else is shown.
//
// So a node is hidden exactly when every path to it from a root passes through a collapsed node before reaching it.
// In a DAG an ingredient that two recipes use stays shown while either recipe is shown and expanded; it's hidden
// only once both are collapsed (or hidden themselves). A collapsed node is still shown itself, if something leads to
// it, but none of its edges out are drawn, even to nodes that are shown through another path: collapsed means "its
// children aren't drawn under it". Only a node with edges out can be collapsed.
//
// Depth is the number of edges from the nearest root (breadth first from every root at once). Along any edge it
// grows by at most one, so every path from a root to a node deeper than d passes through a node at depth d:
// collapsing those shows exactly the nodes at depth d and above.
//
// Pure: no DOM. Everything here is linear in the model's size, except hidden counts (see hiddenBelow).

/**
 * @typedef {object} Disclosure what a view shows of a model
 * @property {Uint8Array} shown   per model node, 1 when it's shown
 * @property {Uint8Array} folded  per model node, 1 when it's collapsed (and has edges out)
 * @property {Int32Array | null} nodes the shown nodes' model indices, ascending (null when everything is shown)
 * @property {Int32Array | null} edges the shown edges' model indices, ascending: those from a shown node that isn't
 *   collapsed (null when every edge is shown)
 * @property {boolean} all        everything is shown (nothing collapsed, or nothing collapsed hides anything)
 */

/**
 * Per model node, 1 when it's in `collapsed` and has edges out (only those fold anything away).
 * @param {import("./model.js").GraphModel} model
 * @param {Iterable<string>} collapsed ids
 */
export function foldFlags(model, collapsed) {
  const folded = new Uint8Array(model.size);
  const { outStart } = model.adjacency();
  for (const id of collapsed) {
    const i = model.index.get(id);
    if (i !== undefined && outStart[i + 1] > outStart[i]) folded[i] = 1;
  }
  return folded;
}

/**
 * What a view of `model` shows with the nodes in `collapsed` collapsed. Breadth first from the roots, never past a
 * collapsed node: linear in the model's size.
 * @param {import("./model.js").GraphModel} model
 * @param {Iterable<string>} collapsed ids (ones the model doesn't have, or that have no edges out, are ignored)
 * @returns {Disclosure}
 */
export function disclose(model, collapsed) {
  const n = model.size;
  const { source, target, outStart, outEdges } = model.adjacency();
  const folded = foldFlags(model, collapsed);
  if (!folded.includes(1))
    return {
      shown: new Uint8Array(n).fill(1),
      folded,
      nodes: null,
      edges: null,
      all: true,
    };
  const shown = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  for (const r of model.forest().roots) {
    shown[r] = 1;
    queue[tail++] = r;
  }
  for (let head = 0; head < tail; head++) {
    const v = queue[head];
    if (folded[v]) continue;
    for (let k = outStart[v]; k < outStart[v + 1]; k++) {
      const t = target[outEdges[k]];
      if (!shown[t]) {
        shown[t] = 1;
        queue[tail++] = t;
      }
    }
  }
  const nodes = new Int32Array(tail);
  for (let i = 0, k = 0; i < n; i++) if (shown[i]) nodes[k++] = i;
  const m = source.length;
  let edgeCount = 0;
  for (let e = 0; e < m; e++)
    if (shown[source[e]] && !folded[source[e]]) edgeCount++;
  const edges = new Int32Array(edgeCount);
  for (let e = 0, k = 0; e < m; e++)
    if (shown[source[e]] && !folded[source[e]]) edges[k++] = e;
  const all = tail === n && edgeCount === m;
  return {
    shown,
    folded,
    nodes: all ? null : nodes,
    edges: all ? null : edges,
    all,
  };
}

/**
 * Per model node, how many nodes are hidden below it: for a shown, collapsed node, the hidden nodes it leads to
 * through hidden nodes only (what a "+N" badge counts); 0 for every other node. A hidden node below two collapsed
 * nodes counts for both. Costs the size of each collapsed node's hidden region: linear for trees, more where many
 * collapsed nodes share one big hidden region.
 * @param {import("./model.js").GraphModel} model
 * @param {Disclosure} disclosure
 * @returns {Int32Array}
 */
export function hiddenBelow(model, { shown, folded }) {
  const n = model.size;
  const { target, outStart, outEdges } = model.adjacency();
  const counts = new Int32Array(n);
  const stamp = new Int32Array(n); // which walk last reached each node (walk c is stamped c + 1)
  const queue = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    if (!shown[c] || !folded[c]) continue;
    let tail = 0;
    queue[tail++] = c;
    for (let head = 0; head < tail; head++) {
      const v = queue[head];
      for (let k = outStart[v]; k < outStart[v + 1]; k++) {
        const t = target[outEdges[k]];
        if (shown[t] || stamp[t] === c + 1) continue;
        stamp[t] = c + 1;
        queue[tail++] = t;
      }
    }
    counts[c] = tail - 1;
  }
  return counts;
}

/**
 * Each model node's depth: edges from the nearest of `from` (default: the roots), following every edge out; -1 where
 * none of them leads.
 * @param {import("./model.js").GraphModel} model
 * @param {number[]} [from] model indices
 * @param {number} [limit] stop looking past this depth (nodes deeper are left at -1)
 * @returns {Int32Array}
 */
export function depths(model, from = model.forest().roots, limit = Infinity) {
  const n = model.size;
  const { target, outStart, outEdges } = model.adjacency();
  const depth = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (const r of from)
    if (depth[r] < 0) {
      depth[r] = 0;
      queue[tail++] = r;
    }
  for (let head = 0; head < tail; head++) {
    const v = queue[head];
    if (depth[v] >= limit) continue;
    for (let k = outStart[v]; k < outStart[v + 1]; k++) {
      const t = target[outEdges[k]];
      if (depth[t] < 0) {
        depth[t] = depth[v] + 1;
        queue[tail++] = t;
      }
    }
  }
  return depth;
}

/**
 * The collapsed ids that show `levels` levels below the roots (0: just the roots) and nothing deeper: every node at
 * that depth with an edge to a deeper node.
 * @param {import("./model.js").GraphModel} model
 * @param {number} levels
 * @returns {Set<string>}
 */
export function collapsedAt(model, levels) {
  const depth = depths(model, undefined, levels + 1);
  const { target, outStart, outEdges } = model.adjacency();
  const records = model.nodes;
  const out = new Set();
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] !== levels) continue;
    for (let k = outStart[i]; k < outStart[i + 1]; k++)
      if (depth[target[outEdges[k]]] === levels + 1) {
        out.add(records[i].id);
        break;
      }
  }
  return out;
}

/**
 * The collapsed ids after expanding model node `index` to show `levels` levels below it: it and every node fewer
 * than `levels` edges below it are expanded, and nodes exactly `levels` below that were hidden are collapsed if they
 * lead on to more hidden nodes, so expanding one node never spills its whole subtree. Nodes shown elsewhere are
 * left as they are. `levels` Infinity expands everything below.
 * @param {import("./model.js").GraphModel} model
 * @param {Set<string>} collapsed the collapsed ids now
 * @param {number} index
 * @param {number} levels at least 1
 * @param {Uint8Array} shown  per model node, shown now (disclose)
 * @returns {Set<string>}
 */
export function expandedTo(model, collapsed, index, levels, shown) {
  const depth = depths(model, [index], levels + 1);
  const { target, outStart, outEdges } = model.adjacency();
  const records = model.nodes;
  const next = new Set(collapsed);
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (d >= 0 && d < levels) next.delete(records[i].id);
    else if (d === levels && !shown[i])
      for (let k = outStart[i]; k < outStart[i + 1]; k++) {
        const c = target[outEdges[k]];
        // A child that stays hidden unless this node shows it (one that's in the expanded levels is shown anyway).
        if (!shown[c] && (depth[c] < 0 || depth[c] > levels)) {
          next.add(records[i].id);
          break;
        }
      }
  }
  return next;
}

/**
 * The collapsed ids after revealing model node `index`: the collapsed nodes on its path from a root (the model's
 * forest path) and every node below them on that path are expanded, and whatever else that brings into view is
 * collapsed if it leads on to more hidden nodes (so only the path opens). Null when it's shown already. Costs the
 * path and its nodes' edges.
 * @param {import("./model.js").GraphModel} model
 * @param {Set<string>} collapsed
 * @param {number} index
 * @param {Disclosure} disclosure
 * @returns {Set<string> | null}
 */
export function revealed(model, collapsed, index, { shown, folded }) {
  if (shown[index]) return null;
  const { parent } = model.forest();
  const { target, outStart, outEdges } = model.adjacency();
  const records = model.nodes;
  const path = [];
  for (let p = parent[index]; p >= 0; p = parent[p]) path.push(p);
  path.reverse();
  const first = path.findIndex((p) => folded[p]);
  if (first < 0) return null;
  const opening = path.slice(first);
  const onPath = new Set(opening).add(index);
  const leadsOn = (t) => {
    for (let k = outStart[t]; k < outStart[t + 1]; k++) {
      const c = target[outEdges[k]];
      if (!shown[c] && !onPath.has(c)) return true;
    }
    return false;
  };
  const next = new Set(collapsed);
  for (const p of opening) {
    next.delete(records[p].id);
    for (let k = outStart[p]; k < outStart[p + 1]; k++) {
      const t = target[outEdges[k]];
      if (!shown[t] && !onPath.has(t) && leadsOn(t)) next.add(records[t].id);
    }
  }
  if (leadsOn(index)) next.add(records[index].id);
  return next;
}
