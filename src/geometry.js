// Edge geometry: the polyline an edge follows, from its source node's centre to its target's, for a routing and a
// shape. Pure functions, no drawing.

import { LINE, reach, startTrim } from "./boxes.js";
import { labelPlace } from "./style.js";

/** Radians per point along a ring arc (the CPU's radial steps; the GPU's pieces size their corners by it too). */
export const ARC_STEP = 0.06;
/** How far an edge's end (an arrow or a dot) holds the edge off its target, as a share of the end's size. */
export const END_ROOM = 0.9;
const FAN_STUB = 0.4; // how far a fan's junction sits towards the children, as a share of the way

/** How far the edge options' end (an arrow or a dot) holds an edge off its source and off its target (0: none there). */
export function endRooms(edge) {
  if (edge.arrow === "none") return { source: 0, target: 0 };
  const room = edge.arrowSize * END_ROOM;
  const at = edge.arrowAt ?? "target";
  return {
    source: at === "source" || at === "both" ? room : 0,
    target: at === "target" || at === "both" ? room : 0,
  };
}

/**
 * The points of an edge from `s` to `t` (anything with x and y). In a tree, a step or curve turns halfway between
 * where it will leave `s` and reach `t` (`trimA`, `trimB` from each centre: past a label in the way), so the run
 * across clears a big node's label.
 * @param {import("./layouts.js").Routing} routing
 * @param {"straight" | "step" | "fan" | "curve"} shape
 * @param {{ x: number, y: number } | null} [junction] fan only: where the parent's edges split (see fanJunctions)
 * @returns {number[]} flat x, y pairs
 */
export function edgePoints(
  routing,
  shape,
  s,
  t,
  junction = null,
  trimA = 0,
  trimB = 0,
) {
  if (shape === "fan")
    return junction
      ? [s.x, s.y, junction.x, junction.y, t.x, t.y]
      : [s.x, s.y, t.x, t.y];
  if (shape === "straight") return [s.x, s.y, t.x, t.y];
  if (shape === "curve") return curve(routing, s, t, trimA, trimB);
  if (routing.kind === "tree")
    return treeStep(routing.direction, s, t, trimA, trimB);
  return radialStep(routing, s, t);
}

/**
 * Where a tree step or curve from `a` to `b` (their positions along the tree's axis) turns: halfway between where it
 * leaves `a` (trimA on) and reaches `b` (trimB short of it).
 */
export function turnAt(a, b, trimA = 0, trimB = 0) {
  const sign = b >= a ? 1 : -1;
  return (a + sign * trimA + b - sign * trimB) / 2;
}

/** Unit vector pointing away from the root in a tree. */
const TREE_AXIS = { TB: [0, 1], BT: [0, -1], LR: [1, 0], RL: [-1, 0] };

/**
 * Where each parent's fan splits, from where its children are right now: a shared point on a short stub out of
 * the parent. In a tree the stub follows the tree's axis; in a radial it points at the children (the mean of the
 * directions to them), and it shrinks away as they spread around the parent, so a centre root with children on
 * every side gets plain spokes. Nodes without one (leaves, or children behind or all around) get NaN.
 * @returns {Float64Array} x, y pairs by node index
 */
export function fanJunctions(graph, routing) {
  const out = new Float64Array(graph.nodes.length * 2).fill(NaN);
  for (const p of graph.nodes) {
    if (!p.children.length) continue;
    let ux, uy, strength;
    if (routing.kind === "tree") {
      [ux, uy] = TREE_AXIS[routing.direction];
      strength = 1;
    } else {
      let sx = 0,
        sy = 0;
      for (const c of p.children) {
        const n = graph.nodes[c];
        const d = Math.hypot(n.x - p.x, n.y - p.y) || 1;
        sx += (n.x - p.x) / d;
        sy += (n.y - p.y) / d;
      }
      strength = Math.hypot(sx, sy) / p.children.length;
      if (strength < 0.3) continue;
      ux = sx / (strength * p.children.length);
      uy = sy / (strength * p.children.length);
    }
    // The stub reaches part of the way to the nearest child along the axis, so no child is behind the split.
    let reach = Infinity;
    for (const c of p.children) {
      const n = graph.nodes[c];
      reach = Math.min(reach, (n.x - p.x) * ux + (n.y - p.y) * uy);
    }
    if (!(reach > 0)) continue;
    const len = reach * FAN_STUB * Math.min(1, (strength - 0.3) / 0.4);
    out[p.index * 2] = p.x + ux * len;
    out[p.index * 2 + 1] = p.y + uy * len;
  }
  return out;
}

/**
 * A smooth S-curve. In a tree it leaves the parent along the tree's axis and arrives at the child the same way; in
 * a radial it leaves along the parent's spoke and arrives along the child's, bending at the ring halfway between.
 */
function curve(routing, s, t, trimA = 0, trimB = 0) {
  let c1, c2;
  if (routing.kind === "tree") {
    if (routing.direction === "LR" || routing.direction === "RL") {
      const mid = turnAt(s.x, t.x, trimA, trimB);
      c1 = [mid, s.y];
      c2 = [mid, t.y];
    } else {
      const mid = turnAt(s.y, t.y, trimA, trimB);
      c1 = [s.x, mid];
      c2 = [t.x, mid];
    }
  } else [c1, c2] = radialControls(routing, s, t);
  return cubic([s.x, s.y], c1, c2, [t.x, t.y]);
}

/** A radial curve's controls: on the ring halfway between its ends, on the source's spoke and on the target's. */
function radialControls({ cx, cy }, s, t) {
  const rs = Math.hypot(s.x - cx, s.y - cy);
  const rt = Math.hypot(t.x - cx, t.y - cy);
  const at = Math.atan2(t.y - cy, t.x - cx);
  // A node at the centre has no angle of its own: leave it towards the child.
  const as = centred(s, rs, cx, cy) ? at : Math.atan2(s.y - cy, s.x - cx);
  const rm = (rs + rt) / 2;
  return [
    [cx + Math.cos(as) * rm, cy + Math.sin(as) * rm],
    [cx + Math.cos(at) * rm, cy + Math.sin(at) * rm],
  ];
}

/** The point at `t` (0–1) of a cubic Bézier from p0 to p3, controls p1 and p2. */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/** Points along a cubic Bézier, enough for its length to look smooth (about one per 6 world px, 8 to 48). */
export function cubic(p0, p1, p2, p3) {
  const hull =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const count = Math.min(48, Math.max(8, Math.ceil(hull / 6)));
  const out = [];
  for (let i = 0; i <= count; i++)
    out.push(...bezierAt(p0, p1, p2, p3, i / count));
  return out;
}

/**
 * A polyline with each corner replaced by a circular arc of up to `radius` (shrunk where the neighbouring
 * segments are too short), as points. The GPU draws straight segments, so arcs become short ones.
 */
export function rounded(pts, radius) {
  if (radius <= 0 || pts.length < 6) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const x = pts[i],
      y = pts[i + 1];
    const ax = pts[i - 2] - x,
      ay = pts[i - 1] - y;
    const bx = pts[i + 2] - x,
      by = pts[i + 3] - y;
    const la = Math.hypot(ax, ay),
      lb = Math.hypot(bx, by);
    // The angle at the corner: near π is nearly straight, so leave the point as it is.
    const cos = (ax * bx + ay * by) / (la * lb || 1);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (!la || !lb || angle > Math.PI - 0.02) {
      out.push(x, y);
      continue;
    }
    const half = angle / 2;
    // The arc touches each segment this far from the corner; never more than half of either segment.
    const reach = Math.min(radius / Math.tan(half), la / 2, lb / 2);
    const r = reach * Math.tan(half);
    const ux = ax / la,
      uy = ay / la,
      vx = bx / lb,
      vy = by / lb;
    // The arc's centre lies along the bisector.
    let mx = ux + vx,
      my = uy + vy;
    const ml = Math.hypot(mx, my);
    mx /= ml;
    my /= ml;
    const dist = r / Math.sin(half);
    const ox = x + mx * dist,
      oy = y + my * dist;
    const a0 = Math.atan2(y + uy * reach - oy, x + ux * reach - ox);
    let sweep = Math.atan2(y + vy * reach - oy, x + vx * reach - ox) - a0;
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    if (sweep < -Math.PI) sweep += Math.PI * 2;
    // About one segment per 3 world px of arc: a small corner needs only a few.
    const steps = Math.min(
      12,
      Math.max(2, Math.ceil((Math.abs(sweep) * r) / 3)),
    );
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (sweep * k) / steps;
      out.push(ox + Math.cos(a) * r, oy + Math.sin(a) * r);
    }
  }
  out.push(pts.at(-2), pts.at(-1));
  return out;
}

/** Points per B-spline span when drawing a bundled edge. */
export const BUNDLE_STEPS = 8;
/** How closely a bundled edge follows its tree path: 1 follows the tree, 0 goes straight. */
export const BUNDLE_STRENGTH = 0.85;

/**
 * The tree path a cross-link bundles along: node indices from its source up to (not including, when there's
 * anything else on the way) the lowest common ancestor of its ends and back down to its target. Null when the edge
 * goes straight instead (ends in different trees, or nothing between them). Depends only on the forest, so it
 * lasts until the structure changes: the WebGL renderer works it out once per layout and traces the curve on the
 * GPU from it.
 * @returns {number[] | null}
 */
export function bundlePath(graph, e) {
  const nodes = graph.nodes;
  let a = e.source,
    b = e.target;
  const up = [],
    down = [];
  // Climb from the deeper end until both are at the same depth, then together until they meet.
  while (nodes[a].depth > nodes[b].depth) up.push((a = nodes[a].parent));
  while (nodes[b].depth > nodes[a].depth) down.push((b = nodes[b].parent));
  while (a !== b) {
    a = nodes[a].parent;
    b = nodes[b].parent;
    if (a < 0 || b < 0) return null;
    up.push(a);
    down.push(b);
  }
  // Both climbs end at the common ancestor. Leave it out of the control points (as Holten does) when there's
  // anything else on the path: bundles then bend towards it rather than all meeting in one point, which turns
  // into a knot at the root.
  up.pop();
  down.pop();
  const path = [e.source, ...up, ...down.reverse(), e.target];
  if (path.length === 2 && a !== e.source && a !== e.target)
    path.splice(1, 0, a); // nothing else between them: bend via the ancestor after all
  return path.length <= 2 ? null : path;
}

/**
 * The route of a cross-link (an edge that isn't a parent → child link in the forest): along the tree path between
 * its ends (bundlePath), as a B-spline pulled towards that path by BUNDLE_STRENGTH (hierarchical edge bundling,
 * Holten 2006). Cross-links that share an ancestor bundle together along the tree instead of cutting across it. Ends
 * in different trees, or a path with nothing between them, go straight.
 * @returns {number[]} flat x, y pairs
 */
export function bundledPoints(graph, e) {
  const nodes = graph.nodes;
  const path = bundlePath(graph, e);
  if (!path) {
    const s = nodes[e.source],
      t = nodes[e.target];
    return [s.x, s.y, t.x, t.y];
  }
  const first = nodes[path[0]],
    last = nodes[path.at(-1)];
  const strength = BUNDLE_STRENGTH;
  const control = path.map((i, k) => {
    // Pull towards the straight line between the ends by (1 − strength).
    const t = k / (path.length - 1);
    const lx = first.x + (last.x - first.x) * t,
      ly = first.y + (last.y - first.y) * t;
    return [
      strength * nodes[i].x + (1 - strength) * lx,
      strength * nodes[i].y + (1 - strength) * ly,
    ];
  });
  return bspline(control);
}

/** A uniform cubic B-spline through `control`, clamped (the first and last points repeated) so it starts and ends on them. */
export function bspline(control) {
  const p = [
    control[0],
    control[0],
    ...control,
    control.at(-1),
    control.at(-1),
  ];
  const out = [];
  for (let i = 0; i + 3 < p.length; i++) {
    for (let k = i === 0 ? 0 : 1; k <= BUNDLE_STEPS; k++)
      out.push(
        ...splineAt(k / BUNDLE_STEPS, p[i], p[i + 1], p[i + 2], p[i + 3]),
      );
  }
  // Exactly on the ends (the sums above can be a hair off), since trimming measures from them.
  out[0] = control[0][0];
  out[1] = control[0][1];
  out[out.length - 2] = control.at(-1)[0];
  out[out.length - 1] = control.at(-1)[1];
  return out;
}

/**
 * A point of a uniform cubic B-spline span with control points p0–p3 (each [x, y]), at t (0–1): the same sum as the
 * bundle shader's.
 */
export function splineAt(t, p0, p1, p2, p3) {
  const t2 = t * t,
    t3 = t2 * t;
  const w0 = (1 - 3 * t + 3 * t2 - t3) / 6,
    w1 = (4 - 6 * t2 + 3 * t3) / 6,
    w2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6,
    w3 = t3 / 6;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

/**
 * The route of edge `e` in `graph`: a cross-link bundles along the tree (unless edges are straight), anything else
 * follows the edge shape.
 */
export function edgeRoute(
  graph,
  routing,
  shape,
  e,
  junction = null,
  trimA = 0,
  trimB = 0,
) {
  if (routing.kind === "layered")
    return layeredPoints(
      routing,
      shape,
      e,
      graph.nodes[e.source],
      graph.nodes[e.target],
      trimA,
      trimB,
    );
  if (!e.tree && shape !== "straight") return bundledPoints(graph, e);
  return edgePoints(
    routing,
    shape,
    graph.nodes[e.source],
    graph.nodes[e.target],
    junction,
    trimA,
    trimB,
  );
}

/**
 * A layered layout's edge: through its bend points (one per layer it crosses). Bends were placed for the nodes'
 * homes; when the ends move (a drag, physics), the bends move with them, each in proportion to how far along the
 * edge it is. Straight and fan draw a polyline; step and curve repeat the tree's step or curve between each pair.
 */
function layeredPoints(routing, shape, e, s, t, trimA = 0, trimB = 0) {
  const bends = routing.bends.get(e) ?? [];
  const k = bends.length;
  const dsx = s.x - (s.homeX ?? s.x),
    dsy = s.y - (s.homeY ?? s.y),
    dtx = t.x - (t.homeX ?? t.x),
    dty = t.y - (t.homeY ?? t.y);
  const points = [{ x: s.x, y: s.y }];
  bends.forEach(([bx, by], i) => {
    const f = (i + 1) / (k + 1);
    points.push({
      x: bx + dsx * (1 - f) + dtx * f,
      y: by + dsy * (1 - f) + dty * f,
    });
  });
  points.push({ x: t.x, y: t.y });
  if (shape !== "step" && shape !== "curve")
    return points.flatMap((p) => [p.x, p.y]);
  const tree = { kind: "tree", direction: routing.direction };
  const out = [];
  for (let i = 1; i < points.length; i++) {
    // The first piece leaves the source, the last reaches the target; pieces between bends turn halfway.
    const a = i === 1 ? trimA : 0,
      b = i === points.length - 1 ? trimB : 0;
    const piece =
      shape === "step"
        ? treeStep(routing.direction, points[i - 1], points[i], a, b)
        : curve(tree, points[i - 1], points[i], a, b);
    // Each piece starts where the last ended: keep that point once.
    out.push(...(i === 1 ? piece : piece.slice(2)));
  }
  return out;
}

function treeStep(direction, s, t, trimA = 0, trimB = 0) {
  if (direction === "LR" || direction === "RL") {
    const mid = turnAt(s.x, t.x, trimA, trimB);
    return [s.x, s.y, mid, s.y, mid, t.y, t.x, t.y];
  }
  const mid = turnAt(s.y, t.y, trimA, trimB);
  return [s.x, s.y, s.x, mid, t.x, mid, t.x, t.y];
}

/**
 * Whether a radial edge's source is the layout's centre: there, or laid out there (a root that physics has nudged
 * off the centre is still the centre; giving it the angle of its drift would hook all its edges round the middle).
 */
function centred(s, rs, cx, cy) {
  if (rs < 1e-6) return true;
  return s.homeX !== undefined && Math.hypot(s.homeX - cx, s.homeY - cy) < 1e-6;
}

function radialStep(routing, s, t) {
  const { cx, cy } = routing;
  const rs = Math.hypot(s.x - cx, s.y - cy);
  // From the centre, a step edge is a spoke: straight out to the child.
  if (centred(s, rs, cx, cy)) return [s.x, s.y, t.x, t.y];
  const rt = Math.hypot(t.x - cx, t.y - cy);
  const at = Math.atan2(t.y - cy, t.x - cx);
  const as = Math.atan2(s.y - cy, s.x - cx);
  // Out along the source's spoke to the ring halfway between, round that ring, then in along the target's spoke.
  const rm = (rs + rt) / 2;
  let delta = at - as;
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  // Where the layout put the ends (a display-only node has no home of its own: where it is).
  const hs =
      s.homeX === undefined ? rs : Math.hypot(s.homeX - cx, s.homeY - cy),
    ht = t.homeX === undefined ? rt : Math.hypot(t.homeX - cx, t.homeY - cy);
  const w = stepCurveWeight(
    rs,
    rt,
    hs,
    ht,
    rm * Math.abs(delta),
    Math.hypot(t.x - s.x, t.y - s.y),
    routing.morphing,
  );
  if (w >= 1) return curve(routing, s, t);
  const pts = [s.x, s.y];
  const count = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
  for (let i = 0; i <= count; i++) {
    const a = as + (delta * i) / count;
    pts.push(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm);
  }
  pts.push(t.x, t.y);
  if (w <= 0) return pts;
  // Partway: each point of the step slides towards the curve, matched by how far along the edge it is.
  const [c1, c2] = radialControls(routing, s, t);
  return blendTowardsCubic(pts, [s.x, s.y], c1, c2, [t.x, t.y], w);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * How far a radial step edge has turned into a curve, 0 (a step round the ring) to 1 (a smooth curve). A step
 * reads as "round the ring" only while its ends sit on their rings, its child is further out than its parent, and
 * its arc doesn't loop round the centre; as a drag or physics breaks one of those, the edge eases into a curve
 * (and back), rather than snapping. Each test passes halfway where the old yes/no rule switched: an end off its ring
 * by a quarter of the gap between the rings, the child level with its parent, an arc 1.75 times the straight
 * distance. While a layout morph runs, nodes travel between rings on purpose: being off a ring doesn't count then.
 * @param {number} rs where the source is, from the centre; `rt` the target; `hs`, `ht` where their layout put them
 * @param {number} arc the step's arc length; `chord` the straight distance between the ends
 */
export function stepCurveWeight(rs, rt, hs, ht, arc, chord, morphing = false) {
  const gap = Math.abs(ht - hs);
  const slack = Math.max(gap / 4, 1e-6);
  const off = morphing
    ? 0
    : smoothstep(
        0.5,
        1.5,
        Math.max(Math.abs(rs - hs), Math.abs(rt - ht)) / slack,
      );
  const inside = smoothstep(-gap / 4, 1, rs - rt);
  const loops = smoothstep(0.9, 1, arc / (1.75 * chord + 10));
  return Math.max(off, inside, loops);
}

/**
 * Points `pts` (flat x, y) slid `w` of the way towards a cubic from p0 to p3 (controls p1, p2): each point to the
 * curve's point as far along it as the point is along `pts`.
 */
function blendTowardsCubic(pts, p0, p1, p2, p3, w) {
  let total = 0;
  const along = [0];
  for (let i = 2; i < pts.length; i += 2) {
    total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    along.push(total);
  }
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const [cx, cy] = bezierAt(p0, p1, p2, p3, total ? along[i / 2] / total : 0);
    out.push(pts[i] + (cx - pts[i]) * w, pts[i + 1] + (cy - pts[i + 1]) * w);
  }
  return out;
}

/**
 * Cut `from` off the start and `to` off the end of a polyline, measured along it. Returns null when the cuts
 * meet (the nodes overlap).
 */
export function trim(pts, from, to) {
  const total = pathLength(pts);
  if (from + to >= total) return null;
  return slice(pts, from, total - to);
}

/** A polyline's length (flat x, y pairs). */
export function pathLength(pts) {
  let total = 0;
  for (let i = 2; i < pts.length; i += 2)
    total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return total;
}

/**
 * Edge `ei` of the scene's graph as painters draw it: its route (through its parent's fan junction when `junctions`,
 * from fanJunctions, has one), cut to start at `starts[ei]` (startTrims) and to end at its target's trim (endTrims),
 * each also clear of the end there, if it has one (an arrow or a dot: endRooms). Null when nothing is left.
 */
export function trimmedRoute(scene, ei, junctions, starts) {
  const { graph, edge } = scene;
  const e = graph.edges[ei];
  const jx = junctions && e.tree ? junctions[e.source * 2] : NaN;
  const junction = Number.isNaN(jx)
    ? null
    : { x: jx, y: junctions[e.source * 2 + 1] };
  const ends = endRooms(edge);
  const from = starts[ei] + ends.source,
    to = endTrims(scene)[ei] + ends.target;
  return trim(
    edgeRoute(graph, scene.routing, edge.shape, e, junction, from, to),
    from,
    to,
  );
}

/** The last trims worked out for each end, and what for: painters ask every frame, and they change only with the layout. */
const trimsMemo = { source: null, target: null };

/**
 * Where each edge starts, as a distance from its source's centre (what `trim` cuts off its route's start, and the
 * GPU pieces' first trim): off the node, and past the node's own label when the edge would leave through it (labels
 * below in a top-to-bottom tree or merged tree: every parent's edges), so labels stay clear of their own edges.
 * Worked out from where the layout put the nodes (homes), so it holds while they move: a step or curve leaves
 * along the layout's axis (a radial's spokes), a straight edge towards its first stop. At most 45% of the way to
 * that stop (35% for a fan, whose trunk splits early). Cross-links that bundle along the tree start off the node
 * only (they rarely leave through the label, and the GPU clips them to a disc). Needs `scene.labelWidths` (each
 * real node's label width as the layout kept room for it); without it, every edge starts at its node's radius. A
 * card (the `look` node option) counts as its node: edges start at its rim.
 * @returns {Float64Array} per edge of the scene's graph
 */
export function startTrims(scene) {
  return trimsAt(scene, "source");
}

/**
 * Where each edge ends, as a distance from its target's centre: off the node, and past the node's label when the
 * edge comes in through it (labels below in a bottom-to-top tree), the same way startTrims works out the start.
 * @returns {Float64Array} per edge of the scene's graph
 */
export function endTrims(scene) {
  return trimsAt(scene, "target");
}

/** How far an edge stays off node `i` when nothing else is in the way: its radius, or its card's half height. */
export function clearOf(scene, i) {
  const real = scene.matrix?.count ?? Infinity;
  return scene.node?.look === "card" && i < real
    ? scene.node.cardHeight / 2
    : scene.looks.radius[i];
}

/** startTrims (`end` "source") or endTrims ("target"). */
function trimsAt(scene, end) {
  const { graph, routing, edge, looks, node, labelWidths } = scene;
  const m = trimsMemo[end];
  if (
    m &&
    scene.geometryVersion !== undefined &&
    m.version === scene.geometryVersion &&
    m.edges === graph.edges &&
    m.looks === looks &&
    m.widths === labelWidths &&
    m.routing === routing
  )
    return m.trims;
  const atSource = end === "source";
  const edges = graph.edges;
  const out = new Float64Array(edges.length);
  for (let i = 0; i < edges.length; i++)
    out[i] = clearOf(scene, atSource ? edges[i].source : edges[i].target);
  const card = node?.look === "card";
  if (labelWidths && node && labelPlace(node) !== "off") {
    const h = card ? node.cardHeight : node.labelSize * LINE;
    const radial = routing.kind === "radial";
    const layered = routing.kind === "layered";
    const axis = TREE_AXIS[routing.direction] ?? TREE_AXIS.TB;
    const shaped = edge.shape !== "straight";
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      // The node at this end, and the stop the edge goes to from it (the other node, or the nearest bend).
      const here = atSource ? e.source : e.target;
      const w = labelWidths[here];
      if (!(w > 0)) continue;
      if (!layered && !e.tree && shaped) continue; // bundled
      const s = graph.nodes[here],
        t = graph.nodes[atSource ? e.target : e.source];
      const sx = s.homeX ?? s.x,
        sy = s.homeY ?? s.y;
      const bends = layered ? routing.bends.get(e) : null;
      const bend = bends?.length
        ? bends[atSource ? 0 : bends.length - 1]
        : null;
      const fx = bend ? bend[0] : (t.homeX ?? t.x),
        fy = bend ? bend[1] : (t.homeY ?? t.y);
      let dx = fx - sx,
        dy = fy - sy;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      let reachOut = len;
      if (shaped && radial) {
        // Along this node's spoke (in, towards a node nearer the centre); from the centre, at the other node.
        const rx = sx - routing.cx,
          ry = sy - routing.cy;
        const rs = Math.hypot(rx, ry);
        const rt = Math.hypot(fx - routing.cx, fy - routing.cy);
        if (rs > 1e-6) {
          const sign = rt >= rs ? 1 : -1;
          dx = (rx / rs) * sign;
          dy = (ry / rs) * sign;
          reachOut = Math.abs(rt - rs) || len;
        } else {
          dx /= len;
          dy /= len;
        }
      } else if (shaped) {
        const along = dx * axis[0] + dy * axis[1];
        const sign = Math.sign(along) || 1;
        dx = axis[0] * sign;
        dy = axis[1] * sign;
        reachOut = Math.abs(along) || len;
      } else {
        dx /= len;
        dy /= len;
      }
      const clear = clearOf(scene, here);
      out[i] = startTrim(
        clear,
        card ? clear : looks.radius[here] * reach(looks.shape[here]),
        s.labelAngle ?? Math.PI / 2,
        w,
        h,
        dx,
        dy,
        // A card is opaque, and the layout keeps its gap clear: an edge always starts past one.
        card ? Infinity : reachOut * (edge.shape === "fan" ? 0.35 : 0.45),
      );
    }
  }
  trimsMemo[end] = {
    version: scene.geometryVersion,
    edges,
    looks,
    widths: labelWidths,
    routing,
    trims: out,
  };
  return out;
}

/** The part of a polyline between two distances along it. */
function slice(pts, start, end) {
  const out = [];
  let walked = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2],
      y0 = pts[i - 1],
      x1 = pts[i],
      y1 = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const a = walked,
      b = walked + len;
    walked = b;
    if (b < start || len === 0) continue;
    if (!out.length) {
      const f = (start - a) / len;
      out.push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
    }
    if (b >= end) {
      const f = (end - a) / len;
      out.push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      break;
    }
    out.push(x1, y1);
  }
  return out;
}
