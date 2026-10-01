// Layouts place every node's home. Each layout also says which physics modes it supports, with its own options
// and defaults for each, and how its edges are routed (the shape of a "step" edge depends on the layout).

import { bool, range, select } from "./schema.js";
import { tidy } from "./tidy.js";
import { layeredLayout } from "./layered.js";

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

/** At most this many rounds of fitting the rings to the tidy angles. */
const RADIAL_ROUNDS = 6;

/**
 * Radial tree: depth is the ring. One root sits in the middle; several roots share the first ring around an empty
 * centre. Rings are at least `ringGap` apart, and clear of each other's footprints.
 *
 * Spacing "tidy" (the default) lays the tree out as a tidy tree in angle (as d3's radial trees do): every node takes
 * the angle its footprint spans on its ring (so inner rings, being smaller, give a node more angle), and the tidy
 * tree (tidy.js) packs subtrees as tightly as those angles allow, spreads small ones evenly and centres every parent
 * over its children. If that needs more than the sweep, every ring moves out in proportion until it fits; the
 * angles are then spread across the sweep. No subtree is ever given angle it doesn't use, so one big branch can't
 * leave the middle empty.
 *
 * Spacing "leaves" is the classic rule: each subtree gets a wedge of its parent's in proportion to its leaf count,
 * and each ring moves out until every node fits across its wedge.
 */
export function radialLayout(
  graph,
  { ringGap = 80, sweep = 360, rotation = 0, spacing = "tidy" } = {},
  sizing = DEFAULT_SIZING,
) {
  const { nodes } = graph;
  const count = nodes.length;
  const shared = graph.roots.length > 1 ? 1 : 0;
  const ringOf = (n) => n.depth + shared;
  const rings = graph.maxDepth + shared + 1;
  const sweepRad = (sweep * Math.PI) / 180;
  // A full circle leaves no gap between the first and last node; a partial one is centred on "up".
  const start =
    ((rotation - 90) * Math.PI) / 180 - (sweep < 360 ? sweepRad / 2 : 0);
  const gap = sizing.gap + 6;

  const angle = new Float64Array(count);
  const across = new Float64Array(count); // footprint width across the spoke

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

  /** The smallest ring radii: ring gap apart and clear of each other's footprints. */
  const baseRadii = ({ out, inward }) => {
    const radius = new Float64Array(rings);
    for (let k = 1; k < rings; k++)
      radius[k] = Math.max(
        radius[k - 1] + ringGap,
        radius[k - 1] + out[k - 1] + gap + inward[k],
      );
    return radius;
  };

  /** Leaf-count wedges: every subtree a share of its parent's wedge in proportion to its leaves. */
  const leafWedges = () => {
    const wedge = new Float64Array(count);
    const share = (list, from, width) => {
      let total = 0;
      for (const c of list) total += nodes[c].leaves;
      let at = from;
      for (const c of list) {
        const part = (width * nodes[c].leaves) / total;
        wedge[c] = part;
        angle[c] = at + part / 2;
        at += part;
      }
    };
    share(graph.roots, start, sweepRad);
    for (const i of graph.order)
      if (nodes[i].children.length)
        share(nodes[i].children, angle[i] - wedge[i] / 2, wedge[i]);
    return wedge;
  };

  /**
   * With the angles settled, pull each ring in as far as it'll go, from the inside out: until neighbours on it
   * would touch (at the angles they have), the ring gap, or the ring inside it. Rings only ever move in, and the
   * angles don't change, so nothing new can overlap: the crowded ring sets its own radius and the others close up
   * behind it, instead of every ring moving out by the same factor.
   */
  const compact = (radius) => {
    const { out, inward } = measure();
    const byRing = Array.from({ length: rings }, () => []);
    for (const n of nodes) byRing[ringOf(n)].push(n.index);
    const full = sweep >= 360;
    const next = new Float64Array(rings);
    for (let k = 1; k < rings; k++) {
      const list = byRing[k].sort((a, b) => angle[a] - angle[b]);
      let fit = 0;
      const pair = (a, b, turn) => {
        const delta = Math.min(turn, Math.PI);
        const halfA = across[a] / 2 + gap / 2,
          halfB = across[b] / 2 + gap / 2;
        fit = Math.max(fit, (halfA + halfB) / (2 * Math.sin(delta / 2)));
      };
      for (let i = 1; i < list.length; i++)
        pair(list[i - 1], list[i], angle[list[i]] - angle[list[i - 1]]);
      if (full && list.length > 1)
        pair(
          list.at(-1),
          list[0],
          angle[list[0]] + Math.PI * 2 - angle[list.at(-1)],
        );
      next[k] = Math.min(
        radius[k],
        Math.max(
          next[k - 1] + ringGap,
          next[k - 1] + out[k - 1] + gap + inward[k],
          fit,
        ),
      );
    }
    return next;
  };

  let radius;
  if (spacing === "leaves") {
    const wedge = leafWedges();
    const reach = measure();
    radius = baseRadii(reach);
    // Out until every node fits across its wedge.
    const fit = new Float64Array(rings);
    for (const n of nodes) {
      const ring = ringOf(n);
      if (!ring) continue;
      const w = Math.min(wedge[n.index], Math.PI);
      fit[ring] = Math.max(
        fit[ring],
        (across[n.index] + gap) / (2 * Math.sin(w / 2)),
      );
    }
    for (let k = 1; k < rings; k++)
      radius[k] = Math.max(radius[k], radius[k - 1] + ringGap, fit[k]);
  } else {
    // Measure footprints at leaf-wedge angles to start with; later rounds measure at the tidy angles.
    leafWedges();
    const tree = {
      parent: nodes.map((n) => n.parent),
      children: nodes.map((n) => n.children),
      roots: graph.roots,
    };
    const half = new Float64Array(count);
    let scale = 1;
    for (let round = 0; round < RADIAL_ROUNDS; round++) {
      // Each ring starts at the least radius its nodes could fit around the sweep at (side by side, no gaps
      // wasted), so a crowded ring starts big and a sparse one small; then all of them out together as needed.
      const reach = measure();
      const around = new Float64Array(rings);
      for (const n of nodes) around[ringOf(n)] += across[n.index] + gap;
      const base = baseRadii(reach);
      for (let k = 1; k < rings; k++)
        base[k] = Math.max(
          base[k],
          base[k - 1] + ringGap,
          around[k] / sweepRad,
        );
      radius = base.map((r) => r * scale);
      // Half the angle each footprint spans on its ring (exactly: two neighbours that far apart just touch).
      for (const n of nodes) {
        const r = radius[ringOf(n)];
        half[n.index] = r
          ? Math.asin(Math.min(1, (across[n.index] / 2 + gap / 2) / r))
          : 0;
      }
      const { x } = tidy(
        { ...tree, left: half, right: half },
        { sibling: 0, cousin: 0, root: 0 },
      );
      let lo = Infinity,
        hi = -Infinity;
      for (let i = 0; i < count; i++) {
        lo = Math.min(lo, x[i] - half[i]);
        hi = Math.max(hi, x[i] + half[i]);
      }
      const span = hi - lo;
      // Spread across the sweep; a full circle spreads over all of it, the seam between last and first included.
      const stretch = span > 0 ? sweepRad / span : 0;
      for (let i = 0; i < count; i++) angle[i] = start + (x[i] - lo) * stretch;
      // Needs more than the sweep: every ring out in proportion (angles shrink about as much), and again.
      if (span > sweepRad * 1.0001) scale *= Math.min(span / sweepRad, 4);
      else if (round > 0) break;
    }
    radius = compact(radius);
  }

  for (const n of nodes) {
    const r = radius[ringOf(n)];
    n.homeX = r ? Math.cos(angle[n.index]) * r : 0;
    n.homeY = r ? Math.sin(angle[n.index]) * r : 0;
  }
  return { kind: "radial", cx: 0, cy: 0 };
}

/** Keeps a node on its level (tree) or its ring (radial) while physics moves it. */
export function constrainer(routing, opts) {
  if (
    (routing.kind === "tree" || routing.kind === "layered") &&
    opts.levelLock
  ) {
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
  merged: {
    label: "Merged tree",
    run: layeredLayout,
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
        "nodeGap",
        "Node gap",
        0,
        120,
        1,
        16,
        "Space between neighbours on a layer.",
      ),
      select(
        "ranking",
        "Layers",
        [
          { value: "longest", label: "By depth from the top" },
          { value: "simplex", label: "Fewest long edges" },
        ],
        "longest",
        "Fewest long edges lets a node sit lower, next to what it's made from.",
      ),
      select(
        "ordering",
        "Ordering",
        [
          { value: "sifting", label: "Global sifting" },
          { value: "barycenter", label: "Barycenter (faster)" },
        ],
        "sifting",
        "How nodes are ordered along each layer to cut crossings.",
      ),
      select(
        "placement",
        "Placement",
        [
          { value: "balanced", label: "Balanced (straight long edges)" },
          { value: "median", label: "Median" },
        ],
        "balanced",
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
            "Nodes only slide sideways along their layer.",
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
        "spacing",
        "Spacing",
        [
          { value: "tidy", label: "Tidy (compact)" },
          { value: "leaves", label: "Wedges by leaf count" },
        ],
        "tidy",
        "Tidy packs the tree in angle like a tidy tree: subtrees take only the angle they use, so the middle fills in. Wedges by leaf count is the classic rule.",
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
