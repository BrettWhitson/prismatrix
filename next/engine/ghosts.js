// Ghosts: nodes that left the graph, folding back into what's left of their family. When a graph change removes
// nodes, each becomes a ghost for the length of the morph: it glides to its nearest ancestor that survived
// (following that ancestor as it moves to its own new place) and fades out, with its label and the edge to its
// parent. Ghosts are only drawn: the view hands the renderer a display graph (the real graph with the ghosts
// appended), while physics, hover and hit-testing only ever see the real graph.
//
// Pure: no DOM, no GL.

/**
 * A ghost's ancestors, as a chain shared between ghosts: `id` is one ancestor's, `up` the chain above it (null at
 * the root). A removed subtree's ghosts all share their parents' chains, so making them costs one link each.
 * @typedef {{ id: string, up: Ancestry | null }} Ancestry
 */

/**
 * @typedef {object} Ghost
 * @property {string} id
 * @property {string} label
 * @property {number} labelAngle
 * @property {number} radius     as drawn when it left
 * @property {string} fill
 * @property {number} x0         where it was when it left
 * @property {number} y0
 * @property {Ancestry | null} up its ancestors in the graph it left, from its parent up to its root
 * @property {string[]} ancestors the same, as a list of ids (made when read)
 * @property {number} depth      how many ancestors it has
 * @property {number} start      when it left (ms, the view's clock)
 */

/** The ids along an ancestry chain, nearest first. */
export function ancestorIds(up) {
  const out = [];
  for (let a = up; a; a = a.up) out.push(a.id);
  return out;
}

/**
 * The nodes of `previous` that aren't in `next`, as ghosts starting at `now`. `looks` are previous's radius and
 * fill per node. Linear in the nodes that left: each one's ancestry is its parent's with one link added, made once.
 * @returns {Ghost[]}
 */
export function departures(previous, next, looks, now) {
  const { nodes } = previous;
  // Per node of previous, the chain of its ancestors (made when first needed, parents before children).
  const chains = new Array(nodes.length);
  const depths = new Int32Array(nodes.length);
  const chainOf = (i) => {
    // Up to the nearest node whose chain is known (or past a root), then down again making each link once.
    const path = [];
    for (let at = i; at >= 0 && chains[at] === undefined; at = nodes[at].parent)
      path.push(at);
    for (let k = path.length - 1; k >= 0; k--) {
      const v = path[k],
        p = nodes[v].parent;
      chains[v] = p < 0 ? null : { id: nodes[p].id, up: chains[p] };
      depths[v] = p < 0 ? 0 : depths[p] + 1;
    }
    return chains[i];
  };
  const out = [];
  for (const n of nodes) {
    if (next.byId.has(n.id)) continue;
    const up = chainOf(n.index);
    out.push({
      id: n.id,
      label: n.label,
      labelAngle: n.labelAngle ?? Math.PI / 2,
      radius: looks.radius[n.index],
      fill: looks.fill[n.index],
      shape: looks.shape?.[n.index] ?? "circle",
      x0: n.x,
      y0: n.y,
      up,
      get ancestors() {
        return ancestorIds(this.up);
      },
      depth: depths[n.index],
      start: now,
    });
  }
  // Parents before children, so a ghost following a ghost parent finds where that parent is this frame.
  return out.sort((a, b) => a.depth - b.depth);
}

/**
 * Where a ghost folds to: its nearest ancestor that `graph` still has (a node), or that is itself a ghost still
 * leaving (a ghost id), or nothing (it fades where it is). Ghosts carry their ancestors as a chain (`up`); a plain
 * list of ids (`ancestors`) works too.
 * @returns {{ node: object } | { ghost: string } | null}
 */
export function foldTarget(ghost, graph, ghostIds) {
  const ids = "up" in ghost ? chainIds(ghost.up) : ghost.ancestors;
  for (const id of ids) {
    const node = graph.byId.get(id);
    if (node) return { node };
    if (ghostIds.has(id)) return { ghost: id };
  }
  return null;
}

/** The ids along an ancestry chain, one at a time (the walk usually stops at the first). */
function* chainIds(up) {
  for (let a = up; a; a = a.up) yield a.id;
}

/** A ghost's parent's id (its nearest ancestor), or undefined for a root. */
const parentOf = (g) => ("up" in g ? g.up?.id : g.ancestors[0]);

/**
 * The display graph for a frame: `graph`'s nodes and edges with the ghosts appended (nodes at their current
 * positions, plus an edge from each ghost's parent, real or ghost, where it has one), and the per-node arrays the
 * renderer reads, extended to match. Ghosts past their time are left out.
 * @param {object} graph   the real graph
 * @param {Ghost[]} ghosts
 * @param {object} base    { looks: { radius, fill }, shade, appear } for the real graph
 * @param {number} now
 * @param {number} ms      how long a ghost takes to fold away
 * @param {(t: number) => number} ease
 * @returns {{ graph: object, looks: object, shade: Float32Array, appear: Float32Array, live: Ghost[] }}
 */
export function withGhosts(graph, ghosts, base, now, ms, ease) {
  const live = ghosts.filter((g) => ms > 0 && now - g.start < ms);
  const count = graph.nodes.length;
  if (!live.length)
    return {
      graph,
      looks: base.looks,
      shade: base.shade,
      appear: base.appear,
      live,
    };

  const ids = new Set(live.map((g) => g.id));
  const index = new Map(live.map((g, k) => [g.id, count + k]));
  const nodes = graph.nodes.slice();
  const edges = graph.edges.slice();
  const radius = new Float64Array(count + live.length);
  const fill = new Array(count + live.length);
  const shape = new Array(count + live.length);
  const shade = new Float32Array(count + live.length).fill(1);
  const appear = new Float32Array(count + live.length).fill(1);
  radius.set(base.looks.radius);
  for (let i = 0; i < count; i++) {
    fill[i] = base.looks.fill[i];
    shape[i] = base.looks.shape?.[i] ?? "circle";
  }
  if (base.shade) shade.set(base.shade.subarray(0, count));
  if (base.appear) appear.set(base.appear.subarray(0, count));

  // Positions. A ghost parent always comes before its ghost children (departures sorts them so), so a ghost
  // following a ghost finds where it is this frame.
  const at = new Map();
  for (const g of live) {
    const t = Math.min((now - g.start) / ms, 1);
    const f = ease(t);
    const target = foldTarget(g, graph, ids);
    let tx = g.x0,
      ty = g.y0;
    if (target?.node) [tx, ty] = [target.node.x, target.node.y];
    else if (target?.ghost && at.has(target.ghost))
      [tx, ty] = at.get(target.ghost);
    const x = g.x0 + (tx - g.x0) * f,
      y = g.y0 + (ty - g.y0) * f;
    at.set(g.id, [x, y]);
    const i = index.get(g.id);
    nodes.push({
      id: g.id,
      label: g.label,
      labelAngle: g.labelAngle,
      index: i,
      x,
      y,
      homeX: x,
      homeY: y,
      parent: -1,
      children: [],
      depth: 0,
      ghost: true,
    });
    radius[i] = g.radius;
    fill[i] = g.fill;
    shape[i] = g.shape;
    appear[i] = 1 - t;
  }
  // An edge from each ghost's parent (its first ancestor) if that's still drawn, real or ghost.
  for (const g of live) {
    const parentId = parentOf(g);
    if (parentId === undefined) continue;
    const real = graph.byId.get(parentId);
    const source = real ? real.index : index.get(parentId);
    if (source === undefined) continue;
    edges.push({ source, target: index.get(g.id), tree: true, ghost: true });
  }
  // Colours and widths for the ghost edges, as the view's edge options would give them.
  const fallback = base.looks.edgeDefault ?? {
    colour: "#5b6478",
    width: 1.5,
    byTarget: false,
  };
  const edgeColour = edges.map((e, i) =>
    i < graph.edges.length
      ? (base.looks.edgeColour?.[i] ?? fallback.colour)
      : fallback.byTarget
        ? fill[e.target]
        : fallback.colour,
  );
  const edgeWidth = Float64Array.from(edges, (_, i) =>
    i < graph.edges.length
      ? (base.looks.edgeWidth?.[i] ?? fallback.width)
      : fallback.width,
  );
  return {
    graph: {
      nodes,
      edges,
      byId: graph.byId,
      roots: graph.roots,
      order: graph.order,
    },
    looks: { ...base.looks, radius, fill, shape, edgeColour, edgeWidth },
    shade,
    appear,
    live,
  };
}
