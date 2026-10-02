// Snapshots: everything needed to see again exactly what a view showed. The graph (as prismatrix-graph JSON), the
// view's settings, the camera, the selection and collapsed nodes, and every shown node's layout state by id. Telemetry saves them (a button in the sandbox,
// and automatically when the page hits an error), tests load them to reproduce a bug, and they're the shape of a
// "save / load view" API later.
//
// Pure: no DOM. The format is documented in next/MODEL.md.

import { GraphModel } from "./model.js";

export const SNAPSHOT_FORMAT = "prismatrix-snapshot";
export const SNAPSHOT_VERSION = 1;

const round = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} view the parts of a view a snapshot records
 * @param {import("./graph.js").Graph} view.graph
 * @param {object} view.settings  layout, layoutOptions, physics, physicsOptions, node, edge, explicit, animation,
 *   renderer
 * @param {{ x: number, y: number, k: number }} view.camera
 * @param {string[]} [view.selection] the selected node ids, in the order they were selected
 * @param {string[]} [view.collapsed] the collapsed node ids (their hidden descendants have no state)
 * @param {string} [note]         why it was taken ("button", "error: …")
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
 * `state` is an object by id (own keys only: "constructor" isn't every node's state) or a Map.
 */
export function applyState(graph, state) {
  const stateOf =
    state instanceof Map
      ? (id) => state.get(id)
      : (id) => (state && Object.hasOwn(state, id) ? state[id] : undefined);
  for (const n of graph.nodes) {
    const s = stateOf(n.id);
    if (!s || typeof s !== "object") continue;
    n.x = s.x;
    n.y = s.y;
    n.homeX = s.homeX;
    n.homeY = s.homeY;
    n.vx = s.vx;
    n.vy = s.vy;
  }
}
