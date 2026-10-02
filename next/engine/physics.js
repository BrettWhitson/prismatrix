// Physics modes. Each is a set of forces plus options; layouts choose which modes they offer (see layouts.js).
//
//   static   — no forces. A dragged node goes where it's put (optionally with its subtree) and stays; a thrown
//              one glides to a stop.
//   elastic  — every node is sprung to its home and every edge keeps its laid-out length. Pull a node and its
//              neighbours follow like jelly; let go and everything springs back.
//   floating — nodes push each other apart and edges hold them together, with only a faint memory of the layout.
//              Whatever you drop stays roughly where you dropped it. Its forces fade out over its settle time
//              after anything disturbs it, so it can't creep on forever as it nears balance.
//
// Every mode has friction, which always brings motion to a full stop: a drag proportional to speed, so motion
// eases out, plus a small constant one, so it actually reaches zero instead of creeping forever.
//
// Units: positions in world pixels, time in seconds. Integration is semi-implicit Euler at a fixed step. Nodes have
// unit mass, except a node with so many edges that its springs together would be too stiff for that step: it gets
// just enough mass to stay stable (see #weigh). Once nothing has moved for a while the simulation sleeps and costs
// nothing until something wakes it.

import { bool, range, resolve } from "./schema.js";
import { LAYOUTS } from "./layouts.js";

const friction = (value) =>
  range(
    "friction",
    "Friction",
    0.5,
    30,
    0.5,
    value,
    "How quickly anything moving eases to a stop.",
  );
const fling = bool(
  "fling",
  "Throw on release",
  true,
  "A released node keeps the speed you threw it with.",
);
const collide = bool(
  "collide",
  "Collide",
  true,
  "Nodes (and, with label collision on, their labels) push each other out of the way.",
);

export const PHYSICS = {
  static: {
    label: "Static",
    options: [
      bool(
        "dragSubtree",
        "Drag subtree",
        true,
        "Dragging a node carries everything below it.",
      ),
      fling,
      friction(5),
    ],
  },
  elastic: {
    label: "Elastic",
    options: [
      range(
        "anchor",
        "Anchor pull",
        0,
        200,
        1,
        50,
        "How hard each node is pulled back to its home.",
      ),
      range(
        "links",
        "Link stiffness",
        0,
        200,
        1,
        35,
        "How hard edges hold their laid-out length.",
      ),
      friction(8),
      collide,
      fling,
    ],
  },
  floating: {
    label: "Floating",
    options: [
      range(
        "repulsion",
        "Repulsion",
        0,
        400,
        5,
        80,
        "How hard nodes push each other apart.",
      ),
      range("links", "Link stiffness", 0, 200, 1, 25),
      range(
        "linkLength",
        "Link length",
        0.3,
        2.5,
        0.05,
        1,
        "Edge length relative to the layout's.",
      ),
      range(
        "memory",
        "Shape memory",
        0,
        30,
        0.25,
        1,
        "A faint pull back to the layout; 0 forgets it.",
      ),
      friction(3),
      range(
        "settle",
        "Settle time",
        0.5,
        30,
        0.5,
        4,
        "Seconds the graph keeps rearranging after it's disturbed, before its forces fade and it eases to a stop.",
      ),
      range(
        "drift",
        "Drift",
        0,
        60,
        1,
        0,
        "Gentle wandering. Above zero the graph never quite stops.",
      ),
      collide,
      fling,
    ],
  },
};

/** The full option schema for a mode within a layout: the mode's own, the layout's extras, its defaults. */
export function physicsSchema(layout, mode) {
  const spec = LAYOUTS[layout]?.physics?.[mode];
  if (!spec) throw new Error(`Layout "${layout}" has no "${mode}" physics`);
  const defaults = spec.defaults ?? {};
  return [...PHYSICS[mode].options, ...(spec.options ?? [])].map((o) =>
    o.key in defaults ? { ...o, default: defaults[o.key] } : o,
  );
}

export function physicsOptions(layout, mode, values) {
  return resolve(physicsSchema(layout, mode), values);
}

const STEP = 1 / 120;
const MAX_SPEED = 4000;
const REPEL_MIN = 12; // closer than this, repulsion stops growing
const STOP = 2; // the constant part of friction, in px/s² per unit of friction
const SLEEP = 0.25; // squared speed (px²/s²) below which a node isn't moving
const REACH_MAX = 600; // furthest repulsion acts, in world px
const STEP_BUDGET_MS = 10; // most time physics may take in one frame
const QUIET_STEPS = 30; // steps in a row with nothing moving before the simulation counts as at rest
// The most stiffness a node may feel per unit of its mass, as h²·k/m. Semi-implicit Euler keeps a spring stable
// while that is under 4; 2 leaves a margin of two.
const STIFF_MAX = 2;
// Collision cells fit footprints up to this many times the typical size. Bigger ones go in coarser grids, each with
// cells twice the last, up to LEVELS of them; anything bigger still is HUGE.
const OVERSIZE = 2;
const LEVELS = 8;
const HUGE = 255;
const AT_HOME = 0.5; // within this of its home on both axes (world px), an elastic node counts as at home

/**
 * @typedef {object} Collision
 * @property {boolean} boxes   collide footprints (node and label) rather than circles
 * @property {number} padding  clearance kept around every node
 */

/**
 * Per edge of `graph`, 1 where the edge is drawn as a reference (a chip by the recipe, not a line to the
 * ingredient), for `Simulation.configure`: those edges get no spring, so dragging a recipe doesn't tug an ingredient
 * that's drawn far away. Null when there are no references.
 * @param {import("./graph.js").Graph} graph
 * @param {{ edge: object }[] | undefined} references the layout's (`routing.references`)
 * @returns {Uint8Array | null}
 */
export function referencedEdges(graph, references) {
  if (!references?.length) return null;
  const index = new Map(graph.edges.map((e, i) => [e, i]));
  const mask = new Uint8Array(graph.edges.length);
  for (const { edge } of references) {
    const e = index.get(edge);
    if (e !== undefined) mask[e] = 1;
  }
  return mask;
}

export class Simulation {
  constructor(graph) {
    this.graph = graph;
    /** The working graph's matrix: physics moves x, y, vx, vy and reads homes and footprints. */
    this.matrix = graph.matrix;
    const count = graph.nodes.length;
    this.ax = new Float64Array(count);
    this.ay = new Float64Array(count);
    this.phase = Float64Array.from(
      { length: count },
      (_, i) => (i * 2.399963) % (Math.PI * 2),
    );
    // Edge ends as flat arrays, for the spring loop, and each edge's laid-out length.
    this.from = Int32Array.from(graph.edges, (e) => e.source);
    this.to = Int32Array.from(graph.edges, (e) => e.target);
    this.rest = new Float64Array(graph.edges.length);
    /** @type {Uint8Array | null} per edge, 1 where it has no spring (see referencedEdges); null: every edge has one */
    this.loose = null;
    /** Per node, 1 / its mass (see #weigh). */
    this.inverseMass = new Float64Array(count).fill(1);
    this.heavy = false; // whether any node's mass isn't 1
    this.pinned = new Uint8Array(count); // `held`, as flags for the hot loops
    // Collision's working columns and grids, kept from step to step so a step allocates nothing.
    this.cx = new Float64Array(count); // footprint centre at the start of the step
    this.cy = new Float64Array(count);
    this.offX = new Float64Array(count); // footprint centre relative to the node
    this.offY = new Float64Array(count);
    this.hw = new Float64Array(count); // half its width and height, padding included
    this.hh = new Float64Array(count);
    this.placeHW = new Float64Array(count); // hw and hh by place in the collision grid
    this.placeHH = new Float64Array(count);
    this.shoved = new Uint8Array(count); // pushed by a collision this step
    this.away = new Uint8Array(count); // held, or off its home (elastic collides only pairs with one of these)
    this.lastX = new Float64Array(count); // where each node was at the start of the step
    this.lastY = new Float64Array(count);
    this.level = new Uint8Array(count); // which collision grid each footprint is in, by size (see #collide)
    this.huge = new Int32Array(count); // the footprints too big for any of them
    this.members = new Int32Array(LEVELS + 1); // how many in each
    this.sizes = new Int32Array(33); // how many footprints in each size class
    this.collisionGrids = Array.from(
      { length: LEVELS + 1 },
      () => new NearGrid(),
    );
    this.repulsionGrid = new NearGrid();
    // Collides the node `target` with node j (for a grid search to call).
    this.target = 0;
    this.withTarget = (j) => {
      const b = this.target;
      if (j < b) this.separate(j, b);
      else this.separate(b, j);
    };
    this.pushX = new Float64Array(count); // repulsion, by place in its grid
    this.pushY = new Float64Array(count);
    /** @type {(a: number, b: number) => void} pushes a pair apart, the way `collision` says */
    this.separate = () => {};
    this.time = 0;
    this.carry = 0;
    this.energy = 0;
    this.moved = false; // whether the last advance moved any node
    this.pushed = false; // whether collision moved a node this step
    this.quiet = 0; // steps in a row with nothing moving
    this.since = 0; // seconds since the last wake
    /** @type {Set<number>} nodes held by the pointer: forces don't move them */
    this.held = new Set();
    this.mode = "static";
    this.opts = {};
    /** @type {((m: import("./matrix.js").Matrix, i: number) => void) | null} keeps row i on its level or ring */
    this.constrain = null;
    /** @type {Collision | null} */
    this.collision = null;
  }

  /**
   * @param {string} mode
   * @param {object} opts
   * @param {((m: import("./matrix.js").Matrix, i: number) => void) | null} [constrain]
   * @param {Collision | null} [collision] how nodes collide, when the mode's `collide` option is on
   * @param {Uint8Array | null} [loose] per edge, 1 for an edge with no spring (see referencedEdges)
   */
  configure(mode, opts, constrain = null, collision = null, loose = null) {
    this.mode = mode;
    this.opts = opts;
    this.constrain = constrain;
    this.collision = opts.collide ? collision : null;
    this.loose = loose?.length === this.from.length ? loose : null;
    if (this.collision) {
      const half = this.collision.padding / 2;
      const boxes = this.collision.boxes;
      const { x, y } = this.matrix;
      const { offX, offY, hw, hh, away } = this;
      const elastic = mode === "elastic";
      // Most pairs the grid offers don't touch: a quick look at where they are now (an earlier push this step may
      // have moved them) before the real test. In elastic, two nodes both at home are left as they are: homes are
      // where the layout put them, and a drag elsewhere shouldn't nudge them.
      this.separate = (a, b) => {
        if (elastic && !away[a] && !away[b]) return;
        if (
          Math.abs(x[a] + offX[a] - x[b] - offX[b]) > hw[a] + hw[b] ||
          Math.abs(y[a] + offY[a] - y[b] - offY[b]) > hh[a] + hh[b]
        )
          return;
        if (boxes) this.#separateBoxes(a, b, half);
        else this.#separateCircles(a, b, half);
      };
    }
    // Each edge rests at its laid-out length. Repulsion reaches a few typical edge lengths: far enough to spread a
    // neighbourhood, near enough to stay cheap. The median, not the mean, so a radial's long outer spokes can't
    // stretch it, and capped, so the grid's cells stay small enough to hold a handful of nodes each.
    const { homeX, homeY } = this.matrix;
    const { from, to, rest } = this;
    for (let e = 0; e < rest.length; e++)
      rest[e] = Math.hypot(
        homeX[to[e]] - homeX[from[e]],
        homeY[to[e]] - homeY[from[e]],
      );
    const sorted = rest.slice().sort();
    const typical = sorted.length ? sorted[sorted.length >> 1] : 0;
    this.reach = Math.min(Math.max(150, 3 * typical), REACH_MAX);
    this.#weigh();
    this.wake();
  }

  /**
   * Give each node a mass: 1, unless it has so many springs that together they'd be too stiff for the step.
   *
   * Semi-implicit Euler at step h keeps a spring of stiffness k on a mass m stable only while h²·k/m < 4. Mass divides
   * the forces between nodes (springs, repulsion); the pull home (`anchor`, or floating's `memory`) and drift are the
   * same for every node whatever its mass, so a heavy node still goes home as briskly as any other. A node with d
   * springs of stiffness `links` then feels at most anchor + 2·links·d/m (Gershgorin's bound on the largest
   * eigenvalue, for the springs linearised: its own springs plus its neighbours' pull on it). With unit mass a busy
   * ingredient breaks that: at links 200 one with about 600 users (real recipe data has one with 629) shakes itself
   * and its users apart. So a node whose bound would pass STIFF_MAX gets just enough mass to bring it back to
   * STIFF_MAX. Ordinary nodes keep unit mass and feel the same as ever (up to about 350 edges at the trees' default
   * stiffness, 70 at the strongest); only the busiest are heavier, which also reads right: a hub moves ponderously.
   */
  #weigh() {
    const { from, to, loose, inverseMass, opts } = this;
    const links = this.mode === "static" ? 0 : (opts.links ?? 0);
    const anchor =
      this.mode === "elastic" ? (opts.anchor ?? 0) : (opts.memory ?? 0);
    inverseMass.fill(1);
    this.heavy = false;
    if (!(links > 0)) return;
    // Degrees, counting only edges with springs; inverseMass holds them for a moment.
    const degree = inverseMass;
    degree.fill(0);
    for (let e = 0; e < from.length; e++) {
      if (loose && loose[e]) continue;
      degree[from[e]]++;
      degree[to[e]]++;
    }
    // What's left of STIFF_MAX for the springs once the pull home has its share (a few percent at most).
    const room = STIFF_MAX - STEP * STEP * anchor;
    for (let i = 0; i < degree.length; i++) {
      const mass = (STEP * STEP * 2 * links * degree[i]) / room;
      inverseMass[i] = mass > 1 ? 1 / mass : 1;
      if (mass > 1) this.heavy = true;
    }
  }

  /**
   * Something changed from outside (a release, new settings, a reset): run until it's settled again, even if
   * nothing is moving yet. A node released at a standstill away from its home has no speed, but it has a spring.
   */
  wake() {
    this.quiet = 0;
    this.since = 0;
  }

  /** True once nothing has moved for a while, and nothing will unless touched. */
  get asleep() {
    if (this.held.size) return false;
    if (this.mode === "floating" && this.opts.drift > 0) return false;
    return this.quiet >= QUIET_STEPS;
  }

  /**
   * Advance by `dt` seconds of wall time in fixed steps. Returns the mean squared speed. Asleep, it does nothing at
   * all (no forces, no collisions) until something wakes it.
   */
  advance(dt) {
    this.moved = false;
    if (this.asleep) {
      this.carry = 0;
      return this.energy;
    }
    this.carry = Math.min(this.carry + dt, 1 / 20);
    const start = now();
    while (this.carry >= STEP) {
      this.carry -= STEP;
      this.energy = this.step(STEP);
      // Out of time for this frame: drop the rest rather than fall further behind (the motion slows down
      // instead of the page locking up).
      if (now() - start > STEP_BUDGET_MS) {
        this.carry = 0;
        break;
      }
    }
    return this.energy;
  }

  step(h) {
    const m = this.matrix;
    const { x, y, vx, vy, count } = m;
    const { ax, ay, opts, pinned, constrain, lastX, lastY } = this;
    pinned.fill(0);
    for (const i of this.held) pinned[i] = 1;
    ax.fill(0);
    ay.fill(0);
    lastX.set(x);
    lastY.set(y);
    this.time += h;
    // Held nodes keep the graph awake: their neighbours respond for as long as they're dragged.
    this.since = this.held.size ? 0 : this.since + h;
    if (this.mode !== "static") this.#forces();
    if (this.mode === "floating") {
      const heat = this.heat;
      if (heat < 1)
        for (let i = 0; i < count; i++) {
          ax[i] *= heat;
          ay[i] *= heat;
        }
      if (opts.drift > 0) this.#drift();
    }

    const keep = Math.exp(-opts.friction * h);
    const stop = opts.friction * STOP * h;
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      let u = (vx[i] + ax[i] * h) * keep;
      let w = (vy[i] + ay[i] * h) * keep;
      const speed = Math.hypot(u, w);
      if (speed > 0) {
        const slowed = Math.min(Math.max(speed - stop, 0), MAX_SPEED);
        u *= slowed / speed;
        w *= slowed / speed;
      }
      vx[i] = u;
      vy[i] = w;
      x[i] += u * h;
      y[i] += w * h;
      if (constrain) constrain(m, i);
    }
    // Elastic collides only while something is held: the dragged node shoves what's in its way, and what it shoves
    // shoves on. Let go, everything springs home through everything else. Homes never overlap (layouts make room),
    // but the way back can cross a row of labels packed edge to edge, and pushing a node back out of that row every
    // step would hold it off its home for ever, wedged.
    if (this.collision && (this.mode !== "elastic" || this.held.size)) {
      this.#collide();
      // A push can shove a node off its level or ring: put it back, so locks hold against collisions too.
      if (constrain)
        for (let i = 0; i < count; i++) if (!pinned[i]) constrain(m, i);
    }
    let energy = 0,
      fastest = 0,
      furthest = 0;
    if (this.pushed) this.moved = true;
    this.pushed = false;
    for (let i = 0; i < count; i++) {
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      energy += v2;
      if (v2 > fastest) fastest = v2;
      const dx = x[i] - lastX[i],
        dy = y[i] - lastY[i];
      if (dx * dx + dy * dy > furthest) furthest = dx * dx + dy * dy;
    }
    energy = count ? energy / count : 0;
    if (fastest > 0) this.moved = true;
    // At rest means every node, not the average: one node still moving among thousands barely shifts the mean. A
    // step where nothing actually went anywhere counts too, whatever the speeds say: a node held in place (by a lock,
    // say) mustn't keep everything awake for ever.
    const still = fastest < SLEEP || furthest < SLEEP * h * h;
    this.quiet = still ? this.quiet + 1 : 0;
    // Falling asleep: whatever speed is left goes nowhere, so it goes.
    if (this.quiet === QUIET_STEPS) {
      vx.fill(0);
      vy.fill(0);
    }
    return energy;
  }

  #forces() {
    const { x, y, homeX, homeY, count } = this.matrix;
    const { ax, ay, opts, inverseMass } = this;
    // Forces between nodes first: springs and repulsion, which mass divides (see #weigh).
    this.#pairForces();
    if (this.heavy)
      for (let i = 0; i < count; i++) {
        ax[i] *= inverseMass[i];
        ay[i] *= inverseMass[i];
      }
    // Then the pull home, the same for every node.
    const anchor = this.mode === "elastic" ? opts.anchor : opts.memory;
    if (anchor > 0)
      for (let i = 0; i < count; i++) {
        ax[i] += anchor * (homeX[i] - x[i]);
        ay[i] += anchor * (homeY[i] - y[i]);
      }
  }

  #pairForces() {
    const { x, y, count } = this.matrix;
    const { ax, ay, opts, from, to, rest, loose } = this;
    const stretch = this.mode === "floating" ? opts.linkLength : 1;
    if (opts.links > 0)
      for (let e = 0; e < from.length; e++) {
        if (loose && loose[e]) continue;
        const s = from[e],
          t = to[e];
        const dx = x[t] - x[s],
          dy = y[t] - y[s];
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const f = (opts.links * (d - rest[e] * stretch)) / d;
        ax[s] += f * dx;
        ay[s] += f * dy;
        ax[t] -= f * dx;
        ay[t] -= f * dy;
      }

    if (this.mode !== "floating") return;
    // Only nearby nodes push: within `reach`, found through a grid, and fading to nothing at its edge so nothing
    // jumps as nodes cross it. All pairs would cost n² per step; this costs about n times the neighbours. Worked
    // out by place in the grid (near in space, near in memory), then handed back to the nodes.
    const k = opts.repulsion * 1000;
    if (k > 0) {
      const reach = this.reach,
        reach2 = reach * reach;
      const grid = this.repulsionGrid;
      grid.build(x, y, count, reach);
      const { placeX: px, placeY: py, items } = grid;
      const { pushX, pushY } = this;
      pushX.fill(0);
      pushY.fill(0);
      grid.eachPlacePair((p, q) => {
        const dx = px[q] - px[p],
          dy = py[q] - py[p];
        const raw2 = dx * dx + dy * dy;
        if (raw2 >= reach2) return;
        const d = Math.max(Math.sqrt(raw2), REPEL_MIN);
        const fade = 1 - raw2 / reach2;
        const f = (k / (d * d * d)) * fade * fade;
        pushX[p] -= f * dx;
        pushY[p] -= f * dy;
        pushX[q] += f * dx;
        pushY[q] += f * dy;
      });
      for (let p = 0; p < count; p++) {
        ax[items[p]] += pushX[p];
        ay[items[p]] += pushY[p];
      }
    }
  }

  /** Floating's force strength: full after a wake, easing to nothing over the settle time. */
  get heat() {
    const t = Math.min(this.since / this.opts.settle, 1);
    return 1 - t * t * (3 - 2 * t);
  }

  /** Gentle wandering, never faded: drift is asked for. */
  #drift() {
    const { ax, ay, opts, phase } = this;
    for (let i = 0; i < ax.length; i++) {
      const p = phase[i];
      ax[i] += opts.drift * Math.sin(this.time * 0.6 + p);
      ay[i] += opts.drift * Math.cos(this.time * 0.47 + p * 1.7);
    }
  }

  /**
   * Push overlapping nodes apart: footprint boxes along the axis they overlap least on, or circles along the
   * line between them. A held node doesn't give way; the other takes the whole push. Overlapping pairs also lose
   * the speed they had towards each other, so they don't bounce.
   */
  #collide() {
    const { x, y, radius, boxX0, boxY0, boxX1, boxY1, count } = this.matrix;
    if (!count) return;
    const { boxes, padding } = this.collision;
    const { cx, cy, offX, offY, hw, hh, level, huge, separate } = this;
    // Every footprint as a centre and half its width and height, padding included: two can only overlap when their
    // centres are closer than the sum of their halves on both axes. Their sizes are counted by powers of two, for a
    // typical size no outlier can drag.
    const { sizes } = this;
    sizes.fill(0);
    for (let i = 0; i < count; i++) {
      if (boxes) {
        offX[i] = (boxX0[i] + boxX1[i]) / 2;
        offY[i] = (boxY0[i] + boxY1[i]) / 2;
        hw[i] = (boxX1[i] - boxX0[i] + padding) / 2;
        hh[i] = (boxY1[i] - boxY0[i] + padding) / 2;
      } else {
        offX[i] = offY[i] = 0;
        hw[i] = hh[i] = radius[i] + padding / 2;
      }
      cx[i] = x[i] + offX[i];
      cy[i] = y[i] + offY[i];
      sizes[sizeClass(Math.max(hw[i], hh[i]))]++;
    }
    if (this.mode === "elastic") {
      const { homeX, homeY } = this.matrix;
      const { away, pinned } = this;
      for (let i = 0; i < count; i++)
        away[i] =
          pinned[i] ||
          Math.abs(x[i] - homeX[i]) > AT_HOME ||
          Math.abs(y[i] - homeY[i]) > AT_HOME
            ? 1
            : 0;
    }
    // Typical: the top of the size class that holds the median (between it and twice it).
    let median = 0,
      seen = sizes[0];
    while (seen * 2 < count && median < sizes.length - 1)
      seen += sizes[++median];
    const typical = 2 ** median;
    // Cells as big as the biggest footprint, so only neighbouring cells can hold overlapping pairs; but not bigger
    // than a few times the typical one, or one huge label would make the cells huge and every node a neighbour of
    // every other. Bigger footprints go up a level, where each level doubles the cell (LEVELS of them); beyond those a
    // footprint is huge, and there are only ever a few of those.
    const limit = OVERSIZE * typical;
    let cell = 0;
    for (let i = 0; i < count; i++) {
      const size = Math.max(hw[i], hh[i]);
      if (size <= limit && size > cell) cell = size;
    }
    cell = Math.max(cell * 2, 1e-3);
    const { members, collisionGrids: grids } = this;
    members.fill(0);
    let hugeCount = 0;
    for (let i = 0; i < count; i++) {
      const size = Math.max(hw[i], hh[i]) * 2;
      let l = 0;
      for (let c = cell; size > c && l <= LEVELS; c *= 2) l++;
      if (l > LEVELS) {
        level[i] = HUGE;
        huge[hugeCount++] = i;
      } else {
        level[i] = l;
        members[l]++;
      }
    }
    for (let l = 0; l <= LEVELS; l++)
      if (members[l]) grids[l].build(cx, cy, count, cell * 2 ** l, level, l);
    this.shoved.fill(0);
    if (members[0]) this.#collideTypical(grids[0], members[0]);
    // Each bigger footprint: the others of its level, then every node of the finer levels near enough to touch it.
    for (let l = 1; l <= LEVELS; l++) {
      if (!members[l]) continue;
      grids[l].eachPair(separate);
      for (let p = 0; p < members[l]; p++)
        this.#collideFiner(grids[l].items[p], l);
    }
    for (let k = 0; k < hugeCount; k++) {
      this.#collideFiner(huge[k], LEVELS + 1);
      for (let j = k + 1; j < hugeCount; j++) separate(huge[k], huge[j]);
    }
  }

  /**
   * The pairs of typical footprints, by place in their grid. Most don't touch, and that shows from the centres the
   * grid took (in order in memory) and half sizes gathered alongside, without reading the nodes' own columns all over
   * memory. Only once a push has moved one of a pair this step does its live position need a look. Either way the
   * same pairs reach the real test.
   */
  #collideTypical(grid, placed) {
    const { items, placeX, placeY } = grid;
    const { hw, hh, placeHW, placeHH, shoved, separate } = this;
    for (let p = 0; p < placed; p++) {
      placeHW[p] = hw[items[p]];
      placeHH[p] = hh[items[p]];
    }
    grid.eachPlacePair((p, q) => {
      const a = items[p],
        b = items[q];
      if (
        !shoved[a] &&
        !shoved[b] &&
        (Math.abs(placeX[p] - placeX[q]) > placeHW[p] + placeHW[q] ||
          Math.abs(placeY[p] - placeY[q]) > placeHH[p] + placeHH[q])
      )
        return;
      if (a < b) separate(a, b);
      else separate(b, a);
    });
  }

  /** Collide node b with every node of the levels below `top` whose centre is near enough for them to touch. */
  #collideFiner(b, top) {
    const { cx, cy, hw, hh, members, collisionGrids: grids } = this;
    this.target = b;
    for (let l = 0; l < top && l <= LEVELS; l++) {
      if (!members[l]) continue;
      // A node of level l reaches at most half its cell from its centre.
      const reach = grids[l].cell / 2;
      grids[l].eachIn(
        cx[b] - hw[b] - reach,
        cy[b] - hh[b] - reach,
        cx[b] + hw[b] + reach,
        cy[b] + hh[b] + reach,
        this.withTarget,
      );
    }
  }

  /** How a push between a and b is shared: a held node doesn't move. Null when both are held. */
  #shares(a, b) {
    const aHeld = this.pinned[a],
      bHeld = this.pinned[b];
    if (aHeld && bHeld) return null;
    return aHeld ? ALL_TO_B : bHeld ? ALL_TO_A : HALVES;
  }

  #separateBoxes(a, b, half) {
    const m = this.matrix;
    const { x, y, boxX0, boxY0, boxX1, boxY1 } = m;
    const ox =
      Math.min(x[a] + boxX1[a], x[b] + boxX1[b]) -
      Math.max(x[a] + boxX0[a], x[b] + boxX0[b]) +
      half * 2;
    if (ox <= 0) return;
    const oy =
      Math.min(y[a] + boxY1[a], y[b] + boxY1[b]) -
      Math.max(y[a] + boxY0[a], y[b] + boxY0[b]) +
      half * 2;
    if (oy <= 0) return;
    const shares = this.#shares(a, b);
    if (!shares) return;
    this.pushed = true;
    this.shoved[a] = this.shoved[b] = 1;
    this.away[a] = this.away[b] = 1;
    if (ox < oy) {
      const dir =
        x[a] + (boxX0[a] + boxX1[a]) / 2 <= x[b] + (boxX0[b] + boxX1[b]) / 2
          ? -1
          : 1;
      x[a] += dir * ox * shares[0];
      x[b] -= dir * ox * shares[1];
      settle(m, a, b, 1, 0, shares);
    } else {
      const dir =
        y[a] + (boxY0[a] + boxY1[a]) / 2 <= y[b] + (boxY0[b] + boxY1[b]) / 2
          ? -1
          : 1;
      y[a] += dir * oy * shares[0];
      y[b] -= dir * oy * shares[1];
      settle(m, a, b, 0, 1, shares);
    }
  }

  #separateCircles(a, b, half) {
    const m = this.matrix;
    const { x, y, radius } = m;
    const min = radius[a] + radius[b] + half * 2;
    let dx = x[b] - x[a],
      dy = y[b] - y[a];
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    const shares = this.#shares(a, b);
    if (!shares) return;
    let d = Math.sqrt(d2);
    if (d < 1e-6) {
      // Exactly on top of each other: pick a direction that differs per pair.
      const angle = (a * 7 + b * 13) % 6.283;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      d = 0;
    } else {
      dx /= d;
      dy /= d;
    }
    const push = min - d;
    this.pushed = true;
    this.shoved[a] = this.shoved[b] = 1;
    this.away[a] = this.away[b] = 1;
    x[a] -= dx * push * shares[0];
    y[a] -= dy * push * shares[0];
    x[b] += dx * push * shares[1];
    y[b] += dy * push * shares[1];
    settle(m, a, b, dx, dy, shares);
  }
}

/** A size's class by powers of two: class k holds sizes from 2^(k-1) up to 2^k; class 0 everything under 1. */
const sizeClass = (size) =>
  size < 1 ? 0 : 32 - Math.clz32(Math.min(size, 2 ** 31));

// How a collision push is shared between a pair: [a's part, b's part].
const HALVES = [0.5, 0.5],
  ALL_TO_A = [1, 0],
  ALL_TO_B = [0, 1];

/** Where a row of grid cells starts in the slot table: a hash of the row, so rows land in unrelated places. */
function rowOffset(gy) {
  let h = Math.imul(gy, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return h ^ (h >>> 13);
}

/** The slot of grid cell (gx, gy): cells along a row take consecutive slots, from where their row starts. */
const slotOf = (gx, gy, mask) => (gx + rowOffset(gy)) & mask;

/**
 * Square cells over a set of points, for finding the pairs that are near each other without looking at all n² of
 * them. Cells are hashed into a table of slots about twice the number of points, so any spread of points (a node
 * thrown 100,000 px away) costs the same memory; two cells sharing a slot only cost a few extra candidates. Each row
 * of cells starts at a hashed slot and runs on through consecutive ones, so neighbours along a row are neighbours in
 * memory, while lines of points in any direction still spread over the table.
 *
 * Built by counting sort into typed arrays that are kept from one build to the next (and grown only when there are
 * more points), so a physics step allocates nothing for it. Points in a slot are in ascending order.
 */
export class NearGrid {
  constructor() {
    this.cell = 1;
    this.mask = 0; // slots - 1
    /** Slot s holds items[start[s]] up to (not including) items[start[s + 1]]. */
    this.start = new Int32Array(1);
    this.items = new Int32Array(0);
    this.cellX = new Int32Array(0); // the cell of the point at each place in `items`
    this.cellY = new Int32Array(0);
    this.placeX = new Float64Array(0); // and its position
    this.placeY = new Float64Array(0);
    this.gx = new Int32Array(0); // each point's cell
    this.gy = new Int32Array(0);
    this.slot = new Int32Array(0); // each point's slot; -1 when left out
    this.seen = new Int32Array(0); // per slot, the last search that looked in it
    this.search = 0;
  }

  /**
   * Put points 0 to count - 1, at (px[i], py[i]), into cells of side `cell`. With `groups`, only the points with
   * groups[i] === group go in (so a 0/1 array of points to skip leaves out the 1s).
   * @param {ArrayLike<number>} px
   * @param {ArrayLike<number>} py
   * @param {number} count
   * @param {number} cell
   * @param {ArrayLike<number> | null} [groups]
   * @param {number} [group]
   */
  build(px, py, count, cell, groups = null, group = 0) {
    if (this.gx.length < count) {
      this.gx = new Int32Array(count);
      this.gy = new Int32Array(count);
      this.slot = new Int32Array(count);
    }
    let members = count;
    if (groups) {
      members = 0;
      for (let i = 0; i < count; i++) if (groups[i] === group) members++;
    }
    if (this.items.length < members) {
      const size = Math.max(members, this.items.length * 2);
      this.items = new Int32Array(size);
      this.cellX = new Int32Array(size);
      this.cellY = new Int32Array(size);
      this.placeX = new Float64Array(size);
      this.placeY = new Float64Array(size);
    }
    let slots = this.mask + 1;
    if (slots < members * 2 || slots < 16) {
      while (slots < members * 2 || slots < 16) slots *= 2;
      this.mask = slots - 1;
      this.start = new Int32Array(slots + 1);
      this.seen = new Int32Array(slots);
      this.search = 0;
    }
    this.cell = cell;
    const { gx, gy, slot, start, items, cellX, cellY, placeX, placeY, mask } =
      this;
    // Count each slot's points into start[s], add up so start[s] is where slot s ends, then hand out places from the
    // back: afterwards start[s] is where it begins and start[s + 1] where it ends. Each place also keeps its point's
    // cell, so looking through a slot reads memory in order.
    start.fill(0);
    for (let i = 0; i < count; i++) {
      if (groups && groups[i] !== group) {
        slot[i] = -1;
        continue;
      }
      gx[i] = Math.floor(px[i] / cell) | 0;
      gy[i] = Math.floor(py[i] / cell) | 0;
      const s = slotOf(gx[i], gy[i], mask);
      slot[i] = s;
      start[s]++;
    }
    let sum = 0;
    for (let s = 0; s <= mask; s++) start[s] = sum += start[s];
    start[mask + 1] = sum;
    for (let i = count - 1; i >= 0; i--) {
      if (slot[i] < 0) continue;
      const p = --start[slot[i]];
      items[p] = i;
      cellX[p] = gx[i];
      cellY[p] = gy[i];
      placeX[p] = px[i];
      placeY[p] = py[i];
    }
  }

  /**
   * Every pair of points in the same or neighbouring cells, once each: that is every pair closer than a cell on both
   * axes, and some a little further. Each point looks at the points after it in its own cell, at the cell to its
   * right and at the three cells of the row below; the other neighbours find it from their side. Cells in a row
   * have consecutive slots, so those are two short runs of memory. A slot can hold cells of other rows too: only
   * points of the cells being looked at count.
   * @param {(i: number, j: number) => void} visit called with i < j
   */
  eachPair(visit) {
    const items = this.items;
    this.eachPlacePair((p, q) => {
      const i = items[p],
        j = items[q];
      if (i < j) visit(i, j);
      else visit(j, i);
    });
  }

  /**
   * The same pairs as eachPair, by place in `items` rather than by point: point items[p] is at (placeX[p],
   * placeY[p]). Places near each other in space are near each other in memory, so work done by place (repulsion
   * adds up its forces this way) reads and writes memory mostly in order instead of all over the node columns.
   * @param {(p: number, q: number) => void} visit
   */
  eachPlacePair(visit) {
    const { start, cellX, cellY, mask } = this;
    const placed = start[mask + 1];
    for (let p = 0; p < placed; p++) {
      const x = cellX[p],
        y = cellY[p];
      // Its own cell (points after it) and the next one along.
      const s = slotOf(x, y, mask);
      let end = start[s + 1];
      for (let q = p + 1; q < end; q++)
        if (cellY[q] === y && cellX[q] === x) visit(p, q);
      const right = (s + 1) & mask;
      end = start[right + 1];
      for (let q = start[right]; q < end; q++)
        if (cellY[q] === y && cellX[q] === x + 1) visit(p, q);
      // The three cells below it.
      const below = slotOf(x - 1, y + 1, mask);
      for (let k = 0; k < 3; k++) {
        const t = (below + k) & mask;
        end = start[t + 1];
        for (let q = start[t]; q < end; q++)
          if (cellY[q] === y + 1 && cellX[q] - x <= 1 && x - cellX[q] <= 1)
            visit(p, q);
      }
    }
  }

  /**
   * Every point with x0 ≤ x ≤ x1 and y0 ≤ y ≤ y1, once each.
   * @param {(i: number) => void} visit
   */
  eachIn(x0, y0, x1, y1, visit) {
    const { placeX, placeY, start, items, mask, seen, cell } = this;
    const placed = start[mask + 1];
    const gx0 = Math.floor(x0 / cell),
      gx1 = Math.floor(x1 / cell),
      gy0 = Math.floor(y0 / cell),
      gy1 = Math.floor(y1 / cell);
    // More cells than points: quicker to look at every point.
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > placed) {
      for (let p = 0; p < placed; p++)
        if (
          placeX[p] >= x0 &&
          placeX[p] <= x1 &&
          placeY[p] >= y0 &&
          placeY[p] <= y1
        )
          visit(items[p]);
      return;
    }
    if (++this.search > 0x7fffffff - 1) {
      seen.fill(0);
      this.search = 1;
    }
    const search = this.search;
    for (let y = gy0; y <= gy1; y++)
      for (let x = gx0; x <= gx1; x++) {
        const s = slotOf(x | 0, y | 0, mask);
        if (seen[s] === search) continue;
        seen[s] = search;
        const end = start[s + 1];
        for (let p = start[s]; p < end; p++)
          if (
            placeX[p] >= x0 &&
            placeX[p] <= x1 &&
            placeY[p] >= y0 &&
            placeY[p] <= y1
          )
            visit(items[p]);
      }
  }
}

const now = () => performance.now();

/** Remove the part of two nodes' velocities that closes the gap between them along (nx, ny). */
function settle(m, a, b, nx, ny, shares) {
  const { x, y, vx, vy } = m;
  const closing = (vx[a] - vx[b]) * nx + (vy[a] - vy[b]) * ny;
  // For boxes the axis isn't oriented from a to b, so take whichever sign is closing.
  const toward = Math.sign((x[a] - x[b]) * nx + (y[a] - y[b]) * ny) || 1;
  if (closing * toward >= 0) return;
  vx[a] -= closing * nx * shares[0];
  vy[a] -= closing * ny * shares[0];
  vx[b] += closing * nx * shares[1];
  vy[b] += closing * ny * shares[1];
}
