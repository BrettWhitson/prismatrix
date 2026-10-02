// The graph model: what a graph *is* and how it looks, separate from where anything is drawn.
//
// One GraphModel holds one graph for as long as it's shown. It's built once from JSON (the prismatrix-graph format,
// next/MODEL.md) and then changed in place: `update(delta)` adds, removes and changes nodes and edges, `replace(json)`
// takes a whole new version and works out what changed, `setOptions` changes how nodes and edges look. Unchanged
// nodes and edges keep their records, and an update costs what it changes, not the size of the graph: the id maps
// are kept up to date in place, and everything worked out from the structure (adjacency, the forest, the DAG
// reading, stats) is worked out again only when it's next asked for. Listeners (`onChange`) hear exactly what
// changed: the controller uses that to choose between doing nothing (data), restyling and laying out again.
//
// Records are frozen and `data` is the model's own copy, so nothing changes a model except its own methods. It also
// keeps every label's measured width.
//
// Layout state (positions, velocities) is not here: a controller keeps that in its matrix (one model can be shown by
// several controllers at once), and a snapshot (snapshot.js) records it by id.

import { LINE } from "./boxes.js";
import { closest, resolve } from "./schema.js";
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
 * @property {string} kind     "duplicate-node", "missing-id", "missing-node", "missing-endpoint", "self-loop",
 *   "duplicate-edge-id", "bad-id", "missing-edge", "bad-style", "bad-option" or "bad-input"
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
 * @property {boolean} looks       anything that's drawn changed (false for a change of data only)
 * @property {boolean} dataOnly    only `data` (or the graph's `meta`) changed: nothing is drawn differently and
 *   nothing moves, so a view only needs the new records (no layout, no restyle)
 * @property {string[]} nodesAdded
 * @property {string[]} nodesRemoved
 * @property {string[]} nodesChanged  every kept node with a new record (label, style or data), in node order
 * @property {string[]} nodesRestyled the part of nodesChanged whose label or style changed (what's drawn)
 * @property {string[]} edgesAdded
 * @property {string[]} edgesRemoved
 * @property {string[]} edgesChanged  every kept edge with a new record (style or data), in edge order
 * @property {string[]} edgesRestyled the part of edgesChanged whose style changed
 * @property {{ node: object, edge: object }} [options] for setOptions: the options that changed, with new values
 * @property {Issue[]} issues      problems in this change (left out, never fixed silently)
 *
 * @typedef {object} ModelOptions
 * @property {object} [node]    node appearance: NODE_OPTIONS (size, shape, colours, labels and their size…)
 * @property {object} [edge]    edge appearance: EDGE_OPTIONS
 * @property {(text: string, size: number) => number} [measure] a label's width at a font size; a renderer supplies a
 *   real one when a controller connects them (until then, an estimate)
 * @property {boolean} [strict] throw on the first problem instead of listing it in `issues`
 * @property {(error: unknown, change: Change | null) => void} [onError] hears an error thrown by a listener (or by
 *   a queued change); without it, errors go to console.error. Never rethrown: the model stays committed.
 *
 * @typedef {object} Adjacency
 * The structure as flat arrays (compressed sparse rows), worked out once per structure.
 * @property {Int32Array} source    per edge, its source node's index
 * @property {Int32Array} target    per edge, its target node's index
 * @property {Int32Array} outStart  per node v, its outgoing edges are outEdges[outStart[v] .. outStart[v + 1]]
 * @property {Int32Array} outEdges  edge indices, grouped by source, in edge order
 * @property {Int32Array} inStart   per node v, its incoming edges are inEdges[inStart[v] .. inStart[v + 1]]
 * @property {Int32Array} inEdges   edge indices, grouped by target, in edge order
 */

const EMPTY = Object.freeze({});

/** Deep-freeze plain objects and arrays (typed arrays can't be frozen, and needn't be: they're the model's copy). */
function freeze(value) {
  if (
    value &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

const objectTag = (v) => Object.prototype.toString.call(v);

/** A plain object (a style, data, meta), or EMPTY for anything else: arrays, dates, maps and the like aren't one. */
const plain = (value) =>
  value && typeof value === "object" && objectTag(value) === "[object Object]"
    ? value
    : EMPTY;

const SHAPES = NODE_OPTIONS.find((o) => o.key === "shape").choices.map(
  (c) => c.value,
);
const colour = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const number = (lo, hi) => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * An icon: an image's URL, or an image already in hand (an HTMLImageElement, ImageBitmap, canvas: anything with a
 * width and a height that a canvas can draw). Only a URL survives toJSON.
 */
const icon = (v) =>
  typeof v === "string"
    ? v.length > 0
    : v !== null &&
      typeof v === "object" &&
      typeof v.width === "number" &&
      typeof v.height === "number";

/** What a node's `style` may set, and what each value must be. */
export const NODE_STYLE = {
  color: colour,
  size: number(1, 400),
  shape: (v) => SHAPES.includes(v),
  stroke: colour,
  strokeWidth: number(0, 100),
  icon,
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
    // Own keys only: "constructor" or "__proto__" aren't style rules.
    if (!Object.hasOwn(rules, key)) {
      const near = closest(key, Object.keys(rules));
      problem(
        "bad-style",
        `${what}: unknown style "${key}" (ignored${near ? `; did you mean "${near}"?` : ""})`,
      );
    } else if (!rules[key](value))
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
 * The model's own frozen copy of a node's or edge's data (or the graph's meta), so freezing it never touches the
 * caller's objects. Flat data (the usual: a price, a rarity) is a quick shallow copy; nested data is cloned.
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

/** Whether the caller's `raw` style or data holds the same as the model's frozen `copy` (only plain objects count). */
function same(raw, copy) {
  if (raw === copy) return true;
  const a = plain(raw);
  if (a === EMPTY) return Object.keys(copy).length === 0;
  return equal(a, copy);
}

/**
 * Deep equality by value, as structuredClone sees values: NaN equals NaN, dates by time, regular expressions by
 * source and flags, arrays and typed arrays element by element, maps and sets by their entries, objects by their own
 * keys. Cycles are followed once.
 * @param {unknown} a
 * @param {unknown} b
 * @param {Map<object, object>} [seen] pairs already being compared (for cycles)
 */
export function equal(a, b, seen) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number") return a !== a && b !== b; // both NaN
  if (typeof a !== "object" || a === null || b === null) return false;
  const tag = objectTag(a);
  if (tag !== objectTag(b)) return false;
  if (seen?.get(a) === b) return true;
  (seen ??= new Map()).set(a, b);
  if (ArrayBuffer.isView(a)) {
    if (a.constructor !== b.constructor || a.byteLength !== b.byteLength)
      return false;
    if (a instanceof DataView) return sameBytes(a, b);
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
    return true;
  }
  switch (tag) {
    case "[object Date]":
      return equal(a.getTime(), b.getTime());
    case "[object RegExp]":
      return a.source === b.source && a.flags === b.flags;
    case "[object Number]":
    case "[object String]":
    case "[object Boolean]":
    case "[object BigInt]":
      return equal(a.valueOf(), b.valueOf());
    case "[object Error]":
      return a.name === b.name && a.message === b.message;
    case "[object ArrayBuffer]":
      return a.byteLength === b.byteLength && sameBytes(a, b);
    case "[object Array]":
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++)
        if (!equal(a[i], b[i], seen)) return false;
      return true;
    case "[object Map]":
      if (a.size !== b.size) return false;
      for (const [k, v] of a)
        if (!b.has(k) || !equal(v, b.get(k), seen)) return false;
      return true;
    case "[object Set]": {
      if (a.size !== b.size) return false;
      let loose = null; // b's object members not matched by identity, for a deep match
      for (const v of a) {
        if (b.has(v)) continue;
        if (v === null || typeof v !== "object") return false;
        loose ??= [...b].filter((w) => w !== null && typeof w === "object");
        const at = loose.findIndex((w) => equal(v, w, seen));
        if (at < 0) return false;
        loose.splice(at, 1);
      }
      return true;
    }
  }
  // Anything else the platform makes (an image, a canvas, a bitmap) is only the same as itself.
  if (tag !== "[object Object]" && tag !== "[object Arguments]") return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys)
    if (!Object.hasOwn(b, k) || !equal(a[k], b[k], seen)) return false;
  return true;
}

function sameBytes(a, b) {
  const x = ArrayBuffer.isView(a)
      ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      : new Uint8Array(a),
    y = ArrayBuffer.isView(b)
      ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
      : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** An id as the model keeps it: a non-empty string, or a number written as one. Anything else is no id. */
function idOf(value) {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return undefined;
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

/** A node's id from its JSON, or undefined (reported: the node is left out) when it has none that can be used. */
function nodeIdOf(raw, problem) {
  const id = idOf(raw?.id);
  if (id === undefined)
    problem(
      "missing-id",
      raw?.id === undefined || raw?.id === null || raw?.id === ""
        ? "a node has no id (left out)"
        : `a node's id ${JSON.stringify(raw.id) ?? String(raw.id)} isn't a string or a number (left out)`,
    );
  return id;
}

/** An edge's own id from its JSON: undefined when it has none (one is made); a bad one is reported and replaced. */
function edgeIdOf(raw, problem) {
  const given = raw?.id;
  if (given === undefined || given === null) return undefined;
  const id = idOf(given);
  if (id === undefined)
    problem(
      "bad-id",
      `an edge's id ${JSON.stringify(given) ?? String(given)} isn't a non-empty string or a number (one was made)`,
    );
  return id;
}

/** Whether an edge's ends are nodes (`has(id)`), and not the same node; reports why not. */
function checkEnds(source, target, has, id, problem) {
  if (
    source === undefined ||
    target === undefined ||
    !has(source) ||
    !has(target)
  ) {
    problem(
      "missing-endpoint",
      `edge ${source ?? "(none)"} → ${target ?? "(none)"} names a node that isn't there (left out)`,
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
  dataOnly: false,
  nodesAdded: [],
  nodesRemoved: [],
  nodesChanged: [],
  nodesRestyled: [],
  edgesAdded: [],
  edgesRemoved: [],
  edgesChanged: [],
  edgesRestyled: [],
  issues: [],
});

const DELTA_KEYS = [
  "addNodes",
  "removeNodes",
  "changeNodes",
  "addEdges",
  "removeEdges",
  "changeEdges",
];

/**
 * A delta's fields as arrays. A single item is taken as a list of one (an id for the remove fields, an object for
 * the others) and any other iterable as its items; anything else, and unknown fields, are reported and ignored.
 */
function readDelta(delta, problem) {
  const out = {};
  for (const key of DELTA_KEYS) out[key] = [];
  if (delta === undefined || delta === null) return out;
  if (typeof delta !== "object" || Array.isArray(delta)) {
    problem(
      "bad-input",
      "a delta is an object: { addNodes, removeNodes, changeNodes, addEdges, removeEdges, changeEdges } (ignored)",
    );
    return out;
  }
  for (const key of Object.keys(delta)) {
    if (!DELTA_KEYS.includes(key)) {
      const near = closest(key, DELTA_KEYS);
      problem(
        "bad-input",
        `unknown delta field "${key}" (ignored${near ? `; did you mean "${near}"?` : ""})`,
      );
      continue;
    }
    const value = delta[key];
    const ids = key.startsWith("remove");
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) out[key] = value;
    else if (
      ids
        ? idOf(value) !== undefined
        : typeof value === "object" && plain(value) === value
    )
      out[key] = [value];
    else if (
      typeof value === "object" &&
      typeof value[Symbol.iterator] === "function"
    )
      out[key] = Array.from(value);
    else
      problem(
        "bad-input",
        `delta field "${key}" should be a list of ${ids ? "ids" : "objects"} (ignored)`,
      );
  }
  return out;
}

/** Ascending numeric sort, for small lists of indices. */
const ascending = (a, b) => a - b;

export class GraphModel {
  /** Listener calls in progress (a change being told): changes asked for meanwhile wait in the queue. */
  #telling = false;
  /** Changes asked for while listeners were being told, applied in order once they've all heard. */
  #queue = [];
  /** Structure worked out from the edges, for the current structure: null until asked for. */
  #adj = null;
  /** Edge ends as node indices, kept across appends: valid for edges [0, #endsValid). */
  #source = new Int32Array(0);
  #target = new Int32Array(0);
  #endsValid = 0;
  /** The array-of-arrays views (ends, outgoing, incoming), built from #adj when first read. */
  #views = null;
  /** Node indices whose label width must be measured again, or null when every width must be (see labelWidths). */
  #widthsDirty = null;
  /** The nodes and edges, in order: the model's own working lists, changed in place. */
  #nodeList = [];
  #edgeList = [];
  /** Frozen copies of them handed out as `nodes` and `edges`, made when first read after a change. */
  #nodesView = null;
  #edgesView = null;
  /** Bumped whenever the node list changes (records or structure); `widths` is for #widthsAt. */
  #nodesStamp = 0;
  #widthsAt = -1;
  /** Option messages already listed as issues: each once per model. */
  #optionWarned = new Set();
  /** Option issues from the constructor, listed with the first load's. */
  #startIssues = [];

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
  constructor(
    input = {},
    { node, edge, measure, strict = false, onError } = {},
  ) {
    this.strict = strict;
    /** Hears errors thrown by listeners (see ModelOptions.onError); console.error when unset. */
    this.onError = onError ?? null;
    const warn = this.#optionWarning(this.#startIssues);
    /** How nodes and edges look: resolved NODE_OPTIONS and EDGE_OPTIONS. */
    this.opts = {
      node: resolve(NODE_OPTIONS, plain(node), warn),
      edge: resolve(EDGE_OPTIONS, plain(edge), warn),
    };
    this.measure = measure ?? roughMeasure;
    /** Whether `measure` is a real text measurement (given, or a renderer's), not the estimate. */
    this.measured = !!measure;
    this.meta = EMPTY;
    /** @type {Map<string, number>} node id → index, kept up to date in place */
    this.index = new Map();
    /** @type {Map<string, number>} edge id → index, kept up to date in place */
    this.edgeIndex = new Map();
    /** Bumped by every change. */
    this.version = 0;
    /** Bumped when nodes or edges come, go or move: what a working graph (graph.js) is built for. */
    this.structureVersion = 0;
    /** @type {Issue[]} problems found by the latest load or change */
    this.issues = [];
    this.listeners = new Set();
    this.cache = new Map(); // views computed once per structure (forest, dag, stats)
    this.widthCache = new Map(); // label text → width, at the current label size and measure
    this.widths = new Float64Array(0); // each node's label width, when last asked for (see labelWidths)
    this.replace(input);
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  /**
   * The nodes, in order (a node's index is its position), frozen: a list read once stays as it was, whatever
   * changes later. A new one is made when first read after a change.
   * @type {ReadonlyArray<ModelNode>}
   */
  get nodes() {
    return (this.#nodesView ??= Object.freeze(this.#nodeList.slice()));
  }

  /**
   * The edges, in order, frozen (see `nodes`).
   * @type {ReadonlyArray<ModelEdge>}
   */
  get edges() {
    return (this.#edgesView ??= Object.freeze(this.#edgeList.slice()));
  }

  get size() {
    return this.#nodeList.length;
  }

  node(id) {
    const i = this.index.get(String(id));
    return i === undefined ? undefined : this.#nodeList[i];
  }

  edge(id) {
    const i = this.edgeIndex.get(String(id));
    return i === undefined ? undefined : this.#edgeList[i];
  }

  /**
   * The structure as flat typed arrays (compressed sparse rows): each edge's ends as node indices, and each node's
   * outgoing and incoming edges. Worked out the first time it's asked for after nodes or edges come or go, then
   * kept. The arrays are the model's: read them, don't write them.
   * @returns {Adjacency}
   */
  adjacency() {
    if (this.#adj) return this.#adj;
    const n = this.#nodeList.length,
      m = this.#edgeList.length;
    // Edge ends: kept across appends (an appended edge or node moves nobody), worked out for the rest. New arrays
    // each time: the old ones may still be in use by whoever read the old structure.
    const valid = Math.min(this.#endsValid, m);
    const source = new Int32Array(m),
      target = new Int32Array(m);
    source.set(this.#source.subarray(0, valid));
    target.set(this.#target.subarray(0, valid));
    for (let i = valid; i < m; i++) {
      const e = this.#edgeList[i];
      source[i] = this.index.get(e.source);
      target[i] = this.index.get(e.target);
    }
    this.#source = source;
    this.#target = target;
    this.#endsValid = m;
    // Counting sort by source and by target: each node's edges stay in edge order.
    const outStart = new Int32Array(n + 1),
      inStart = new Int32Array(n + 1);
    for (let i = 0; i < m; i++) {
      outStart[source[i] + 1]++;
      inStart[target[i] + 1]++;
    }
    for (let v = 0; v < n; v++) {
      outStart[v + 1] += outStart[v];
      inStart[v + 1] += inStart[v];
    }
    const outEdges = new Int32Array(m),
      inEdges = new Int32Array(m);
    const outAt = outStart.slice(0, n),
      inAt = inStart.slice(0, n);
    for (let i = 0; i < m; i++) {
      outEdges[outAt[source[i]]++] = i;
      inEdges[inAt[target[i]]++] = i;
    }
    this.#adj = Object.freeze({
      source,
      target,
      outStart,
      outEdges,
      inStart,
      inEdges,
    });
    return this.#adj;
  }

  /** The same structure as arrays of arrays (what working graphs and layouts read), built when first read. */
  #arrays() {
    if (this.#views) return this.#views;
    const { source, target } = this.adjacency();
    const n = this.#nodeList.length,
      m = this.#edgeList.length;
    const ends = new Array(m),
      outgoing = new Array(n),
      incoming = new Array(n);
    for (let v = 0; v < n; v++) {
      outgoing[v] = [];
      incoming[v] = [];
    }
    for (let i = 0; i < m; i++) {
      ends[i] = [source[i], target[i]];
      outgoing[source[i]].push(i);
      incoming[target[i]].push(i);
    }
    this.#views = { ends, outgoing, incoming };
    return this.#views;
  }

  /** Per edge index, `[source index, target index]`. */
  get ends() {
    return this.#arrays().ends;
  }

  /** Per node index, the indices of the edges out of it, in edge order. */
  get outgoing() {
    return this.#arrays().outgoing;
  }

  /** Per node index, the indices of the edges into it, in edge order. */
  get incoming() {
    return this.#arrays().incoming;
  }

  /** Each node's label width at the current label size (world px): every distinct label is measured once and kept. */
  labelWidths() {
    if (this.#widthsAt === this.#nodesStamp) return this.widths;
    const size = this.opts.node.labelSize;
    const width = (label) => {
      let w = this.widthCache.get(label);
      if (w === undefined) {
        w = this.measure(label, size);
        this.widthCache.set(label, w);
      }
      return w;
    };
    const count = this.#nodeList.length;
    const widths = new Float64Array(count);
    const dirty = this.#widthsDirty;
    // A copy (the old array may be in a layout job's hands), with only the labels that changed measured again.
    if (dirty && this.#widthsAt >= 0) {
      widths.set(this.widths.subarray(0, Math.min(count, this.widths.length)));
      for (const i of dirty)
        if (i < count) widths[i] = width(this.#nodeList[i].label);
    } else
      for (let i = 0; i < count; i++)
        widths[i] = width(this.#nodeList[i].label);
    this.widths = widths;
    this.#widthsAt = this.#nodesStamp;
    this.#widthsDirty = new Set();
    return widths;
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
    this.#widthsAt = -1;
    this.#widthsDirty = null;
  }

  /**
   * Hear about every change: `listener(change, model)`. Returns a function that stops listening.
   *
   * Every listener hears every change, in order, and each with the model as that change left it: one that throws
   * doesn't stop the others (the error goes to `onError`, or the console). A change asked for from inside a
   * listener (an `update` in reply to another) waits until every listener has heard the current one, then is
   * applied and told in its turn; the call itself returns null.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- changing --------------------------------------------------------------------------------------------------

  /**
   * Make the model hold `input` (JSON, plain `{ nodes, edges }`, or another model), in its order. Nodes and edges
   * that are the same as before keep their records: nothing is copied, checked or measured again.
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  replace(input) {
    return this.#mutate(() => this.#replace(input));
  }

  /**
   * Apply a delta: removals first (a removed node takes its edges with it), then changes, then additions (appended,
   * in the order given). Anything that doesn't fit (a change to a node that isn't there, an edge to a missing node)
   * is listed in the change's issues and skipped. Costs what it changes: a change of data or style touches only
   * those records; additions are appended; only a removal renumbers the nodes or edges after it.
   * @param {Delta} delta
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  update(delta) {
    return this.#mutate(() => this.#update(delta));
  }

  /**
   * Change how nodes and edges look: `{ node, edge }`, each all of NODE_OPTIONS / EDGE_OPTIONS or the part to
   * change. Numbers out of range are clamped; unknown keys and bad values are listed in the issues. A new label size
   * measures labels again (each distinct one, once).
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  setOptions(options) {
    return this.#mutate(() => this.#setOptions(options));
  }

  // ---- internals: telling listeners ------------------------------------------------------------------------------

  /** Run a change now, or queue it if listeners are hearing about another; then tell listeners (and the queue). */
  #mutate(apply) {
    if (this.#telling) {
      this.#queue.push(apply);
      return null;
    }
    const change = apply();
    if (change) this.#tellAll(change);
    return change;
  }

  #tellAll(change) {
    this.#telling = true;
    try {
      this.#tell(change);
      while (this.#queue.length) {
        const apply = this.#queue.shift();
        let next = null;
        try {
          next = apply();
        } catch (error) {
          this.#report(error, null); // a strict model's problem in a queued change: that change is skipped
        }
        if (next) this.#tell(next);
      }
    } finally {
      this.#telling = false;
    }
  }

  /** Every listener hears `change`: those listening when it was made, and still listening when their turn comes. */
  #tell(change) {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(change, this);
      } catch (error) {
        this.#report(error, change);
      }
    }
  }

  #report(error, change) {
    if (this.onError)
      try {
        this.onError(error, change);
        return;
      } catch (inner) {
        error = inner;
      }
    console.error("Prismatrix: a model listener failed", error);
  }

  // ---- internals: changes ----------------------------------------------------------------------------------------

  #problem(issues) {
    return (kind, message, id) => {
      if (this.strict) throw new Error(`Prismatrix graph: ${message}`);
      issues.push({ kind, message, ...(id !== undefined && { id }) });
    };
  }

  /** A warning callback for resolve(): each message becomes a "bad-option" issue, once per model. */
  #optionWarning(issues) {
    const problem = this.#problem(issues);
    return (message) => {
      if (this.#optionWarned.has(message)) return;
      this.#optionWarned.add(message);
      problem("bad-option", message);
    };
  }

  #replace(input) {
    const issues = this.#startIssues.splice(0);
    const problem = this.#problem(issues);
    if (input instanceof GraphModel) input = input.toJSON();
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object") {
      problem("bad-input", "a graph is an object: { nodes, edges }");
      input = {};
    }
    if (!Array.isArray(input.nodes ?? []) || !Array.isArray(input.edges ?? []))
      problem("bad-input", "nodes and edges must be arrays");

    const nodes = [];
    const seen = new Set();
    for (const raw of Array.isArray(input.nodes) ? input.nodes : []) {
      const id = nodeIdOf(raw, problem);
      if (id === undefined) continue;
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
    const has = (id) => seen.has(id);
    for (const raw of Array.isArray(input.edges) ? input.edges : []) {
      const source = idOf(raw?.source),
        target = idOf(raw?.target);
      const given = edgeIdOf(raw, problem);
      if (!checkEnds(source, target, has, given, problem)) continue;
      const pair = `${source}>${target}`;
      const repeat = (pairs.get(pair) ?? 0) + 1;
      pairs.set(pair, repeat);
      let id = given ?? (repeat > 1 ? `${pair}#${repeat}` : pair);
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
      input.meta === undefined
        ? EMPTY
        : same(input.meta, this.meta)
          ? this.meta
          : copyData(input.meta);
    return this.#commit(nodes, edges, issues, meta);
  }

  /** Take whole new node and edge lists (replace): work out what changed by id, re-index if the structure did. */
  #commit(nodes, edges, issues, meta) {
    const change = { ...noChange(), issues };
    const oldNodes = this.#nodeList,
      oldEdges = this.#edgeList;
    let structure =
      nodes.length !== oldNodes.length || edges.length !== oldEdges.length;
    let kept = 0;
    const changedAt = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const j = this.index.get(n.id);
      if (j === undefined) change.nodesAdded.push(n.id);
      else {
        kept++;
        if (j !== i) structure = true;
        if (oldNodes[j] !== n) changedAt.push([oldNodes[j], n, i]);
      }
    }
    if (kept !== oldNodes.length) {
      const ids = new Set(nodes.map((n) => n.id));
      for (const n of oldNodes)
        if (!ids.has(n.id)) change.nodesRemoved.push(n.id);
    }
    kept = 0;
    const edgeChangedAt = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const j = this.edgeIndex.get(e.id);
      if (j === undefined) change.edgesAdded.push(e.id);
      else {
        kept++;
        const old = oldEdges[j];
        if (j !== i || old.source !== e.source || old.target !== e.target)
          structure = true;
        if (old !== e) edgeChangedAt.push([old, e]);
      }
    }
    if (kept !== oldEdges.length) {
      const ids = new Set(edges.map((e) => e.id));
      for (const e of oldEdges)
        if (!ids.has(e.id)) change.edgesRemoved.push(e.id);
    }
    structure ||= change.nodesAdded.length > 0 || change.edgesAdded.length > 0;

    this.issues = issues;
    const metaChanged = meta !== this.meta;
    const anything =
      structure ||
      changedAt.length > 0 ||
      edgeChangedAt.length > 0 ||
      metaChanged;
    // The first load always counts as a change, even an empty one.
    if (!anything && this.version > 0) return null;

    this.meta = meta;
    this.#describe(change, changedAt, edgeChangedAt, structure, metaChanged);
    this.#nodeList = nodes;
    this.#edgeList = edges;
    this.#listsChanged(
      changedAt.length > 0 || structure,
      edgeChangedAt.length > 0 || structure,
    );
    if (structure) {
      this.index = new Map();
      for (let i = 0; i < nodes.length; i++) this.index.set(nodes[i].id, i);
      this.edgeIndex = new Map();
      for (let i = 0; i < edges.length; i++) this.edgeIndex.set(edges[i].id, i);
      this.#endsValid = 0;
      this.#newStructure(true);
    } else this.#relabel(changedAt);
    change.version = ++this.version;
    return change;
  }

  /**
   * Fill a change's flags and changed lists from the records that changed (`[before, after, index]` for nodes,
   * `[before, after]` for edges, in order). A change of data (or meta) alone is `dataOnly`: nothing drawn changed.
   */
  #describe(change, nodePairs, edgePairs, structure, metaChanged = false) {
    const labelled = this.opts.node.labels !== "off";
    let sizes = structure,
      drawn = structure;
    for (const [before, after] of nodePairs) {
      change.nodesChanged.push(after.id);
      const label = before.label !== after.label;
      const style = !same(after.style, before.style);
      if (label || style) {
        change.nodesRestyled.push(after.id);
        drawn = true;
      }
      sizes ||=
        (labelled && label) ||
        before.style.size !== after.style.size ||
        before.style.shape !== after.style.shape;
    }
    for (const [before, after] of edgePairs) {
      change.edgesChanged.push(after.id);
      if (!same(after.style, before.style)) {
        change.edgesRestyled.push(after.id);
        drawn = true;
      }
    }
    change.structure = structure;
    change.sizes = sizes;
    change.looks = drawn;
    change.dataOnly =
      !drawn && (nodePairs.length > 0 || edgePairs.length > 0 || metaChanged);
  }

  /** The node or edge lists changed: the frozen copies handed out are for the old ones. */
  #listsChanged(nodes, edges) {
    if (nodes) {
      this.#nodesView = null;
      this.#nodesStamp++;
    }
    if (edges) this.#edgesView = null;
  }

  /** Nodes or edges came, went or moved: what was worked out from the old structure is dropped. */
  #newStructure(renumbered) {
    this.structureVersion++;
    this.#adj = null;
    this.#views = null;
    this.cache = new Map();
    if (renumbered) this.#widthsDirty = null;
  }

  /** Labels changed in place (same nodes, same order): only those need measuring again. */
  #relabel(nodePairs) {
    if (!this.#widthsDirty) return;
    for (const [before, after, i] of nodePairs)
      if (before.label !== after.label) this.#widthsDirty.add(i);
  }

  #update(delta) {
    const issues = [];
    const problem = this.#problem(issues);
    const d = readDelta(delta, problem);
    const oldNodes = this.#nodeList,
      oldEdges = this.#edgeList;

    // Everything is worked out first, without touching the model: a strict model's throw leaves it as it was.

    // Removals: nodes, then the edges named and the edges of removed nodes.
    const goneNodes = new Set();
    for (const raw of d.removeNodes) {
      const id = idOf(raw);
      if (id === undefined || !this.index.has(id))
        problem("missing-node", `no node "${String(raw)}" to remove`, id);
      else goneNodes.add(id);
    }
    let edgeGone = null; // per old edge, 1 when it goes
    const goneEdgeAt = [];
    const dropEdge = (i) => {
      edgeGone ??= new Uint8Array(oldEdges.length);
      if (edgeGone[i]) return;
      edgeGone[i] = 1;
      goneEdgeAt.push(i);
    };
    for (const raw of d.removeEdges) {
      const id = idOf(raw);
      const i = id === undefined ? undefined : this.edgeIndex.get(id);
      if (i === undefined)
        problem("missing-edge", `no edge "${String(raw)}" to remove`, id);
      else dropEdge(i);
    }
    const goneNodeAt = [];
    if (goneNodes.size) {
      for (const id of goneNodes) goneNodeAt.push(this.index.get(id));
      goneNodeAt.sort(ascending);
      const adj = this.#adj;
      if (adj)
        for (const v of goneNodeAt) {
          for (let k = adj.outStart[v]; k < adj.outStart[v + 1]; k++)
            dropEdge(adj.outEdges[k]);
          for (let k = adj.inStart[v]; k < adj.inStart[v + 1]; k++)
            dropEdge(adj.inEdges[k]);
        }
      else
        for (let i = 0; i < oldEdges.length; i++) {
          const e = oldEdges[i];
          if (goneNodes.has(e.source) || goneNodes.has(e.target)) dropEdge(i);
        }
    }
    goneEdgeAt.sort(ascending);
    const addedNodes = new Map(); // id → record
    const nodeThere = (id) =>
      (this.index.has(id) && !goneNodes.has(id)) || addedNodes.has(id);

    // Changes to nodes that stay: the latest record per id.
    const changedNodes = new Map(); // id → new record
    for (const c of d.changeNodes) {
      const id = idOf(c?.id);
      if (id === undefined || !this.index.has(id) || goneNodes.has(id)) {
        problem("missing-node", `no node "${String(c?.id)}" to change`, id);
        continue;
      }
      const old = changedNodes.get(id) ?? oldNodes[this.index.get(id)];
      const raw = {
        label: "label" in c ? c.label : old.label,
        style: "style" in c ? c.style : old.style,
        data: "data" in c ? c.data : old.data,
      };
      if (sameNode(raw, old)) continue;
      const original = oldNodes[this.index.get(id)];
      const made = makeNode(id, raw, problem);
      if (sameNode(made, original)) changedNodes.delete(id);
      else changedNodes.set(id, made);
    }

    // Added nodes, appended in the order given.
    for (const raw of d.addNodes) {
      const id = nodeIdOf(raw, problem);
      if (id === undefined) continue;
      if (nodeThere(id)) {
        problem("duplicate-node", `node "${id}" is already there`, id);
        continue;
      }
      addedNodes.set(id, makeNode(id, raw, problem));
    }

    // Changes to edges that stay.
    const changedEdges = new Map(); // index → new record
    for (const c of d.changeEdges) {
      const id = idOf(c?.id);
      const i = id === undefined ? undefined : this.edgeIndex.get(id);
      if (i === undefined || edgeGone?.[i]) {
        problem("missing-edge", `no edge "${String(c?.id)}" to change`, id);
        continue;
      }
      const old = changedEdges.get(i) ?? oldEdges[i];
      const raw = {
        style: "style" in c ? c.style : old.style,
        data: "data" in c ? c.data : old.data,
      };
      if (sameEdge(raw, old)) continue;
      const made = makeEdge(id, old.source, old.target, raw, problem);
      if (sameEdge(made, oldEdges[i])) changedEdges.delete(i);
      else changedEdges.set(i, made);
    }

    // Added edges, appended; an id is made for those without one ("source>target", then "#2", "#3"…).
    const addedEdges = new Map(); // id → record
    const edgeThere = (id) => {
      const i = this.edgeIndex.get(id);
      return (i !== undefined && !edgeGone?.[i]) || addedEdges.has(id);
    };
    for (const raw of d.addEdges) {
      const source = idOf(raw?.source),
        target = idOf(raw?.target);
      const given = edgeIdOf(raw, problem);
      if (!checkEnds(source, target, nodeThere, given, problem)) continue;
      let id = given ?? `${source}>${target}`;
      if (edgeThere(id)) {
        if (given !== undefined)
          problem(
            "duplicate-edge-id",
            `duplicate edge id "${id}" (renamed)`,
            id,
          );
        let repeat = 2;
        while (edgeThere(`${id}#${repeat}`)) repeat++;
        id = `${id}#${repeat}`;
      }
      addedEdges.set(id, makeEdge(id, source, target, raw, problem));
    }

    this.issues = issues;
    const structure =
      goneNodeAt.length > 0 ||
      goneEdgeAt.length > 0 ||
      addedNodes.size > 0 ||
      addedEdges.size > 0;
    if (!structure && !changedNodes.size && !changedEdges.size) return null;

    // Nothing below throws: the model takes the change whole.
    const change = { ...noChange(), issues };
    const nodePairs = [];
    for (const [id, after] of changedNodes) {
      const i = this.index.get(id);
      nodePairs.push([oldNodes[i], after, i]);
    }
    nodePairs.sort((a, b) => a[2] - b[2]);
    const edgePairs = [];
    for (const i of [...changedEdges.keys()].sort(ascending))
      edgePairs.push([oldEdges[i], changedEdges.get(i)]);
    this.#describe(change, nodePairs, edgePairs, structure);
    for (const i of goneNodeAt) change.nodesRemoved.push(oldNodes[i].id);
    for (const i of goneEdgeAt) change.edgesRemoved.push(oldEdges[i].id);
    change.nodesAdded = [...addedNodes.keys()];
    change.edgesAdded = [...addedEdges.keys()];

    // Nodes: removed ones compacted out (the ones after them renumbered), changed ones swapped, added ones appended.
    // The lists change in place; the frozen copies already handed out keep the old ones.
    const oldNodeCount = oldNodes.length,
      oldEdgeCount = oldEdges.length;
    const nodes = this.#nodeList,
      edges = this.#edgeList;
    if (goneNodeAt.length) {
      for (const id of goneNodes) this.index.delete(id);
      compact(nodes, goneNodeAt);
      for (let i = goneNodeAt[0]; i < nodes.length; i++)
        this.index.set(nodes[i].id, i);
    }
    for (const [id, record] of changedNodes) nodes[this.index.get(id)] = record;
    for (const [id, record] of addedNodes) {
      this.index.set(id, nodes.length);
      nodes.push(record);
    }
    if (goneEdgeAt.length) {
      for (const id of change.edgesRemoved) this.edgeIndex.delete(id);
      compact(edges, goneEdgeAt);
      for (let i = goneEdgeAt[0]; i < edges.length; i++)
        this.edgeIndex.set(edges[i].id, i);
    }
    for (const record of changedEdges.values())
      edges[this.edgeIndex.get(record.id)] = record;
    for (const [id, record] of addedEdges) {
      this.edgeIndex.set(id, edges.length);
      edges.push(record);
    }
    this.#listsChanged(
      goneNodeAt.length > 0 || changedNodes.size > 0 || addedNodes.size > 0,
      goneEdgeAt.length > 0 || changedEdges.size > 0 || addedEdges.size > 0,
    );

    if (structure) {
      // Edge ends stay right for the edges before the first removed one, unless nodes were renumbered.
      const firstEdge = goneEdgeAt.length ? goneEdgeAt[0] : oldEdgeCount;
      this.#endsValid = goneNodeAt.length
        ? 0
        : Math.min(this.#endsValid, firstEdge);
      this.#newStructure(goneNodeAt.length > 0);
      // Appended nodes are measured when widths are next asked for (after a removal, every node is).
      if (this.#widthsDirty)
        for (let i = oldNodeCount; i < nodes.length; i++)
          this.#widthsDirty.add(i);
    }
    this.#relabel(nodePairs); // their indices are still right: without a removal nothing was renumbered
    change.version = ++this.version;
    return change;
  }

  #setOptions(options) {
    const { node, edge } = plain(options);
    const issues = [];
    const warn = this.#optionWarning(issues);
    const before = this.opts;
    const next = {
      node: node
        ? resolve(NODE_OPTIONS, { ...before.node, ...plain(node) }, warn)
        : before.node,
      edge: edge
        ? resolve(EDGE_OPTIONS, { ...before.edge, ...plain(edge) }, warn)
        : before.edge,
    };
    const nodeChanged = changes(before.node, next.node),
      edgeChanged = changes(before.edge, next.edge);
    if (!Object.keys(nodeChanged).length && !Object.keys(edgeChanged).length) {
      if (issues.length) this.issues = issues;
      return null;
    }
    this.opts = next;
    this.issues = issues;
    if ("labelSize" in nodeChanged) this.#forgetWidths();
    return {
      ...noChange(),
      issues,
      sizes: SIZE_KEYS.some((k) => k in nodeChanged),
      looks: true,
      options: { node: nodeChanged, edge: edgeChanged },
      version: ++this.version,
    };
  }

  // ---- views of the structure ------------------------------------------------------------------------------------

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
      const { target, outStart, outEdges, inStart } = this.adjacency();
      const count = this.#nodeList.length;
      const parent = new Int32Array(count).fill(-1),
        depth = new Int32Array(count),
        leaves = new Int32Array(count).fill(1),
        descendants = new Int32Array(count),
        tree = new Uint8Array(this.#edgeList.length);
      const children = new Array(count);
      for (let i = 0; i < count; i++) children[i] = [];
      const roots = [],
        order = [];
      const seen = new Uint8Array(count);
      // Breadth first from `root`, with `order` as the queue.
      const grow = (root) => {
        seen[root] = 1;
        roots.push(root);
        order.push(root);
        for (let head = order.length - 1; head < order.length; head++) {
          const at = order[head];
          for (let k = outStart[at]; k < outStart[at + 1]; k++) {
            const ei = outEdges[k];
            const t = target[ei];
            if (seen[t]) continue;
            seen[t] = 1;
            tree[ei] = 1;
            parent[t] = at;
            depth[t] = depth[at] + 1;
            children[at].push(t);
            order.push(t);
          }
        }
      };
      for (let i = 0; i < count; i++)
        if (inStart[i] === inStart[i + 1]) grow(i);
      for (let i = 0; i < count; i++) if (!seen[i]) grow(i);
      let maxDepth = 0;
      for (let k = order.length - 1; k >= 0; k--) {
        const v = order[k];
        const kids = children[v];
        if (kids.length) {
          let l = 0,
            dsc = 0;
          for (const c of kids) {
            l += leaves[c];
            dsc += descendants[c] + 1;
          }
          leaves[v] = l;
          descendants[v] = dsc;
        }
        if (depth[v] > maxDepth) maxDepth = depth[v];
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
      const { source, target, outStart, outEdges } = this.adjacency();
      const count = this.#nodeList.length,
        m = this.#edgeList.length;
      const back = new Uint8Array(m);
      const state = new Uint8Array(count); // 0 new, 1 on the stack, 2 done
      // Depth first without recursion: a stack of nodes and, per node, how far through its edges it is.
      const stack = new Int32Array(count),
        next = new Int32Array(count);
      const visit = (start) => {
        let top = 0;
        stack[0] = start;
        next[start] = outStart[start];
        state[start] = 1;
        while (top >= 0) {
          const v = stack[top];
          if (next[v] < outStart[v + 1]) {
            const ei = outEdges[next[v]++];
            const w = target[ei];
            if (state[w] === 1) back[ei] = 1;
            else if (!state[w]) {
              state[w] = 1;
              next[w] = outStart[w];
              stack[++top] = w;
            }
          } else {
            state[v] = 2;
            top--;
          }
        }
      };
      for (const r of this.forest().roots) if (!state[r]) visit(r);
      for (let v = 0; v < count; v++) if (!state[v]) visit(v);

      // With back edges reversed: each node's edges down, in edge order (a counting sort again).
      const indegree = new Int32Array(count),
        downStart = new Int32Array(count + 1);
      for (let ei = 0; ei < m; ei++) {
        const from = back[ei] ? target[ei] : source[ei],
          to = back[ei] ? source[ei] : target[ei];
        indegree[to]++;
        downStart[from + 1]++;
      }
      for (let v = 0; v < count; v++) downStart[v + 1] += downStart[v];
      const down = new Int32Array(m),
        at = downStart.slice(0, count);
      for (let ei = 0; ei < m; ei++) {
        const from = back[ei] ? target[ei] : source[ei],
          to = back[ei] ? source[ei] : target[ei];
        down[at[from]++] = to;
      }
      const sources = [];
      for (let v = 0; v < count; v++) if (!indegree[v]) sources.push(v);
      const order = sources.slice(),
        longest = new Int32Array(count);
      for (let head = 0; head < order.length; head++) {
        const v = order[head];
        for (let k = downStart[v]; k < downStart[v + 1]; k++) {
          const w = down[k];
          if (longest[v] + 1 > longest[w]) longest[w] = longest[v] + 1;
          if (--indegree[w] === 0) order.push(w);
        }
      }
      const sinks = [];
      for (let v = 0; v < count; v++)
        if (downStart[v] === downStart[v + 1]) sinks.push(v);
      return { back, order, longest, sources, sinks };
    });
  }

  /**
   * Counts that describe the graph's shape, for telemetry and tests. Worked out when first asked for after the
   * structure changes (it reads the forest and the DAG), then kept: changes don't pay for it.
   */
  stats() {
    return { ...this.#shape(), issues: this.issues.length };
  }

  #shape() {
    return this.#cached("stats", () => {
      const f = this.forest(),
        d = this.dag();
      const { outStart, inStart } = this.adjacency();
      let crossLinks = 0;
      for (let i = 0; i < f.tree.length; i++) if (!f.tree[i]) crossLinks++;
      let maxIn = 0,
        maxOut = 0,
        shared = 0;
      for (let v = 0; v < this.#nodeList.length; v++) {
        const into = inStart[v + 1] - inStart[v],
          out = outStart[v + 1] - outStart[v];
        if (into > maxIn) maxIn = into;
        if (out > maxOut) maxOut = out;
        if (into > 1) shared++;
      }
      let layers = 0;
      for (let v = 0; v < d.longest.length; v++)
        if (d.longest[v] + 1 > layers) layers = d.longest[v] + 1;
      let backEdges = 0;
      for (let i = 0; i < d.back.length; i++) backEdges += d.back[i];
      return Object.freeze({
        nodes: this.#nodeList.length,
        edges: this.#edgeList.length,
        roots: f.roots.length,
        depth: f.maxDepth,
        layers,
        crossLinks,
        sharedNodes: shared,
        maxInDegree: maxIn,
        maxOutDegree: maxOut,
        backEdges,
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
    for (const n of this.#nodeList) {
      const old = before.node(n.id);
      if (!old) nodesAdded.push(n.id);
      else {
        nodesKept.push(n.id);
        if (
          old.label !== n.label ||
          !equal(old.style, n.style) ||
          !equal(old.data, n.data)
        )
          nodesChanged.push(n.id);
      }
    }
    const nodesRemoved = before.nodes
      .filter((n) => !this.index.has(n.id))
      .map((n) => n.id);
    const edgesAdded = this.#edgeList
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
      nodes: this.#nodeList.map((n) => ({
        id: n.id,
        ...(n.label !== n.id && { label: n.label }),
        ...(Object.keys(n.style).length && { style: n.style }),
        ...(Object.keys(n.data).length && { data: n.data }),
      })),
      edges: this.#edgeList.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(Object.keys(e.style).length && { style: e.style }),
        ...(Object.keys(e.data).length && { data: e.data }),
      })),
    };
  }
}

/** Take the items at `gone` (ascending indices) out of `list`, in place, keeping the others in order. */
function compact(list, gone) {
  let to = gone[0],
    g = 0;
  for (let i = gone[0]; i < list.length; i++) {
    if (g < gone.length && gone[g] === i) {
      g++;
      continue;
    }
    list[to++] = list[i];
  }
  list.length = to;
}
