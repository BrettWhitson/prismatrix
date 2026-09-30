/**
 * Tether's settings: what an app lets its users choose (which layout, which way it flows, how the graph moves, and
 * the four forces). The finer constants behind them are the tuning (tuning.js).
 */
/** @type {import('./schema.js').Schema} */
export declare const SETTINGS_SCHEMA: import("./schema.js").Schema;
export type LayoutSettings = {
  layout: string;
  direction: "TB" | "BT" | "LR" | "RL" | "radial";
  layered: boolean;
  physicsMode: "elastic" | "floating" | "none";
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  forces: (
    | import("./forces.js").Force
    | {
        type: string;
        [option: string]: any;
      }
  )[];
};
/** @typedef {{ layout: string, direction: "TB" | "BT" | "LR" | "RL" | "radial", layered: boolean,
 *              physicsMode: "elastic" | "floating" | "none", centerForce: number, repelForce: number,
 *              linkForce: number, linkDistance: number,
 *              forces: (import('./forces.js').Force | { type: string, [option: string]: any })[] }} LayoutSettings */
/** @type {Readonly<LayoutSettings>} */
export declare const DEFAULT_SETTINGS: Readonly<LayoutSettings>;
/** Controls for settings UIs, in schema order. */
export declare const SETTINGS_OPTIONS: readonly (import("./schema.js").Field & {
  key: string;
})[];
/**
 * The default settings with `settings` checked and applied. Keys this schema doesn't know are kept (an app's own
 * options can travel in the same object).
 * @param {Partial<LayoutSettings>} [settings]
 * @param {import('./schema.js').ResolveOptions} [options]
 * @returns {LayoutSettings}
 */
export declare function resolveSettings(
  settings?: Partial<LayoutSettings>,
  options?: import("./schema.js").ResolveOptions,
): LayoutSettings;
