// The working graph: a GraphModel's structure, plus a matrix (matrix.js) of every node's live state.
//
// The model says what the graph is (ids, labels, data, edges). This adds what the engine works with: each node's
// place in the model's forest (parent, children, depth…), and its row of the matrix: position (x, y), velocity
// (vx, vy), where its layout wants it (homeX, homeY), and what the controller adds (labelAngle, radius, box).
//
// Each node is a view: `node.x` reads and writes `graph.matrix.x[node.index]`, so layouts and tests can work node by
// node while physics and renderers run down the matrix's columns. A working graph is built for one structure of
// its model; when nodes or edges come or go, the controller builds a new one and carries rows across by id.
//
// A working graph can show just part of its model (a Part, from disclosure.js: what's left once collapsed nodes fold
// their descendants away). Its nodes and edges are then the part's, renumbered from 0 with their ids kept, and its
// forest is the part's own; `indexOf` and `edgeIndexOf` turn model indices into its own.

import { GraphModel, compressedRows, forestOf } from "./model.js";
import { Matrix } from "./matrix.js";

/** A node of the working graph: its model record, its place in the forest, and its row of the matrix. */
export class Node {
  constructor(record, index, matrix, forest) {
    /** The model's record (frozen): id, label, style, data. */
    this.record = record;
    /** Position in graph.nodes, and the node's row in the matrix. */
    this.index = index;
    this.matrix = matrix;
    /** Index of the parent in the forest, or -1 for a root. */
    this.parent = forest.parent[index];
    /** @type {number[]} indices of the children in the forest */
    this.children = forest.children[index].slice();
    this.depth = forest.depth[index];
    /** Leaves in its subtree (1 for a leaf). */
    this.leaves = forest.leaves[index];
    /** Nodes in its subtree, not counting itself. */
    this.descendants = forest.descendants[index];
  }

  get id() {
    return this.record.id;
  }
  get label() {
    return this.record.label;
  }
  get style() {
    return this.record.style;
  }
  get data() {
    return this.record.data;
  }

  get x() {
    return this.matrix.x[this.index];
  }
  set x(v) {
    this.matrix.x[this.index] = v;
  }
  get y() {
    return this.matrix.y[this.index];
  }
  set y(v) {
    this.matrix.y[this.index] = v;
  }
  get vx() {
    return this.matrix.vx[this.index];
  }
  set vx(v) {
    this.matrix.vx[this.index] = v;
  }
  get vy() {
    return this.matrix.vy[this.index];
  }
  set vy(v) {
    this.matrix.vy[this.index] = v;
  }
  get homeX() {
    return this.matrix.homeX[this.index];
  }
  set homeX(v) {
    this.matrix.homeX[this.index] = v;
  }
  get homeY() {
    return this.matrix.homeY[this.index];
  }
  set homeY(v) {
    this.matrix.homeY[this.index] = v;
  }
  get labelAngle() {
    return this.matrix.labelAngle[this.index];
  }
  set labelAngle(v) {
    this.matrix.labelAngle[this.index] = v;
  }
  get radius() {
    return this.matrix.radius[this.index];
  }
  set radius(v) {
    this.matrix.radius[this.index] = v;
  }
  /** Its footprint relative to its centre: { x0, y0, x1, y1 } (a copy; set a new one to change it). */
  get box() {
    const m = this.matrix,
      i = this.index;
    return { x0: m.boxX0[i], y0: m.boxY0[i], x1: m.boxX1[i], y1: m.boxY1[i] };
  }
  set box(b) {
    const m = this.matrix,
      i = this.index;
    m.boxX0[i] = b.x0;
    m.boxY0[i] = b.y0;
    m.boxX1[i] = b.x1;
    m.boxY1[i] = b.y1;
  }

  /** A plain copy, for the console and logs. */
  toJSON() {
    const { id, label, index, x, y, vx, vy, homeX, homeY, depth, parent } =
      this;
    return { id, label, index, x, y, vx, vy, homeX, homeY, depth, parent };
  }
}

/**
 * @typedef {object} Edge
 * @property {string} id     the model edge's id
 * @property {number} source index of the source node
 * @property {number} target index of the target node
 * @property {boolean} tree  true when this edge is the target's parent link in the forest
 * @property {string} label  the model edge's label ("" for none)
 * @property {object} style  the model edge's style overrides (frozen)
 * @property {object} data   the model edge's data (frozen)
 */

/**
 * @typedef {object} Part the part of a model a working graph shows (disclosure.js): the rest is folded away
 * @property {Int32Array} nodes  model node indices, ascending
 * @property {Int32Array} edges  model edge indices, ascending (both ends shown)
 * @property {string} key        names this part of this structure: a graph built for it is current while it's the same
 */

export class Graph {
  /**
   * @param {GraphModel | { id: string | number, label?: string, data?: object }[]} [nodes] a model, or nodes
   * @param {{ source: string | number, target: string | number, id?: string, data?: object }[] | null} [edges]
   * @param {Part | null} [part] with a model: show only this part of it (null: all of it)
   */
  constructor(nodes = [], edges = [], part = null) {
    /** @type {GraphModel} */
    this.model =
      nodes instanceof GraphModel
        ? nodes
        : GraphModel.from({ nodes, edges: edges ?? [] });
    const model = this.model;
    /** The part of the model shown, or null for all of it. */
    this.part = part;
    /**
     * What this graph was built for: the model's structure version, or (showing part of it) the part's key. A
     * graph is current while that's unchanged.
     * @type {number | string}
     */
    this.structure = part ? part.key : model.structureVersion;
    /** @type {Int32Array | null} per model node, its index here (-1: not shown); null when every node is */
    this.local = null;
    /** @type {Int32Array | null} per model edge, its index here (-1: not shown); null when every edge is */
    this.localEdges = null;
    let forest, ends, outgoing, incoming;
    if (!part) {
      forest = model.forest();
      ends = model.ends;
      outgoing = model.outgoing;
      incoming = model.incoming;
    } else {
      // The part's own structure: its nodes and edges renumbered from 0, read as a forest of their own (a node
      // whose first user is folded away hangs from another that's shown).
      const local = new Int32Array(model.size).fill(-1);
      part.nodes.forEach((mi, i) => (local[mi] = i));
      const localEdges = new Int32Array(model.edgeIndex.size).fill(-1);
      part.edges.forEach((me, i) => (localEdges[me] = i));
      const adj = model.adjacency();
      const source = Int32Array.from(part.edges, (me) => local[adj.source[me]]);
      const target = Int32Array.from(part.edges, (me) => local[adj.target[me]]);
      forest = forestOf(
        part.nodes.length,
        compressedRows(part.nodes.length, source, target),
      );
      ends = Array.from(source, (s, i) => [s, target[i]]);
      outgoing = Array.from(part.nodes, () => []);
      incoming = Array.from(part.nodes, () => []);
      for (let i = 0; i < source.length; i++) {
        outgoing[source[i]].push(i);
        incoming[target[i]].push(i);
      }
      this.local = local;
      this.localEdges = localEdges;
    }
    const records = model.nodes,
      edgeRecords = model.edges;
    const nodeAt = part ? (i) => records[part.nodes[i]] : (i) => records[i];
    const edgeAt = part
      ? (i) => edgeRecords[part.edges[i]]
      : (i) => edgeRecords[i];
    /** Every node's live state, one column per quantity. */
    this.matrix = new Matrix(part ? part.nodes.length : records.length);
    /** @type {Node[]} */
    this.nodes = Array.from(
      { length: this.matrix.count },
      (_, index) => new Node(nodeAt(index), index, this.matrix, forest),
    );
    /** @type {Map<string, Node>} */
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    /** @type {Edge[]} */
    this.edges = ends.map(([source, target], i) => {
      const e = edgeAt(i);
      return {
        id: e.id,
        source,
        target,
        tree: !!forest.tree[i],
        label: e.label,
        style: e.style,
        data: e.data,
      };
    });
    /** @type {ReadonlyArray<ReadonlyArray<number>>} per node, the indices of the edges out of it and into it */
    this.outgoing = outgoing;
    this.incoming = incoming;
    /** @type {number[]} roots of the forest, in the order they were found */
    this.roots = forest.roots;
    /** @type {number[]} every node, parents before children (breadth first per root) */
    this.order = forest.order;
    this.maxDepth = forest.maxDepth;
  }

  /** Model node `i`'s index in this graph, or -1 when it isn't shown. */
  indexOf(i) {
    return this.local ? this.local[i] : i < this.nodes.length ? i : -1;
  }

  /** Model edge `i`'s index in this graph, or -1 when it isn't shown. */
  edgeIndexOf(i) {
    return this.localEdges
      ? this.localEdges[i]
      : i < this.edges.length
        ? i
        : -1;
  }

  /** A per-model-node array (label widths, say) as one per node of this graph. */
  pick(values) {
    return this.part
      ? Float64Array.from(this.part.nodes, (i) => values[i])
      : values;
  }

  /**
   * Take the model's current records (labels, styles, data) after a change that kept the structure: same nodes and
   * edges in the same order, so rows and indices still line up.
   */
  refresh() {
    const { nodes, edges } = this.model;
    const { part } = this;
    for (let i = 0; i < this.nodes.length; i++)
      this.nodes[i].record = nodes[part ? part.nodes[i] : i];
    for (let i = 0; i < this.edges.length; i++) {
      const e = edges[part ? part.edges[i] : i];
      this.edges[i].label = e.label;
      this.edges[i].style = e.style;
      this.edges[i].data = e.data;
    }
  }

  /** The bounding box of the live positions, or of the homes. */
  bounds(homes = false) {
    if (!this.nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const m = this.matrix;
    const xs = homes ? m.homeX : m.x,
      ys = homes ? m.homeY : m.y;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < m.count; i++) {
      const x = xs[i],
        y = ys[i];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
}
