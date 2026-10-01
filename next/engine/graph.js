// The graph model: nodes and directed edges, read as a forest so tree-shaped layouts have a parent for every node.
//
// Every node carries its live position (x, y), velocity (vx, vy) and the position its layout wants (homeX, homeY).
// Layouts write homes; physics moves x/y; the renderer reads x/y.

/**
 * @typedef {object} Node
 * @property {string} id
 * @property {string} label
 * @property {number} index     position in graph.nodes
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} homeX     where the layout puts it
 * @property {number} homeY
 * @property {number} parent    index of the parent in the forest, or -1 for a root
 * @property {number[]} children indices of the children in the forest
 * @property {number} depth     0 for a root
 * @property {number} leaves    leaves in its subtree (1 for a leaf)
 * @property {number} descendants nodes in its subtree, not counting itself
 */

/**
 * @typedef {object} Edge
 * @property {number} source index of the source node
 * @property {number} target index of the target node
 * @property {boolean} tree  true when this edge is the target's parent link in the forest
 */

export class Graph {
  /**
   * @param {{ id: string | number, label?: string }[]} nodes
   * @param {{ source: string | number, target: string | number }[]} edges
   */
  constructor(nodes = [], edges = []) {
    /** @type {Node[]} */
    this.nodes = nodes.map((n, index) => ({
      id: String(n.id),
      label: n.label ?? String(n.id),
      index,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      homeX: 0,
      homeY: 0,
      parent: -1,
      children: [],
      depth: 0,
      leaves: 1,
      descendants: 0,
    }));
    /** @type {Map<string, Node>} */
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    /** @type {Edge[]} */
    this.edges = [];
    for (const e of edges) {
      const s = this.byId.get(String(e.source));
      const t = this.byId.get(String(e.target));
      if (!s || !t || s === t) continue;
      this.edges.push({ source: s.index, target: t.index, tree: false });
    }
    /** @type {number[]} roots of the forest, in the order they were found */
    this.roots = [];
    /** @type {number[]} every node, parents before children (breadth first per root) */
    this.order = [];
    this.maxDepth = 0;
    this.#buildForest();
  }

  /** Breadth-first from each node nothing points at, then from anything left over (cycles), first edge wins. */
  #buildForest() {
    const count = this.nodes.length;
    const out = Array.from({ length: count }, () => []);
    const indegree = new Array(count).fill(0);
    this.edges.forEach((e, i) => {
      out[e.source].push(i);
      indegree[e.target]++;
    });
    const seen = new Uint8Array(count);
    const grow = (root) => {
      seen[root] = 1;
      this.roots.push(root);
      const queue = [root];
      for (let head = 0; head < queue.length; head++) {
        const at = queue[head];
        this.order.push(at);
        for (const ei of out[at]) {
          const edge = this.edges[ei];
          if (seen[edge.target]) continue;
          seen[edge.target] = 1;
          edge.tree = true;
          const child = this.nodes[edge.target];
          child.parent = at;
          child.depth = this.nodes[at].depth + 1;
          this.nodes[at].children.push(child.index);
          queue.push(child.index);
        }
      }
    };
    for (let i = 0; i < count; i++) if (indegree[i] === 0) grow(i);
    for (let i = 0; i < count; i++) if (!seen[i]) grow(i);

    for (let k = this.order.length - 1; k >= 0; k--) {
      const node = this.nodes[this.order[k]];
      if (node.children.length) {
        node.leaves = 0;
        for (const c of node.children) {
          node.leaves += this.nodes[c].leaves;
          node.descendants += this.nodes[c].descendants + 1;
        }
      }
      if (node.depth > this.maxDepth) this.maxDepth = node.depth;
    }
  }

  /** The bounding box of the live positions, or of the homes. */
  bounds(homes = false) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of this.nodes) {
      const x = homes ? n.homeX : n.x;
      const y = homes ? n.homeY : n.y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!this.nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }
}
