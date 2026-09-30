/**
 * Extra forces for the simulation (physics.js). A force is any object with `apply(simulation, alpha)`, which adds to
 * the simulation's velocities (vx, vy) in proportion to `alpha` (the temperature: it cools to 0 as the graph
 * settles, and a drag warms it). `initialize(simulation)` runs once, when the force joins a simulation.
 *
 * Pass them in the settings, as instances or as `{ type, ...options }` for a registered type:
 *
 *   registerForce("wind", ({ strength = 0.5 }) => ({
 *     apply(sim, alpha) { for (let i = 0; i < sim.count; i++) sim.vx[i] += strength * alpha; },
 *   }));
 *   runLayout(graph, { ...settings, forces: [{ type: "wind", strength: 0.2 }] });
 *
 * Built in: "position" (pull toward a point or a line) and "radial" (pull toward a circle).
 * Per-node values can be functions of the node id: `x: (id) => …`.
 */
export type Force = {
  apply: (
    simulation: import("./physics.js").ForceSimulation,
    alpha: number,
  ) => void;
  initialize?: (simulation: import("./physics.js").ForceSimulation) => void;
  type?: string;
};
/**
 * Make a force type available by name, for `{ type: name, ...options }` in the settings.
 * @param {string} type
 * @param {(options: any) => Force} factory
 */
export declare function registerForce(
  type: string,
  factory: (options: any) => Force,
): void;
/** The names of the registered force types. */
export declare function forceTypes(): string[];
/**
 * A force from a spec: an instance is used as it is; `{ type, ...options }` is built by its registered factory.
 * Unknown types and malformed specs are warned about and skipped (null).
 * @param {Force | { type: string, [option: string]: any }} spec
 * @returns {Force | null}
 */
export declare function createForce(
  spec:
    | Force
    | {
        type: string;
        [option: string]: any;
      },
): Force | null;
/** Every spec in `specs` as a force (unknown ones left out). */
export declare function createForces(specs?: any[]): Force[];
