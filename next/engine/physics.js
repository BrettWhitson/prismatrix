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
// Units: positions in world pixels, time in seconds. Integration is semi-implicit Euler at a fixed step.

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

/**
 * @typedef {object} Collision
 * @property {boolean} boxes   collide footprints (node and label) rather than circles
 * @property {number} padding  clearance kept around every node
 */

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
    this.pinned = new Uint8Array(count); // `held`, as flags for the hot loops
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
   */
  configure(mode, opts, constrain = null, collision = null) {
    this.mode = mode;
    this.opts = opts;
    this.constrain = constrain;
    this.collision = opts.collide ? collision : null;
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
    this.wake();
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

  /** Advance by `dt` seconds of wall time in fixed steps. Returns the mean squared speed. */
  advance(dt) {
    this.moved = false;
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
    const { ax, ay, opts, pinned, constrain } = this;
    pinned.fill(0);
    for (const i of this.held) pinned[i] = 1;
    ax.fill(0);
    ay.fill(0);
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
    if (this.collision) {
      this.#collide();
      // A push can shove a node off its level or ring: put it back, so locks hold against collisions too.
      if (constrain)
        for (let i = 0; i < count; i++) if (!pinned[i]) constrain(m, i);
    }
    let energy = 0,
      fastest = 0;
    if (this.pushed) this.moved = true;
    this.pushed = false;
    for (let i = 0; i < count; i++) {
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      energy += v2;
      if (v2 > fastest) fastest = v2;
    }
    energy = count ? energy / count : 0;
    if (fastest > 0) this.moved = true;
    // At rest means every node, not the average: one node still moving among thousands barely shifts the mean.
    this.quiet = fastest < SLEEP ? this.quiet + 1 : 0;
    return energy;
  }

  #forces() {
    const { x, y, homeX, homeY, count } = this.matrix;
    const { ax, ay, opts, from, to, rest } = this;
    const anchor = this.mode === "elastic" ? opts.anchor : opts.memory;
    if (anchor > 0)
      for (let i = 0; i < count; i++) {
        ax[i] += anchor * (homeX[i] - x[i]);
        ay[i] += anchor * (homeY[i] - y[i]);
      }

    const stretch = this.mode === "floating" ? opts.linkLength : 1;
    if (opts.links > 0)
      for (let e = 0; e < from.length; e++) {
        const s = from[e],
          t = to[e];
        const dx = x[t] - x[s],
          dy = y[t] - y[s];
        const d = Math.hypot(dx, dy) || 1e-6;
        const f = (opts.links * (d - rest[e] * stretch)) / d;
        ax[s] += f * dx;
        ay[s] += f * dy;
        ax[t] -= f * dx;
        ay[t] -= f * dy;
      }

    if (this.mode !== "floating") return;
    // Only nearby nodes push: within `reach`, found through a grid, and fading to nothing at its edge so nothing
    // jumps as nodes cross it. All pairs would cost n² per step; this costs about n times the neighbours.
    const k = opts.repulsion * 1000;
    if (k > 0) {
      const reach = this.reach;
      eachNearPair(x, y, count, reach, (a, b) => {
        const dx = x[b] - x[a],
          dy = y[b] - y[a];
        const raw = Math.hypot(dx, dy);
        if (raw >= reach) return;
        const d = Math.max(raw, REPEL_MIN);
        const fade = 1 - (raw / reach) ** 2;
        const f = (k / (d * d * d)) * fade * fade;
        ax[a] -= f * dx;
        ay[a] -= f * dy;
        ax[b] += f * dx;
        ay[b] += f * dy;
      });
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
    const m = this.matrix;
    const { boxes, padding } = this.collision;
    const half = padding / 2;
    const { x, y, boxX0, boxY0, boxX1, boxY1, count } = m;
    // Bucket by footprint centre into cells at least as big as the biggest footprint: only neighbouring cells
    // can hold overlapping pairs.
    let cell = 1;
    const cx = new Float64Array(count),
      cy = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      cell = Math.max(
        cell,
        boxX1[i] - boxX0[i] + padding,
        boxY1[i] - boxY0[i] + padding,
      );
      cx[i] = x[i] + (boxX0[i] + boxX1[i]) / 2;
      cy[i] = y[i] + (boxY0[i] + boxY1[i]) / 2;
    }
    eachNearPair(cx, cy, count, cell, (a, b) => {
      if (boxes) this.#separateBoxes(a, b, half);
      else this.#separateCircles(a, b, half);
    });
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
    x[a] -= dx * push * shares[0];
    y[a] -= dy * push * shares[0];
    x[b] += dx * push * shares[1];
    y[b] += dy * push * shares[1];
    settle(m, a, b, dx, dy, shares);
  }
}

// How a collision push is shared between a pair: [a's part, b's part].
const HALVES = [0.5, 0.5],
  ALL_TO_A = [1, 0],
  ALL_TO_B = [0, 1];

/** A grid cell's key: exact for cells within ±32k of the origin, which at any useful cell size is plenty. */
const cellKey = (gx, gy) => (gx + 0x8000) * 0x10000 + (gy + 0x8000);

/**
 * Every pair of points closer than `cell` (and some a little further), once each: points go into square cells of
 * that side, and each is paired with the points in its own cell and the neighbouring ones.
 */
function eachNearPair(px, py, count, cell, visit) {
  const grid = new Map();
  const gx = new Int32Array(count),
    gy = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    gx[i] = Math.floor(px[i] / cell);
    gy[i] = Math.floor(py[i] / cell);
    const key = cellKey(gx[i], gy[i]);
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }
  for (let i = 0; i < count; i++)
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const list = grid.get(cellKey(gx[i] + ox, gy[i] + oy));
        if (!list) continue;
        for (const j of list) if (j > i) visit(i, j);
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
