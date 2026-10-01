// Ghosts: nodes that left the graph, folding back into what's left of their family. When a graph change removes
// nodes, each becomes a ghost for the length of the morph: it glides to its nearest ancestor that survived
// (following that ancestor as it moves to its own new place) and fades out, with its label and the edge to its
// parent. Ghosts are only drawn: the view hands the renderer a display graph (the real graph with the ghosts
// appended), while physics, hover and hit-testing only ever see the real graph.
//
// Pure: no DOM, no GL.

/**
 * @typedef {object} Ghost
 * @property {string} id
 * @property {string} label
 * @property {number} labelAngle
 * @property {number} radius     as drawn when it left
 * @property {string} fill
 * @property {number} x0         where it was when it left
 * @property {number} y0
 * @property {string[]} ancestors ids from its parent up to its root, in the graph it left
 * @property {number} start      when it left (ms, the view's clock)
 */

/**
 * The nodes of `previous` that aren't in `next`, as ghosts starting at `now`. `looks` are previous's radius and
 * fill per node.
 * @returns {Ghost[]}
 */
export function departures(previous, next, looks, now) {
  const out = [];
  for (const n of previous.nodes) {
    if (next.byId.has(n.id)) continue;
    const ancestors = [];
    for (let p = n.parent; p >= 0; p = previous.nodes[p].parent)
      ancestors.push(previous.nodes[p].id);
    out.push({
      id: n.id,
      label: n.label,
      labelAngle: n.labelAngle ?? Math.PI / 2,
      radius: looks.radius[n.index],
      fill: looks.fill[n.index],
      shape: looks.shape?.[n.index] ?? "circle",
      x0: n.x,
      y0: n.y,
      ancestors,
      start: now,
    });
  }
  // Parents before children, so a ghost following a ghost parent finds where that parent is this frame.
  return out.sort((a, b) => a.ancestors.length - b.ancestors.length);
}

/**
 * Where a ghost folds to: its nearest ancestor that `graph` still has (a node), or that is itself a ghost still
 * leaving (a ghost id), or nothing (it fades where it is).
 * @returns {{ node: object } | { ghost: string } | null}
 */
export function foldTarget(ghost, graph, ghostIds) {
  for (const id of ghost.ancestors) {
    const node = graph.byId.get(id);
    if (node) return { node };
    if (ghostIds.has(id)) return { ghost: id };
  }
  return null;
}

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
    const parentId = g.ancestors[0];
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
