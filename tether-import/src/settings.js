import { defaultsOf, describeSchema, resolve } from "./schema.js";

/**
 * Tether's settings: what an app lets its users choose (which layout, which way it flows, how the graph moves, and
 * the four forces). The finer constants behind them are the tuning (tuning.js).
 */

/** @type {import('./schema.js').Schema} */
export const SETTINGS_SCHEMA = Object.freeze({
  layout: {
    type: "enum",
    values: ["tree", "radial"],
    open: true, // and any layout added with registerLayout()
    default: "tree",
    group: "Layout",
    label: "Layout",
    hint: 'A registered layout: "tree" (directional), "radial", or your own (registerLayout).',
  },
  direction: {
    type: "enum",
    values: ["TB", "BT", "LR", "RL", "radial"],
    default: "BT",
    group: "Layout",
    label: "Direction",
    hint: 'Directional layouts: which way the graph flows, leaves → root ("BT": leaves at the bottom). "radial" is shorthand for layout: "radial".',
  },
  layered: {
    type: "boolean",
    default: false,
    group: "Layout",
    label: "Layered",
    hint: "Always use the layered layout (graphs with shared nodes or cycles), not a tidy tree.",
  },
  physicsMode: {
    type: "enum",
    values: ["elastic", "floating", "none"],
    default: "elastic",
    group: "Physics",
    label: "Physics",
    hint: "elastic: a dragged node pulls its neighbours, less with every link. floating: the whole graph is live. none: a dragged node moves alone.",
  },
  centerForce: {
    type: "number",
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
    group: "Physics",
    label: "Center",
    hint: "Pull toward the middle; also how firmly levels, rings and (elastic) rest positions hold.",
  },
  repelForce: {
    type: "number",
    default: 8,
    min: 0,
    max: 40,
    step: 0.5,
    group: "Physics",
    label: "Repel",
    hint: "Push between nodes; also the room left between siblings and for labels.",
  },
  linkForce: {
    type: "number",
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.01,
    group: "Physics",
    label: "Link strength",
    hint: "How hard links pull toward their length; (elastic) how far a pull reaches.",
  },
  linkDistance: {
    type: "number",
    default: 120,
    min: 10,
    max: 600,
    step: 5,
    group: "Physics",
    label: "Link distance",
    hint: "The length links settle at: the spacing between levels and rings.",
  },
  forces: {
    type: "array",
    default: [],
    group: "Physics",
    label: "Extra forces",
    hint: "Forces added to the simulation: instances, or { type, ...options } for forces added with registerForce().",
  },
});

/** @typedef {{ layout: string, direction: "TB" | "BT" | "LR" | "RL" | "radial", layered: boolean,
 *              physicsMode: "elastic" | "floating" | "none", centerForce: number, repelForce: number,
 *              linkForce: number, linkDistance: number,
 *              forces: (import('./forces.js').Force | { type: string, [option: string]: any })[] }} LayoutSettings */

/** @type {Readonly<LayoutSettings>} */
export const DEFAULT_SETTINGS = Object.freeze(defaultsOf(SETTINGS_SCHEMA));

/** Controls for settings UIs, in schema order. */
export const SETTINGS_OPTIONS = Object.freeze(describeSchema(SETTINGS_SCHEMA));

/**
 * The default settings with `settings` checked and applied. Keys this schema doesn't know are kept (an app's own
 * options can travel in the same object).
 * @param {Partial<LayoutSettings>} [settings]
 * @param {import('./schema.js').ResolveOptions} [options]
 * @returns {LayoutSettings}
 */
export function resolveSettings(settings, options = {}) {
  return resolve(SETTINGS_SCHEMA, settings, {
    scope: "Tether settings",
    allowUnknown: true,
    ...options,
  });
}
