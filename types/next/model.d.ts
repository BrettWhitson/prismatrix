export declare const GRAPH_FORMAT = "prismatrix-graph";
export declare const GRAPH_VERSION = 1;
/** Node options that change how much room a node takes: changing one lays the graph out again. */
export declare const SIZE_KEYS: string[];
/** Text width without a browser: about right for a sans-serif face. Renderers measure for real. */
export declare const roughMeasure: (text: any, size: any) => number;
export type ModelNode = {
  id: string;
  /**
   * shown on the node; defaults to the id
   */
  label: string;
  /**
   * how this node looks, overriding the model's node options (see NODE_STYLE)
   */
  style: NodeStyle;
  /**
   * anything else, untouched by the engine
   */
  data: Record<string, any>;
};
export type NodeStyle = {
  /**
   * "#rrggbb"
   */
  color?: string;
  /**
   * diameter, world px (1–400)
   */
  size?: number;
  shape?:
    "circle" | "square" | "rounded" | "diamond" | "hexagon" | "ring" | "tile";
  /**
   * a border's colour, "#rrggbb"
   */
  stroke?: string;
  /**
   * the border's width, world px (0–100; default: the node option `strokeWidth`)
   */
  strokeWidth?: number;
  /**
   * an image drawn in the node: a URL, or an image
   * already in hand (an HTMLImageElement, ImageBitmap, canvas…; only a URL survives toJSON)
   */
  icon?:
    | string
    | {
        width: number;
        height: number;
      };
  /**
   * up to 12 characters in a pill at the node's top right ("!", "new"); top left when the
   * node is collapsed (its "+N" takes the right)
   */
  badge?: string;
};
export type EdgeStyle = {
  /**
   * "#rrggbb"
   */
  color?: string;
  /**
   * world px (0.1–40)
   */
  width?: number;
};
export type ModelEdge = {
  /**
   * given, or "source>target" (with "#2", "#3"… for repeats)
   */
  id: string;
  /**
   * node id
   */
  source: string;
  /**
   * node id
   */
  target: string;
  /**
   * drawn small near the target end ("×3"), or "" for none
   */
  label: string;
  /**
   * how this edge looks, overriding the model's edge options (see EDGE_STYLE)
   */
  style: EdgeStyle;
  data: Record<string, any>;
};
export type NodeJSON = {
  id: string | number;
  label?: string;
  style?: NodeStyle;
  data?: Record<string, any>;
};
export type EdgeJSON = {
  id?: string | number;
  source: string | number;
  target: string | number;
  label?: string | number;
  style?: EdgeStyle;
  data?: Record<string, any>;
};
export type GraphJSON = {
  format?: "prismatrix-graph";
  version?: number;
  meta?: Record<string, any>;
  nodes?: NodeJSON[];
  edges?: EdgeJSON[];
};
export type NodeChange = {
  id: string | number;
  label?: string;
  style?: NodeStyle;
  data?: Record<string, any>;
};
export type EdgeChange = {
  id: string | number;
  label?: string | number;
  style?: EdgeStyle;
  data?: Record<string, any>;
};
export type Issue = {
  /**
   * "duplicate-node", "missing-id", "missing-node", "missing-endpoint", "self-loop",
   * "duplicate-edge-id", "bad-id", "missing-edge", "bad-style", "bad-option" or "bad-input"
   */
  kind: string;
  message: string;
  id?: string;
};
export type Delta = {
  /**
   * new nodes, as in the JSON format
   */
  addNodes?: NodeJSON | Iterable<NodeJSON>;
  /**
   * ids (their edges go too)
   */
  removeNodes?: string | number | Iterable<string | number>;
  /**
   * `{ id, label?, style?, data? }`: the fields given
   * replace the node's own
   */
  changeNodes?: NodeChange | Iterable<NodeChange>;
  /**
   * new edges, as in the JSON format
   */
  addEdges?: EdgeJSON | Iterable<EdgeJSON>;
  /**
   * ids
   */
  removeEdges?: string | number | Iterable<string | number>;
  /**
   * `{ id, label?, style?, data? }`
   */
  changeEdges?: EdgeChange | Iterable<EdgeChange>;
};
export type Change = {
  /**
   * the model's version after the change
   */
  version: number;
  /**
   * nodes or edges came, went or were reordered: lay out again
   */
  structure: boolean;
  /**
   * something changed how much room a node takes (a shown label, a size, a shape)
   */
  sizes: boolean;
  /**
   * anything that's drawn changed (false for a change of data only)
   */
  looks: boolean;
  /**
   * only `data` (or the graph's `meta`) changed: nothing is drawn differently and
   * nothing moves, so a view only needs the new records (no layout, no restyle)
   */
  dataOnly: boolean;
  nodesAdded: string[];
  nodesRemoved: string[];
  /**
   * every kept node with a new record (label, style or data), in node order
   */
  nodesChanged: string[];
  /**
   * the part of nodesChanged whose label or style changed (what's drawn)
   */
  nodesRestyled: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
  /**
   * every kept edge with a new record (style or data), in edge order
   */
  edgesChanged: string[];
  /**
   * the part of edgesChanged whose style changed
   */
  edgesRestyled: string[];
  /**
   * for setOptions: the options that changed, with their new values
   */
  options?: {
    node: Partial<import("./style.js").NodeOptions>;
    edge: Partial<import("./style.js").EdgeOptions>;
  };
  /**
   * problems in this change (left out, never fixed silently)
   */
  issues: Issue[];
};
export type ModelOptions = {
  /**
   * node appearance: NODE_OPTIONS (size, shape, colours,
   * labels and their size…)
   */
  node?: Partial<import("./style.js").NodeOptions>;
  /**
   * edge appearance: EDGE_OPTIONS
   */
  edge?: Partial<import("./style.js").EdgeOptions>;
  /**
   * a label's width at a font size; a renderer supplies a
   * real one when a controller connects them (until then, an estimate)
   */
  measure?: (text: string, size: number) => number;
  /**
   * throw on the first problem instead of listing it in `issues`
   */
  strict?: boolean;
  /**
   * hears an error thrown by a listener (or by
   * a queued change); without it, errors go to console.error. Never rethrown: the model stays committed.
   */
  onError?: (error: unknown, change: Change | null) => void;
};
export type Adjacency = {
  /**
   * per edge, its source node's index
   */
  source: Int32Array;
  /**
   * per edge, its target node's index
   */
  target: Int32Array;
  /**
   * per node v, its outgoing edges are outEdges[outStart[v] .. outStart[v + 1]]
   */
  outStart: Int32Array;
  /**
   * edge indices, grouped by source, in edge order
   */
  outEdges: Int32Array;
  /**
   * per node v, its incoming edges are inEdges[inStart[v] .. inStart[v + 1]]
   */
  inStart: Int32Array;
  /**
   * edge indices, grouped by target, in edge order
   */
  inEdges: Int32Array;
};
declare const colour: (v: any) => boolean;
/**
 * An icon: an image's URL, or an image already in hand (an HTMLImageElement, ImageBitmap, canvas: anything with a
 * width and a height that a canvas can draw). Only a URL survives toJSON.
 */
declare const icon: (v: any) => boolean;
/** What a node's `style` may set, and what each value must be. */
export declare const NODE_STYLE: {
  color: typeof colour;
  size: (v: any) => boolean;
  shape: (v: any) => boolean;
  stroke: typeof colour;
  strokeWidth: (v: any) => boolean;
  icon: typeof icon;
  badge: (v: any) => boolean;
};
/** What an edge's `style` may set. */
export declare const EDGE_STYLE: {
  color: typeof colour;
  width: (v: any) => boolean;
};
/**
 * Deep equality by value, as structuredClone sees values: NaN equals NaN, dates by time, regular expressions by
 * source and flags, arrays and typed arrays element by element, maps and sets by their entries, objects by their own
 * keys. Cycles are followed once.
 * @param {any} a
 * @param {any} b
 * @param {Map<object, object>} [seen] pairs already being compared (for cycles)
 * @returns {boolean}
 */
export declare function equal(
  a: any,
  b: any,
  seen?: Map<object, object>,
): boolean;
export declare class GraphModel {
  #private;
  strict: boolean;
  /** Hears errors thrown by listeners (see ModelOptions.onError); console.error when unset. */
  onError: (error: unknown, change: Change | null) => void;
  /**
   * How nodes and edges look: resolved NODE_OPTIONS and EDGE_OPTIONS.
   * @type {{ node: import("./style.js").NodeOptions, edge: import("./style.js").EdgeOptions }}
   */
  opts: {
    node: import("./style.js").NodeOptions;
    edge: import("./style.js").EdgeOptions;
  };
  /**
   * The options that were set on purpose (given here or to `setOptions`), by key: anything else is a default, and
   * a view may put its own default in its place (a layout's edge defaults, see LAYOUTS). Read only.
   * @type {{ node: ReadonlySet<string>, edge: ReadonlySet<string> }}
   */
  explicit: {
    node: ReadonlySet<string>;
    edge: ReadonlySet<string>;
  };
  /** @type {(text: string, size: number) => number} a label's width at a font size */
  measure: (text: string, size: number) => number;
  /** Whether `measure` is a real text measurement (given, or a renderer's), not the estimate. */
  measured: boolean;
  /** @type {Readonly<Record<string, any>>} the graph's `meta` (frozen) */
  meta: Readonly<Record<string, any>>;
  /** @type {Map<string, number>} node id → index, kept up to date in place */
  index: Map<string, number>;
  /** @type {Map<string, number>} edge id → index, kept up to date in place */
  edgeIndex: Map<string, number>;
  /** Bumped by every change. */
  version: number;
  /** Bumped when nodes or edges come, go or move: what a working graph (graph.js) is built for. */
  structureVersion: number;
  /** @type {Issue[]} problems found by the latest load or change */
  issues: Issue[];
  /** @type {Set<(change: Change, model: GraphModel) => void>} */
  listeners: Set<(change: Change, model: GraphModel) => void>;
  cache: Map<any, any>;
  widthCache: Map<any, any>;
  widths: Float64Array<ArrayBuffer>;
  /**
   * A model from JSON (the prismatrix-graph format, or plain `{ nodes, edges }`), or the model itself if given one.
   * @param {GraphJSON | GraphModel} input
   * @param {ModelOptions} [options]
   * @returns {GraphModel}
   */
  static from(
    input: GraphJSON | GraphModel,
    options?: ModelOptions,
  ): GraphModel;
  /**
   * @param {GraphJSON | GraphModel} [input] prismatrix-graph JSON, or plain `{ nodes, edges }`
   * @param {ModelOptions} [options]
   */
  constructor(
    input?: GraphJSON | GraphModel,
    { node, edge, measure, strict, onError }?: ModelOptions,
  );
  /**
   * The nodes, in order (a node's index is its position), frozen: a list read once stays as it was, whatever
   * changes later. A new one is made when first read after a change.
   * @type {ReadonlyArray<ModelNode>}
   */
  get nodes(): ReadonlyArray<ModelNode>;
  /**
   * The edges, in order, frozen (see `nodes`).
   * @type {ReadonlyArray<ModelEdge>}
   */
  get edges(): ReadonlyArray<ModelEdge>;
  /** How many nodes. */
  get size(): number;
  /**
   * The node with id `id`, or undefined.
   * @param {string | number} id
   * @returns {ModelNode | undefined}
   */
  node(id: string | number): ModelNode | undefined;
  /**
   * The edge with id `id`, or undefined.
   * @param {string | number} id
   * @returns {ModelEdge | undefined}
   */
  edge(id: string | number): ModelEdge | undefined;
  /**
   * The structure as flat typed arrays (compressed sparse rows): each edge's ends as node indices, and each node's
   * outgoing and incoming edges. Worked out the first time it's asked for after nodes or edges come or go, then
   * kept. The arrays are the model's: read them, don't write them.
   * @returns {Adjacency}
   */
  adjacency(): Adjacency;
  /** Per edge index, `[source index, target index]`. */
  get ends(): any;
  /** Per node index, the indices of the edges out of it, in edge order. */
  get outgoing(): any;
  /** Per node index, the indices of the edges into it, in edge order. */
  get incoming(): any;
  /**
   * Each node's label width at the current label size (world px): every distinct label is measured once and kept.
   * A label wider than the `labelMaxWidth` option is cut short with an ellipsis (fitLabel), as the painters draw it.
   */
  labelWidths(): Float64Array<ArrayBuffer>;
  /** A label's height (one line) at the current label size, world px. */
  get labelHeight(): number;
  /**
   * Measure labels with `measure` from now on (a renderer's real text measurement, say).
   * @param {(text: string, size: number) => number} measure
   */
  setMeasure(measure: (text: string, size: number) => number): void;
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
  onChange(listener: (change: Change, model: GraphModel) => void): () => void;
  /**
   * Make the model hold `input` (JSON, plain `{ nodes, edges }`, or another model), in its order. Nodes and edges
   * that are the same as before keep their records: nothing is copied, checked or measured again.
   * @param {GraphJSON | GraphModel} input
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  replace(input: GraphJSON | GraphModel): Change | null;
  /**
   * Apply a delta: removals first (a removed node takes its edges with it), then changes, then additions (appended,
   * in the order given). Anything that doesn't fit (a change to a node that isn't there, an edge to a missing node)
   * is listed in the change's issues and skipped. Costs what it changes: a change of data or style touches only
   * those records; additions are appended; only a removal renumbers the nodes or edges after it.
   * @param {Delta} delta
   * @returns {Change | null} what changed; null when nothing did (or when called from a listener: queued)
   */
  update(delta: Delta): Change | null;
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
  setOptions(
    options: {
      node?: Partial<import("./style.js").NodeOptions>;
      edge?: Partial<import("./style.js").EdgeOptions>;
    },
    {
      reset,
    }?: {
      reset?: boolean;
    },
  ): Change | null;
  /**
   * The graph read as a forest: breadth-first from every node nothing points to (in node order), then from any
   * node still unreached (cycles); the first edge to reach a node is its tree edge, any other edge into it is a
   * cross-link.
   * @returns {{ roots: number[], order: number[], parent: Int32Array, depth: Int32Array, children: number[][],
   *   leaves: Int32Array, descendants: Int32Array, tree: Uint8Array, maxDepth: number }}
   */
  forest(): {
    roots: number[];
    order: number[];
    parent: Int32Array;
    depth: Int32Array;
    children: number[][];
    leaves: Int32Array;
    descendants: Int32Array;
    tree: Uint8Array;
    maxDepth: number;
  };
  /**
   * The graph read as a DAG: edges that close a cycle (found depth-first from the forest's roots) are marked as
   * back edges, to be reversed for layout; with them reversed, a topological order and each node's longest path
   * from a source.
   * @returns {{ back: Uint8Array, order: number[], longest: Int32Array, sources: number[], sinks: number[] }}
   */
  dag(): {
    back: Uint8Array;
    order: number[];
    longest: Int32Array;
    sources: number[];
    sinks: number[];
  };
  /**
   * Counts that describe the graph's shape, for telemetry and tests. Worked out when first asked for after the
   * structure changes (it reads the forest and the DAG), then kept: changes don't pay for it.
   */
  stats(): any;
  /**
   * What differs from `previous` (another model, or JSON) to this model, by id: nodes and edges added, removed,
   * kept, and kept nodes whose label, style or data differ.
   * @param {GraphModel | GraphJSON} previous
   * @returns {{ nodesAdded: string[], nodesRemoved: string[], nodesKept: string[], nodesChanged: string[],
   *   edgesAdded: string[], edgesRemoved: string[] }}
   */
  diff(previous: GraphModel | GraphJSON): {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesKept: string[];
    nodesChanged: string[];
    edgesAdded: string[];
    edgesRemoved: string[];
  };
  /**
   * The model as prismatrix-graph JSON: GraphModel.from(model.toJSON()) gives an equal model.
   * @returns {GraphJSON}
   */
  toJSON(): GraphJSON;
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
export declare function compressedRows(
  n: number,
  source: Int32Array,
  target: Int32Array,
): Adjacency;
/**
 * A structure read as a forest (see GraphModel.forest): breadth-first from every node nothing points to (in node
 * order), then from any node still unreached (cycles); the first edge to reach a node is its tree edge.
 * @param {number} count nodes
 * @param {Adjacency} adjacency
 */
export declare function forestOf(
  count: number,
  { target, outStart, outEdges, inStart }: Adjacency,
): {
  roots: any[];
  order: any[];
  parent: Int32Array<ArrayBuffer>;
  depth: Int32Array<ArrayBuffer>;
  children: any[];
  leaves: Int32Array<ArrayBuffer>;
  descendants: Int32Array<ArrayBuffer>;
  tree: Uint8Array<ArrayBuffer>;
  maxDepth: number;
};
export {};
