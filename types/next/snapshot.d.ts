import { GraphModel } from "./model.js";
export declare const SNAPSHOT_FORMAT = "prismatrix-snapshot";
export declare const SNAPSHOT_VERSION = 1;
export type NodeState = {
  /**
   * where it is
   */
  x: number;
  y: number;
  /**
   * where its layout wants it
   */
  homeX: number;
  homeY: number;
  /**
   * how fast it's moving, world px/s
   */
  vx: number;
  vy: number;
};
export type SnapshotSettings = {
  layout: import("./controller.js").LayoutName;
  layoutOptions: Record<string, any>;
  physics: import("./controller.js").PhysicsMode;
  physicsOptions: Record<string, any>;
  node: import("./style.js").NodeOptions;
  /**
   * the edge options shown (with the layout's own defaults)
   */
  edge: import("./style.js").EdgeOptions;
  /**
   * the node and edge options set on purpose (the rest are
   * defaults: restore sets only these again, so a layout's own defaults still apply to the rest)
   */
  explicit?: {
    node: string[];
    edge: string[];
  };
  animation: import("./animation.js").AnimationOptions;
  /**
   * "webgl" or "canvas" (not restored: it depends on the machine)
   */
  renderer?: string;
};
export type Snapshot = {
  format: "prismatrix-snapshot";
  version: number;
  /**
   * when it was taken (ISO 8601)
   */
  time: string;
  /**
   * why it was taken
   */
  note?: string;
  graph: import("./model.js").GraphJSON;
  /**
   * what the model said about the graph (GraphModel.stats)
   */
  stats: Record<string, number>;
  issues: import("./model.js").Issue[];
  settings: SnapshotSettings;
  camera: import("./camera.js").Camera;
  /**
   * the selected node ids, in the order they were selected
   */
  selection?: string[];
  /**
   * the collapsed node ids
   */
  collapsed?: string[];
  /**
   * every shown node's layout state, by id
   */
  state: Record<string, NodeState>;
};
/**
 * @typedef {object} NodeState A node's layout state, rounded to hundredths.
 * @property {number} x       where it is
 * @property {number} y
 * @property {number} homeX   where its layout wants it
 * @property {number} homeY
 * @property {number} vx      how fast it's moving, world px/s
 * @property {number} vy
 *
 * @typedef {object} SnapshotSettings The view's resolved options: everything that decides how it looks and moves.
 * @property {import("./controller.js").LayoutName} layout
 * @property {Record<string, any>} layoutOptions
 * @property {import("./controller.js").PhysicsMode} physics
 * @property {Record<string, any>} physicsOptions
 * @property {import("./style.js").NodeOptions} node
 * @property {import("./style.js").EdgeOptions} edge the edge options shown (with the layout's own defaults)
 * @property {{ node: string[], edge: string[] }} [explicit] the node and edge options set on purpose (the rest are
 *   defaults: restore sets only these again, so a layout's own defaults still apply to the rest)
 * @property {import("./animation.js").AnimationOptions} animation
 * @property {string} [renderer] "webgl" or "canvas" (not restored: it depends on the machine)
 *
 * @typedef {object} Snapshot A view, as JSON (the prismatrix-snapshot format, next/MODEL.md).
 * @property {"prismatrix-snapshot"} format
 * @property {number} version
 * @property {string} time       when it was taken (ISO 8601)
 * @property {string} [note]     why it was taken
 * @property {import("./model.js").GraphJSON} graph
 * @property {Record<string, number>} stats what the model said about the graph (GraphModel.stats)
 * @property {import("./model.js").Issue[]} issues
 * @property {SnapshotSettings} settings
 * @property {import("./camera.js").Camera} camera
 * @property {string[]} [selection] the selected node ids, in the order they were selected
 * @property {string[]} [collapsed] the collapsed node ids
 * @property {Record<string, NodeState>} state every shown node's layout state, by id
 */
/**
 * @param {object} view the parts of a view a snapshot records
 * @param {import("./graph.js").Graph} view.graph
 * @param {SnapshotSettings} view.settings
 * @param {{ x: number, y: number, k: number }} view.camera
 * @param {string[]} [view.selection] the selected node ids, in the order they were selected
 * @param {string[]} [view.collapsed] the collapsed node ids (their hidden descendants have no state)
 * @param {string} [note]         why it was taken ("button", "error: …")
 * @returns {Snapshot}
 */
export declare function takeSnapshot(
  {
    graph,
    settings,
    camera,
    selection,
    collapsed,
  }: {
    graph: import("./graph.js").Graph;
    settings: SnapshotSettings;
    camera: {
      x: number;
      y: number;
      k: number;
    };
    selection?: string[];
    collapsed?: string[];
  },
  note?: string,
): Snapshot;
/**
 * Check a snapshot and return its graph model; throws on anything that isn't a snapshot this engine can read.
 * @param {Snapshot} snapshot
 * @returns {GraphModel}
 */
export declare function snapshotModel(snapshot: Snapshot): GraphModel;
/**
 * Put a snapshot's recorded layout state onto a working graph's nodes, by id. Nodes it doesn't mention keep theirs.
 * `state` is an object by id (own keys only: "constructor" isn't every node's state) or a Map.
 * @param {import("./graph.js").Graph} graph
 * @param {Record<string, NodeState> | Map<string, NodeState>} state
 */
export declare function applyState(
  graph: import("./graph.js").Graph,
  state: Record<string, NodeState> | Map<string, NodeState>,
): void;
