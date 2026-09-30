import { isHorizontalDirection, treeDirection } from "./directions.js";
import { layeredLayout } from "./layered.js";
import { radialTreeLayout, tidyTreeLayout } from "./trees.js";

/**
 * The layouts runLayout can use, by name. A layout places every node (writing graph.x / graph.y) and says how the
 * physics should hold that shape afterwards. Two are built in, "tree" and "radial"; add your own with
 * registerLayout:
 *
 *   registerLayout("grid", {
 *     label: "Grid",
 *     directional: false,
 *     seed(graph, settings, { siblingGap }) {
 *       const columns = Math.ceil(Math.sqrt(graph.count));
 *       for (let i = 0; i < graph.count; i++) {
 *         graph.x[i] = (i % columns) * (48 + siblingGap);
 *         graph.y[i] = Math.floor(i / columns) * settings.linkDistance;
 *       }
 *       return { mode: "none" }; // the forces polish it, with no levels or rings to keep
 *     },
 *   });
 *
 * seed() returns the simulation's structure (`{ mode: "layered", axis }`, `{ mode: "radial", depthById, rootId }` or
 * `{ mode: "none" }`), or null when it can't lay this graph out (no simulation: runLayout returns null).
 */

/**
 * @typedef {object} SeedContext
 * @property {typeof import('./tuning.js').PHYSICS_TUNING} tuning
 * @property {number} labelShare  0..1: how much of each label's overhang to leave room for
 * @property {number} siblingGap  space between siblings (from Repel)
 * @property {number} levelGap  space between levels (link distance minus the node size)
 * @property {(i: number) => { w: number, h: number }} sizeOf  node i's footprint with its share of label
 *
 * @typedef {{ mode: "layered", axis: "x" | "y" } | { mode: "radial", depthById: Map<string, number>, rootId: string }
 *   | { mode: "none" }} SeedResult
 *
 * @typedef {object} LayoutDefinition
 * @property {string} [label]  for settings UIs
 * @property {boolean} [directional]  levels along one axis (labels beside nodes in horizontal flows, right-angle
 *   edges): true for "tree"; false for radial and free layouts (default false)
 * @property {(graph: import('./layout-graph.js').LayoutGraph,
 *             settings: import('./settings.js').LayoutSettings, context: SeedContext) => SeedResult | null} seed
 */

/** @type {Map<string, LayoutDefinition>} */
const registry = new Map();

/**
 * Add a layout (or replace one, built-ins included).
 * @param {string} name
 * @param {LayoutDefinition} definition
 */
export function registerLayout(name, definition) {
  if (typeof name !== "string" || !name)
    throw new TypeError("registerLayout: the name must be a non-empty string");
  if (typeof definition?.seed !== "function")
    throw new TypeError(
      `registerLayout("${name}"): a layout needs a seed() function`,
    );
  registry.set(name, { directional: false, label: name, ...definition });
}

/** @returns {LayoutDefinition | undefined} */
export function getLayout(name) {
  return registry.get(name);
}

/** The registered layouts: [{ name, label, directional }]. */
export function listLayouts() {
  return [...registry].map(([name, { label, directional }]) => ({
    name,
    label,
    directional,
  }));
}

/** The layout the settings ask for: `layout`, with `direction: "radial"` as shorthand for the radial layout. */
export function layoutNameOf(settings) {
  return settings.direction === "radial"
    ? "radial"
    : (settings.layout ?? "tree");
}

/**
 * How the laid-out graph flows, for whoever draws it: whether its levels run along an axis, which axis, which way
 * the root lies (a unit vector; zero when there's no direction), and which way the tree grows (root → leaves, as a
 * direction: "TB", "BT", "LR", "RL"). Renderers read this instead of interpreting the settings themselves.
 * @param {Partial<import('./settings.js').LayoutSettings>} settings
 * @returns {{ directional: boolean, axis: "x" | "y" | null, rootSide: { x: number, y: number },
 *             growth: "TB" | "BT" | "LR" | "RL" | null }}
 */
export function flowOf(settings) {
  if (!isDirectionalLayout(settings))
    return {
      directional: false,
      axis: null,
      rootSide: { x: 0, y: 0 },
      growth: null,
    };
  const direction = settings.direction ?? "BT";
  const growth = /** @type {"TB" | "BT" | "LR" | "RL"} */ (
    treeDirection(direction)
  );
  // The direction names the flow leaves → root, so the root lies at its far end.
  const rootSide = {
    TB: { x: 0, y: 1 },
    BT: { x: 0, y: -1 },
    LR: { x: 1, y: 0 },
    RL: { x: -1, y: 0 },
  }[direction] ?? {
    x: 0,
    y: -1,
  };
  return {
    directional: true,
    axis: isHorizontalDirection(direction) ? "x" : "y",
    rootSide,
    growth,
  };
}

/** Does this layout spread levels along an axis (the direction)? Unknown layouts count as the tree they fall back to. */
export function isDirectionalLayout(settings) {
  return (registry.get(layoutNameOf(settings)) ?? registry.get("tree"))
    .directional;
}

// ---------------------------------------------------------------- built in

registerLayout("tree", {
  label: "Directional tree",
  directional: true,
  /**
   * A tidy tree (over a spanning tree: a node with several parents sits under the first), or the layered layout
   * (for `layered: true`, the way to lay out a DAG, or a graph without a root). The physics then pulls each node
   * toward its level.
   */
  seed(graph, s, { tuning: t, labelShare, siblingGap, levelGap }) {
    const horizontal = isHorizontalDirection(s.direction);
    const growth = treeDirection(s.direction); // root → leaves
    const seeded =
      !s.layered &&
      tidyTreeLayout(graph, {
        direction: growth,
        siblingGap,
        levelGap,
        breadthLabelShare: labelShare,
      });
    if (!seeded) {
      const [widthLabelShare, heightLabelShare] = horizontal
        ? [1, labelShare]
        : [labelShare, 1];
      layeredLayout(graph, {
        direction: growth,
        nodeSep: siblingGap,
        rankSep: levelGap,
        edgeSep: t.edgeGap,
        widthLabelShare,
        heightLabelShare,
        sweeps: t.crossingSweeps,
        transposePasses: t.transposePasses,
        alignRounds: t.alignRounds,
        rankPasses: t.rankPasses,
        longEdgeWeight: t.longEdgeWeight,
      });
    }
    return { mode: "layered", axis: horizontal ? "x" : "y" };
  },
});

registerLayout("radial", {
  label: "Radial",
  directional: false,
  /** A radial tree (the root in the centre, one ring per depth); the physics pulls each node toward its ring. */
  seed(graph, s, { siblingGap }) {
    const tree = radialTreeLayout(graph, {
      siblingGap,
      ringStep: s.linkDistance,
    });
    if (!tree) return null;
    return { mode: "radial", depthById: tree.depthById, rootId: tree.rootId };
  },
});
