// Snapshots: everything needed to see again exactly what a view showed. The graph (as prismatrix-graph JSON), the
// view's settings, the camera, the selection and collapsed nodes, and every shown node's layout state by id. Telemetry saves them (a button in the sandbox,
// and automatically when the page hits an error), tests load them to reproduce a bug, and they're the shape of a
// "save / load view" API later.
//
// Pure: no DOM. The format is documented in MODEL.md.

import { GraphModel } from "./model.js";

export const SNAPSHOT_FORMAT = "prismatrix-snapshot";
export const SNAPSHOT_VERSION = 1;

const round = (v) => Math.round(v * 100) / 100;

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
 * @typedef {object} Snapshot A view, as JSON (the prismatrix-snapshot format, MODEL.md).
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
export function takeSnapshot(
  { graph, settings, camera, selection = [], collapsed = [] },
  note = "",
) {
  // Keyed by id with no prototype: an id like "__proto__" or "constructor" is just a key (JSON keeps it as one).
  const state = Object.create(null);
  for (const n of graph.nodes)
    state[n.id] = {
      x: round(n.x),
      y: round(n.y),
      homeX: round(n.homeX),
      homeY: round(n.homeY),
      vx: round(n.vx),
      vy: round(n.vy),
    };
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    time: new Date().toISOString(),
    ...(note && { note }),
    graph: graph.model.toJSON(),
    stats: graph.model.stats(),
    issues: graph.model.issues,
    settings: structuredClone(settings),
    camera: { x: round(camera.x), y: round(camera.y), k: camera.k },
    selection: [...selection],
    collapsed: [...collapsed],
    state,
  };
}

/**
 * Check a snapshot and return its graph model; throws on anything that isn't a snapshot this engine can read.
 * @param {Snapshot} snapshot
 * @returns {GraphModel}
 */
export function snapshotModel(snapshot) {
  if (snapshot?.format !== SNAPSHOT_FORMAT)
    throw new Error("Prismatrix: not a prismatrix-snapshot");
  if (snapshot.version > SNAPSHOT_VERSION)
    throw new Error(
      `Prismatrix: snapshot version ${snapshot.version} is newer than this engine reads (${SNAPSHOT_VERSION})`,
    );
  return GraphModel.from(snapshot.graph);
}

/**
 * Put a snapshot's recorded layout state onto a working graph's nodes, by id. Nodes it doesn't mention keep theirs.
 * `state` is an object by id (own keys only: "constructor" isn't every node's state).
 * @param {import("./graph.js").Graph} graph
 * @param {Record<string, NodeState>} state
 */
export function applyState(graph, state) {
  for (const n of graph.nodes) {
    const s = state && Object.hasOwn(state, n.id) ? state[n.id] : undefined;
    if (!s || typeof s !== "object") continue;
    n.x = s.x;
    n.y = s.y;
    n.homeX = s.homeX;
    n.homeY = s.homeY;
    n.vx = s.vx;
    n.vy = s.vy;
  }
}
