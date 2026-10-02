// References: in a layered layout, a cross-link into a busy shared ingredient can end at a reference (a small
// hollow chip in the ingredient's colour, just below the node that uses it) instead of running all the way to the
// ingredient. The layout decides which edges, where, and how big a chip it kept room for (layered.js,
// `routing.references`); this draws them. A chip has no label: the layout keeps it compact (a busy recipe can have
// many side by side), and hovering one lights up its ingredient.
//
// Like ghosts, references are only drawn: the view hands the renderer a display graph (the real graph with a node
// per reference appended, and each referenced edge ending at its reference), while physics, hover and hit-testing
// only ever see the real graph. A reference keeps its place relative to its source, so it follows a drag.
//
// Pure: no DOM, no GL.

/** How big a reference is drawn, relative to its ingredient (and never bigger than the room the layout kept). */
export const REFERENCE_SCALE = 0.7;

/** A reference's chip radius: its ingredient's, scaled down, within the room the layout kept for it. */
export function referenceRadius(ref, ingredientRadius) {
  return Math.min(ingredientRadius * REFERENCE_SCALE, ref.radius ?? Infinity);
}

/**
 * The display graph with references: `graph`'s nodes plus one per reference, and its edges with each referenced
 * one ending at its reference (same index, so per-edge looks still line up). Per-node arrays are extended to match.
 * @param {object} graph   the real graph
 * @param {{ edge: object, source: number, target: number, x: number, y: number, radius?: number }[]} references
 *   from the layout (layered.js)
 * @param {{ looks: object, shade: Float32Array, appear: Float32Array }} base for the real graph
 * @returns {{ graph: object, looks: object, shade: Float32Array, appear: Float32Array }}
 */
export function withReferences(graph, references, base) {
  if (!references?.length) return { graph, ...base };
  const count = graph.nodes.length;
  const total = count + references.length;
  const nodes = graph.nodes.slice();
  const edges = graph.edges.slice();
  const index = new Map(graph.edges.map((e, i) => [e, i]));
  const radius = new Float64Array(total);
  const fill = new Array(total);
  const shape = new Array(total);
  const shade = new Float32Array(total);
  const appear = new Float32Array(total);
  radius.set(base.looks.radius);
  for (let i = 0; i < count; i++) {
    fill[i] = base.looks.fill[i];
    shape[i] = base.looks.shape[i];
  }
  shade.set(base.shade.subarray(0, count));
  appear.set(base.appear.subarray(0, count));

  references.forEach((ref, k) => {
    const i = count + k;
    const s = graph.nodes[ref.source],
      t = graph.nodes[ref.target];
    // Where the layout put it, moved along with its source.
    const x = ref.x + s.x - s.homeX,
      y = ref.y + s.y - s.homeY;
    nodes.push({
      id: `${t.id}@${s.id}`,
      label: "",
      labelAngle: t.labelAngle,
      index: i,
      x,
      y,
      homeX: x,
      homeY: y,
      parent: ref.source,
      children: [],
      depth: s.depth + 1,
      reference: ref.target,
    });
    radius[i] = referenceRadius(ref, base.looks.radius[ref.target]);
    fill[i] = base.looks.fill[ref.target];
    shape[i] = "ring";
    // Lit when the hover lights both ends of the edge it stands in for.
    shade[i] = Math.min(base.shade[ref.source], base.shade[ref.target]);
    appear[i] = Math.min(base.appear[ref.source], base.appear[ref.target]);
    const ei = index.get(ref.edge);
    if (ei !== undefined)
      edges[ei] = { ...ref.edge, target: i, reference: true };
  });
  return {
    graph: {
      nodes,
      edges,
      byId: graph.byId,
      roots: graph.roots,
      order: graph.order,
    },
    looks: { ...base.looks, radius, fill, shape },
    shade,
    appear,
  };
}
