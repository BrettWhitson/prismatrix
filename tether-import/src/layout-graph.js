/**
 * The graph as the layouts and the physics see it: plain arrays, no renderer. Each node has its own box (w × h) and
 * its footprint with the label (fullW × fullH, the box they make together); edges run parent → child, from the root outward.
 * Positions live in `x` / `y` (centres) and are what every layout reads and writes.
 *
 *   const graph = new LayoutGraph(
 *     [{ id: "result", w: 58, h: 58, fullW: 200, fullH: 58, root: true }, { id: "ore", w: 48, h: 48 }],
 *     [{ source: "result", target: "ore" }],
 *   );
 */
export class LayoutGraph {
  /**
   * @param {{ id: string, w: number, h: number, fullW?: number, fullH?: number, x?: number, y?: number,
   *           root?: boolean, ghost?: boolean }[]} nodes  ghosts are leaving: laid out, but not simulated
   * @param {{ id?: string, source: string, target: string }[]} edges
   *   Ids must be unique: of nodes sharing an id, the first is kept and the rest dropped, with a warning. The same
   *   goes for edges, whose id is their `id` or "source->target" (so an edge given twice pulls once).
   */
  constructor(nodes, edges) {
    nodes = uniqueById(nodes, "Tether: LayoutGraph");
    const count = (this.count = nodes.length);
    this.ids = nodes.map((node) => node.id);
    this.indexById = new Map(this.ids.map((id, i) => [id, i]));
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
    this.w = new Float64Array(count);
    this.h = new Float64Array(count);
    this.fullW = new Float64Array(count);
    this.fullH = new Float64Array(count);
    this.ghost = new Uint8Array(count);
    this.rootIndex = -1;
    nodes.forEach((node, i) => {
      this.x[i] = node.x ?? 0;
      this.y[i] = node.y ?? 0;
      this.w[i] = node.w;
      this.h[i] = node.h;
      this.fullW[i] = Math.max(node.w, node.fullW ?? node.w);
      this.fullH[i] = Math.max(node.h, node.fullH ?? node.h);
      this.ghost[i] = node.ghost ? 1 : 0;
      if (node.root && this.rootIndex < 0) this.rootIndex = i;
    });
    /** Edges as index pairs (both ends present, no self-loops). */
    this.sources = [];
    this.targets = [];
    const keyed = edges.map((edge) => ({
      id: edge.id ?? `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
    }));
    for (const { source, target } of uniqueById(
      keyed,
      "Tether: LayoutGraph edges",
    )) {
      const s = this.indexById.get(source),
        t = this.indexById.get(target);
      if (s == null || t == null || s === t) continue;
      this.sources.push(s);
      this.targets.push(t);
    }
  }

  get rootId() {
    return this.rootIndex >= 0 ? this.ids[this.rootIndex] : undefined;
  }

  /**
   * Space node `i` takes up: its box plus a share (0..1) of the label's overhang on each axis. Low shares let labels
   * overlap their neighbours' (tighter packing).
   */
  footprint(i, widthLabelShare = 1, heightLabelShare = 1) {
    return {
      w: this.w[i] + (this.fullW[i] - this.w[i]) * widthLabelShare,
      h: this.h[i] + (this.fullH[i] - this.h[i]) * heightLabelShare,
    };
  }

  positionOf(id) {
    const i = this.indexById.get(id);
    return i == null ? null : { x: this.x[i], y: this.y[i] };
  }

  /** Every node's position, as a Map: id → { x, y }. */
  positions() {
    return new Map(
      this.ids.map((id, i) => [id, { x: this.x[i], y: this.y[i] }]),
    );
  }
}

/**
 * `items` with one per id: the first of each id is kept, later ones are dropped, with one warning per call that
 * found any (naming a few of the ids). Returns `items` itself when every id is unique.
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {string} [scope]  who is asking, for the warning
 * @returns {T[]}
 */
export function uniqueById(items, scope = "Tether") {
  const seen = new Set(),
    duplicates = new Set();
  for (const item of items)
    if (seen.has(item.id)) duplicates.add(item.id);
    else seen.add(item.id);
  if (!duplicates.size) return items;
  const shown = [...duplicates].slice(0, 5).map((id) => JSON.stringify(id));
  console.warn(
    `${scope}: ${duplicates.size} duplicate id${duplicates.size > 1 ? "s" : ""} (${shown.join(", ")}${duplicates.size > 5 ? ", …" : ""}); keeping the first of each`,
  );
  const kept = new Set();
  return items.filter((item) => !kept.has(item.id) && kept.add(item.id));
}
