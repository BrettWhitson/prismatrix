// Transitions: how nodes get from one state to the next. A new layout's morph (every node gliding from where it is to
// its home, round the rings in a radial), where a new graph's new nodes start (grown out of their family, or faded in
// where they land), and the shading that eases the hover's emphasis and fade-ins along.
//
// Pure: they work on a matrix (matrix.js) and per-node arrays. The controller (controller.js) decides when.

import { EASINGS, approach } from "./animation.js";

/**
 * A point `f` of the way from (x0, y0) to (x1, y1) around a radial layout's centre: angle and radius each change
 * evenly (the angle the short way round), so nodes swing along their rings instead of cutting across the middle.
 */
export function alongRings({ cx, cy }, x0, y0, x1, y1, f) {
  const r0 = Math.hypot(x0 - cx, y0 - cy),
    r1 = Math.hypot(x1 - cx, y1 - cy);
  // At (or very near) the centre a point has no angle of its own: take the other end's.
  const a1 =
    r1 > 1e-6 ? Math.atan2(y1 - cy, x1 - cx) : Math.atan2(y0 - cy, x0 - cx);
  const a0 = r0 > 1e-6 ? Math.atan2(y0 - cy, x0 - cx) : a1;
  let turn = a1 - a0;
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  const r = r0 + (r1 - r0) * f,
    a = a0 + turn * f;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

/**
 * Progress of an animation that started at `start` and lasts `ms`, at `now`: `t` 0–1, and `f` eased by `easing`
 * (an EASINGS name). A frame stamped a little before the change that started it counts as its start.
 */
export function progress(now, start, ms, easing) {
  const t = ms > 0 ? Math.min(Math.max((now - start) / ms, 0), 1) : 1;
  return { t, f: (EASINGS[easing] ?? EASINGS.smooth)(t) };
}

/**
 * The positions a morph starts from (every node where it is now). Velocities are cleared: the morph moves them.
 * @param {import("./matrix.js").Matrix} m
 */
export function morphFrom(m) {
  m.vx.fill(0);
  m.vy.fill(0);
  return { x: m.x.slice(), y: m.y.slice() };
}

/**
 * One morph frame: every node `f` of the way from where it started (`from`) to its home, round the rings in a radial
 * (`routing.kind`), except the `held` ones (under the pointer).
 * @param {import("./matrix.js").Matrix} m
 * @param {{ x: Float64Array, y: Float64Array }} from
 * @param {{ kind: string, cx?: number, cy?: number }} routing
 * @param {Set<number>} held
 */
export function morph(m, from, routing, held, f) {
  const { x, y, homeX, homeY, count } = m;
  const { x: x0, y: y0 } = from;
  if (routing.kind === "radial") {
    for (let i = 0; i < count; i++) {
      if (held.size && held.has(i)) continue;
      [x[i], y[i]] = alongRings(routing, x0[i], y0[i], homeX[i], homeY[i], f);
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    if (held.size && held.has(i)) continue;
    x[i] = x0[i] + (homeX[i] - x0[i]) * f;
    y[i] = y0[i] + (homeY[i] - y0[i]) * f;
  }
}

/**
 * Where a new graph's nodes start. Nodes the previous graph had start where they were. New ones, by `enter`: "grow"
 * out of their nearest ancestor that was already there (or their root's new home), "fade" in where they land, or
 * ("none") just appear there; the first two start unseen (`appear` 0). One pass, parents before children: each new
 * node takes its parent's answer, so a long new chain costs no more than a short one.
 * @param {import("./graph.js").Graph} graph   the new working graph, homes in place
 * @param {import("./graph.js").Graph | null} previous
 * @param {Int32Array | null} was  per node, its index in `previous` (-1: new)
 * @param {string} enter
 * @param {Float32Array} appear     per node, how far faded in (set for new nodes)
 * @returns {boolean} whether any node starts unseen
 */
export function arrive(graph, previous, was, enter, appear) {
  const { nodes, matrix: m, order } = graph;
  const count = nodes.length;
  // Per node: the previous graph's index of its nearest ancestor that was already there (-1: none), and its root.
  const from = new Int32Array(count).fill(-1);
  const root = Int32Array.from({ length: count }, (_, i) => i);
  for (const i of order) {
    const p = nodes[i].parent;
    if (p < 0) continue;
    root[i] = root[p];
    from[i] = was && was[p] >= 0 ? was[p] : from[p];
  }
  let unseen = false;
  for (let i = 0; i < count; i++) {
    const old = was ? was[i] : -1;
    if (old >= 0) {
      m.x[i] = previous.matrix.x[old];
      m.y[i] = previous.matrix.y[old];
      continue;
    }
    appear[i] = enter === "none" ? 1 : 0;
    unseen ||= enter !== "none";
    if (enter !== "grow") {
      m.x[i] = m.homeX[i];
      m.y[i] = m.homeY[i];
    } else if (from[i] >= 0) {
      m.x[i] = previous.matrix.x[from[i]];
      m.y[i] = previous.matrix.y[from[i]];
    } else {
      m.x[i] = m.homeX[root[i]];
      m.y[i] = m.homeY[root[i]];
    }
  }
  return unseen;
}

/**
 * One step of the shading: each node's `shade` eases toward lit (1) or dimmed (0) over `hoverFade` ms (`lit`: a
 * flag per node to light, or null for all), and nodes still fading in (`appear` < 1) carry on over `transition` ms.
 * @param {Float32Array} shade
 * @param {Float32Array} appear
 * @param {Uint8Array | null} lit
 * @param {number} dt seconds
 * @param {{ hoverFade: number, transition: number }} anim
 * @returns {{ changing: boolean, arriving: boolean }} whether anything changed, and whether any node is still fading in
 */
export function fade(shade, appear, lit, dt, { hoverFade, transition }) {
  let changing = false,
    arriving = false;
  for (let i = 0; i < shade.length; i++) {
    const target = !lit || lit[i] ? 1 : 0;
    if (shade[i] !== target) {
      shade[i] = approach(shade[i], target, dt, hoverFade);
      changing = true;
    }
    if (appear[i] < 1) {
      appear[i] =
        transition > 0 ? Math.min(1, appear[i] + (dt * 1000) / transition) : 1;
      changing = true;
      arriving ||= appear[i] < 1;
    }
  }
  return { changing, arriving };
}
