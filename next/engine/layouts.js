// Layouts place every node's home. Each layout also says which physics modes it supports, with its own options
// and defaults for each, and how its edges are routed (the shape of a "step" edge depends on the layout).

import { bool, range, select } from "./schema.js";
import { tidy } from "./tidy.js";

/**
 * @typedef {object} Routing How edges bend for this layout.
 * @property {"tree" | "radial"} kind
 * @property {string} [direction] tree: TB, BT, LR or RL
 * @property {number} [cx]        radial: the centre
 * @property {number} [cy]
 */

/**
 * @typedef {object} Sizing What a layout needs to know about node sizes.
 * @property {(index: number, angle: number) => { x0: number, y0: number, x1: number, y1: number }} box
 *   a node's footprint relative to its centre, with its label placed at `angle` (see boxes.js)
 * @property {number} gap extra clearance every footprint keeps from its neighbours
 */

/** Nodes of radius 8 with no labels. */
export const DEFAULT_SIZING = {
  box: () => ({ x0: -8, y0: -8, x1: 8, y1: 8 }),
  gap: 0,
};

/** Where an "outward" label points in a tree. */
export const TREE_LABEL_ANGLE = {
  TB: Math.PI / 2,
  BT: -Math.PI / 2,
  LR: 0,
  RL: Math.PI,
};

/**
 * Tidy tree: Walker's algorithm in linear time (Buchheim, Jünger & Leipert; see tidy.js), with every node's real
 * footprint (node and label). Subtrees pack as tightly as their outlines allow, small ones between big ones are
 * spread out evenly, and every parent sits centred over its children. Levels are at least `levelGap` apart, and
 * further when their footprints need it.
 */
export function treeLayout(
  graph,
  {
    direction = "TB",
    levelGap = 90,
    siblingGap = 16,
    subtreeGap = 28,
    parentAlign = "centres",
  } = {},
  sizing = DEFAULT_SIZING,
) {
  const count = graph.nodes.length;
  const flip = direction === "BT" || direction === "RL";
  const across = direction === "LR" || direction === "RL";
  // Footprints in (breadth, depth) terms: breadth runs along a level, depth away from the root.
  const left = new Float64Array(count),
    right = new Float64Array(count),
    d0 = new Float64Array(count),
    d1 = new Float64Array(count);
  for (const n of graph.nodes) {
    const box = sizing.box(n.index, TREE_LABEL_ANGLE[direction]);
    const [lo, hi, near, far] = across
      ? [box.y0, box.y1, box.x0, box.x1]
      : [box.x0, box.x1, box.y0, box.y1];
    left[n.index] = Math.max(0, -lo);
    right[n.index] = Math.max(0, hi);
    d0[n.index] = flip ? -far : near;
    d1[n.index] = flip ? -near : far;
  }

  const { x: breadth } = tidy(
    {
      parent: graph.nodes.map((n) => n.parent),
      children: graph.nodes.map((n) => n.children),
      roots: graph.roots,
      left,
      right,
    },
    {
      sibling: siblingGap + sizing.gap,
      cousin: subtreeGap + sizing.gap,
      root: subtreeGap * 2 + sizing.gap,
      parent: parentAlign,
    },
  );

  // Levels: at least levelGap apart, more where one level's footprints would reach the next's.
  const far = new Array(graph.maxDepth + 1).fill(-Infinity);
  const near = new Array(graph.maxDepth + 1).fill(Infinity);
  for (const n of graph.nodes) {
    far[n.depth] = Math.max(far[n.depth], d1[n.index]);
    near[n.depth] = Math.min(near[n.depth], d0[n.index]);
  }
  const level = [0];
  for (let k = 1; k <= graph.maxDepth; k++)
    level[k] =
      level[k - 1] +
      Math.max(levelGap, far[k - 1] - near[k] + siblingGap + sizing.gap);

  for (const n of graph.nodes) {
    const depth = level[n.depth] * (flip ? -1 : 1);
    n.homeX = across ? depth : breadth[n.index];
    n.homeY = across ? breadth[n.index] : depth;
  }
  return { kind: "tree", direction };
}

/** At most this many rounds of solving wedges and ring radii together. */
const RADIAL_ROUNDS = 8;

/**
 * Radial tree: depth is the ring, and every subtree gets a wedge of its parent's angle. One root sits in the
 * middle; several roots share the first ring around an empty centre.
 *
 * Wedges are sized by need, not by leaf count: a subtree needs the larger of what its own root takes up across
 * its spoke and what its children need together, so a lone leaf takes only its own width and a deep, bushy
 * subtree gets room for its outer rings. Spare angle is shared out in proportion to need. Rings are at least
 * `ringGap` apart and far enough out for every node to fit across its wedge.
 *
 * Wedges and radii depend on each other (a node's angular need shrinks as its ring moves out), so they're solved
 * in rounds. The first round shares wedges by leaf count, which always fits; each later one shares them by need at
 * the previous round's radii. Every round's result fits (the radii are fitted to its wedges), so the most compact
 * one (nodes nearest the centre on average) is kept: never less compact than sharing by leaves.
 */
export function radialLayout(
  graph,
  { ringGap = 80, sweep = 360, rotation = 0, wedges = "need" } = {},
  sizing = DEFAULT_SIZING,
) {
  const { nodes } = graph;
  const count = nodes.length;
  const shared = graph.roots.length > 1 ? 1 : 0;
  const ringOf = (n) => n.depth + shared;
  const rings = graph.maxDepth + shared + 1;
  const sweepRad = (sweep * Math.PI) / 180;
  // A full circle leaves no gap between the first and last wedge; a partial one is centred on "up".
  const start =
    ((rotation - 90) * Math.PI) / 180 - (sweep < 360 ? sweepRad / 2 : 0);
  const gap = sizing.gap + 6;

  const angle = new Float64Array(count);
  const wedge = new Float64Array(count);
  const across = new Float64Array(count); // footprint width across the spoke
  const need = new Float64Array(count); // angle a subtree needs
  let radius = new Float64Array(rings);

  /** Footprints at the current angles: per node its width across the spoke, per ring its radial reach. */
  const measure = () => {
    const out = new Float64Array(rings),
      inward = new Float64Array(rings);
    for (const n of nodes) {
      const a = angle[n.index];
      const box = sizing.box(n.index, a);
      const ux = Math.cos(a),
        uy = Math.sin(a);
      let lo = Infinity,
        hi = -Infinity,
        side0 = Infinity,
        side1 = -Infinity,
        reach = 0;
      for (const [x, y] of [
        [box.x0, box.y0],
        [box.x1, box.y0],
        [box.x0, box.y1],
        [box.x1, box.y1],
      ]) {
        const along = x * ux + y * uy;
        const side = y * ux - x * uy;
        lo = Math.min(lo, along);
        hi = Math.max(hi, along);
        side0 = Math.min(side0, side);
        side1 = Math.max(side1, side);
        reach = Math.max(reach, Math.hypot(x, y));
      }
      across[n.index] = side1 - side0;
      const ring = ringOf(n);
      if (ring === 0) out[0] = Math.max(out[0], reach);
      else {
        out[ring] = Math.max(out[ring], hi);
        inward[ring] = Math.max(inward[ring], -lo);
      }
    }
    return { out, inward };
  };

  /** Ring radii: ring gap apart, clear of each other's footprints, and (with `fitted`) wide enough for wedges. */
  const solveRadii = (out, inward, fitted) => {
    const fit = new Float64Array(rings);
    if (fitted)
      for (const n of nodes) {
        const ring = ringOf(n);
        if (!ring) continue;
        const w = Math.min(wedge[n.index], Math.PI);
        fit[ring] = Math.max(
          fit[ring],
          (across[n.index] + gap) / (2 * Math.sin(w / 2)),
        );
      }
    const next = new Float64Array(rings);
    for (let k = 1; k < rings; k++)
      next[k] = Math.max(
        next[k - 1] + ringGap,
        next[k - 1] + out[k - 1] + gap + inward[k],
        fit[k],
      );
    return next;
  };

  /** Wedges shared out top-down by `weight` per node (leaves, or need). */
  const shareBy = (weight) => {
    const share = (list, from, width) => {
      let total = 0;
      for (const c of list) total += weight[c];
      let at = from;
      for (const c of list) {
        // In proportion to weight; with no weights at all (a degenerate graph), evenly.
        const part =
          total > 0 ? (width * weight[c]) / total : width / list.length;
        wedge[c] = part;
        angle[c] = at + part / 2;
        at += part;
      }
    };
    share(graph.roots, start, sweepRad);
    for (const i of graph.order) {
      const n = nodes[i];
      if (n.children.length)
        share(n.children, angle[i] - wedge[i] / 2, wedge[i]);
    }
  };

  /** Each subtree's angular need at the current radii, bottom-up. */
  const needs = () => {
    for (let k = graph.order.length - 1; k >= 0; k--) {
      const n = nodes[graph.order[k]];
      const r = radius[ringOf(n)];
      // A node in the centre takes no angle of its own; a ring node needs the angle its width spans there.
      const own = r
        ? 2 * Math.asin(Math.min(1, (across[n.index] + gap) / (2 * r)))
        : 0;
      let children = 0;
      for (const c of n.children) children += need[c];
      need[n.index] = Math.max(own, children);
    }
    return need;
  };

  const leaves = Float64Array.from(nodes, (n) => n.leaves);
  let best = null;
  /** Fit radii to the current wedges, and keep the result if it's the most compact so far. */
  const settle = () => {
    const reach = measure();
    const next = solveRadii(reach.out, reach.inward, true);
    let moved = 0;
    for (let k = 0; k < rings; k++)
      moved = Math.max(moved, Math.abs(next[k] - radius[k]));
    radius = next;
    // Most compact: nodes closest to the centre on average. (The outermost ring alone would keep a big empty
    // middle to save a few per cent at the rim.)
    let score = 0;
    for (const n of nodes) score += radius[ringOf(n)];
    if (!best || score < best.score)
      best = { score, radius: radius.slice(), angle: angle.slice() };
    return moved;
  };

  // Sharing by leaf count always fits: it's the fallback, and all there is with wedges: "leaves".
  shareBy(leaves);
  settle();

  if (wedges !== "leaves") {
    // Need rounds start from each ring's smallest possible radius: just wide enough for its nodes to fit around
    // the whole sweep (and the ring gap). Starting from the leaf round instead can trap them: a lone leaf given a
    // sliver there pushes its ring far out, and measured at that radius it needs almost nothing, so the ring
    // stays out.
    const reach = measure();
    const around = new Float64Array(rings);
    for (const n of nodes) around[ringOf(n)] += across[n.index] + gap;
    radius = solveRadii(reach.out, reach.inward, false);
    for (let k = 1; k < rings; k++)
      radius[k] = Math.max(
        radius[k],
        radius[k - 1] + ringGap,
        around[k] / sweepRad,
      );
    for (let round = 0; round < RADIAL_ROUNDS; round++) {
      shareBy(needs());
      if (settle() < 0.5) break;
    }
  }
  radius = best.radius;
  angle.set(best.angle);

  for (const n of nodes) {
    const r = radius[ringOf(n)];
    n.homeX = r ? Math.cos(angle[n.index]) * r : 0;
    n.homeY = r ? Math.sin(angle[n.index]) * r : 0;
  }
  return { kind: "radial", cx: 0, cy: 0 };
}

/** Keeps a node on its level (tree) or its ring (radial) while physics moves it. */
export function constrainer(routing, opts) {
  if (routing.kind === "tree" && opts.levelLock) {
    const across = routing.direction === "LR" || routing.direction === "RL";
    return across
      ? (n) => {
          n.x = n.homeX;
          n.vx = 0;
        }
      : (n) => {
          n.y = n.homeY;
          n.vy = 0;
        };
  }
  if (routing.kind === "radial" && opts.ringLock) {
    return (n) => {
      const r = Math.hypot(n.homeX - routing.cx, n.homeY - routing.cy);
      if (r < 1e-6) return;
      const dx = n.x - routing.cx;
      const dy = n.y - routing.cy;
      const d = Math.hypot(dx, dy) || 1;
      n.x = routing.cx + (dx / d) * r;
      n.y = routing.cy + (dy / d) * r;
      // Keep only the velocity along the ring.
      const tx = -dy / d,
        ty = dx / d;
      const along = n.vx * tx + n.vy * ty;
      n.vx = tx * along;
      n.vy = ty * along;
    };
  }
  return null;
}

/**
 * The layouts. `physics` lists the modes each one supports; for each mode, `options` are extra knobs only this
 * layout has and `defaults` override the mode's general defaults.
 */
export const LAYOUTS = {
  tree: {
    label: "Tree",
    run: treeLayout,
    options: [
      select(
        "direction",
        "Direction",
        [
          { value: "TB", label: "Top → bottom" },
          { value: "BT", label: "Bottom → top" },
          { value: "LR", label: "Left → right" },
          { value: "RL", label: "Right → left" },
        ],
        "TB",
      ),
      range(
        "levelGap",
        "Level gap",
        20,
        300,
        5,
        90,
        "At least this far apart; more when labels need it.",
      ),
      range(
        "siblingGap",
        "Sibling gap",
        0,
        120,
        1,
        16,
        "Space between neighbours with the same parent.",
      ),
      range(
        "subtreeGap",
        "Subtree gap",
        0,
        200,
        1,
        28,
        "Space between neighbours with different parents, so separate branches read as separate. Separate trees get twice this.",
      ),
      select(
        "parentAlign",
        "Parent over",
        [
          { value: "centres", label: "Its children's centres" },
          { value: "edges", label: "Its children's whole span" },
        ],
        "centres",
        "Centre a parent between its first and last child's centres (the classic tidy tree), or between their outer edges, which counts their labels too.",
      ),
    ],
    physics: {
      static: {},
      elastic: {
        options: [
          bool(
            "levelLock",
            "Lock to level",
            false,
            "Nodes only slide sideways along their level.",
          ),
        ],
        defaults: { anchor: 60, links: 40, friction: 9 },
      },
    },
  },
  radial: {
    label: "Radial",
    run: radialLayout,
    options: [
      range(
        "ringGap",
        "Ring gap",
        20,
        300,
        5,
        80,
        "At least this far apart; more when nodes need the room.",
      ),
      range(
        "sweep",
        "Sweep",
        60,
        360,
        5,
        360,
        "How much of the circle the tree fans over.",
      ),
      range("rotation", "Rotation", -180, 180, 5, 0),
      select(
        "wedges",
        "Wedges",
        [
          { value: "need", label: "By need" },
          { value: "leaves", label: "By leaf count" },
        ],
        "need",
        "By need gives each subtree the angle it actually takes up, so rings sit closer in. By leaf count is the classic rule.",
      ),
    ],
    physics: {
      static: {},
      elastic: {
        options: [
          bool(
            "ringLock",
            "Lock to ring",
            false,
            "Nodes only slide around their ring.",
          ),
        ],
        defaults: { anchor: 40, links: 30, friction: 7 },
      },
      floating: {},
    },
  },
};
