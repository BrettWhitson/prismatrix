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

/**
 * @typedef {object} Force
 * @property {(simulation: import('./physics.js').ForceSimulation, alpha: number) => void} apply
 * @property {(simulation: import('./physics.js').ForceSimulation) => void} [initialize]
 * @property {string} [type]
 */

/** @type {Map<string, (options: any) => Force>} */
const registry = new Map();

/**
 * Make a force type available by name, for `{ type: name, ...options }` in the settings.
 * @param {string} type
 * @param {(options: any) => Force} factory
 */
export function registerForce(type, factory) {
  if (typeof type !== "string" || !type)
    throw new TypeError("registerForce: the type must be a non-empty string");
  if (typeof factory !== "function")
    throw new TypeError(
      `registerForce("${type}"): the factory must be a function`,
    );
  registry.set(type, factory);
}

/** The names of the registered force types. */
export function forceTypes() {
  return [...registry.keys()];
}

/**
 * A force from a spec: an instance is used as it is; `{ type, ...options }` is built by its registered factory.
 * Unknown types and malformed specs are warned about and skipped (null).
 * @param {Force | { type: string, [option: string]: any }} spec
 * @returns {Force | null}
 */
export function createForce(spec) {
  if (spec && typeof spec.apply === "function")
    return /** @type {Force} */ (spec);
  const factory = spec && registry.get(spec.type);
  if (!factory) {
    console.warn(
      `Tether: unknown force ${JSON.stringify(spec?.type ?? spec)}; known types: ${forceTypes().join(", ")}`,
    );
    return null;
  }
  const force = factory(spec);
  if (typeof force?.apply !== "function")
    throw new TypeError(
      `Force "${spec.type}": its factory must return an object with apply(simulation, alpha)`,
    );
  return Object.assign(force, { type: spec.type });
}

/** Every spec in `specs` as a force (unknown ones left out). */
export function createForces(specs = []) {
  return specs.map(createForce).filter(Boolean);
}

/** A per-node value: a constant, or a function of the node id. */
function perNode(value, fallback) {
  if (typeof value === "function") return value;
  const constant = value ?? fallback;
  return () => constant;
}

/**
 * Pull nodes toward a point, or toward a line when only x or only y is given.
 * Options: x, y (number or (id) => number | null for "no pull on this axis"), strength (0..1, default 0.1).
 */
registerForce("position", ({ x = null, y = null, strength = 0.1 }) => {
  const xOf = perNode(x, null),
    yOf = perNode(y, null),
    strengthOf = perNode(strength, 0.1);
  let targetX, targetY, k;
  return {
    initialize(sim) {
      targetX = sim.ids.map((id) => xOf(id));
      targetY = sim.ids.map((id) => yOf(id));
      k = Float64Array.from(sim.ids, (id) => strengthOf(id));
    },
    apply(sim, alpha) {
      for (let i = 0; i < sim.count; i++) {
        if (targetX[i] != null)
          sim.vx[i] += (targetX[i] - sim.x[i]) * k[i] * alpha;
        if (targetY[i] != null)
          sim.vy[i] += (targetY[i] - sim.y[i]) * k[i] * alpha;
      }
    },
  };
});

/**
 * Pull nodes toward a circle.
 * Options: radius (number or (id) => number), x, y (centre, default 0, 0), strength (0..1, default 0.1).
 */
registerForce("radial", ({ radius = 100, x = 0, y = 0, strength = 0.1 }) => {
  const radiusOf = perNode(radius, 100),
    strengthOf = perNode(strength, 0.1);
  let r, k;
  return {
    initialize(sim) {
      r = Float64Array.from(sim.ids, (id) => radiusOf(id));
      k = Float64Array.from(sim.ids, (id) => strengthOf(id));
    },
    apply(sim, alpha) {
      for (let i = 0; i < sim.count; i++) {
        const dx = sim.x[i] - x || 0.01,
          dy = sim.y[i] - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const pull = ((r[i] - distance) / distance) * k[i] * alpha;
        sim.vx[i] += dx * pull;
        sim.vy[i] += dy * pull;
      }
    },
  };
});
