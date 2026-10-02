// The working graph: a GraphModel's structure, plus a matrix (matrix.js) of every node's live state.
//
// The model says what the graph is (ids, labels, data, edges). This adds what the engine works with: each node's
// place in the model's forest (parent, children, depth…), and its row of the matrix: position (x, y), velocity
// (vx, vy), where its layout wants it (homeX, homeY), and what the controller adds (labelAngle, radius, box).
//
// Each node is a view: `node.x` reads and writes `graph.matrix.x[node.index]`, so layouts and tests can work node by
// node while physics and renderers run down the matrix's columns. A working graph is built for one structure of
// its model; when nodes or edges come or go, the controller builds a new one and carries rows across by id.

import { GraphModel } from "./model.js";
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
 * @property {object} style  the model edge's style overrides (frozen)
 * @property {object} data   the model edge's data (frozen)
 */

export class Graph {
  /**
   * @param {GraphModel | { id: string | number, label?: string, data?: object }[]} [nodes] a model, or nodes
   * @param {{ source: string | number, target: string | number, id?: string, data?: object }[]} [edges]
   */
  constructor(nodes = [], edges = []) {
    /** @type {GraphModel} */
    this.model =
      nodes instanceof GraphModel ? nodes : GraphModel.from({ nodes, edges });
    const model = this.model;
    /** The model's structure version this graph was built for. */
    this.structure = model.structureVersion;
    const forest = model.forest();
    /** Every node's live state, one column per quantity. */
    this.matrix = new Matrix(model.nodes.length);
    /** @type {Node[]} */
    this.nodes = model.nodes.map(
      (record, index) => new Node(record, index, this.matrix, forest),
    );
    /** @type {Map<string, Node>} */
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    /** @type {Edge[]} */
    this.edges = model.edges.map((e, i) => ({
      id: e.id,
      source: model.ends[i][0],
      target: model.ends[i][1],
      tree: !!forest.tree[i],
      style: e.style,
      data: e.data,
    }));
    /** @type {ReadonlyArray<ReadonlyArray<number>>} per node, the indices of the edges out of it and into it */
    this.outgoing = model.outgoing;
    this.incoming = model.incoming;
    /** @type {number[]} roots of the forest, in the order they were found */
    this.roots = forest.roots;
    /** @type {number[]} every node, parents before children (breadth first per root) */
    this.order = forest.order;
    this.maxDepth = forest.maxDepth;
  }

  /**
   * Take the model's current records (labels, styles, data) after a change that kept the structure: same nodes and
   * edges in the same order, so rows and indices still line up.
   */
  refresh() {
    const { nodes, edges } = this.model;
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].record = nodes[i];
    for (let i = 0; i < this.edges.length; i++) {
      this.edges[i].style = edges[i].style;
      this.edges[i].data = edges[i].data;
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
