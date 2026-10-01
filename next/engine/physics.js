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
    this.ax = new Float64Array(graph.nodes.length);
    this.ay = new Float64Array(graph.nodes.length);
    this.phase = Float64Array.from(
      graph.nodes,
      (_, i) => (i * 2.399963) % (Math.PI * 2),
    );
    this.time = 0;
    this.carry = 0;
    this.energy = 0;
    this.quiet = 0; // steps in a row with nothing moving
    this.since = 0; // seconds since the last wake
    /** @type {Set<number>} nodes held by the pointer: forces don't move them */
    this.held = new Set();
    this.mode = "static";
    this.opts = {};
    /** @type {((n: any) => void) | null} */
    this.constrain = null;
    /** @type {Collision | null} */
    this.collision = null;
  }

  /**
   * @param {string} mode
   * @param {object} opts
   * @param {((n: any) => void) | null} [constrain]
   * @param {Collision | null} [collision] how nodes collide, when the mode's `collide` option is on
   */
  configure(mode, opts, constrain = null, collision = null) {
    this.mode = mode;
    this.opts = opts;
    this.constrain = constrain;
    this.collision = opts.collide ? collision : null;
    // Repulsion reaches a few typical edge lengths: far enough to spread a neighbourhood, near enough to stay
    // cheap. The median, not the mean, so a radial's long outer spokes can't stretch it, and capped, so the
    // grid's cells stay small enough to hold a handful of nodes each.
    const { nodes, edges } = this.graph;
    const lengths = edges
      .map((e) => {
        const s = nodes[e.source],
          t = nodes[e.target];
        return Math.hypot(t.homeX - s.homeX, t.homeY - s.homeY);
      })
      .sort((x, y) => x - y);
    const typical = lengths.length ? lengths[lengths.length >> 1] : 0;
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
    const { nodes } = this.graph;
    const { ax, ay, opts } = this;
    ax.fill(0);
    ay.fill(0);
    this.time += h;
    // Held nodes keep the graph awake: their neighbours respond for as long as they're dragged.
    this.since = this.held.size ? 0 : this.since + h;
    if (this.mode !== "static") this.#forces();
    if (this.mode === "floating") {
      const heat = this.heat;
      if (heat < 1) {
        for (let i = 0; i < ax.length; i++) {
          ax[i] *= heat;
          ay[i] *= heat;
        }
      }
      if (opts.drift > 0) this.#drift();
    }

    const keep = Math.exp(-opts.friction * h);
    const stop = opts.friction * STOP * h;
    let energy = 0;
    for (const n of nodes) {
      if (this.held.has(n.index)) continue;
      let vx = (n.vx + ax[n.index] * h) * keep;
      let vy = (n.vy + ay[n.index] * h) * keep;
      const speed = Math.hypot(vx, vy);
      const slowed = Math.min(Math.max(speed - stop, 0), MAX_SPEED);
      if (speed > 0) {
        vx *= slowed / speed;
        vy *= slowed / speed;
      }
      n.vx = vx;
      n.vy = vy;
      n.x += vx * h;
      n.y += vy * h;
      if (this.constrain) this.constrain(n);
    }
    if (this.collision) {
      this.#collide();
      // A push can shove a node off its level or ring: put it back, so locks hold against collisions too.
      if (this.constrain)
        for (const n of nodes) if (!this.held.has(n.index)) this.constrain(n);
    }
    let fastest = 0;
    for (const n of nodes) {
      const v2 = n.vx * n.vx + n.vy * n.vy;
      energy += v2;
      if (v2 > fastest) fastest = v2;
    }
    energy = nodes.length ? energy / nodes.length : 0;
    // At rest means every node, not the average: one node still moving among thousands barely shifts the mean.
    this.quiet = fastest < SLEEP ? this.quiet + 1 : 0;
    return energy;
  }

  #forces() {
    const { nodes, edges } = this.graph;
    const { ax, ay, opts } = this;
    const anchor = this.mode === "elastic" ? opts.anchor : opts.memory;
    if (anchor > 0) {
      for (const n of nodes) {
        ax[n.index] += anchor * (n.homeX - n.x);
        ay[n.index] += anchor * (n.homeY - n.y);
      }
    }

    const stretch = this.mode === "floating" ? opts.linkLength : 1;
    if (opts.links > 0) {
      for (const e of edges) {
        const s = nodes[e.source],
          t = nodes[e.target];
        const rest = Math.hypot(t.homeX - s.homeX, t.homeY - s.homeY) * stretch;
        const dx = t.x - s.x,
          dy = t.y - s.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const f = (opts.links * (d - rest)) / d;
        ax[s.index] += f * dx;
        ay[s.index] += f * dy;
        ax[t.index] -= f * dx;
        ay[t.index] -= f * dy;
      }
    }

    if (this.mode !== "floating") return;
    // Only nearby nodes push: within `reach`, found through a grid, and fading to nothing at its edge so nothing
    // jumps as nodes cross it. All pairs would cost n² per step; this costs about n times the neighbours.
    const k = opts.repulsion * 1000;
    if (k > 0) {
      const reach = this.reach;
      const pos = (n) => n.x;
      const posY = (n) => n.y;
      const grid = bucket(nodes, reach, pos, posY);
      eachNearPair(nodes, grid, reach, pos, posY, (a, b) => {
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const raw = Math.hypot(dx, dy);
        if (raw >= reach) return;
        const d = Math.max(raw, REPEL_MIN);
        const fade = 1 - (raw / reach) ** 2;
        const f = (k / (d * d * d)) * fade * fade;
        ax[a.index] -= f * dx;
        ay[a.index] -= f * dy;
        ax[b.index] += f * dx;
        ay[b.index] += f * dy;
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
    const { ax, ay, opts } = this;
    for (const n of this.graph.nodes) {
      const p = this.phase[n.index];
      ax[n.index] += opts.drift * Math.sin(this.time * 0.6 + p);
      ay[n.index] += opts.drift * Math.cos(this.time * 0.47 + p * 1.7);
    }
  }

  /**
   * Push overlapping nodes apart: footprint boxes along the axis they overlap least on, or circles along the
   * line between them. A held node doesn't give way; the other takes the whole push. Overlapping pairs also lose
   * the speed they had towards each other, so they don't bounce.
   */
  #collide() {
    const { nodes } = this.graph;
    const { boxes, padding } = this.collision;
    const half = padding / 2;
    // Bucket by footprint centre into cells at least as big as the biggest footprint: only neighbouring cells
    // can hold overlapping pairs.
    let cell = 1;
    for (const n of nodes) {
      const b = n.box;
      cell = Math.max(cell, b.x1 - b.x0 + padding, b.y1 - b.y0 + padding);
    }
    const cx = (n) => n.x + (n.box.x0 + n.box.x1) / 2;
    const cy = (n) => n.y + (n.box.y0 + n.box.y1) / 2;
    const grid = bucket(nodes, cell, cx, cy);
    eachNearPair(nodes, grid, cell, cx, cy, (a, b) => {
      if (boxes) this.#separateBoxes(a, b, half);
      else this.#separateCircles(a, b, half);
    });
  }

  #shares(a, b) {
    const aHeld = this.held.has(a.index),
      bHeld = this.held.has(b.index);
    if (aHeld && bHeld) return null;
    return aHeld ? [0, 1] : bHeld ? [1, 0] : [0.5, 0.5];
  }

  #separateBoxes(a, b, half) {
    const ox =
      Math.min(a.x + a.box.x1, b.x + b.box.x1) -
      Math.max(a.x + a.box.x0, b.x + b.box.x0) +
      half * 2;
    if (ox <= 0) return;
    const oy =
      Math.min(a.y + a.box.y1, b.y + b.box.y1) -
      Math.max(a.y + a.box.y0, b.y + b.box.y0) +
      half * 2;
    if (oy <= 0) return;
    const shares = this.#shares(a, b);
    if (!shares) return;
    if (ox < oy) {
      const dir =
        a.x + (a.box.x0 + a.box.x1) / 2 <= b.x + (b.box.x0 + b.box.x1) / 2
          ? -1
          : 1;
      a.x += dir * ox * shares[0];
      b.x -= dir * ox * shares[1];
      settle(a, b, 1, 0, shares);
    } else {
      const dir =
        a.y + (a.box.y0 + a.box.y1) / 2 <= b.y + (b.box.y0 + b.box.y1) / 2
          ? -1
          : 1;
      a.y += dir * oy * shares[0];
      b.y -= dir * oy * shares[1];
      settle(a, b, 0, 1, shares);
    }
  }

  #separateCircles(a, b, half) {
    const min = a.radius + b.radius + half * 2;
    let dx = b.x - a.x,
      dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    const shares = this.#shares(a, b);
    if (!shares) return;
    let d = Math.sqrt(d2);
    if (d < 1e-6) {
      // Exactly on top of each other: pick a direction that differs per pair.
      const angle = (a.index * 7 + b.index * 13) % 6.283;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      d = 1;
    } else {
      dx /= d;
      dy /= d;
    }
    const push = min - (d < 1e-6 ? 0 : d);
    a.x -= dx * push * shares[0];
    a.y -= dy * push * shares[0];
    b.x += dx * push * shares[1];
    b.y += dy * push * shares[1];
    settle(a, b, dx, dy, shares);
  }
}

/** A grid cell's key: exact for cells within ±32k of the origin, which at any useful cell size is plenty. */
const cellKey = (gx, gy) => (gx + 0x8000) * 0x10000 + (gy + 0x8000);

/** Nodes in square cells of side `cell`, by the point (px, py) of each. */
function bucket(nodes, cell, px, py) {
  const grid = new Map();
  for (const n of nodes) {
    const key = cellKey(Math.floor(px(n) / cell), Math.floor(py(n) / cell));
    const list = grid.get(key);
    if (list) list.push(n);
    else grid.set(key, [n]);
  }
  return grid;
}

/** Every pair of nodes in the same or neighbouring cells, once each: all pairs closer than a cell's side. */
function eachNearPair(nodes, grid, cell, px, py, visit) {
  for (const n of nodes) {
    const gx = Math.floor(px(n) / cell),
      gy = Math.floor(py(n) / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const list = grid.get(cellKey(gx + ox, gy + oy));
        if (!list) continue;
        for (const m of list) if (m.index > n.index) visit(n, m);
      }
    }
  }
}

const now = () => performance.now();

/** Remove the part of two nodes' velocities that closes the gap between them along (nx, ny). */
function settle(a, b, nx, ny, shares) {
  const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  // For boxes the axis isn't oriented from a to b, so take whichever sign is closing.
  const ax = a.x - b.x,
    ay = a.y - b.y;
  const toward = Math.sign(ax * nx + ay * ny) || 1;
  if (closing * toward >= 0) return;
  a.vx -= closing * nx * shares[0];
  a.vy -= closing * ny * shares[0];
  b.vx += closing * nx * shares[1];
  b.vy += closing * ny * shares[1];
}
