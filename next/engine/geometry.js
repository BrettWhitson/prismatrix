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
    const as = rs < 1e-6 ? at : Math.atan2(s.y - cy, s.x - cx);
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

function treeStep(direction, s, t) {
  if (direction === "LR" || direction === "RL") {
    const mid = (s.x + t.x) / 2;
    return [s.x, s.y, mid, s.y, mid, t.y, t.x, t.y];
  }
  const mid = (s.y + t.y) / 2;
  return [s.x, s.y, s.x, mid, t.x, mid, t.x, t.y];
}

function radialStep({ cx, cy }, s, t) {
  const rs = Math.hypot(s.x - cx, s.y - cy);
  const rt = Math.hypot(t.x - cx, t.y - cy);
  const at = Math.atan2(t.y - cy, t.x - cx);
  // A node at the centre has no angle of its own: leave it towards the child.
  const as = rs < 1e-6 ? at : Math.atan2(s.y - cy, s.x - cx);
  // Out along the source's spoke to the ring halfway between, round that ring, then in along the target's spoke.
  const rm = (rs + rt) / 2;
  let delta = at - as;
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  const pts = [s.x, s.y];
  const count = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
  for (let i = 0; i <= count; i++) {
    const a = as + (delta * i) / count;
    pts.push(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm);
  }
  pts.push(t.x, t.y);
  return pts;
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
