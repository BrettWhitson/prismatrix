// References: in a layered layout, a cross-link into a busy shared ingredient can end at a reference (a small
// hollow chip in the ingredient's colour, just below the node that uses it) instead of running all the way to the
// ingredient. The layout decides which edges, where, and how big a chip it kept room for (layered.js,
// `routing.references`); this draws them. A chip has no label of its own: the layout keeps it compact (a busy
// recipe can have many side by side). What makes it read as a reference rather than a fourth "Copper Ore":
//
// - a link glyph inside the ring (two interlocked links, drawn as a shape: LINK below), once it's big enough to see;
// - hovering it hovers its ingredient (the controller's pick): the ingredient's lineage lights up (the real node
//   and every recipe that uses it), its label shows at any zoom, and each of its chips shows its name (labels.js);
// - the real, shared node carries "×N", N its in-degree (how many recipes use it), whenever it has chips;
// - a tap on a chip is a tap on its ingredient, with `reference: true` in the detail. To fly to the real node:
//   `view.on("tap", ({ node, reference }) => reference && view.focus(node))` (focus glides the camera there).
//
// Like ghosts, references are only drawn: the view hands the renderer a display graph (the real graph with a node
// per reference appended, and each referenced edge ending at its reference), while physics, hover and hit-testing
// only ever see the real graph. A reference keeps its place relative to its source, so it follows a drag.
//
// Pure: no DOM, no GL.

// A reference with `copy` (references "crossing": a split) is drawn as a whole copy of its ingredient instead: its
// label, shape, size, icon and marks, every look the ingredient has. Hovering and tapping it still work as above.

/** Per-node looks a copy takes from its ingredient (the rest are a chip's own). */
const COPIED = [
  "stroke",
  "strokeWidth",
  "icon",
  "badgeIcon",
  "strokeStyle",
  "opacity",
  "ring",
  "aura",
  "stack",
];

/** How big a reference is drawn, relative to its ingredient (and never bigger than the room the layout kept). */
const REFERENCE_SCALE = 0.7;

/** A reference's chip radius: its ingredient's, scaled down, within the room the layout kept for it. */
export function referenceRadius(ref, ingredientRadius) {
  return Math.min(ingredientRadius * REFERENCE_SCALE, ref.radius ?? Infinity);
}

/**
 * The link glyph, in units of its radius, before it's turned 45° (lying from lower left to upper right): two
 * stadiums (rounded bars) `length` × `height`, their centres `offset` either side of the middle, stroked `stroke`
 * wide. The Canvas 2D painter strokes them as rounded rectangles; the WebGL one draws the same as a distance field
 * (GLYPH_FRAGMENT).
 */
export const LINK = { offset: 0.32, length: 1, height: 0.52, stroke: 0.18 };

/** A chip's ring is this wide (as Canvas 2D strokes a ring node; the node shader's ringHalfStroke is half). */
export const ringStroke = (r) => Math.max(1.5, r * 0.35);

/** The link glyph's radius inside a chip of radius `r`: the ring's hole, less a little room. */
export const glyphRadius = (r) => (r - ringStroke(r) / 2) * 0.92;

/** A glyph is drawn once it's at least this many CSS px across (radius), else the chip is just its ring. */
export const GLYPH_MIN_PX = 2.5;

/**
 * Where to draw link glyphs this frame: one per chip (display-only node with a `reference`) whose glyph is at
 * least `minimum` CSS px (radius) on screen, in its ingredient's colour.
 * @returns {{ index: number, x: number, y: number, radius: number, colour: string }[]}
 */
export function linkGlyphs(scene, minimum = GLYPH_MIN_PX) {
  const { graph, looks, camera } = scene;
  const out = [];
  const first = scene.matrix?.count ?? 0;
  for (let i = first; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (n.reference === undefined || n.copy) continue;
    const radius = glyphRadius(looks.radius[i]);
    if (radius * camera.k < minimum) continue;
    out.push({ index: i, x: n.x, y: n.y, radius, colour: looks.fill[i] });
  }
  return out;
}

/**
 * The real graph's per-node radius, fill, shape, shade and appear (`base`, for its `count` nodes), with room for
 * `more` display-only nodes after them (lit and shown until set).
 * @param {Omit<import("./render.js").Shown, "graph">} base
 * @param {number} count
 * @param {number} more
 */
export function extendNodes(base, count, more) {
  const total = count + more;
  const radius = new Float64Array(total);
  const fill = new Array(total);
  const shape = new Array(total);
  const shade = new Float32Array(total).fill(1);
  const appear = new Float32Array(total).fill(1);
  radius.set(base.looks.radius);
  for (let i = 0; i < count; i++) {
    fill[i] = base.looks.fill[i];
    shape[i] = base.looks.shape[i];
  }
  shade.set(base.shade.subarray(0, count));
  appear.set(base.appear.subarray(0, count));
  return { radius, fill, shape, shade, appear };
}

/**
 * The display graph with references: `graph`'s nodes plus one per reference, and its edges with each referenced
 * one ending at its reference (same index, so per-edge looks still line up). Per-node arrays are extended to match.
 * The display graph's `uses` maps each referenced ingredient's index to its in-degree.
 * @param {import("./render.js").DisplayGraph} graph the real graph
 * @param {import("./layered.js").Reference[] | undefined} references from the layout (layered.js)
 * @param {Omit<import("./render.js").Shown, "graph">} base for the real graph
 * @returns {import("./render.js").Shown}
 */
export function withReferences(graph, references, base) {
  if (!references?.length) return { graph, ...base };
  const count = graph.nodes.length;
  const total = count + references.length;
  const nodes = graph.nodes.slice();
  const edges = graph.edges.slice();
  const index = new Map(graph.edges.map((e, i) => [e, i]));
  const { radius, fill, shape, shade, appear } = extendNodes(
    base,
    count,
    references.length,
  );
  // The looks only copies use, extended (a chip's: none, and a whole fill).
  const extra = {};
  for (const key of COPIED) {
    const list = base.looks[key];
    if (!list) continue;
    const out = Array.isArray(list)
      ? list.concat(new Array(references.length).fill(null))
      : new /** @type {any} */ (list.constructor)(total);
    if (!Array.isArray(list)) out.set(list.subarray(0, count));
    if (key === "opacity") out.fill(1, count);
    extra[key] = out;
  }

  references.forEach((ref, k) => {
    const i = count + k;
    const s = graph.nodes[ref.source],
      t = graph.nodes[ref.target];
    // Where the layout put it, moved along with its source.
    const x = ref.x + s.x - s.homeX,
      y = ref.y + s.y - s.homeY;
    nodes.push({
      id: `${t.id}@${s.id}`,
      label: ref.copy ? t.label : "",
      ...(ref.copy && { copy: true, style: t.style, data: t.data }),
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
    radius[i] = ref.copy
      ? base.looks.radius[ref.target]
      : referenceRadius(ref, base.looks.radius[ref.target]);
    fill[i] = base.looks.fill[ref.target];
    shape[i] = ref.copy ? base.looks.shape[ref.target] : "ring";
    if (ref.copy)
      for (const key of Object.keys(extra))
        extra[key][i] = base.looks[key][ref.target];
    // Lit when the hover lights both ends of the edge it stands in for.
    shade[i] = Math.min(base.shade[ref.source], base.shade[ref.target]);
    appear[i] = Math.min(base.appear[ref.source], base.appear[ref.target]);
    const ei = index.get(ref.edge);
    if (ei !== undefined)
      edges[ei] = { ...ref.edge, target: i, reference: true };
  });
  // How many use each referenced ingredient (its in-degree), for the "×N" on the real node.
  const uses = new Map();
  for (const ref of references)
    if (!uses.has(ref.target))
      uses.set(ref.target, graph.incoming?.[ref.target]?.length ?? 0);
  return {
    graph: {
      nodes,
      edges,
      byId: graph.byId,
      roots: graph.roots,
      order: graph.order,
      uses,
    },
    looks: { ...base.looks, ...extra, radius, fill, shape },
    shade,
    appear,
  };
}
