// The graph model: what a graph *is* and how it looks, separate from where anything is drawn.
//
// One GraphModel holds one graph for as long as it's shown. It's built once from JSON (the prismatrix-graph format,
// MODEL.md) and then changed in place: `update(delta)` adds, removes and changes nodes and edges, `replace(json)`
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

import { LABEL_GAP, LINE, fitLabel } from "./boxes.js";
import { closest, isHex, resolve } from "./schema.js";
import { EDGE_OPTIONS, NODE_OPTIONS, labelPlace } from "./style.js";

export const GRAPH_FORMAT = "prismatrix-graph";
export const GRAPH_VERSION = 1;

/** Node options that change how much room a node takes: changing one lays the graph out again. */
const SIZE_KEYS = [
  "shape",
  "size",
  "sizeBy",
  "labels",
  "labelSize",
  "collisionRadius",
  "labelCollide",
  "labelMaxWidth",
  "look",
  "cardWidth",
  "cardHeight",
];

/** Text width without a browser: about right for a sans-serif face. Renderers measure for real. */
export const roughMeasure = (text, size) => text.length * size * 0.56;

/**
 * @typedef {object} ModelNode A node as the model keeps it (frozen).
 * @property {string} id
 * @property {string} label    shown on the node; defaults to the id
 * @property {NodeStyle} style how this node looks, overriding the model's node options (see NODE_STYLE)
 * @property {Record<string, any>} data anything else, untouched by the engine
 *
 * @typedef {object} NodeStyle
 * @property {string} [color]  "#rrggbb"
 * @property {number} [size]   diameter, world px (1–400)
 * @property {"circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile"} [shape]
 * @property {string} [stroke] a border's colour, "#rrggbb"
 * @property {number} [strokeWidth] the border's width, world px (0–100; default: the node option `strokeWidth`)
 * @property {string | { width: number, height: number }} [icon] an image drawn in the node: a URL, or an image
 *   already in hand (an HTMLImageElement, ImageBitmap, canvas…; only a URL survives toJSON)
 * @property {string} [badge]  up to 12 characters in a pill at the node's top right ("!", "new"); top left when the
 *   node is collapsed (its "+N" takes the right)
 * @property {string | { width: number, height: number }} [badgeIcon] a small round image on the node's top right
 *   corner (a URL, or an image in hand): a mark, like a maker's stamp
 * @property {"solid" | "dashed" | "dotted"} [strokeStyle] how the border is drawn (default solid)
 * @property {number} [opacity] the fill's opacity, 0–1 (the border, icon and badge stay opaque)
 * @property {string} [ring]   a ring just outside the shape, "#rrggbb"
 * @property {string} [aura]   a soft glow round the shape, "#rrggbb"
 * @property {boolean} [stack] a second copy of the shape peeks out behind it: there's more folded away here
 * @property {boolean} [pinLabel] the label stays at any zoom, like a root's
 * @property {CardText} [subtitle] a card's second line (cards only: the `look` node option)
 * @property {CardText} [value]  a card's third line
 * @property {string} [tag]      a card's tag: up to 24 characters in a pill on its top edge ("owned", "×3")
 *
 * @typedef {string | (string | { text: string, color?: string } | { mark: string } | { dot: string })[]} CardText A
 *   line of a card: text, or runs of it: plain text, text in a colour of its own, a small square (`mark`) or a small
 *   disc (`dot`) in a colour
 *
 * @typedef {object} EdgeStyle
 * @property {string} [color]  "#rrggbb"
 * @property {number} [width]  world px (0.1–40)
 * @property {"solid" | "dashed" | "dotted"} [dash] how this edge is drawn (default: the edge option `dash`)
 * @property {boolean} [glow]  a soft glow along the edge, in its colour
 *
 * @typedef {object} ModelEdge An edge as the model keeps it (frozen).
 * @property {string} id       given, or "source>target" (with "#2", "#3"… for repeats)
 * @property {string} source   node id
 * @property {string} target   node id
 * @property {string} label    drawn small near the target end ("×3"), or "" for none
 * @property {EdgeStyle} style how this edge looks, overriding the model's edge options (see EDGE_STYLE)
 * @property {Record<string, any>} data
 *
 * @typedef {object} NodeJSON A node in the prismatrix-graph format (MODEL.md).
 * @property {string | number} id
 * @property {string} [label]
 * @property {NodeStyle} [style]
 * @property {Record<string, any>} [data]
 *
 * @typedef {object} EdgeJSON An edge in the prismatrix-graph format.
 * @property {string | number} [id]
 * @property {string | number} source
 * @property {string | number} target
 * @property {string | number} [label]
 * @property {EdgeStyle} [style]
 * @property {Record<string, any>} [data]
 *
 * @typedef {object} GraphJSON A graph in the prismatrix-graph format (or plain `{ nodes, edges }`).
 * @property {"prismatrix-graph"} [format]
 * @property {number} [version]
 * @property {Record<string, any>} [meta]
 * @property {NodeJSON[]} [nodes]
 * @property {EdgeJSON[]} [edges]
 *
 * @typedef {object} NodeChange A change to a node: each field given replaces the node's own.
 * @property {string | number} id
 * @property {string} [label]
 * @property {NodeStyle} [style]
 * @property {Record<string, any>} [data]
 *
 * @typedef {object} EdgeChange A change to an edge.
 * @property {string | number} id
 * @property {string | number} [label]
 * @property {EdgeStyle} [style]
 * @property {Record<string, any>} [data]
 *
 * @typedef {object} Issue
 * @property {string} kind     "duplicate-node", "missing-id", "missing-node", "missing-endpoint", "self-loop",
 *   "duplicate-edge-id", "bad-id", "missing-edge", "bad-style", "bad-option" or "bad-input"
 * @property {string} message
 * @property {string} [id]
 *
 * @typedef {object} Delta A change to a model (`update`). Each field takes a list (any iterable), or a single item.
 * @property {NodeJSON | Iterable<NodeJSON>} [addNodes] new nodes, as in the JSON format
 * @property {string | number | Iterable<string | number>} [removeNodes] ids (their edges go too)
 * @property {NodeChange | Iterable<NodeChange>} [changeNodes] `{ id, label?, style?, data? }`: the fields given
 *   replace the node's own
 * @property {EdgeJSON | Iterable<EdgeJSON>} [addEdges] new edges, as in the JSON format
 * @property {string | number | Iterable<string | number>} [removeEdges] ids
 * @property {EdgeChange | Iterable<EdgeChange>} [changeEdges] `{ id, label?, style?, data? }`
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
 * @property {string[]} edgesChanged  every kept edge with a new record (label, style or data), in edge order
 * @property {string[]} edgesRestyled the part of edgesChanged whose label or style changed
 * @property {{ node: Partial<import("./style.js").NodeOptions>, edge: Partial<import("./style.js").EdgeOptions> }}
 *   [options] for setOptions: the options that changed, with their new values
 * @property {Issue[]} issues      problems in this change (left out, never fixed silently)
 *
 * @typedef {object} ModelOptions
 * @property {Partial<import("./style.js").NodeOptions>} [node] node appearance: NODE_OPTIONS (size, shape, colours,
 *   labels and their size…)
 * @property {Partial<import("./style.js").EdgeOptions>} [edge] edge appearance: EDGE_OPTIONS
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

/** A card's line (CardText): text, or up to 24 runs of text, coloured text, marks and dots. */
const cardText = (v) =>
  typeof v === "string"
    ? v.length <= 200
    : Array.isArray(v) &&
      v.length <= 24 &&
      v.every((run) =>
        typeof run === "string"
          ? run.length <= 200
          : run !== null &&
            typeof run === "object" &&
            (typeof run.text === "string"
              ? run.text.length <= 200 &&
                (run.color === undefined || isHex(run.color))
              : isHex(run.mark) || isHex(run.dot)),
      );

/** What a node's `style` may set, and what each value must be. */
export const NODE_STYLE = {
  color: isHex,
  size: number(1, 400),
  shape: (v) => SHAPES.includes(v),
  stroke: isHex,
  strokeWidth: number(0, 100),
  icon,
  badge: (v) => typeof v === "string" && v.length <= 12,
  badgeIcon: icon,
  strokeStyle: (v) => v === "solid" || v === "dashed" || v === "dotted",
  opacity: number(0, 1),
  ring: isHex,
  aura: isHex,
  stack: (v) => typeof v === "boolean",
  pinLabel: (v) => typeof v === "boolean",
  subtitle: cardText,
  value: cardText,
  tag: (v) => typeof v === "string" && v.length <= 24,
};
/** What an edge's `style` may set. */
export const EDGE_STYLE = {
  color: isHex,
  width: number(0.1, 40),
  dash: (v) => v === "solid" || v === "dashed" || v === "dotted",
  glow: (v) => typeof v === "boolean",
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
 * caller's objects.
 */
function copyData(value) {
  const data = plain(value);
  if (data === EMPTY || Object.keys(data).length === 0) return EMPTY;
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
 * Deep equality by value, for JSON-like data: NaN equals NaN, arrays element by element, plain objects by their own
 * keys. Anything else (a date, a map, an image) is only the same as itself. Cycles are followed once.
 * @param {any} a
 * @param {any} b
 * @param {Map<object, object>} [seen] pairs already being compared (for cycles)
 * @returns {boolean}
 */
export function equal(a, b, seen) {
  if (a === b) return true;
  if (typeof a === "number") return a !== a && b !== b; // both NaN
  if (typeof a !== "object" || a === null || b === null) return false;
  const tag = objectTag(a);
  if (tag !== objectTag(b)) return false;
  if (tag !== "[object Array]" && tag !== "[object Object]") return false;
  if (seen?.get(a) === b) return true;
  (seen ??= new Map()).set(a, b);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys)
    if (!Object.hasOwn(b, k) || !equal(a[k], b[k], seen)) return false;
  return true;
}

/** An id as the model keeps it: a non-empty string, or a number written as one. Anything else is no id. */
function idOf(value) {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

const labelOf = (id, raw) =>
  raw?.label === undefined ? id : String(raw.label);

/** A change's label, style and data, with the record's for those it leaves out. */
const merged = (c, old) => ({
  label: "label" in c ? c.label : old.label,
  style: "style" in c ? c.style : old.style,
  data: "data" in c ? c.data : old.data,
});

/** A node as the caller gave it is the same as a model node: nothing to copy or check again. */
const sameNode = (raw, node) =>
  labelOf(node.id, raw) === node.label &&
  same(raw?.style, node.style) &&
  same(raw?.data, node.data);

/** An edge's label: "" when it has none. */
const edgeLabelOf = (raw) =>
  raw?.label === undefined || raw?.label === null ? "" : String(raw.label);

const sameEdge = (raw, edge) =>
  edgeLabelOf(raw) === edge.label &&
  same(raw?.style, edge.style) &&
  same(raw?.data, edge.data);

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
    label: edgeLabelOf(raw),
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

/**
 * The keys of `given` options that the schema knows and that have a value, added to `onto` (a new set either way).
 * @returns {Set<string>}
 */
function givenKeys(schema, given, onto = null) {
  const out = new Set(onto);
  const values = plain(given);
  for (const o of schema)
    if (Object.hasOwn(values, o.key) && values[o.key] != null) out.add(o.key);
  return out;
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
  /** The array-of-arrays views (ends, outgoing, incoming), built from #adj when first read. */
  #views = null;
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
   * @param {GraphJSON | GraphModel} input
   * @param {ModelOptions} [options]
   * @returns {GraphModel}
   */
  static from(input, options) {
    if (input instanceof GraphModel) return input;
    return new GraphModel(input, options);
  }

  /**
   * @param {GraphJSON | GraphModel} [input] prismatrix-graph JSON, or plain `{ nodes, edges }`
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
    /**
     * How nodes and edges look: resolved NODE_OPTIONS and EDGE_OPTIONS.
     * @type {{ node: import("./style.js").NodeOptions, edge: import("./style.js").EdgeOptions }}
     */
    this.opts = {
      node: resolve(NODE_OPTIONS, plain(node), warn),
      edge: resolve(EDGE_OPTIONS, plain(edge), warn),
    };
    /**
     * The options that were set on purpose (given here or to `setOptions`), by key: anything else is a default, and
     * a view may put its own default in its place (a layout's edge defaults, see LAYOUTS). Read only.
     * @type {{ node: ReadonlySet<string>, edge: ReadonlySet<string> }}
     */
    this.explicit = {
      node: givenKeys(NODE_OPTIONS, node),
      edge: givenKeys(EDGE_OPTIONS, edge),
    };
    /** @type {(text: string, size: number) => number} a label's width at a font size */
    this.measure = measure ?? roughMeasure;
    /** Whether `measure` is a real text measurement (given, or a renderer's), not the estimate. */
    this.measured = !!measure;
    /** @type {Readonly<Record<string, any>>} the graph's `meta` (frozen) */
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
    /** @type {Set<(change: Change, model: GraphModel) => void>} */
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

  /** How many nodes. */
  get size() {
    return this.#nodeList.length;
  }

  /**
   * The node with id `id`, or undefined.
   * @param {string | number} id
   * @returns {ModelNode | undefined}
   */
  node(id) {
    const i = this.index.get(String(id));
    return i === undefined ? undefined : this.#nodeList[i];
  }

  /**
   * The edge with id `id`, or undefined.
   * @param {string | number} id
   * @returns {ModelEdge | undefined}
   */
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
    const source = new Int32Array(m),
      target = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      const e = this.#edgeList[i];
      source[i] = this.index.get(e.source);
      target[i] = this.index.get(e.target);
    }
    this.#adj = compressedRows(n, source, target);
    return this.#adj;
  }

  /** The same structure as arrays of arrays (what working graphs and layouts read), built when first read. */
  #arrays() {
    if (this.#views) return this.#views;
    const { source, target } = this.adjacency();
    this.#views = edgeLists(this.#nodeList.length, source, target);
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

  /**
   * Each node's label width at the current label size (world px): every distinct label is measured once and kept.
   * A label wider than the `labelMaxWidth` option is cut short with an ellipsis (fitLabel), as the painters draw it.
   */
  labelWidths() {
    const node = this.opts.node;
    if (node.look === "card") {
      // A card's text has the card's room, whatever it says: every card is the same size.
      const widths = new Float64Array(this.#nodeList.length);
      return widths.fill(cardTextWidth(node));
    }
    if (this.#widthsAt === this.#nodesStamp) return this.widths;
    const { labelSize: size, labelMaxWidth: max } = node;
    const measure = (text) => this.measure(text, size);
    // A new array (the old one may be in a layout job's hands); every label already measured comes from the cache.
    const widths = new Float64Array(this.#nodeList.length);
    for (let i = 0; i < widths.length; i++) {
      const label = this.#nodeList[i].label;
      let w = this.widthCache.get(label);
      if (w === undefined) {
        w = fitLabel(label, max, measure).width;
        this.widthCache.set(label, w);
      }
      widths[i] = w;
    }
    this.widths = widths;
    this.#widthsAt = this.#nodesStamp;
    return widths;
  }

  /** A label's height (one line) at the current label size, world px; a card's text has the card's height. */
  get labelHeight() {
    const node = this.opts.node;
    return node.look === "card" ? node.cardHeight : node.labelSize * LINE;
  }

  /**
   * Measure labels with `measure` from now on (a renderer's real text measurement, say).
   * @param {(text: string, size: number) => number} measure
   */
  setMeasure(measure) {
    if (!measure || measure === this.measure) return;
    this.measure = measure;
    this.measured = true;
    this.#forgetWidths();
  }

  #forgetWidths() {
    this.widthCache.clear();
    this.#widthsAt = -1;
  }

  /**
   * Hear about every change: `listener(change, model)`. Returns a function that stops listening.
   *
   * Every listener hears every change, in order, and each with the model as that change left it: one that throws
   * doesn't stop the others (the error goes to `onError`, or the console). A change asked for from inside a
   * listener (an `update` in reply to another) waits until every listener has heard the current one, then is
   * applied and told in its turn; the call itself returns null.
   * @param {(change: Change, model: GraphModel) => void} listener
   * @returns {() => void}
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- changing --------------------------------------------------------------------------------------------------

  /**
   * Make the model hold `input` (JSON, plain `{ nodes, edges }`, or another model), in its order. Nodes and edges
   * that are the same as before keep their records: nothing is copied, checked or measured again.
   * @param {GraphJSON | GraphModel} input
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
   * measures labels again (each distinct one, once). The keys given count as set on purpose (`explicit`). With
   * `reset`, the options become exactly what's given over the defaults, and only those keys are set on purpose.
   * @param {{ node?: Partial<import("./style.js").NodeOptions>, edge?: Partial<import("./style.js").EdgeOptions> }}
   *   options
   * @param {{ reset?: boolean }} [how]
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  setOptions(options, { reset = false } = {}) {
    return this.#mutate(() => this.#setOptions(options, reset));
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
      this.#newStructure();
    }
    change.version = ++this.version;
    return change;
  }

  /**
   * Fill a change's flags and changed lists from the records that changed (`[before, after, index]` for nodes,
   * `[before, after]` for edges, in order). A change of data (or meta) alone is `dataOnly`: nothing drawn changed.
   */
  #describe(change, nodePairs, edgePairs, structure, metaChanged = false) {
    const labelled = labelPlace(this.opts.node) !== "off";
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
      if (before.label !== after.label || !same(after.style, before.style)) {
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
  #newStructure() {
    this.structureVersion++;
    this.#adj = null;
    this.#views = null;
    this.cache = new Map();
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
      const raw = merged(c, old);
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
      const raw = merged(c, old);
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

    if (structure) this.#newStructure();
    change.version = ++this.version;
    return change;
  }

  #setOptions(options, reset) {
    const { node, edge } = plain(options);
    const issues = [];
    const warn = this.#optionWarning(issues);
    const before = this.opts;
    // Merged over what's set (or, with `reset`, over the defaults: only what's given is set).
    /** @type {GraphModel["opts"]} */
    const next = {
      node:
        node || reset
          ? resolve(
              NODE_OPTIONS,
              { ...(reset ? {} : before.node), ...plain(node) },
              warn,
            )
          : before.node,
      edge:
        edge || reset
          ? resolve(
              EDGE_OPTIONS,
              { ...(reset ? {} : before.edge), ...plain(edge) },
              warn,
            )
          : before.edge,
    };
    const explicit = {
      node: givenKeys(NODE_OPTIONS, node, reset ? null : this.explicit.node),
      edge: givenKeys(EDGE_OPTIONS, edge, reset ? null : this.explicit.edge),
    };
    // A key that becomes set on purpose (or stops being) is a change even at the same value: a view's own default
    // for it may have been showing.
    const nodeChanged = changes(before.node, next.node),
      edgeChanged = changes(before.edge, next.edge);
    /** @type {[ReadonlySet<string>, Set<string>, Record<string, any>, Record<string, any>][]} */
    const kinds = [
      [this.explicit.node, explicit.node, nodeChanged, next.node],
      [this.explicit.edge, explicit.edge, edgeChanged, next.edge],
    ];
    for (const [was, now, out, values] of kinds) {
      for (const k of now) if (!was.has(k)) out[k] = values[k];
      for (const k of was) if (!now.has(k)) out[k] = values[k];
    }
    this.explicit = explicit;
    if (!Object.keys(nodeChanged).length && !Object.keys(edgeChanged).length) {
      if (issues.length) this.issues = issues;
      return null;
    }
    this.opts = next;
    this.issues = issues;
    if ("labelSize" in nodeChanged || "labelMaxWidth" in nodeChanged)
      this.#forgetWidths();
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
    return this.#cached("forest", () =>
      forestOf(this.#nodeList.length, this.adjacency()),
    );
  }

  /**
   * The graph read as a DAG: edges that close a cycle (found depth-first from the forest's roots) are marked as
   * back edges, to be reversed for layout; with them reversed, a topological order and each node's longest path
   * from a source.
   * @returns {{ back: Uint8Array, order: number[], longest: Int32Array, sources: number[], sinks: number[] }}
   */
  dag() {
    return this.#cached("dag", () =>
      dagOf(this.#nodeList.length, this.adjacency(), this.forest().roots),
    );
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
   * The model as prismatrix-graph JSON: GraphModel.from(model.toJSON()) gives an equal model.
   * @returns {GraphJSON}
   */
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
        ...(e.label && { label: e.label }),
        ...(Object.keys(e.style).length && { style: e.style }),
        ...(Object.keys(e.data).length && { data: e.data }),
      })),
    };
  }
}

/**
 * How wide a card's text is, for these node options: the card less its icon square (the card's height) and the gap
 * after it. A card's footprint is its icon and this "label" to its right: its own box.
 * @param {{ cardWidth: number, cardHeight: number }} node
 */
export function cardTextWidth(node) {
  return Math.max(0, node.cardWidth - node.cardHeight - LABEL_GAP);
}

/**
 * `n` nodes' edges (`source` and `target` per edge) as arrays of arrays: per edge `[source, target]`, per node the
 * edges out of it and into it, in edge order. For a model's structure and a working graph's part (graph.js).
 * @param {number} n
 * @param {ArrayLike<number>} source
 * @param {ArrayLike<number>} target
 * @returns {{ ends: number[][], outgoing: number[][], incoming: number[][] }}
 */
export function edgeLists(n, source, target) {
  const ends = Array.from(source, (s, i) => [s, target[i]]);
  const outgoing = Array.from({ length: n }, () => []),
    incoming = Array.from({ length: n }, () => []);
  for (let i = 0; i < source.length; i++) {
    outgoing[source[i]].push(i);
    incoming[target[i]].push(i);
  }
  return { ends, outgoing, incoming };
}

/**
 * A structure as compressed sparse rows, from each edge's ends: each node's outgoing and incoming edges, in edge
 * order (a counting sort by source and by target). For a model's adjacency, and for a working graph that shows only
 * part of its model (graph.js).
 * @param {number} n  nodes
 * @param {Int32Array} source per edge, its source node's index
 * @param {Int32Array} target per edge, its target node's index
 * @returns {Adjacency}
 */
export function compressedRows(n, source, target) {
  const m = source.length;
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
  return Object.freeze({
    source,
    target,
    outStart,
    outEdges,
    inStart,
    inEdges,
  });
}

/**
 * A structure read as a forest (see GraphModel.forest): breadth-first from every node nothing points to (in node
 * order), then from any node still unreached (cycles); the first edge to reach a node is its tree edge.
 * @param {number} count nodes
 * @param {Adjacency} adjacency
 */
export function forestOf(count, { target, outStart, outEdges, inStart }) {
  const parent = new Int32Array(count).fill(-1),
    depth = new Int32Array(count),
    leaves = new Int32Array(count).fill(1),
    descendants = new Int32Array(count),
    tree = new Uint8Array(target.length);
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
  for (let i = 0; i < count; i++) if (inStart[i] === inStart[i + 1]) grow(i);
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
}

/**
 * A structure read as a DAG (see GraphModel.dag): edges that close a cycle, found depth-first from `roots` (then from
 * any node still unvisited), are back edges; with them reversed, a topological order and each node's longest path
 * from a source. For a model, and for a merged layout of a working graph (layered.js).
 * @param {number} count nodes
 * @param {Adjacency} adjacency
 * @param {Iterable<number>} roots where the search starts, in order (the forest's roots)
 * @returns {{ back: Uint8Array, order: number[], longest: Int32Array, sources: number[], sinks: number[] }}
 */
export function dagOf(count, { source, target, outStart, outEdges }, roots) {
  const m = source.length;
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
  for (const r of roots) if (!state[r]) visit(r);
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
