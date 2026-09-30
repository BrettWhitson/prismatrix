export type SeedContext = {
  tuning: typeof import("./tuning.js").PHYSICS_TUNING;
  /**
   * 0..1: how much of each label's overhang to leave room for
   */
  labelShare: number;
  /**
   * space between siblings (from Repel)
   */
  siblingGap: number;
  /**
   * space between levels (link distance minus the node size)
   */
  levelGap: number;
  /**
   * node i's footprint with its share of label
   */
  sizeOf: (i: number) => {
    w: number;
    h: number;
  };
};
export type SeedResult =
  | {
      mode: "layered";
      axis: "x" | "y";
    }
  | {
      mode: "radial";
      depthById: Map<string, number>;
      rootId: string;
    }
  | {
      mode: "none";
    };
export type LayoutDefinition = {
  /**
   * for settings UIs
   */
  label?: string;
  /**
   * levels along one axis (labels beside nodes in horizontal flows, right-angle
   * edges): true for "tree"; false for radial and free layouts (default false)
   */
  directional?: boolean;
  seed: (
    graph: import("./layout-graph.js").LayoutGraph,
    settings: import("./settings.js").LayoutSettings,
    context: SeedContext,
  ) => SeedResult | null;
};
/**
 * Add a layout (or replace one, built-ins included).
 * @param {string} name
 * @param {LayoutDefinition} definition
 */
export declare function registerLayout(
  name: string,
  definition: LayoutDefinition,
): void;
/** @returns {LayoutDefinition | undefined} */
export declare function getLayout(name: any): LayoutDefinition | undefined;
/** The registered layouts: [{ name, label, directional }]. */
export declare function listLayouts(): {
  name: string;
  label: string;
  directional: boolean;
}[];
/** The layout the settings ask for: `layout`, with `direction: "radial"` as shorthand for the radial layout. */
export declare function layoutNameOf(settings: any): any;
/**
 * How the laid-out graph flows, for whoever draws it: whether its levels run along an axis, which axis, which way
 * the root lies (a unit vector; zero when there's no direction), and which way the tree grows (root → leaves, as a
 * direction: "TB", "BT", "LR", "RL"). Renderers read this instead of interpreting the settings themselves.
 * @param {Partial<import('./settings.js').LayoutSettings>} settings
 * @returns {{ directional: boolean, axis: "x" | "y" | null, rootSide: { x: number, y: number },
 *             growth: "TB" | "BT" | "LR" | "RL" | null }}
 */
export declare function flowOf(
  settings: Partial<import("./settings.js").LayoutSettings>,
): {
  directional: boolean;
  axis: "x" | "y" | null;
  rootSide: {
    x: number;
    y: number;
  };
  growth: "TB" | "BT" | "LR" | "RL" | null;
};
/** Does this layout spread levels along an axis (the direction)? Unknown layouts count as the tree they fall back to. */
export declare function isDirectionalLayout(settings: any): boolean;
