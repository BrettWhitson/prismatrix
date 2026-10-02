// The graph model: what a graph *is* and how it looks, separate from where anything is drawn.
//
// One GraphModel holds one graph for as long as it's shown. It's built once from JSON (the prismatrix-graph format,
// next/MODEL.md) and then changed in place: `update(delta)` adds, removes and changes nodes and edges, `replace(json)`
// takes a whole new version and works out what changed, `setOptions` changes how nodes and edges look. Unchanged
// nodes and edges keep their records, so a change costs what changed, not the size of the graph. Listeners
// (`onChange`) hear exactly what changed: the controller uses that to choose between restyling and laying out again.
//
// Records are frozen and `data` is the model's own copy, so nothing changes a model except its own methods. It also
// keeps what's costly to work out and rarely changes: adjacency, a spanning forest (for tree-shaped layouts), a DAG
// reading (for layered layouts), stats, and every label's measured width.
//
// Layout state (positions, velocities) is not here: a controller keeps that in its matrix (one model can be shown by
// several controllers at once), and a snapshot (snapshot.js) records it by id.

import { LINE } from "./boxes.js";
import { resolve } from "./schema.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "./style.js";

export const GRAPH_FORMAT = "prismatrix-graph";
export const GRAPH_VERSION = 1;

/** Node options that change how much room a node takes: changing one lays the graph out again. */
export const SIZE_KEYS = [
  "shape",
  "size",
  "sizeBy",
  "labels",
  "labelSize",
  "collisionRadius",
  "labelCollide",
];

/** Text width without a browser: about right for a sans-serif face. Renderers measure for real. */
export const roughMeasure = (text, size) => text.length * size * 0.56;

/**
 * @typedef {object} ModelNode
 * @property {string} id
 * @property {string} label    shown on the node; defaults to the id
 * @property {NodeStyle} style how this node looks, overriding the model's node options (see NODE_STYLE)
 * @property {object} data     anything else, untouched by the engine
 *
 * @typedef {object} NodeStyle
 * @property {string} [color]  "#rrggbb"
 * @property {number} [size]   diameter, world px
 * @property {string} [shape]  one of the node shapes (circle, square, rounded, diamond, hexagon, ring)
 *
 * @typedef {object} EdgeStyle
 * @property {string} [color]  "#rrggbb"
 * @property {number} [width]  world px
 *
 * @typedef {object} ModelEdge
 * @property {string} id       given, or "source>target" (with "#2", "#3"… for repeats)
 * @property {string} source   node id
 * @property {string} target   node id
 * @property {EdgeStyle} style how this edge looks, overriding the model's edge options (see EDGE_STYLE)
 * @property {object} data
 *
 * @typedef {object} Issue
 * @property {string} kind     "duplicate-node", "missing-node", "missing-endpoint", "self-loop", "duplicate-edge-id",
 *   "missing-edge", "bad-style" or "bad-input"
 * @property {string} message
 * @property {string} [id]
 *
 * @typedef {object} Delta
 * @property {object[]} [addNodes]     new nodes, as in the JSON format
 * @property {string[]} [removeNodes]  ids (their edges go too)
 * @property {object[]} [changeNodes]  `{ id, label?, style?, data? }`: the fields given replace the node's own
 * @property {object[]} [addEdges]     new edges, as in the JSON format
 * @property {string[]} [removeEdges]  ids
 * @property {object[]} [changeEdges]  `{ id, style?, data? }`
 *
 * @typedef {object} Change
 * @property {number} version      the model's version after the change
 * @property {boolean} structure   nodes or edges came, went or were reordered: lay out again
 * @property {boolean} sizes       something changed how much room a node takes (a shown label, a size, a shape)
 * @property {boolean} looks       anything that's drawn changed
 * @property {string[]} nodesAdded
 * @property {string[]} nodesRemoved
 * @property {string[]} nodesChanged
 * @property {string[]} edgesAdded
 * @property {string[]} edgesRemoved
 * @property {string[]} edgesChanged
 * @property {{ node: object, edge: object }} [options] for setOptions: the options that changed, with new values
 * @property {Issue[]} issues      problems in this change (left out, never fixed silently)
 *
 * @typedef {object} ModelOptions
 * @property {object} [node]    node appearance: NODE_OPTIONS (size, shape, colours, labels and their size…)
 * @property {object} [edge]    edge appearance: EDGE_OPTIONS
 * @property {(text: string, size: number) => number} [measure] a label's width at a font size; a renderer supplies a
 *   real one when a controller connects them (until then, an estimate)
 * @property {boolean} [strict] throw on the first problem instead of listing it in `issues`
 */

const EMPTY = Object.freeze({});

/** Deep-freeze plain objects and arrays. */
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : EMPTY;

const SHAPES = NODE_OPTIONS.find((o) => o.key === "shape").choices.map(
  (c) => c.value,
);
const colour = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const number = (lo, hi) => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** What a node's `style` may set, and what each value must be. */
export const NODE_STYLE = {
  color: colour,
  size: number(1, 400),
  shape: (v) => SHAPES.includes(v),
};
/** What an edge's `style` may set. */
export const EDGE_STYLE = {
  color: colour,
  width: number(0.1, 40),
};

/**
 * The valid part of a node's or edge's `style`, frozen; anything unknown or out of range is reported and left out,
 * so a bad style never breaks a graph.
 */
function checkStyle(raw, rules, what, problem) {
  const given = plain(raw);
  if (given === EMPTY) return EMPTY;
  const style = {};
  let any = false;
  for (const [key, value] of Object.entries(given)) {
    if (!rules[key])
      problem("bad-style", `${what}: unknown style "${key}" (ignored)`);
    else if (!rules[key](value))
      problem(
        "bad-style",
        `${what}: style ${key} ${JSON.stringify(value)} isn't valid (ignored)`,
      );
    else {
      style[key] = value;
      any = true;
    }
  }
  return any ? Object.freeze(style) : EMPTY;
}

/**
 * The model's own frozen copy of a node's or edge's data, so freezing it never touches the caller's objects. Flat
 * data (the usual: a price, a rarity) is a quick shallow copy; nested data is cloned.
 */
function copyData(value) {
  const data = plain(value);
  if (data === EMPTY) return EMPTY;
  let any = false,
    flat = true;
  for (const k in data) {
    any = true;
    const v = data[k];
    if (v !== null && typeof v === "object") {
      flat = false;
      break;
    }
  }
  if (!any) return EMPTY;
  if (flat) return Object.freeze({ ...data });
  try {
    return freeze(structuredClone(data));
  } catch {
    return Object.freeze({ ...data }); // something that can't be cloned (a function, say): a shallow copy
  }
}

/** Whether the caller's `raw` value holds the same as the model's frozen `copy` (a style, data). */
function same(raw, copy) {
  if (raw === copy) return true;
  const a = plain(raw);
  if (a === EMPTY) return Object.keys(copy).length === 0;
  let count = 0;
  for (const k in a) {
    count++;
    const v = a[k],
      w = copy[k];
    if (v === w) continue;
    if (
      v === null ||
      w === null ||
      typeof v !== "object" ||
      typeof w !== "object" ||
      Array.isArray(v) !== Array.isArray(w) ||
      !same(v, w)
    )
      return false;
  }
  return count === Object.keys(copy).length;
}

const labelOf = (id, raw) =>
  raw?.label === undefined ? id : String(raw.label);

/** A node as the caller gave it is the same as a model node: nothing to copy or check again. */
const sameNode = (raw, node) =>
  labelOf(node.id, raw) === node.label &&
  same(raw?.style, node.style) &&
  same(raw?.data, node.data);

const sameEdge = (raw, edge) =>
  same(raw?.style, edge.style) && same(raw?.data, edge.data);

function makeNode(id, raw, problem) {
  return Object.freeze({
    id,
    label: labelOf(id, raw),
    style: checkStyle(raw?.style, NODE_STYLE, `node "${id}"`, (k, m) =>
      problem(k, m, id),
    ),
    data: copyData(raw?.data),
  });
}

function makeEdge(id, source, target, raw, problem) {
  return Object.freeze({
    id,
    source,
    target,
    style: checkStyle(raw?.style, EDGE_STYLE, `edge "${id}"`, (k, m) =>
      problem(k, m, id),
    ),
    data: copyData(raw?.data),
  });
}

/** Whether an edge's ends are nodes in `has`, and not the same node; reports why not. */
function checkEnds(source, target, has, id, problem) {
  if (!has.has(source) || !has.has(target)) {
    problem(
      "missing-endpoint",
      `edge ${source} → ${target} names a node that isn't there (left out)`,
      id,
    );
    return false;
  }
  if (source === target) {
    problem(
      "self-loop",
      `edge ${source} → ${target} loops to itself (left out)`,
      id,
    );
    return false;
  }
  return true;
}

/** The keys whose values differ, with their new values. */
function changes(before, after) {
  const out = {};
  for (const k of Object.keys(after))
    if (before[k] !== after[k]) out[k] = after[k];
  return out;
}

const noChange = () => ({
  version: 0,
  structure: false,
  sizes: false,
  looks: false,
  nodesAdded: [],
  nodesRemoved: [],
  nodesChanged: [],
  edgesAdded: [],
  edgesRemoved: [],
  edgesChanged: [],
  issues: [],
});

export class GraphModel {
  /**
   * A model from JSON (the prismatrix-graph format, or plain `{ nodes, edges }`), or the model itself if given one.
   * @param {object | GraphModel} input
   * @param {ModelOptions} [options]
   */
  static from(input, options) {
    if (input instanceof GraphModel) return input;
    return new GraphModel(input, options);
  }

  /**
   * @param {object} [input] prismatrix-graph JSON, or plain `{ nodes, edges }`
   * @param {ModelOptions} [options]
   */
  constructor(input = {}, { node, edge, measure, strict = false } = {}) {
    this.strict = strict;
    /** How nodes and edges look: resolved NODE_OPTIONS and EDGE_OPTIONS. */
    this.opts = {
      node: resolve(NODE_OPTIONS, node),
      edge: resolve(EDGE_OPTIONS, edge),
    };
    this.measure = measure ?? roughMeasure;
    /** Whether `measure` is a real text measurement (given, or a renderer's), not the estimate. */
    this.measured = !!measure;
    this.meta = EMPTY;
    /** @type {ModelNode[]} */
    this.nodes = [];
    /** @type {ModelEdge[]} */
    this.edges = [];
    /** Bumped by every change. */
    this.version = 0;
    /** Bumped when nodes or edges come, go or move: what a working graph (graph.js) is built for. */
    this.structureVersion = 0;
    /** @type {Issue[]} problems found by the latest load or change */
    this.issues = [];
    this.listeners = new Set();
    this.widthCache = new Map(); // label text → width, at the current label size and measure
    this.widths = new Float64Array(0);
    this.widthsFor = null; // the node list `widths` was worked out for
    this.#index();
    this.replace(input);
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  get size() {
    return this.nodes.length;
  }

  node(id) {
    const i = this.index.get(String(id));
    return i === undefined ? undefined : this.nodes[i];
  }

  edge(id) {
    const i = this.edgeIndex.get(String(id));
    return i === undefined ? undefined : this.edges[i];
  }

  /** Each node's label width at the current label size (world px): every distinct label is measured once and kept. */
  labelWidths() {
    if (this.widthsFor !== this.nodes) {
      const size = this.opts.node.labelSize;
      const widths = new Float64Array(this.nodes.length);
      for (let i = 0; i < widths.length; i++) {
        const label = this.nodes[i].label;
        let w = this.widthCache.get(label);
        if (w === undefined) {
          w = this.measure(label, size);
          this.widthCache.set(label, w);
        }
        widths[i] = w;
      }
      this.widths = widths;
      this.widthsFor = this.nodes;
    }
    return this.widths;
  }

  /** A label's height (one line) at the current label size, world px. */
  get labelHeight() {
    return this.opts.node.labelSize * LINE;
  }

  /** Measure labels with `measure` from now on (a renderer's real text measurement, say). */
  setMeasure(measure) {
    if (!measure || measure === this.measure) return;
    this.measure = measure;
    this.measured = true;
    this.#forgetWidths();
  }

  #forgetWidths() {
    this.widthCache.clear();
    this.widthsFor = null;
  }

  /** Hear about every change: `listener(change, model)`. Returns a function that stops listening. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- changing --------------------------------------------------------------------------------------------------

  /**
   * Make the model hold `input` (JSON, plain `{ nodes, edges }`, or another model), in its order. Nodes and edges
   * that are the same as before keep their records: nothing is copied, checked or measured again.
   * @returns {Change | null} what changed; null when nothing did
   */
  replace(input) {
    const issues = [];
    const problem = this.#problem(issues);
    if (input instanceof GraphModel) input = input.toJSON();
    input ??= {};
    if (!Array.isArray(input.nodes ?? []) || !Array.isArray(input.edges ?? []))
      problem("bad-input", "nodes and edges must be arrays");

    const nodes = [];
    const seen = new Set();
    for (const raw of Array.isArray(input.nodes) ? input.nodes : []) {
      const id = String(raw?.id ?? "");
      if (seen.has(id)) {
        problem(
          "duplicate-node",
          `duplicate node id "${id}" (the first is kept)`,
          id,
        );
        continue;
      }
      seen.add(id);
      const old = this.node(id);
      nodes.push(old && sameNode(raw, old) ? old : makeNode(id, raw, problem));
    }

    const edges = [];
    const ids = new Set();
    const pairs = new Map();
    for (const raw of Array.isArray(input.edges) ? input.edges : []) {
      const source = String(raw?.source ?? ""),
        target = String(raw?.target ?? "");
      if (!checkEnds(source, target, seen, raw?.id, problem)) continue;
      const pair = `${source}>${target}`;
      const repeat = (pairs.get(pair) ?? 0) + 1;
      pairs.set(pair, repeat);
      let id =
        raw.id === undefined
          ? repeat > 1
            ? `${pair}#${repeat}`
            : pair
          : String(raw.id);
      if (ids.has(id)) {
        problem("duplicate-edge-id", `duplicate edge id "${id}" (renamed)`, id);
        id = `${id}#${edges.length}`;
      }
      ids.add(id);
      const old = this.edge(id);
      edges.push(
        old &&
          old.source === source &&
          old.target === target &&
          sameEdge(raw, old)
          ? old
          : makeEdge(id, source, target, raw, problem),
      );
    }
    const meta =
      input.meta === undefined || same(input.meta, this.meta)
        ? input.meta === undefined
          ? EMPTY
          : this.meta
        : freeze({ ...plain(input.meta) });
    return this.#commit(nodes, edges, issues, meta);
  }

  /**
   * Apply a delta: removals first (a removed node takes its edges with it), then changes, then additions (appended,
   * in the order given). Anything that doesn't fit (a change to a node that isn't there, an edge to a missing node)
   * is listed in the change's issues and skipped.
   * @param {Delta} delta
   * @returns {Change | null} what changed; null when nothing did
   */
  update({
    addNodes = [],
    removeNodes = [],
    changeNodes = [],
    addEdges = [],
    removeEdges = [],
    changeEdges = [],
  } = {}) {
    const issues = [];
    const problem = this.#problem(issues);
    let nodes = this.nodes,
      edges = this.edges;

    if (removeNodes.length || removeEdges.length) {
      const goneNodes = new Set(removeNodes.map(String));
      const goneEdges = new Set(removeEdges.map(String));
      for (const id of goneNodes)
        if (!this.index.has(id))
          problem("missing-node", `no node "${id}" to remove`, id);
      for (const id of goneEdges)
        if (!this.edgeIndex.has(id))
          problem("missing-edge", `no edge "${id}" to remove`, id);
      nodes = nodes.filter((n) => !goneNodes.has(n.id));
      edges = edges.filter(
        (e) =>
          !goneEdges.has(e.id) &&
          !goneNodes.has(e.source) &&
          !goneNodes.has(e.target),
      );
    }
    const at =
      nodes === this.nodes
        ? new Map(this.index)
        : new Map(nodes.map((n, i) => [n.id, i]));

    if (changeNodes.length) {
      if (nodes === this.nodes) nodes = nodes.slice();
      for (const c of changeNodes) {
        const id = String(c?.id ?? "");
        const i = at.get(id);
        if (i === undefined) {
          problem("missing-node", `no node "${id}" to change`, id);
          continue;
        }
        const old = nodes[i];
        const raw = {
          label: "label" in c ? c.label : old.label,
          style: "style" in c ? c.style : old.style,
          data: "data" in c ? c.data : old.data,
        };
        if (!sameNode(raw, old)) nodes[i] = makeNode(id, raw, problem);
      }
    }
    if (addNodes.length) {
      if (nodes === this.nodes) nodes = nodes.slice();
      for (const raw of addNodes) {
        const id = String(raw?.id ?? "");
        if (at.has(id)) {
          problem("duplicate-node", `node "${id}" is already there`, id);
          continue;
        }
        at.set(id, nodes.length);
        nodes.push(makeNode(id, raw, problem));
      }
    }

    const edgeAt =
      edges === this.edges
        ? new Map(this.edgeIndex)
        : new Map(edges.map((e, i) => [e.id, i]));
    if (changeEdges.length) {
      if (edges === this.edges) edges = edges.slice();
      for (const c of changeEdges) {
        const id = String(c?.id ?? "");
        const i = edgeAt.get(id);
        if (i === undefined) {
          problem("missing-edge", `no edge "${id}" to change`, id);
          continue;
        }
        const old = edges[i];
        const raw = {
          style: "style" in c ? c.style : old.style,
          data: "data" in c ? c.data : old.data,
        };
        if (!sameEdge(raw, old))
          edges[i] = makeEdge(id, old.source, old.target, raw, problem);
      }
    }
    if (addEdges.length) {
      if (edges === this.edges) edges = edges.slice();
      for (const raw of addEdges) {
        const source = String(raw?.source ?? ""),
          target = String(raw?.target ?? "");
        if (!checkEnds(source, target, at, raw?.id, problem)) continue;
        let id = raw.id === undefined ? `${source}>${target}` : String(raw.id);
        if (edgeAt.has(id)) {
          if (raw.id !== undefined)
            problem(
              "duplicate-edge-id",
              `duplicate edge id "${id}" (renamed)`,
              id,
            );
          let repeat = 2;
          while (edgeAt.has(`${id}#${repeat}`)) repeat++;
          id = `${id}#${repeat}`;
        }
        edgeAt.set(id, edges.length);
        edges.push(makeEdge(id, source, target, raw, problem));
      }
    }
    return this.#commit(nodes, edges, issues, this.meta);
  }

  /**
   * Change how nodes and edges look: `{ node, edge }`, each all of NODE_OPTIONS / EDGE_OPTIONS or the part to
   * change. A new label size measures labels again (each distinct one, once).
   * @returns {Change | null} what changed; null when nothing did
   */
  setOptions({ node, edge } = {}) {
    const before = this.opts;
    const next = {
      node: node
        ? resolve(NODE_OPTIONS, { ...before.node, ...node })
        : before.node,
      edge: edge
        ? resolve(EDGE_OPTIONS, { ...before.edge, ...edge })
        : before.edge,
    };
    const nodeChanged = changes(before.node, next.node),
      edgeChanged = changes(before.edge, next.edge);
    if (!Object.keys(nodeChanged).length && !Object.keys(edgeChanged).length)
      return null;
    this.opts = next;
    if ("labelSize" in nodeChanged) this.#forgetWidths();
    return this.#emit({
      ...noChange(),
      sizes: SIZE_KEYS.some((k) => k in nodeChanged),
      looks: true,
      options: { node: nodeChanged, edge: edgeChanged },
    });
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  #problem(issues) {
    return (kind, message, id) => {
      if (this.strict) throw new Error(`Prismatrix graph: ${message}`);
      issues.push({ kind, message, ...(id !== undefined && { id }) });
    };
  }

  /** Take new node and edge lists: work out what changed, re-index if the structure did, tell listeners. */
  #commit(nodes, edges, issues, meta) {
    const change = { ...noChange(), issues };
    const oldNodes = this.nodes,
      oldEdges = this.edges;
    let structure =
      nodes.length !== oldNodes.length || edges.length !== oldEdges.length;
    let kept = 0;
    nodes.forEach((n, i) => {
      const j = this.index.get(n.id);
      if (j === undefined) change.nodesAdded.push(n.id);
      else {
        kept++;
        if (j !== i) structure = true;
        if (oldNodes[j] !== n) change.nodesChanged.push(n.id);
      }
    });
    if (kept !== oldNodes.length) {
      const ids = new Set(nodes.map((n) => n.id));
      for (const n of oldNodes)
        if (!ids.has(n.id)) change.nodesRemoved.push(n.id);
    }
    kept = 0;
    edges.forEach((e, i) => {
      const j = this.edgeIndex.get(e.id);
      if (j === undefined) change.edgesAdded.push(e.id);
      else {
        kept++;
        const old = oldEdges[j];
        if (j !== i || old.source !== e.source || old.target !== e.target)
          structure = true;
        if (old !== e) change.edgesChanged.push(e.id);
      }
    });
    if (kept !== oldEdges.length) {
      const ids = new Set(edges.map((e) => e.id));
      for (const e of oldEdges)
        if (!ids.has(e.id)) change.edgesRemoved.push(e.id);
    }
    structure ||= change.nodesAdded.length > 0 || change.edgesAdded.length > 0;

    this.issues = issues;
    const metaChanged = meta !== this.meta;
    this.meta = meta;
    const anything =
      structure ||
      change.nodesChanged.length > 0 ||
      change.edgesChanged.length > 0 ||
      metaChanged;
    // The first load always counts as a change, even an empty one.
    if (!anything && this.version > 0) return null;

    // A node's room changes with its size or shape, and with its label when labels are shown.
    const labelled = this.opts.node.labels !== "off";
    change.sizes =
      structure ||
      change.nodesChanged.some((id) => {
        const before = oldNodes[this.index.get(id)],
          after = nodes[this.index.get(id)];
        return (
          (labelled && before.label !== after.label) ||
          before.style.size !== after.style.size ||
          before.style.shape !== after.style.shape
        );
      });
    change.structure = structure;
    change.looks = anything;
    this.nodes = Object.freeze(nodes);
    this.edges = Object.freeze(edges);
    if (structure) {
      this.structureVersion++;
      this.#index();
    }
    return this.#emit(change);
  }

  #emit(change) {
    change.version = ++this.version;
    for (const listener of this.listeners) listener(change, this);
    return change;
  }

  /** Lookups and adjacency for the current nodes and edges; cached views are dropped (they were for the old ones). */
  #index() {
    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.edgeIndex = new Map(this.edges.map((e, i) => [e.id, i]));
    const out = this.nodes.map(() => []),
      into = this.nodes.map(() => []);
    /** Each edge's ends as node indices. */
    this.ends = this.edges.map((e, i) => {
      const s = this.index.get(e.source),
        t = this.index.get(e.target);
      out[s].push(i);
      into[t].push(i);
      return [s, t];
    });
    /** Per node, the indices of the edges out of it and into it, in edge order. */
    this.outgoing = out;
    this.incoming = into;
    this.cache = new Map();
  }

  /** Computed once per structure and kept until it changes. */
  #cached(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }

  /**
   * The graph read as a forest: breadth-first from every node nothing points to (in node order), then from any
   * node still unreached (cycles); the first edge to reach a node is its tree edge, any other edge into it is a
   * cross-link.
   * @returns {{ roots: number[], order: number[], parent: Int32Array, depth: Int32Array, children: number[][],
   *   leaves: Int32Array, descendants: Int32Array, tree: Uint8Array, maxDepth: number }}
   */
  forest() {
    return this.#cached("forest", () => {
      const count = this.nodes.length;
      const parent = new Int32Array(count).fill(-1),
        depth = new Int32Array(count),
        leaves = new Int32Array(count).fill(1),
        descendants = new Int32Array(count),
        tree = new Uint8Array(this.edges.length);
      const children = Array.from({ length: count }, () => []);
      const roots = [],
        order = [];
      const seen = new Uint8Array(count);
      const grow = (root) => {
        seen[root] = 1;
        roots.push(root);
        const queue = [root];
        for (let head = 0; head < queue.length; head++) {
          const at = queue[head];
          order.push(at);
          for (const ei of this.outgoing[at]) {
            const target = this.ends[ei][1];
            if (seen[target]) continue;
            seen[target] = 1;
            tree[ei] = 1;
            parent[target] = at;
            depth[target] = depth[at] + 1;
            children[at].push(target);
            queue.push(target);
          }
        }
      };
      for (let i = 0; i < count; i++) if (!this.incoming[i].length) grow(i);
      for (let i = 0; i < count; i++) if (!seen[i]) grow(i);
      let maxDepth = 0;
      for (let k = order.length - 1; k >= 0; k--) {
        const v = order[k];
        if (children[v].length) {
          leaves[v] = 0;
          for (const c of children[v]) {
            leaves[v] += leaves[c];
            descendants[v] += descendants[c] + 1;
          }
        }
        maxDepth = Math.max(maxDepth, depth[v]);
      }
      return {
        roots,
        order,
        parent,
        depth,
        children,
        leaves,
        descendants,
        tree,
        maxDepth,
      };
    });
  }

  /**
   * The graph read as a DAG: edges that close a cycle (found depth-first from the forest's roots) are marked as
   * back edges, to be reversed for layout; with them reversed, a topological order and each node's longest path
   * from a source.
   * @returns {{ back: Uint8Array, order: number[], longest: Int32Array, sources: number[], sinks: number[] }}
   */
  dag() {
    return this.#cached("dag", () => {
      const count = this.nodes.length;
      const back = new Uint8Array(this.edges.length);
      const state = new Uint8Array(count); // 0 new, 1 on the stack, 2 done
      const visit = (start) => {
        const stack = [[start, 0]];
        state[start] = 1;
        while (stack.length) {
          const top = stack[stack.length - 1];
          const v = top[0];
          if (top[1] < this.outgoing[v].length) {
            const ei = this.outgoing[v][top[1]++];
            const w = this.ends[ei][1];
            if (state[w] === 1) back[ei] = 1;
            else if (!state[w]) {
              state[w] = 1;
              stack.push([w, 0]);
            }
          } else {
            state[v] = 2;
            stack.pop();
          }
        }
      };
      for (const r of this.forest().roots) if (!state[r]) visit(r);
      for (let v = 0; v < count; v++) if (!state[v]) visit(v);

      const from = (ei) => this.ends[ei][back[ei] ? 1 : 0],
        to = (ei) => this.ends[ei][back[ei] ? 0 : 1];
      const indegree = new Int32Array(count),
        down = Array.from({ length: count }, () => []);
      this.edges.forEach((_, ei) => {
        indegree[to(ei)]++;
        down[from(ei)].push(to(ei));
      });
      const sources = [];
      for (let v = 0; v < count; v++) if (!indegree[v]) sources.push(v);
      const order = sources.slice(),
        longest = new Int32Array(count);
      for (let head = 0; head < order.length; head++) {
        const v = order[head];
        for (const w of down[v]) {
          longest[w] = Math.max(longest[w], longest[v] + 1);
          if (--indegree[w] === 0) order.push(w);
        }
      }
      const sinks = [];
      for (let v = 0; v < count; v++) if (!down[v].length) sinks.push(v);
      return { back, order, longest, sources, sinks };
    });
  }

  /** Counts that describe the graph's shape, for telemetry and tests. */
  stats() {
    return { ...this.#shape(), issues: this.issues.length };
  }

  #shape() {
    return this.#cached("stats", () => {
      const f = this.forest(),
        d = this.dag();
      let crossLinks = 0;
      for (let i = 0; i < this.edges.length; i++) if (!f.tree[i]) crossLinks++;
      let maxIn = 0,
        maxOut = 0,
        shared = 0;
      for (let v = 0; v < this.nodes.length; v++) {
        maxIn = Math.max(maxIn, this.incoming[v].length);
        maxOut = Math.max(maxOut, this.outgoing[v].length);
        if (this.incoming[v].length > 1) shared++;
      }
      return Object.freeze({
        nodes: this.nodes.length,
        edges: this.edges.length,
        roots: f.roots.length,
        depth: f.maxDepth,
        layers: d.longest.reduce((m, l) => Math.max(m, l + 1), 0),
        crossLinks,
        sharedNodes: shared,
        maxInDegree: maxIn,
        maxOutDegree: maxOut,
        backEdges: d.back.reduce((a, b) => a + b, 0),
      });
    });
  }

  /**
   * What differs from `previous` (another model, or JSON) to this model, by id: nodes and edges added, removed,
   * kept, and kept nodes whose label, style or data differ.
   */
  diff(previous) {
    const before = GraphModel.from(previous);
    const nodesAdded = [],
      nodesKept = [],
      nodesChanged = [];
    for (const n of this.nodes) {
      const old = before.node(n.id);
      if (!old) nodesAdded.push(n.id);
      else {
        nodesKept.push(n.id);
        if (
          old.label !== n.label ||
          JSON.stringify(old.style) !== JSON.stringify(n.style) ||
          JSON.stringify(old.data) !== JSON.stringify(n.data)
        )
          nodesChanged.push(n.id);
      }
    }
    const nodesRemoved = before.nodes
      .filter((n) => !this.index.has(n.id))
      .map((n) => n.id);
    const edgesAdded = this.edges
      .filter((e) => !before.edgeIndex.has(e.id))
      .map((e) => e.id);
    const edgesRemoved = before.edges
      .filter((e) => !this.edgeIndex.has(e.id))
      .map((e) => e.id);
    return {
      nodesAdded,
      nodesRemoved,
      nodesKept,
      nodesChanged,
      edgesAdded,
      edgesRemoved,
    };
  }

  /** The model as prismatrix-graph JSON: GraphModel.from(model.toJSON()) gives an equal model. */
  toJSON() {
    return {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      ...(Object.keys(this.meta).length && { meta: this.meta }),
      nodes: this.nodes.map((n) => ({
        id: n.id,
        ...(n.label !== n.id && { label: n.label }),
        ...(Object.keys(n.style).length && { style: n.style }),
        ...(Object.keys(n.data).length && { data: n.data }),
      })),
      edges: this.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(Object.keys(e.style).length && { style: e.style }),
        ...(Object.keys(e.data).length && { data: e.data }),
      })),
    };
  }
}
