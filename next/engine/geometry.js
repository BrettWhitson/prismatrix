// Edge geometry: the polyline an edge follows, from its source node's centre to its target's, for a routing and a
// shape. Pure functions, no drawing.

const ARC_STEP = 0.06; // radians per point along a ring arc
const FAN_STUB = 0.4; // how far a fan's junction sits towards the children, as a share of the way

/**
 * The points of an edge from `s` to `t` (anything with x and y).
 * @param {import("./layouts.js").Routing} routing
 * @param {"straight" | "step" | "fan" | "curve"} shape
 * @param {{ x: number, y: number } | null} [junction] fan only: where the parent's edges split (see fanJunctions)
 * @returns {number[]} flat x, y pairs
 */
export function edgePoints(routing, shape, s, t, junction = null) {
  if (shape === "fan")
    return junction
      ? [s.x, s.y, junction.x, junction.y, t.x, t.y]
      : [s.x, s.y, t.x, t.y];
  if (shape === "straight") return [s.x, s.y, t.x, t.y];
  if (shape === "curve") return curve(routing, s, t);
  if (routing.kind === "tree") return treeStep(routing.direction, s, t);
  return radialStep(routing, s, t);
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
function curve(routing, s, t) {
  let c1, c2;
  if (routing.kind === "tree") {
    if (routing.direction === "LR" || routing.direction === "RL") {
      const mid = (s.x + t.x) / 2;
      c1 = [mid, s.y];
      c2 = [mid, t.y];
    } else {
      const mid = (s.y + t.y) / 2;
      c1 = [s.x, mid];
      c2 = [t.x, mid];
    }
  } else {
    const { cx, cy } = routing;
    const rs = Math.hypot(s.x - cx, s.y - cy);
    const rt = Math.hypot(t.x - cx, t.y - cy);
    const at = Math.atan2(t.y - cy, t.x - cx);
    const as = centred(s, rs, cx, cy) ? at : Math.atan2(s.y - cy, s.x - cx);
    const rm = (rs + rt) / 2;
    c1 = [cx + Math.cos(as) * rm, cy + Math.sin(as) * rm];
    c2 = [cx + Math.cos(at) * rm, cy + Math.sin(at) * rm];
  }
  return cubic([s.x, s.y], c1, c2, [t.x, t.y]);
}

/** Points along a cubic Bézier, enough for its length to look smooth (about one per 6 world px, 8 to 48). */
export function cubic(p0, p1, p2, p3) {
  const hull =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const count = Math.min(48, Math.max(8, Math.ceil(hull / 6)));
  const out = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count,
      u = 1 - t;
    const a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      d = t * t * t;
    out.push(
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    );
  }
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
const BUNDLE_STEPS = 8;

/**
 * The route of a cross-link (an edge that isn't a parent → child link in the forest): along the tree path between
 * its ends, up to their lowest common ancestor and back down, as a B-spline pulled towards that path by `strength`
 * (hierarchical edge bundling, Holten 2006). Cross-links that share an ancestor bundle together along the tree
 * instead of cutting across it. Ends in different trees, or a path with nothing between them, go straight.
 * @returns {number[]} flat x, y pairs
 */
export function bundledPoints(graph, e, strength = 0.85) {
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
    if (a < 0 || b < 0) return straight(nodes, e);
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
  if (path.length <= 2) return straight(nodes, e);
  const first = nodes[path[0]],
    last = nodes[path.at(-1)];
  const control = path.map((i, k) => {
    // Pull towards the straight line between the ends by (1 − strength): 1 follows the tree, 0 goes straight.
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

function straight(nodes, e) {
  const s = nodes[e.source],
    t = nodes[e.target];
  return [s.x, s.y, t.x, t.y];
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
    for (let k = i === 0 ? 0 : 1; k <= BUNDLE_STEPS; k++) {
      const t = k / BUNDLE_STEPS,
        t2 = t * t,
        t3 = t2 * t;
      const w0 = (1 - 3 * t + 3 * t2 - t3) / 6,
        w1 = (4 - 6 * t2 + 3 * t3) / 6,
        w2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6,
        w3 = t3 / 6;
      out.push(
        w0 * p[i][0] + w1 * p[i + 1][0] + w2 * p[i + 2][0] + w3 * p[i + 3][0],
        w0 * p[i][1] + w1 * p[i + 1][1] + w2 * p[i + 2][1] + w3 * p[i + 3][1],
      );
    }
  }
  // Exactly on the ends (the sums above can be a hair off), since trimming measures from them.
  out[0] = control[0][0];
  out[1] = control[0][1];
  out[out.length - 2] = control.at(-1)[0];
  out[out.length - 1] = control.at(-1)[1];
  return out;
}

/**
 * The route of edge `e` in `graph`: a cross-link bundles along the tree (unless edges are straight), anything else
 * follows the edge shape.
 */
export function edgeRoute(graph, routing, shape, e, junction = null) {
  if (routing.kind === "layered")
    return layeredPoints(
      routing,
      shape,
      e,
      graph.nodes[e.source],
      graph.nodes[e.target],
    );
  if (!e.tree && shape !== "straight") return bundledPoints(graph, e);
  return edgePoints(
    routing,
    shape,
    graph.nodes[e.source],
    graph.nodes[e.target],
    junction,
  );
}

/**
 * A layered layout's edge: through its bend points (one per layer it crosses). Bends were placed for the nodes'
 * homes; when the ends move (a drag, physics), the bends move with them, each in proportion to how far along the
 * edge it is. Straight and fan draw a polyline; step and curve repeat the tree's step or curve between each pair.
 */
export function layeredPoints(routing, shape, e, s, t) {
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
    const piece =
      shape === "step"
        ? treeStep(routing.direction, points[i - 1], points[i])
        : curve(tree, points[i - 1], points[i]);
    // Each piece starts where the last ended: keep that point once.
    out.push(...(i === 1 ? piece : piece.slice(2)));
  }
  return out;
}

function treeStep(direction, s, t) {
  if (direction === "LR" || direction === "RL") {
    const mid = (s.x + t.x) / 2;
    return [s.x, s.y, mid, s.y, mid, t.y, t.x, t.y];
  }
  const mid = (s.y + t.y) / 2;
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
  // A node at the centre has no angle of its own: leave it towards the child.
  const as = centred(s, rs, cx, cy) ? at : Math.atan2(s.y - cy, s.x - cx);
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
  const c1 = [cx + Math.cos(as) * rm, cy + Math.sin(as) * rm],
    c2 = [cx + Math.cos(at) * rm, cy + Math.sin(at) * rm];
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
export function blendTowardsCubic(pts, p0, p1, p2, p3, w) {
  let total = 0;
  const along = [0];
  for (let i = 2; i < pts.length; i += 2) {
    total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    along.push(total);
  }
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const u = total ? along[i / 2] / total : 0,
      v = 1 - u;
    const a = v * v * v,
      b = 3 * v * v * u,
      c = 3 * v * u * u,
      d = u * u * u;
    const cx = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      cy = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
    out.push(pts[i] + (cx - pts[i]) * w, pts[i + 1] + (cy - pts[i + 1]) * w);
  }
  return out;
}

/**
 * Cut `from` off the start and `to` off the end of a polyline, measured along it. Returns null when the cuts
 * meet (the nodes overlap).
 */
export function trim(pts, from, to) {
  let total = 0;
  for (let i = 2; i < pts.length; i += 2)
    total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  if (from + to >= total) return null;
  return slice(pts, from, total - to);
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
