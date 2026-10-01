// The engine's working graph: one GraphModel (model.js) plus the layout state the engine moves around.
//
// The model says what the graph is (ids, labels, data, edges) and never changes. This working copy gives every
// node an object the layouts, physics and renderers share: its place in the model's forest (parent, children,
// depth…) and its live layout state: position (x, y), velocity (vx, vy), where its layout wants it (homeX, homeY),
// and what the view adds (labelAngle, radius, box). Layouts write homes; physics moves x/y; renderers read x/y.
// A snapshot (snapshot.js) records that state by id.

import { GraphModel } from "./model.js";

/**
 * @typedef {object} Node
 * @property {string} id
 * @property {string} label
 * @property {object} data      the model node's data (frozen)
 * @property {number} index     position in graph.nodes (the same as in the model)
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
 * @property {string} id     the model edge's id
 * @property {number} source index of the source node
 * @property {number} target index of the target node
 * @property {boolean} tree  true when this edge is the target's parent link in the forest
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
    const forest = model.forest();
    /** @type {Node[]} */
    this.nodes = model.nodes.map((m, index) => ({
      id: m.id,
      label: m.label,
      data: m.data,
      index,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      homeX: 0,
      homeY: 0,
      parent: forest.parent[index],
      children: forest.children[index].slice(),
      depth: forest.depth[index],
      leaves: forest.leaves[index],
      descendants: forest.descendants[index],
    }));
    /** @type {Map<string, Node>} */
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    /** @type {Edge[]} */
    this.edges = model.edges.map((e, i) => ({
      id: e.id,
      source: model.ends[i][0],
      target: model.ends[i][1],
      tree: !!forest.tree[i],
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
