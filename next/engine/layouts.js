// Layouts place every node's home. Each layout also says which physics modes it supports, with its own options
// and defaults for each, and how its edges are routed (the shape of a "step" edge depends on the layout).

import { bool, range, select } from "./schema.js";

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
 * Tidy tree (Reingold–Tilford style): each subtree is packed against its left sibling as tightly as their
 * footprints allow, level by level, and every parent sits centred over its first and last child. Levels are at
 * least `levelGap` apart, and further when their footprints need it.
 */
export function treeLayout(
  graph,
  { direction = "TB", levelGap = 90, siblingGap = 16 } = {},
  sizing = DEFAULT_SIZING,
) {
  const count = graph.nodes.length;
  const flip = direction === "BT" || direction === "RL";
  const across = direction === "LR" || direction === "RL";
  // Footprints in (breadth, depth) terms: breadth runs along a level, depth away from the root.
  const b0 = new Float64Array(count),
    b1 = new Float64Array(count),
    d0 = new Float64Array(count),
    d1 = new Float64Array(count);
  for (const n of graph.nodes) {
    const box = sizing.box(n.index, TREE_LABEL_ANGLE[direction]);
    const [lo, hi, near, far] = across
      ? [box.y0, box.y1, box.x0, box.x1]
      : [box.x0, box.x1, box.y0, box.y1];
    b0[n.index] = lo;
    b1[n.index] = hi;
    d0[n.index] = flip ? -far : near;
    d1[n.index] = flip ? -near : far;
  }
  const gap = siblingGap + sizing.gap;
  const offset = new Float64Array(count); // breadth relative to the parent

  /** Pack contours left to right as tightly as they allow: each one's offset, and the merged contour. */
  const pack = (contours, spacing) => {
    const offsets = [];
    let acc = null;
    for (const c of contours) {
      if (!acc) {
        offsets.push(0);
        acc = { lo: [...c.lo], hi: [...c.hi] };
        continue;
      }
      let off = -Infinity;
      const common = Math.min(acc.lo.length, c.lo.length);
      for (let d = 0; d < common; d++)
        off = Math.max(off, acc.hi[d] - c.lo[d] + spacing);
      offsets.push(off);
      for (let d = 0; d < c.lo.length; d++) {
        if (d < acc.lo.length) acc.hi[d] = c.hi[d] + off;
        else {
          acc.lo.push(c.lo[d] + off);
          acc.hi.push(c.hi[d] + off);
        }
      }
    }
    return { offsets, acc };
  };

  /** A subtree's contour: for each level from its root down, its leftmost and rightmost extent. */
  const contour = (i) => {
    const node = graph.nodes[i];
    if (!node.children.length) return { lo: [b0[i]], hi: [b1[i]] };
    const { offsets, acc } = pack(node.children.map(contour), gap);
    const centre = (offsets[0] + offsets.at(-1)) / 2;
    node.children.forEach((c, k) => (offset[c] = offsets[k] - centre));
    return {
      lo: [b0[i], ...acc.lo.map((v) => v - centre)],
      hi: [b1[i], ...acc.hi.map((v) => v - centre)],
    };
  };

  if (count) {
    const { offsets, acc } = pack(graph.roots.map(contour), gap * 3);
    const middle = (Math.min(...acc.lo) + Math.max(...acc.hi)) / 2;
    graph.roots.forEach((r, k) => (offset[r] = offsets[k] - middle));
  }

  // Levels: at least levelGap apart, more where one level's footprints would reach the next's.
  const far = new Array(graph.maxDepth + 1).fill(-Infinity);
  const near = new Array(graph.maxDepth + 1).fill(Infinity);
  for (const n of graph.nodes) {
    far[n.depth] = Math.max(far[n.depth], d1[n.index]);
    near[n.depth] = Math.min(near[n.depth], d0[n.index]);
  }
  const level = [0];
  for (let k = 1; k <= graph.maxDepth; k++)
    level[k] = level[k - 1] + Math.max(levelGap, far[k - 1] - near[k] + gap);

  const breadth = new Float64Array(count);
  for (const i of graph.order) {
    const n = graph.nodes[i];
    breadth[i] = (n.parent >= 0 ? breadth[n.parent] : 0) + offset[i];
    const depth = level[n.depth] * (flip ? -1 : 1);
    n.homeX = across ? depth : breadth[i];
    n.homeY = across ? breadth[i] : depth;
  }
  return { kind: "tree", direction };
}

/**
 * Radial tree: depth is the ring, and every subtree gets a wedge of its parent's angle in proportion to its
 * leaves. One root sits in the middle; several roots share the first ring around an empty centre. Rings are at
 * least `ringGap` apart, and each sits far enough out for every node's footprint to fit inside its wedge.
 */
export function radialLayout(
  graph,
  { ringGap = 80, sweep = 360, rotation = 0 } = {},
  sizing = DEFAULT_SIZING,
) {
  const shared = graph.roots.length > 1 ? 1 : 0;
  const total =
    graph.roots.reduce((sum, r) => sum + graph.nodes[r].leaves, 0) || 1;
  const sweepRad = (sweep * Math.PI) / 180;
  const angle = new Float64Array(graph.nodes.length);
  const wedge = new Float64Array(graph.nodes.length);
  // A full circle leaves no gap between the first and last wedge; a partial one is centred on "up".
  let start =
    ((rotation - 90) * Math.PI) / 180 - (sweep < 360 ? sweepRad / 2 : 0);
  const share = (i, from, width) => {
    const node = graph.nodes[i];
    angle[i] = from + width / 2;
    wedge[i] = width;
    let at = from;
    for (const c of node.children) {
      const part = (width * graph.nodes[c].leaves) / node.leaves;
      share(c, at, part);
      at += part;
    }
  };
  for (const r of graph.roots) {
    const width = (sweepRad * graph.nodes[r].leaves) / total;
    share(r, start, width);
    start += width;
  }

  // Per ring: how far its footprints reach out along their spokes and in towards the centre, and the radius it
  // needs for each node to fit across its wedge.
  const rings = graph.maxDepth + shared + 1;
  const out = new Array(rings).fill(0);
  const inward = new Array(rings).fill(0);
  const fit = new Array(rings).fill(0);
  const gap = sizing.gap + 6;
  for (const n of graph.nodes) {
    const ring = n.depth + shared;
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
    if (ring === 0) {
      out[0] = Math.max(out[0], reach);
      continue;
    }
    out[ring] = Math.max(out[ring], hi);
    inward[ring] = Math.max(inward[ring], -lo);
    const w = Math.min(wedge[n.index], Math.PI);
    fit[ring] = Math.max(
      fit[ring],
      (side1 - side0 + gap) / (2 * Math.sin(w / 2)),
    );
  }
  const radius = [0];
  for (let k = 1; k < rings; k++)
    radius[k] = Math.max(
      radius[k - 1] + ringGap,
      radius[k - 1] + out[k - 1] + gap + inward[k],
      fit[k],
    );

  for (const n of graph.nodes) {
    const r = radius[n.depth + shared];
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
        "Space between neighbouring footprints.",
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
