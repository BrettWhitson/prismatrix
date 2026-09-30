import { ElasticNetwork } from "./elastic.js";
import { Emitter } from "./emitter.js";
import { flowOf } from "./layouts.js";
import { PHYSICS_TUNING, resolveTuning } from "./tuning.js";

/**
 * Tether's physics after the layout: dragging, shaking, floating into place. A renderer tells it what the pointer
 * does and calls step() once per frame while `active`, drawing the positions it returns; everything that moves
 * (and how) is decided here, in the chosen physics mode:
 *
 *  - elastic: the graph is an elastic net around where it rests (elastic.js). The held node's neighbours follow,
 *    theirs less, fading with every link; what isn't connected, or is far enough away, stays still. Letting go keeps
 *    the pulled shape. Link force sets how far a pull reaches, center force how firmly nodes hold on.
 *  - floating: the whole graph is live (the layout's force simulation, physics.js): the held node drags its
 *    neighbours, the rest sways and makes room, and it all settles again after you let go.
 *  - none: the held node moves alone.
 *
 *   const physics = new LivePhysics(settings);
 *   physics.simulation = runLayout(graph, settings);
 *   physics.grab(id, { ids, links, positionOf });   // then physics.drag(id, point) as the pointer moves
 *   while (physics.active) draw(physics.step().moved);
 *
 * Positions are read through `positionOf(id)`, so the physics starts from what's on screen (a transition may still
 * be under way). A drag stays in the mode it started in, even if the mode setting changes before it ends.
 *
 * Events (physics.on(type, listener) returns an unsubscribe function):
 *  - "grab" ({ id, mode }), "release" ({ id, mode }): a node was grabbed or let go;
 *  - "start" ({ reason }): step() has something to move again ("drag", "shake" or "float-in");
 *  - "settle" (): everything is still again (step() went quiet, or stop()).
 * @extends {Emitter<{ grab: [{ id: string, mode: string }], release: [{ id: string, mode: string }],
 *                     start: [{ reason: string }], settle: [] }>}
 */
export class LivePhysics extends Emitter {
  #simulation = null;
  #settings;
  #tuning = { ...PHYSICS_TUNING };
  /** What step() advances: "net" (the elastic net), "simulation", "single" (mode none), or null (nothing moving). */
  #running = null;
  /** For a simulation run: its own finish line, or null (until it cools). */
  #until = null;
  #net = null;
  #netIds = [];
  /** Mode none: where the held node goes next, or null. */
  #single = null;
  /** Mode none: "start" was announced at the grab, and "settle" is due once it's let go and drawn. */
  #singleOpen = false;
  /** The node being dragged and the engine holding it ("net", "simulation" or "single"), or null. */
  #held = null;
  /** step()'s list of moved nodes for a simulation run, reused frame to frame. */
  #moved = [];

  /**
   * @param {{ physicsMode?: string, linkForce: number, centerForce: number, direction: string, layout?: string }} settings
   *   read on every grab, so the caller may change them in place
   */
  constructor(settings) {
    super();
    this.#settings = settings;
  }

  /** The layout's force simulation (from runLayout), or null. Floating mode, shake() and floatIn() need one. */
  get simulation() {
    return this.#simulation;
  }

  /** A new layout's simulation: whatever the old one was doing stops (and lets go of a held node). */
  set simulation(simulation) {
    if (simulation === this.#simulation) return;
    this.stop();
    this.#simulation = simulation ?? null;
    this.#moved = [];
  }

  get tuning() {
    return { ...this.#tuning };
  }

  /**
   * PHYSICS_TUNING (tuning.js) with these overrides, checked (see resolveTuning); every other constant goes back to
   * its default. Applies to the running simulation too.
   */
  set tuning(tuning) {
    this.#tuning = resolveTuning(tuning);
    if (this.#simulation) Object.assign(this.#simulation.tuning, this.#tuning);
  }

  /** Does step() have anything to move? */
  get active() {
    return this.#running !== null;
  }

  /** The node being dragged, or null. */
  get heldId() {
    return this.#held?.id ?? null;
  }

  /** The elastic net while a node is held and until it settles, or null (for developer tools). */
  get elasticNet() {
    return this.#net;
  }

  /**
   * A node is grabbed. Nodes `positionOf` knows nothing about (on their way out, say) sit the drag out.
   * @param {string} id
   * @param {{ ids: string[], links: { source: string, target: string }[],
   *           positionOf: (id: string) => { x: number, y: number } | null | undefined }} graph  what's on screen
   */
  grab(id, { ids, links, positionOf }) {
    this.stop();
    const at = positionOf(id);
    if (!at) return;
    const mode = this.#settings.physicsMode ?? "elastic";
    if (mode === "none") {
      this.#held = { id, engine: "single" };
      this.emit("grab", { id, mode });
      // One start and one settle per drag (not per frame): the node moves alone, only while it's held.
      this.#singleOpen = true;
      this.emit("start", { reason: "drag" });
      return;
    }
    if (mode === "floating") {
      if (!this.#simulation) return;
      this.emit("grab", { id, mode });
      this.#runSimulation(
        positionOf,
        (simulation) => {
          simulation.reheat(this.#tuning.dragHeat);
          // What's on screen is rest: only what the drag changes moves anything.
          simulation.holdRest();
          simulation.fix(id, at);
        },
        null,
        "drag",
      );
      this.#held = { id, engine: "simulation" };
      return;
    }
    const placed = [],
      xs = [],
      ys = [];
    for (const nodeId of ids) {
      const p = positionOf(nodeId);
      if (!p) continue;
      placed.push(nodeId);
      xs.push(p.x);
      ys.push(p.y);
    }
    const index = new Map(placed.map((nodeId, i) => [nodeId, i]));
    const sources = [],
      targets = [];
    for (const link of links) {
      const s = index.get(link.source),
        t = index.get(link.target);
      if (s == null || t == null || s === t) continue;
      sources.push(s);
      targets.push(t);
    }
    const s = this.#settings,
      t = this.#tuning;
    this.#net = new ElasticNetwork(
      { ids: placed, x: xs, y: ys, sources, targets },
      {
        stiffness:
          t.elasticStiffnessBase + t.elasticStiffnessPerLink * s.linkForce,
        anchor: t.elasticAnchorBase + t.elasticAnchorPerCenter * s.centerForce,
        damping: t.elasticDamping,
        // Trees hold their levels more firmly than their place along them.
        alongAxis: flowOf(s).axis,
        alongHold: t.elasticAlongHold,
        wake: t.elasticWake,
        rest: t.elasticRest,
      },
    );
    this.#netIds = placed;
    this.#net.grab(id, at);
    this.#held = { id, engine: "net" };
    this.emit("grab", { id, mode: "elastic" });
    this.#run("net", "drag");
  }

  /** The held node moved to `point`. */
  drag(id, point) {
    if (this.#held?.id !== id) return;
    const { engine } = this.#held;
    if (engine === "single") {
      this.#single = { id, x: point.x, y: point.y };
      this.#running = "single";
      return;
    }
    if (engine === "simulation") {
      if (!this.#simulation) return;
      this.#simulation.fix(id, point);
      if (!this.#running) this.#run("simulation", "drag");
      return;
    }
    if (!this.#net) return;
    this.#net.move(id, point);
    if (!this.#running) this.#run("net", "drag");
  }

  /** The held node was let go. */
  release(id) {
    if (this.#held?.id !== id) return;
    const { engine } = this.#held;
    this.#held = null;
    this.emit("release", { id, mode: MODE_OF_ENGINE[engine] });
    if (engine === "single") {
      if (!this.#running) this.#closeSingle(); // else after the last move is drawn
      return;
    }
    if (engine === "simulation") {
      if (!this.#simulation) return;
      this.#simulation.release(id);
      // Settle at the drag heat, and stop once still: the forces at rest were recorded at that heat (holdRest), and
      // only there do they cancel exactly. Cooling instead unbalances busy nodes, and the graph wanders off.
      let ticks = 0;
      this.#until = (simulation) =>
        ++ticks >= this.#tuning.releaseTicks ||
        // Still enough: nothing moves more than the dead zone would let a resting node move.
        simulation.motion <
          Math.max(this.#tuning.stillness, this.#tuning.deadZone);
      if (!this.#running) this.#run("simulation", "drag");
      return;
    }
    if (!this.#net) return;
    this.#net.release(id);
    if (!this.#running) this.#run("net", "drag");
  }

  /**
   * Shake the physics and let it settle: optionally scatter every node by up to `scatter` world units (the same way
   * each time), heat the simulation to `heat` (0..1) and let it cool. Returns false without a simulation.
   */
  shake(positionOf, { heat = 0.6, scatter = 0 } = {}) {
    return this.#runSimulation(
      positionOf,
      (simulation) => {
        if (scatter)
          for (let i = 0; i < simulation.count; i++) {
            simulation.x[i] += (unitNoise(i * 2) * 2 - 1) * scatter;
            simulation.y[i] += (unitNoise(i * 2 + 1) * 2 - 1) * scatter;
          }
        simulation.alphaTarget = 0;
        simulation.alpha = Math.max(simulation.alpha, heat);
      },
      null,
      "shake",
    );
  }

  /**
   * A new layout floats into place from its seed (runLayout with `settle: false`), cooling to the drag heat and
   * stopping once still there (or after floatInTicks: crowded graphs can jitter at that heat for good), so a node
   * grabbed later only moves what's near it. Returns false without a simulation.
   */
  floatIn() {
    let ticks = 0;
    return this.#runSimulation(
      null,
      (simulation) => {
        simulation.alpha = 1;
        simulation.alphaTarget = this.#tuning.dragHeat;
      },
      (simulation) =>
        ++ticks >= this.#tuning.floatInTicks ||
        (simulation.alpha - simulation.alphaTarget < 0.01 &&
          simulation.motion < this.#tuning.stillness),
      "float-in",
    );
  }

  /** Stop whatever is moving (a drag settling, a shake, floating in), and let go of a held node. */
  stop() {
    if (this.#held?.engine === "simulation" && this.#simulation) {
      this.#simulation.release(this.#held.id);
      this.#simulation.reheat(0);
    }
    this.#held = null;
    this.#until = null;
    this.#net = null;
    this.#single = null;
    if (this.#running === "single") this.#running = null;
    this.#quiet();
    this.#closeSingle();
  }

  /** Mode none: the drag is over. */
  #closeSingle() {
    if (!this.#singleOpen) return;
    this.#singleOpen = false;
    this.emit("settle");
  }

  /**
   * Advance one frame. `moved` lists [id, x, y] for every node that moved (for a simulation run the same array is
   * reused next frame, so read it before calling step() again); `moving` is false once everything is still (then
   * `active` is false too, until the next grab, drag, release or shake).
   * @returns {{ moving: boolean, moved: [string, number, number][] }}
   */
  step() {
    if (this.#running === "single") {
      const single = this.#single;
      this.#single = null;
      this.#running = null;
      if (!this.#held) this.#closeSingle();
      return {
        moving: false,
        moved: single ? [[single.id, single.x, single.y]] : [],
      };
    }
    if (this.#running === "net") {
      const net = this.#net,
        ids = this.#netIds;
      const moving = net.step();
      const moved = net.changed.map((i) => [ids[i], net.x[i], net.y[i]]);
      if (!moving) {
        if (!net.held.includes(1)) this.#net = null;
        this.#quiet();
      }
      return { moving, moved };
    }
    if (this.#running === "simulation") {
      const simulation = this.#simulation;
      if (!simulation) {
        this.stop();
        return { moving: false, moved: [] };
      }
      simulation.tick();
      const { ids, x, y } = simulation;
      if (this.#moved.length !== ids.length)
        this.#moved = ids.map((id) => [id, 0, 0]);
      const moved = this.#moved;
      for (let i = 0; i < ids.length; i++) {
        moved[i][1] = x[i];
        moved[i][2] = y[i];
      }
      const until = this.#until;
      const done = until ? until(simulation) : !simulation.isActive;
      if (done) {
        if (until) simulation.alpha = simulation.alphaTarget = 0;
        this.#until = null;
        this.#quiet();
      }
      return { moving: !done, moved };
    }
    return { moving: false, moved: [] };
  }

  /** Start moving (`what`, for step()), announcing it if nothing was moving. */
  #run(what, reason) {
    const was = this.#running;
    this.#running = what;
    if (!was) this.emit("start", { reason });
  }

  /** Nothing moves any more (announced if something was). */
  #quiet() {
    const was = this.#running;
    this.#running = null;
    if (was) this.emit("settle");
  }

  /** Run the simulation from what's on screen (or, without `positionOf`, its own positions) after `prepare`. */
  #runSimulation(positionOf, prepare, until, reason) {
    const simulation = this.#simulation;
    if (!simulation) return false;
    this.stop();
    if (positionOf) simulation.setPositions(positionOf);
    prepare(simulation);
    this.#until = until;
    this.#run("simulation", reason);
    return true;
  }
}

const MODE_OF_ENGINE = {
  single: "none",
  simulation: "floating",
  net: "elastic",
};

/** A repeatable pseudo-random number in [0, 1) for an integer. */
function unitNoise(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
