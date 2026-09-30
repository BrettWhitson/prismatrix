/**
 * Tether's physics: a force simulation behind every layout, Four forces,
 * one setting each, all acting in every direction:
 *
 *  - center:   pulls nodes toward the graph's own middle (keeps it compact without moving it)
 *  - repel:    pushes nodes away from each other (Barnes-Hut, O(n log n))
 *  - link:     how strongly links pull their ends toward the link distance (0 = links don't pull at all)
 *  - distance: the length links settle at
 *
 * Plus a structure force for the layout, and collision so nodes (and their labels) don't overlap:
 *  - "layered": each node is pulled toward the line for its level, `distance` apart along the flow axis;
 *  - "radial":  the result is pinned in the centre; each node is pulled toward the ring for its depth;
 *  - "none":    no structure (layouts of your own that only want the forces).
 * Center also sets how firmly nodes hold their level or ring (0 loose, 1 crisp).
 *
 * Extra forces (forces.js, or any object with apply(simulation, alpha)) run after the built-in ones, every tick.
 * They read and write the public arrays: x, y (positions), vx, vy (velocities: add to these), fx, fy (NaN unless
 * held), halfW, halfH (collision half-sizes), linkSources, linkTargets, degree, and ids / indexById / count.
 *
 * The simulation keeps running while a node is dragged: the dragged node is held under the pointer and everything
 * else reacts (neighbours follow, others make room), then it cools down and settles.
 * Deterministic: the same input gives the same layout (no random starts; ties are broken by index).
 * Works on plain arrays (see layout-graph.js) and allocates nothing per tick beyond its first.
 */

import { PHYSICS_TUNING, ticksFor } from "./tuning.js";

export { ticksFor };

/**
 * @typedef {object} SimulationOptions
 * @property {"layered" | "radial" | "none"} mode  the structure force
 * @property {"x" | "y"} [axis]  layered only: the flow axis levels are spread along
 * @property {number} center  the four force settings
 * @property {number} repel
 * @property {number} link
 * @property {number} distance
 * @property {Map<string, number>} [depthById]  radial: each node's ring
 * @property {string} [rootId]
 * @property {Partial<typeof PHYSICS_TUNING>} [tuning]
 * @property {(graphIndex: number) => { w: number, h: number }} [sizeOf]  collision box (default: the node box)
 * @property {import('./forces.js').Force[]} [forces]  extra forces, applied after the built-in ones
 * @property {boolean} [softCollisions]  push overlaps apart through velocities (Floating) instead of outright
 * @property {boolean} [polish]  simulateForces: resolve overlaps exactly at the end (default true)
 * @property {boolean} [equilibrate]  simulateForces: bring the result truly to rest (Floating)
 * @property {number} [ticks]  simulateForces: how long to settle (default: ticksFor(count))
 */

export class ForceSimulation {
  alpha = 1;
  alphaTarget = 0;
  motion = Infinity;

  /**
   * @param {import('./layout-graph.js').LayoutGraph} graph  current positions are the starting point; ghosts sit out
   * @param {SimulationOptions} options
   *   axis: layered only, the flow axis levels are spread along
   *   depthById / rootId: radial rings
   *   sizeOf: collision box per node, including its label (default: the node box)
   */
  constructor(graph, options) {
    this.options = options;
    /** The constants (tuning.js), editable while it runs. */
    this.tuning = { ...PHYSICS_TUNING, ...options.tuning };
    /** Graph index of each simulated node. */
    this.members = [];
    for (let i = 0; i < graph.count; i++)
      if (!graph.ghost[i]) this.members.push(i);
    const count = (this.count = this.members.length);
    this.ids = this.members.map((i) => graph.ids[i]);
    this.indexById = new Map(this.ids.map((id, i) => [id, i]));
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    /** Fixed (dragged / pinned) positions, NaN when free. */
    this.fx = new Float64Array(count).fill(NaN);
    this.fy = new Float64Array(count).fill(NaN);
    this.halfW = new Float64Array(count);
    this.halfH = new Float64Array(count);
    this.members.forEach((g, i) => {
      // Tiny deterministic offsets so coincident seeds can separate.
      this.x[i] = graph.x[g] + ((i % 7) - 3) * 0.01;
      this.y[i] = graph.y[g] + ((i % 5) - 2) * 0.01;
      const size = options.sizeOf?.(g) ?? { w: graph.w[g], h: graph.h[g] };
      this.halfW[i] = size.w / 2;
      this.halfH[i] = size.h / 2;
    });

    const local = new Int32Array(graph.count).fill(-1);
    this.members.forEach((g, i) => (local[g] = i));
    const sources = [],
      targets = [];
    this.degree = new Uint32Array(count);
    for (let e = 0; e < graph.sources.length; e++) {
      const s = local[graph.sources[e]],
        t = local[graph.targets[e]];
      if (s < 0 || t < 0 || s === t) continue;
      sources.push(s);
      targets.push(t);
      this.degree[s]++;
      this.degree[t]++;
    }
    this.linkSources = Int32Array.from(sources);
    this.linkTargets = Int32Array.from(targets);
    // Each node's linked neighbours (both directions), as offsets into one flat list.
    this.neighbourStart = new Int32Array(count + 1);
    for (let e = 0; e < sources.length; e++) {
      this.neighbourStart[sources[e] + 1]++;
      this.neighbourStart[targets[e] + 1]++;
    }
    for (let i = 0; i < count; i++)
      this.neighbourStart[i + 1] += this.neighbourStart[i];
    this.neighbours = new Int32Array(sources.length * 2);
    const fill = this.neighbourStart.slice(0, count);
    for (let e = 0; e < sources.length; e++) {
      this.neighbours[fill[sources[e]]++] = targets[e];
      this.neighbours[fill[targets[e]]++] = sources[e];
    }

    const rootId = options.rootId ?? graph.rootId;
    this.root = this.indexById.get(rootId) ?? null;
    this.structureTarget = new Float64Array(count); // level coordinate or ring radius
    if (options.mode === "radial") {
      this.ids.forEach((id, i) => {
        this.structureTarget[i] =
          (options.depthById?.get(id) ?? 0) * options.distance;
      });
      if (this.root != null) {
        this.fx[this.root] = 0;
        this.fy[this.root] = 0;
      }
    } else if (options.mode === "layered") {
      this.#setUpLevels();
    }
    // Each link's resting length: the link distance, or in layered layouts at least the gap between its ends'
    // levels. A link across three levels can't be one link distance long; pulling it that hard only drags its ends
    // sideways across everything in between (DAGs, where shared nodes link to several levels).
    this.restLength = new Float64Array(this.linkSources.length).fill(
      options.distance,
    );
    if (options.mode === "layered")
      for (let e = 0; e < this.linkSources.length; e++)
        this.restLength[e] = Math.max(
          options.distance,
          Math.abs(
            this.structureTarget[this.linkTargets[e]] -
              this.structureTarget[this.linkSources[e]],
          ),
        );

    this.#takeCenter();
    /** Extra forces (forces.js), applied every tick after the built-in ones. */
    this.forces = [...(options.forces ?? [])];
    for (const force of this.forces) force.initialize?.(this);
    this.#tree = new Quadtree(count, this.tuning.maxTreeDepth);
    this.#grid = new CollisionGrid(count);
  }

  #tree;
  #grid;

  /** A node pinned for good (the radial centre), or -1: a real anchor, whose forces aren't cancelled. */
  get #anchor() {
    return this.options.mode === "radial" && this.root != null ? this.root : -1;
  }

  /** Settle synchronously (a fresh layout). */
  run(ticks = ticksFor(this.count, this.tuning)) {
    const decay = 1 - Math.pow(this.tuning.alphaMin, 1 / ticks);
    for (let i = 0; i < ticks; i++) this.tick(decay);
    return this;
  }

  /** Still moving? (the live, animated mode stops when this turns false) */
  get isActive() {
    return this.alpha > this.tuning.alphaMin * 5 || this.alphaTarget > 0;
  }

  /**
   * Bring the graph truly to rest at `heat` (floating graphs: the drag heat), so waking it at that heat later only
   * moves what's disturbed. Cooling alone freezes the graph once its forces get too weak to move anything, before it
   * has reached balance; waking it then sends everything toward the balance it never reached. Ends cold (alpha 0).
   * The work is capped in node-ticks (settleWork), not time, so the same graph settles the same on any machine.
   */
  equilibrate(heat = this.tuning.dragHeat) {
    this.alpha = this.alphaTarget = heat;
    const ticks = Math.min(
      this.tuning.settleTicks,
      Math.ceil(this.tuning.settleWork / Math.max(1, this.count)),
    );
    for (let k = 0; k < ticks; k++) {
      this.tick(0);
      if (this.motion < this.tuning.stillness) break;
    }
    this.alpha = this.alphaTarget = 0;
    return this;
  }

  /** Warm up again (a node was grabbed) and stay warm while `alphaTarget` > 0. */
  reheat(alphaTarget = 0.3) {
    this.alphaTarget = alphaTarget;
    this.alpha = Math.max(this.alpha, alphaTarget);
  }

  /** Hold a node at a position (while dragged). */
  fix(id, position) {
    const i = this.indexById.get(id);
    if (i == null) return;
    this.fx[i] = position.x;
    this.fy[i] = position.y;
  }

  /** Let a dragged node move freely again (the pinned radial root stays pinned). */
  release(id) {
    const i = this.indexById.get(id);
    if (i == null || (this.options.mode === "radial" && i === this.root))
      return;
    this.fx[i] = NaN;
    this.fy[i] = NaN;
  }

  /** Start again from these positions (id → { x, y }; nodes moved by hand since), at rest. */
  setPositions(positionOf) {
    this.ids.forEach((id, i) => {
      const p = positionOf(id);
      if (!p) return;
      this.x[i] = p.x;
      this.y[i] = p.y;
      this.vx[i] = this.vy[i] = 0;
    });
    this.#takeCenter();
    this.#anchorStructure();
    this.#rest = null; // a new position: whatever was held as rest no longer applies
  }

  /**
   * Levels and rings go where the graph now is: layered levels keep their spacing but shift with the nodes along
   * the flow; the radial result stays pinned where it is. Otherwise waking the physics on a graph that has moved
   * (or never sat at the origin) would drag it back.
   */
  #anchorStructure() {
    const mode = this.options.mode;
    if (mode === "radial" && this.root != null) {
      this.fx[this.root] = this.x[this.root];
      this.fy[this.root] = this.y[this.root];
    } else if (mode === "layered" && this.count) {
      const along = this.options.axis === "x" ? this.x : this.y;
      let shift = 0;
      for (let i = 0; i < this.count; i++)
        shift += along[i] - this.structureTarget[i];
      shift /= this.count;
      for (let i = 0; i < this.count; i++) this.structureTarget[i] += shift;
    }
  }

  /**
   * The point center pulls toward: the middle of the nodes as they are now. Pulling toward the world origin instead
   * slid the whole graph over whenever the physics woke up (a drag), since layouts don't sit around the origin.
   */
  #takeCenter() {
    let sumX = 0,
      sumY = 0;
    for (let i = 0; i < this.count; i++) {
      sumX += this.x[i];
      sumY += this.y[i];
    }
    this.centerX = this.count ? sumX / this.count : 0;
    this.centerY = this.count ? sumY / this.count : 0;
  }

  /** Copy positions into the graph's arrays (the simulated nodes only). */
  writeTo(graph) {
    this.ids.forEach((id, i) => {
      const g = graph.indexById.get(id);
      if (g == null) return;
      graph.x[g] = this.x[i];
      graph.y[g] = this.y[i];
    });
  }

  /** One step. `decay` sets how fast alpha moves toward alphaTarget (≈300 ticks to settle by default). */
  tick(decay = this.tuning.cooling) {
    const t = this.tuning;
    const alpha = this.alpha;
    this.#applyForces(alpha);
    const { x, y, vx, vy, fx, fy } = this;
    const rest = this.#rest;
    if (rest) {
      // Take away what was already pushing each node at rest (it scales with the heat, like the forces), and pull
      // each node gently back toward where it rested: nothing else holds a graph against turning or sliding as a
      // whole (a radial graph spins freely about its pinned centre), so a nudge would set it all adrift.
      const home = t.liveAnchor * alpha;
      for (let i = 0; i < this.count; i++) {
        vx[i] -= rest.x[i] * alpha + (x[i] - rest.startX[i]) * home;
        vy[i] -= rest.y[i] * alpha + (y[i] - rest.startY[i]) * home;
      }
      if (this.options.mode === "radial" && this.root != null)
        this.#cancelSpin();
    }
    let motion = 0;
    // Held at rest (a live floating graph): a node pushed less than the dead zone stays put. The compensated forces
    // balance exactly only where they were recorded; without this, the leftovers (a big graph is never perfectly
    // settled) feed on themselves after a release, and far-off parts of the graph slowly drift.
    // The dead zone only holds nodes the drag hasn't reached: a held node is awake, and a node that has moved more
    // than wakeDistance from rest wakes its linked neighbours, so a pull travels along the links in full.
    const deadZone = rest ? t.deadZone : 0;
    const awake = rest?.awake;
    for (let i = 0; i < this.count; i++) {
      if (!Number.isNaN(fx[i])) {
        x[i] = fx[i];
        y[i] = fy[i];
        vx[i] = vy[i] = 0;
        if (awake && !awake[i]) this.#wake(i, rest);
        continue;
      }
      vx[i] *= 1 - t.velocityDecay;
      vy[i] *= 1 - t.velocityDecay;
      if (
        deadZone &&
        !awake[i] &&
        Math.abs(vx[i]) + Math.abs(vy[i]) < deadZone
      ) {
        vx[i] = vy[i] = 0;
        continue;
      }
      x[i] += vx[i];
      y[i] += vy[i];
      const speed = Math.abs(vx[i]) + Math.abs(vy[i]);
      if (speed > motion) motion = speed;
    }
    /** The fastest free node's speed this tick (world units): how far from rest the graph is. */
    this.motion = motion;
    if (awake)
      for (let i = 0; i < this.count; i++)
        if (
          awake[i] === 1 &&
          Math.abs(x[i] - rest.startX[i]) + Math.abs(y[i] - rest.startY[i]) >
            t.wakeDistance
        )
          this.#wake(i, rest);
    this.#collide();
    if (rest?.collideX)
      for (let i = 0; i < this.count; i++) {
        vx[i] -= rest.collideX[i];
        vy[i] -= rest.collideY[i];
      }
    this.alpha += (this.alphaTarget - this.alpha) * decay;
  }

  /** The four forces and the structure pull, into the velocities, at `alpha`. */
  #applyForces(alpha) {
    const { center, repel, link } = this.options;
    const t = this.tuning;
    this.#links(link * t.linkScale * alpha);
    this.#repel(repel * t.repelScale * alpha);
    if (this.options.mode !== "radial")
      this.#center(center * t.centerScale * alpha);
    this.#structure(alpha);
    for (const force of this.forces) force.apply(this, alpha);
  }

  /** Add a force while it runs (see forces.js). Returns a function that takes it out again. */
  addForce(force) {
    if (typeof force?.apply !== "function")
      throw new TypeError(
        "addForce: a force needs an apply(simulation, alpha) method",
      );
    this.forces.push(force);
    force.initialize?.(this);
    return () => {
      const k = this.forces.indexOf(force);
      if (k >= 0) this.forces.splice(k, 1);
    };
  }

  /**
   * Treat where things are now as rest: record the push every node already feels here, and subtract it from then on
   * (until setPositions). A big graph never reaches perfect balance (the Barnes-Hut approximation leaves a little
   * noise), and without this, waking it for a drag let every node act on those leftovers: the whole graph drifted.
   * With it, only what the drag changes moves anything, spreading through the forces like a ripple.
   */
  holdRest() {
    const { vx, vy } = this;
    const savedX = Float64Array.from(vx),
      savedY = Float64Array.from(vy);
    vx.fill(0);
    vy.fill(0);
    // At the heat it'll run at (the link pass isn't exactly proportional to the heat), stored per unit of heat.
    const heat = this.alpha || 1;
    this.#applyForces(heat);
    const rest = {
      x: vx.map((v) => v / heat),
      y: vy.map((v) => v / heat),
    };
    if (this.options.softCollisions) {
      vx.fill(0);
      vy.fill(0);
      this.#collide(); // soft: only touches velocities
      rest.collideX = Float64Array.from(vx);
      rest.collideY = Float64Array.from(vy);
    }
    vx.set(savedX);
    vy.set(savedY);
    // Nothing is disturbed yet: what the drag reaches wakes, link by link (see tick).
    rest.startX = Float64Array.from(this.x);
    rest.startY = Float64Array.from(this.y);
    rest.awake = new Uint8Array(this.count);
    this.#rest = rest;
  }

  /**
   * Radial graphs turn freely about their pinned centre, so a pull on one leaf would spin the whole graph. Take the
   * graph's net turn out of the free nodes' velocities (like the net push elsewhere): the pulled branch still bends,
   * the rest of the graph doesn't rotate with it.
   */
  #cancelSpin() {
    const { x, y, vx, vy, fx } = this;
    const ox = x[this.root],
      oy = y[this.root];
    let turn = 0,
      inertia = 0;
    for (let i = 0; i < this.count; i++) {
      if (!Number.isNaN(fx[i])) continue;
      const rx = x[i] - ox,
        ry = y[i] - oy;
      turn += rx * vy[i] - ry * vx[i];
      inertia += rx * rx + ry * ry;
    }
    if (!inertia) return;
    const spin = turn / inertia;
    for (let i = 0; i < this.count; i++) {
      if (!Number.isNaN(fx[i])) continue;
      vx[i] += spin * (y[i] - oy);
      vy[i] -= spin * (x[i] - ox);
    }
  }

  /**
   * Node i is awake (the dead zone no longer holds it); once it has moved (awake 1 → 2), its linked neighbours wake
   * too. A held node counts as moved.
   */
  #wake(i, rest) {
    const awake = rest.awake;
    awake[i] = 2;
    for (let k = this.neighbourStart[i]; k < this.neighbourStart[i + 1]; k++) {
      const j = this.neighbours[k];
      if (!awake[j]) awake[j] = 1;
    }
  }

  /** Stop treating a position as rest (the forces act in full again). */
  releaseRest() {
    this.#rest = null;
  }

  #rest = null;

  /**
   * Collision passes on their own, until nothing overlaps (or the budget runs out). One pass per tick can leave a
   * dense stack overlapping: each push can create a new overlap further along.
   */
  resolveOverlaps(maxPasses = 50) {
    if (this.options.mode !== "layered") return; // radial: per-tick collision, rings kept exact
    for (let pass = 0; pass < maxPasses; pass++) if (!this.#collide()) break;
    this.#separateLevels();
  }

  // ---------------------------------------------------------------- forces

  /** Springs toward the link distance; the busier end of a link moves less. */
  /**
   * Springs toward the link distance; the busier end of a link moves less. That weighting means a link's two pulls
   * aren't equal and opposite, so on their own they'd push the whole graph along a little every tick (it slid after
   * every drag); the net push is taken back out, spread evenly over every node.
   */
  #links(strength) {
    if (!strength) return;
    const { x, y, vx, vy, fx, degree, linkSources, linkTargets, restLength } =
      this;
    const anchor = this.#anchor;
    let netX = 0,
      netY = 0;
    for (let e = 0; e < linkSources.length; e++) {
      const distance = restLength[e];
      const s = linkSources[e],
        t = linkTargets[e];
      const dx = x[t] + vx[t] - x[s] - vx[s] || 0.01,
        dy = y[t] + vy[t] - y[s] - vy[s] || 0.01;
      const length = Math.sqrt(dx * dx + dy * dy);
      const pull = ((length - distance) / length) * strength * 0.5;
      const bias = degree[s] / (degree[s] + degree[t]);
      vx[t] -= dx * pull * bias;
      vy[t] -= dy * pull * bias;
      vx[s] += dx * pull * (1 - bias);
      vy[s] += dy * pull * (1 - bias);
      if (s !== anchor && t !== anchor) {
        netX += dx * pull * (1 - 2 * bias);
        netY += dy * pull * (1 - 2 * bias);
      }
    }
    // Spread over every node, held ones included: holding a node must not change what's cancelled, or the moment you
    // grab one the rest of the graph starts sliding. The radial centre is different: it's pinned for good, a real
    // anchor, and its pulls stay.
    netX /= this.count;
    netY /= this.count;
    for (let i = 0; i < this.count; i++)
      if (Number.isNaN(fx[i])) {
        vx[i] -= netX;
        vy[i] -= netY;
      }
  }

  #center(strength) {
    if (!strength) return;
    const { centerX, centerY } = this;
    for (let i = 0; i < this.count; i++) {
      this.vx[i] -= (this.x[i] - centerX) * strength;
      this.vy[i] -= (this.y[i] - centerY) * strength;
    }
  }

  /** Levels (layered) or rings (radial). Center sets how firmly nodes hold them. */
  #structure(alpha) {
    const mode = this.options.mode;
    if (mode !== "layered" && mode !== "radial") return;
    const t = this.tuning;
    const strength =
      t.structureScale *
      (t.structureBase + t.structurePerCenter * this.options.center) *
      alpha; // 0 loose, default 0.2 → ×1, 1 crisp
    const { x, y, vx, vy, structureTarget: target } = this;
    if (mode === "layered") {
      const along = this.options.axis === "x" ? x : y;
      const velocity = this.options.axis === "x" ? vx : vy;
      for (let i = 0; i < this.count; i++)
        velocity[i] += (target[i] - along[i]) * strength;
      return;
    }
    // Rings around the result, wherever it is (pinned, or held under the pointer).
    const originX = this.root != null ? x[this.root] : 0,
      originY = this.root != null ? y[this.root] : 0;
    for (let i = 0; i < this.count; i++) {
      if (i === this.root) continue;
      const dx = x[i] - originX,
        dy = y[i] - originY;
      const r = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const k = ((target[i] - r) / r) * strength;
      vx[i] += dx * k;
      vy[i] += dy * k;
    }
  }

  /**
   * Levels come from the seed layout's positions along the flow axis (ranked), relative to the result's level. They
   * are `distance` apart, or further when the nodes and labels on two neighbouring levels need more room along the
   * flow (labels beside nodes in left-right layouts): otherwise neighbouring levels collide and can only make room by
   * stacking everything into one tall column.
   */
  #setUpLevels() {
    const horizontal = this.options.axis === "x";
    const along = horizontal ? this.x : this.y;
    const half = horizontal ? this.halfW : this.halfH;
    const rounded = Array.from(along, (value) => Math.round(value));
    const ranks = [...new Set(rounded)].sort((a, b) => a - b);
    const rankOf = new Map(ranks.map((value, rank) => [value, rank]));
    const extent = new Float64Array(ranks.length); // widest half-footprint on each level
    for (let i = 0; i < this.count; i++) {
      const rank = rankOf.get(rounded[i]);
      extent[rank] = Math.max(extent[rank], half[i]);
    }
    const levelAt = new Float64Array(ranks.length);
    for (let rank = 1; rank < ranks.length; rank++)
      levelAt[rank] =
        levelAt[rank - 1] +
        Math.max(
          this.options.distance,
          extent[rank - 1] + extent[rank] + this.tuning.levelGap,
        );
    const rootLevel = levelAt[rankOf.get(rounded[this.root ?? 0])];
    for (let i = 0; i < this.count; i++) {
      this.structureTarget[i] = levelAt[rankOf.get(rounded[i])] - rootLevel;
      along[i] = this.structureTarget[i]; // start on the level
    }
  }

  /**
   * Layered only: on each level, push nodes apart across the flow, in their current order, until none overlap;
   * then shift the level back so it stays centred where it was. Exact where collision passes converge slowly (a
   * column of a hundred siblings).
   */
  #separateLevels() {
    const horizontal = this.options.axis === "x";
    const across = horizontal ? this.y : this.x;
    const half = horizontal ? this.halfH : this.halfW;
    const levels = new Map();
    for (let i = 0; i < this.count; i++) {
      const level = this.structureTarget[i];
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(i);
    }
    for (const members of levels.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => across[a] - across[b] || a - b);
      const before =
        members.reduce((sum, i) => sum + across[i], 0) / members.length;
      for (let k = 1; k < members.length; k++) {
        const previous = members[k - 1],
          current = members[k];
        const minimum = across[previous] + half[previous] + half[current];
        if (across[current] < minimum) across[current] = minimum;
      }
      const shift =
        before -
        members.reduce((sum, i) => sum + across[i], 0) / members.length;
      for (const i of members) across[i] += shift;
    }
  }

  /**
   * Many-body repulsion, approximated with a Barnes-Hut quadtree. The approximation isn't exactly symmetric (a far
   * group pushes you as one, you push its members one by one), so the net push on the free nodes is taken back out,
   * evenly: the graph spreads without drifting.
   */
  #repel(strength) {
    if (!strength) return;
    const { x, y, vx, vy, fx } = this;
    const tree = this.#tree;
    let netX = 0,
      netY = 0;
    tree.build(x, y, this.count);
    // The tree flattened in visiting order: a linear walk (skip a whole subtree by jumping to its end) over arrays
    // laid out in the order they're read, instead of a stack over scattered cells. Same cells, same order, same sums.
    const cells = tree.flatten();
    const { flatX, flatY, flatMass, flatSize2, flatPoint, flatSkip } = tree;
    const anchor = this.#anchor;
    const theta2 = this.tuning.theta * this.tuning.theta;
    for (let i = 0; i < this.count; i++) {
      const xi = x[i],
        yi = y[i];
      let forceX = 0,
        forceY = 0;
      for (let k = 0; k < cells;) {
        const dx = flatX[k] - xi,
          dy = flatY[k] - yi;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1) distanceSquared = 1;
        const point = flatPoint[k]; // the leaf's point, -1 for an empty leaf, -2 for an internal cell
        // Far enough (the cell looks small from here), or a single point: one push from its centre of mass.
        if (point > -2 || flatSize2[k] < theta2 * distanceSquared) {
          const cellMass = flatMass[k];
          k = flatSkip[k];
          if (point === i || !cellMass) continue;
          const push = (strength * cellMass) / distanceSquared;
          if (dx === 0 && dy === 0) {
            // Right on top of it: push apart in a direction fixed by the node's index, or they'd never separate.
            const angle = i * 2.399963229728653;
            forceX += Math.cos(angle) * push;
            forceY += Math.sin(angle) * push;
            continue;
          }
          forceX += dx * push;
          forceY += dy * push;
        } else k++;
      }
      vx[i] -= forceX;
      vy[i] -= forceY;
      if (i !== anchor) {
        netX += forceX;
        netY += forceY;
      }
    }
    // Over every node, held ones included (see #links).
    netX /= this.count;
    netY /= this.count;
    for (let i = 0; i < this.count; i++)
      if (Number.isNaN(fx[i])) {
        vx[i] += netX;
        vy[i] += netY;
      }
  }

  /**
   * Keep node boxes (with labels) apart: overlapping pairs are pushed apart along the axis where they overlap least.
   * Normally the boxes are moved apart outright (crisp layouts); with `softCollisions` (Floating) the push goes into
   * their velocities instead. Hard pushes at a floating graph's heat never let it rest: links pull a node into its
   * neighbour, the push teleports it back, again and again, and whole rows jitter.
   * In layered layouts, nodes on the same level are pushed only across the flow: along it, the level pull would undo
   * the push next tick, and dense stacks of siblings never separated. A uniform grid finds the neighbours in O(n).
   * Returns whether any pair that can move overlapped.
   */
  #collide() {
    const { x, y, vx, vy, halfW, halfH, fx, structureTarget } = this;
    const soft = this.options.softCollisions ? this.tuning.softCollision : 0;
    const layeredAxis =
      this.options.mode === "layered" ? this.options.axis : null;
    let overlapped = false;
    let cellSize = 1;
    for (let i = 0; i < this.count; i++)
      cellSize = Math.max(cellSize, halfW[i] * 2, halfH[i] * 2);
    const grid = this.#grid;
    grid.build(x, y, this.count, cellSize);
    const { next } = grid;
    for (let i = 0; i < this.count; i++) {
      const gx = Math.floor(x[i] / cellSize),
        gy = Math.floor(y[i] / cellSize);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          for (let j = grid.first(gx + ox, gy + oy); j >= 0; j = next[j]) {
            if (j <= i) continue;
            const overlapX = halfW[i] + halfW[j] - Math.abs(x[j] - x[i]),
              overlapY = halfH[i] + halfH[j] - Math.abs(y[j] - y[i]);
            if (overlapX <= 0 || overlapY <= 0) continue;
            const iFixed = !Number.isNaN(fx[i]),
              jFixed = !Number.isNaN(fx[j]);
            if (iFixed && jFixed) continue;
            overlapped = true;
            const share = iFixed ? 0 : jFixed ? 1 : 0.5; // how much of the push i takes
            const pushAlongX =
              layeredAxis && structureTarget[i] === structureTarget[j]
                ? layeredAxis === "y" // same level, flow along y → spread along x
                : overlapX < overlapY;
            if (soft) {
              // Floating: overlaps push on velocities, so the graph stays one smooth motion and can come to rest. Each
              // side always gets half: a held node doesn't hand its half to its neighbour (that made it a wall that
              // shoved whole rows along the moment it was grabbed); it just doesn't use it.
              const push = 0.5 * soft;
              if (pushAlongX) {
                const sign = x[j] > x[i] || (x[j] === x[i] && j > i) ? 1 : -1;
                vx[i] -= sign * overlapX * push;
                vx[j] += sign * overlapX * push;
              } else {
                const sign = y[j] > y[i] || (y[j] === y[i] && j > i) ? 1 : -1;
                vy[i] -= sign * overlapY * push;
                vy[j] += sign * overlapY * push;
              }
              continue;
            }
            if (pushAlongX) {
              const sign = x[j] > x[i] || (x[j] === x[i] && j > i) ? 1 : -1;
              x[i] -= sign * overlapX * share;
              x[j] += sign * overlapX * (1 - share);
            } else {
              const sign = y[j] > y[i] || (y[j] === y[i] && j > i) ? 1 : -1;
              y[i] -= sign * overlapY * share;
              y[j] += sign * overlapY * (1 - share);
            }
          }
        }
    }
    return overlapped;
  }
}

/**
 * Build, settle and write back a layout in one go. Returns the simulation (kept for live dragging), or null for
 * fewer than two nodes.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 */
export function simulateForces(graph, options) {
  const simulation = new ForceSimulation(graph, options);
  if (simulation.count < 2) return null;
  simulation.run(options.ticks);
  if (options.equilibrate) simulation.equilibrate();
  // The polish separates any overlaps left on crowded levels, but leaves the graph a little off balance: skipped
  // when the graph is going to float (a live simulation should start at rest, or everything drifts when woken).
  if (options.polish !== false) simulation.resolveOverlaps();
  simulation.writeTo(graph);
  simulation.alpha = 0; // settled
  return simulation;
}

// ---------------------------------------------------------------- Barnes-Hut quadtree

/**
 * A quadtree over points in flat typed arrays, rebuilt every tick without allocating. Cell 0 is the root; a cell is
 * a leaf holding one point (index ≥ 0), an internal cell with up to four children, or empty. Coincident points past
 * `maxDepth` (tuning: maxTreeDepth) merge into one leaf's mass.
 */
export class Quadtree {
  /** @param {number} points  expected point count (it grows as needed) */
  constructor(points, maxDepth = PHYSICS_TUNING.maxTreeDepth) {
    this.maxDepth = maxDepth;
    this.#grow(Math.max(16, points * 4 + 8));
  }

  #grow(capacity) {
    const copy = (Type, old, factor = 1) => {
      const array = new Type(capacity * factor);
      if (old) array.set(old);
      return array;
    };
    this.left = copy(Float64Array, this.left);
    this.top = copy(Float64Array, this.top);
    this.size = copy(Float64Array, this.size);
    this.mass = copy(Float64Array, this.mass);
    this.cx = copy(Float64Array, this.cx);
    this.cy = copy(Float64Array, this.cy);
    this.index = copy(Int32Array, this.index);
    this.internal = copy(Uint8Array, this.internal);
    this.child = copy(Int32Array, this.child, 4); // 0: no child (cell 0 is the root, never a child)
    this.stack = new Int32Array(capacity);
    this.capacity = capacity;
  }

  #newCell(left, top, size) {
    if (this.cells === this.capacity) this.#grow(this.capacity * 2);
    const cell = this.cells++;
    this.left[cell] = left;
    this.top[cell] = top;
    this.size[cell] = size;
    this.mass[cell] = 0;
    this.cx[cell] = this.cy[cell] = 0;
    this.index[cell] = -1;
    this.internal[cell] = 0;
    this.child.fill(0, cell * 4, cell * 4 + 4);
    return cell;
  }

  build(x, y, count) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      if (x[i] < minX) minX = x[i];
      if (y[i] < minY) minY = y[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] > maxY) maxY = y[i];
    }
    this.cells = 0;
    this.#newCell(minX, minY, Math.max(maxX - minX, maxY - minY, 1));
    this.#insertAll(x, y, count);
    this.#summarise(x, y);
  }

  /**
   * #insert for every point, with the cell arrays held in locals (re-read only when the tree grows): the same tree,
   * built without a method call and a property load per level.
   */
  #insertAll(x, y, count) {
    let { left, top, size, mass, cx, cy, index, internal, child } = this;
    const maxDepth = this.maxDepth;
    const newChild = (cell, slot, right, bottom, half) => {
      if (this.cells === this.capacity) {
        this.#grow(this.capacity * 2);
        ({ left, top, size, mass, cx, cy, index, internal, child } = this);
      }
      const created = this.cells++;
      left[created] = left[cell] + right * half;
      top[created] = top[cell] + bottom * half;
      size[created] = half;
      mass[created] = 0;
      cx[created] = cy[created] = 0;
      index[created] = -1;
      internal[created] = 0;
      const base = created * 4;
      child[base] = child[base + 1] = child[base + 2] = child[base + 3] = 0;
      child[slot] = created;
      return created;
    };
    // The child of `cell` that point p falls in, created if needed.
    const childFor = (cell, p) => {
      const half = size[cell] / 2;
      const right = x[p] >= left[cell] + half ? 1 : 0,
        bottom = y[p] >= top[cell] + half ? 1 : 0;
      const slot = cell * 4 + right + bottom * 2;
      return child[slot] || newChild(cell, slot, right, bottom, half);
    };
    for (let i = 0; i < count; i++) {
      let cell = 0;
      for (let depth = 0; ; depth++) {
        if (!internal[cell]) {
          if (index[cell] < 0) {
            index[cell] = i; // an empty leaf
            mass[cell] = 1;
            break;
          }
          if (depth > maxDepth) {
            mass[cell]++; // coincident points: merge
            break;
          }
          // Split the leaf: its point moves one level down, into a fresh (empty) child.
          const previous = index[cell];
          index[cell] = -1;
          mass[cell] = 0;
          internal[cell] = 1;
          const moved = childFor(cell, previous);
          index[moved] = previous;
          mass[moved] = 1;
        }
        cell = childFor(cell, i);
      }
    }
  }

  /**
   * Lay the cells out in the order a depth-first walk visits them (children last to first, as a stack pops them), in
   * flat arrays: centre (flatX, flatY), mass, size squared, the leaf's point (or -1 empty, -2 internal) and flatSkip,
   * the position just past the cell's subtree. Returns the number of cells.
   */
  flatten() {
    const cells = this.cells;
    if (!this.flatX || this.flatX.length < cells) {
      const capacity = this.capacity;
      this.flatX = new Float64Array(capacity);
      this.flatY = new Float64Array(capacity);
      this.flatMass = new Float64Array(capacity);
      this.flatSize2 = new Float64Array(capacity);
      this.flatPoint = new Int32Array(capacity);
      this.flatSkip = new Int32Array(capacity);
      this.subtree = new Int32Array(capacity);
    }
    const { mass, cx, cy, size, index, child, internal, stack, subtree } = this;
    // Subtree sizes: children are created after their parents, so a backwards pass sees every child first.
    for (let cell = cells - 1; cell >= 0; cell--) {
      let count = 1;
      if (internal[cell])
        for (let q = 0; q < 4; q++) {
          const c = child[cell * 4 + q];
          if (c) count += subtree[c];
        }
      subtree[cell] = count;
    }
    const { flatX, flatY, flatMass, flatSize2, flatPoint, flatSkip } = this;
    let k = 0,
      top = 0;
    stack[top++] = 0;
    while (top) {
      const cell = stack[--top];
      flatX[k] = cx[cell];
      flatY[k] = cy[cell];
      flatMass[k] = mass[cell];
      flatSize2[k] = size[cell] * size[cell];
      flatPoint[k] = internal[cell] ? -2 : index[cell];
      flatSkip[k] = k + subtree[cell];
      k++;
      if (internal[cell])
        for (let q = 0; q < 4; q++) {
          const c = child[cell * 4 + q];
          if (c) stack[top++] = c;
        }
    }
    return k;
  }

  /** Centres of mass, children before parents (cells are created after their parents, so walk backwards). */
  #summarise(x, y) {
    const { mass, cx, cy, index, child, internal } = this;
    for (let cell = this.cells - 1; cell >= 0; cell--) {
      if (!internal[cell]) {
        if (index[cell] >= 0) {
          cx[cell] = x[index[cell]];
          cy[cell] = y[index[cell]];
        }
        continue;
      }
      let total = 0,
        sx = 0,
        sy = 0;
      for (let q = 0; q < 4; q++) {
        const c = child[cell * 4 + q];
        if (!c) continue;
        total += mass[c];
        sx += cx[c] * mass[c];
        sy += cy[c] * mass[c];
      }
      mass[cell] = total;
      cx[cell] = total ? sx / total : 0;
      cy[cell] = total ? sy / total : 0;
    }
  }
}

// ---------------------------------------------------------------- collision grid

/**
 * A uniform grid of linked lists over points, rebuilt every tick: `first(gx, gy)` then follow `next`. Cells live in
 * an open-addressing hash table of typed arrays (stamped per build, so nothing is cleared or allocated per tick).
 */
export class CollisionGrid {
  constructor(points) {
    this.next = new Int32Array(Math.max(1, points));
    let size = 16;
    while (size < points * 2) size *= 2;
    this.mask = size - 1;
    this.cellX = new Int32Array(size);
    this.cellY = new Int32Array(size);
    this.head = new Int32Array(size);
    this.stamp = new Uint32Array(size);
    this.build_ = 0;
  }

  build(x, y, count, cellSize) {
    const stamp = ++this.build_;
    const { cellX, cellY, head, next, mask } = this;
    for (let i = count - 1; i >= 0; i--) {
      const gx = Math.floor(x[i] / cellSize),
        gy = Math.floor(y[i] / cellSize);
      let slot = hashCell(gx, gy) & mask;
      while (
        this.stamp[slot] === stamp &&
        (cellX[slot] !== gx || cellY[slot] !== gy)
      )
        slot = (slot + 1) & mask;
      if (this.stamp[slot] !== stamp) {
        this.stamp[slot] = stamp;
        cellX[slot] = gx;
        cellY[slot] = gy;
        head[slot] = -1;
      }
      next[i] = head[slot];
      head[slot] = i;
    }
  }

  first(gx, gy) {
    const stamp = this.build_;
    let slot = hashCell(gx, gy) & this.mask;
    while (this.stamp[slot] === stamp) {
      if (this.cellX[slot] === gx && this.cellY[slot] === gy)
        return this.head[slot];
      slot = (slot + 1) & this.mask;
    }
    return -1;
  }
}

function hashCell(gx, gy) {
  return Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663);
}
