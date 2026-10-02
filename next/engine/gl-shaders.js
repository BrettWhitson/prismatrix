// GLSL for the WebGL renderer. Every shape is drawn as a signed distance field: the fragment shader works out how
// far each pixel is outside the shape, and turns that into coverage. That gives smooth, resolution-independent
// edges at any zoom without multisampling.
//
// Shared uniforms: u_view (canvas size, CSS px), u_camera (world x, y at the view's centre, and zoom), u_pixel (one
// device pixel in world px). All colours are written premultiplied.

/** World position to clip space, and the coverage of a pixel whose centre is d world px outside an edge. */
const COMMON_VERTEX = `
uniform vec2 u_view;
uniform vec3 u_camera;
uniform float u_pixel;

vec4 toClip(vec2 world) {
  vec2 css = (world - u_camera.xy) * u_camera.z + u_view * 0.5;
  vec2 clip = css / u_view * 2.0 - 1.0;
  return vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const COMMON_FRAGMENT = `
uniform float u_pixel;

float cover(float d) {
  return clamp(0.5 - d / u_pixel, 0.0, 1.0);
}`;

export const NODE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_centre;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_colour;
layout(location = 4) in float a_shape;
${COMMON_VERTEX}
uniform float u_outline;

out vec2 v_local;
flat out float v_radius;
flat out vec4 v_colour;
flat out float v_shape;

void main() {
  float reach = a_shape == 3.0 ? 1.25 : a_shape == 4.0 ? 1.1 : 1.0;
  float ring = a_shape == 5.0 ? max(1.5, a_radius * 0.35) * 0.5 : 0.0;
  // Big enough for the shape, half its outline or ring stroke, and a couple of pixels of anti-aliasing.
  float extent = a_radius * reach + max(u_outline * 0.5, ring) + 2.0 * u_pixel;
  vec2 local = a_corner * extent;
  gl_Position = toClip(a_centre + local);
  v_local = local;
  v_radius = a_radius;
  v_colour = a_colour;
  v_shape = a_shape;
}`;

export const NODE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_radius;
flat in vec4 v_colour;
flat in float v_shape;
${COMMON_FRAGMENT}
uniform float u_outline;
uniform vec3 u_background;
out vec4 outColour;

float box(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float roundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// A hexagon with points at top and bottom; r is the distance from the centre to a point.
float hexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p.yx);
  float apothem = r * 0.866025404;
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * apothem, k.z * apothem), apothem);
  return length(p) * sign(p.y);
}

void main() {
  vec2 p = v_local;
  float r = v_radius;
  vec3 colour = v_colour.rgb;
  float alpha;
  if (v_shape == 5.0) {
    // A ring: background inside, a stroke in the node's colour around it.
    float halfStroke = max(1.5, r * 0.35) * 0.5;
    float d = length(p) - r;
    float stroke = cover(abs(d) - halfStroke);
    alpha = max(cover(d), stroke);
    colour = mix(u_background, colour, alpha > 0.0 ? stroke / alpha : 0.0);
  } else {
    float d = v_shape == 1.0 ? box(p, vec2(r))
      : v_shape == 2.0 ? roundedBox(p, vec2(r), r * 0.45)
      : v_shape == 3.0 ? (abs(p.x) + abs(p.y) - r * 1.25) * 0.707106781
      : v_shape == 4.0 ? hexagon(p, r * 1.1)
      : length(p) - r;
    if (u_outline > 0.0) {
      // An outline in the background colour, centred on the shape's edge.
      float halfLine = u_outline * 0.5;
      alpha = cover(d - halfLine);
      float line = cover(abs(d) - halfLine);
      colour = mix(colour, u_background, alpha > 0.0 ? line / alpha : 0.0);
    } else alpha = cover(d);
  }
  alpha *= v_colour.a;
  outColour = vec4(colour * alpha, alpha);
}`;

/** An edge segment: a capsule whose radius runs from one half-width to the other, so joints come out round. */
export const SEGMENT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_ends;
layout(location = 2) in vec2 a_half;
layout(location = 3) in vec3 a_colour;
layout(location = 4) in float a_alpha;
${COMMON_VERTEX}

out vec2 v_world;
flat out vec4 v_ends;
flat out vec2 v_half;
flat out vec4 v_colour;

void main() {
  vec2 a = a_ends.xy, b = a_ends.zw;
  vec2 along = b - a;
  float length_ = length(along);
  vec2 dir = length_ > 0.0 ? along / length_ : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float pad = max(a_half.x, a_half.y) + 2.0 * u_pixel;
  float t = mix(-pad, length_ + pad, a_corner.x * 0.5 + 0.5);
  vec2 world = a + dir * t + normal * a_corner.y * pad;
  gl_Position = toClip(world);
  v_world = world;
  v_ends = a_ends;
  v_half = a_half;
  v_colour = vec4(a_colour, a_alpha);
}`;

export const SEGMENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_world;
flat in vec4 v_ends;
flat in vec2 v_half;
flat in vec4 v_colour;
${COMMON_FRAGMENT}
out vec4 outColour;

void main() {
  vec2 a = v_ends.xy, ab = v_ends.zw - a;
  float t = clamp(dot(v_world - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  float d = length(v_world - (a + ab * t)) - mix(v_half.x, v_half.y, t);
  float alpha = cover(d) * v_colour.a;
  outColour = vec4(v_colour.rgb * alpha, alpha);
}`;

/** An edge's end: an arrowhead (a triangle pointing along the edge) or a dot, just short of the target. */
export const END_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_tip;    // tip x, y, direction x, y
layout(location = 2) in vec2 a_shape;  // size, kind
layout(location = 3) in vec3 a_colour;
layout(location = 4) in float a_alpha;
${COMMON_VERTEX}

out vec2 v_local;
flat out vec2 v_shape;
flat out vec4 v_colour;

void main() {
  vec2 dir = a_tip.zw;
  vec2 normal = vec2(-dir.y, dir.x);
  float size = a_shape.x;
  // Local frame: x runs back from the tip along the edge, y across it.
  vec2 local = vec2(0.45 * size, 0.0) + a_corner * (0.75 * size + 2.0 * u_pixel);
  gl_Position = toClip(a_tip.xy - dir * local.x + normal * local.y);
  v_local = local;
  v_shape = a_shape;
  v_colour = vec4(a_colour, a_alpha);
}`;

export const END_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec2 v_shape;
flat in vec4 v_colour;
${COMMON_FRAGMENT}
out vec4 outColour;

// Exact distance to a triangle (Inigo Quilez).
float triangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

void main() {
  float size = v_shape.x;
  float d;
  if (v_shape.y > 0.5) d = length(v_local - vec2(0.45 * size, 0.0)) - 0.45 * size;
  else {
    // The canvas arrow: sides at 0.45 rad either side of the edge, each size long.
    vec2 side = vec2(cos(0.45), sin(0.45)) * size;
    d = triangle(v_local, vec2(0.0), side, vec2(side.x, -side.y));
  }
  float alpha = cover(d) * v_colour.a;
  outColour = vec4(v_colour.rgb * alpha, alpha);
}`;

/** A whole-screen triangle that lays a texture onto the canvas at an opacity. */
export const COMPOSITE_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;
out vec4 outColour;
void main() {
  outColour = texture(u_texture, v_uv) * u_alpha;
}`;

/** A label: a quad cut from the label atlas, tinted. The atlas holds white text, premultiplied. */
export const LABEL_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_box;    // left, middle, width, height (world)
layout(location = 2) in vec4 a_uv;     // u0, v0, u1, v1
layout(location = 3) in float a_alpha;
${COMMON_VERTEX}

out vec2 v_uv;
flat out float v_alpha;

void main() {
  vec2 t = a_corner * 0.5 + 0.5;
  gl_Position = toClip(vec2(a_box.x + t.x * a_box.z, a_box.y + a_corner.y * 0.5 * a_box.w));
  v_uv = mix(a_uv.xy, a_uv.zw, t);
  v_alpha = a_alpha;
}`;

export const LABEL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
flat in float v_alpha;
uniform sampler2D u_atlas;
uniform vec3 u_colour;
out vec4 outColour;

void main() {
  float coverage = texture(u_atlas, v_uv).a * v_alpha;
  outColour = vec4(u_colour * coverage, coverage);
}`;

/**
 * Positions of every display node, relative to the edge origin: one RGBA32F texel per node (x, y, homeX, homeY).
 * A stop is a node (where it is this frame) or a bend (where the layout put it, moved along with the edge's ends,
 * each end's share by how far along the edge the bend is).
 */
const STOPS = `
uniform highp sampler2D u_positions;
uniform int u_columns;

vec4 nodeAt(float index) {
  int i = int(index + 0.5);
  return texelFetch(u_positions, ivec2(i % u_columns, i / u_columns), 0);
}

vec2 stopAt(vec4 stop, vec4 s, vec4 t) {
  if (stop.w > 0.5) return stop.z < 0.5 ? s.xy : t.xy;
  return stop.xy + (s.xy - s.zw) * (1.0 - stop.z) + (t.xy - t.zw) * stop.z;
}`;

/**
 * An edge piece, built on the GPU: from its two stops (looked up in the positions texture), the shader traces the
 * piece's shape (u_shape: 0 straight, 1 step with rounded corners, 2 curve) in the layout's axis frame (u_axis: y
 * runs from parent to child) as 16 points, and each instance's vertices draw the capsule between two of them
 * (gl_VertexID / 6 picks which). The same geometry as piecePoints in gl-edges.js.
 */
export const PIECE_VERTEX = `#version 300 es
layout(location = 0) in vec4 a_stopA;
layout(location = 1) in vec4 a_stopB;
layout(location = 2) in vec2 a_nodes;
layout(location = 3) in vec2 a_trim;
layout(location = 4) in float a_half;
layout(location = 5) in vec3 a_colour;
layout(location = 6) in float a_alpha;
${COMMON_VERTEX}
${STOPS}
uniform int u_shape;
uniform mat2 u_axis;
uniform float u_corner;
uniform bool u_radial;

out vec2 v_world;
flat out vec4 v_ends;
flat out vec2 v_half;
flat out vec4 v_colour;

const float HALF_PI = 1.5707963;

// A curve from A to B leaving and arriving along the axis, at t (0–1).
vec2 curveAt(float t, vec2 A, vec2 B, float mid) {
  float u = 1.0 - t;
  float w0 = u * u * u, w1 = 3.0 * u * u * t, w2 = 3.0 * u * t * t, w3 = t * t * t;
  return vec2((w0 + w1) * A.x + (w2 + w3) * B.x, w0 * A.y + (w1 + w2) * mid + w3 * B.y);
}

// Where the curve is reach from its end (t = 0 at A, or t = 1 at B when fromB): the curve is cut there, off
// the node, as the CPU cuts its traced curves.
float curveCut(float reach, vec2 A, vec2 B, float mid, bool fromB) {
  if (reach <= 0.0) return fromB ? 1.0 : 0.0;
  vec2 end = fromB ? B : A;
  float lo = 0.0, hi = 0.5;
  for (int k = 0; k < 12; k++) {
    float m = (lo + hi) * 0.5;
    if (length(curveAt(fromB ? 1.0 - m : m, A, B, mid) - end) < reach) lo = m;
    else hi = m;
  }
  return fromB ? 1.0 - lo : lo;
}

// Point i (0–15) of the piece from A to B, in the axis frame. Curves run between t0 and t1.
vec2 pointAt(int i, vec2 A, vec2 B, float mid, float r1, float r2, float sx, float sy, bool straight, vec2 cut) {
  if (straight) return i == 0 ? A : B;
  if (u_shape == 2) return curveAt(mix(cut.x, cut.y, float(i) / 15.0), A, B, mid);
  if (i == 0) return A;
  if (i == 15) return B;
  if (i <= 7) {
    float th = float(i - 1) / 6.0 * HALF_PI;
    return vec2(A.x + sx * r1 - sx * r1 * cos(th), mid - sy * r1 + sy * r1 * sin(th));
  }
  float th = float(i - 8) / 6.0 * HALF_PI;
  return vec2(B.x - sx * r2 + sx * r2 * sin(th), mid + sy * r2 - sy * r2 * cos(th));
}

// The capsule numbered part of a tree or layered piece (its points 0–15), in world px relative to the origin.
void treePart(int part, vec4 s, vec4 t, out vec2 a, out vec2 b) {
  vec2 A = u_axis * stopAt(a_stopA, s, t);
  vec2 B = u_axis * stopAt(a_stopB, s, t);
  bool straight = u_shape == 0 || abs(B.x - A.x) < 1e-6;
  float sx = sign(B.x - A.x), sy = B.y >= A.y ? 1.0 : -1.0;
  // Halfway between the stops themselves: the ends are pulled in off the nodes after (as the CPU trims after).
  float mid = (A.y + B.y) * 0.5;
  vec2 cut = vec2(0.0, 1.0);
  if (straight) {
    vec2 d = B - A;
    float len = length(d);
    vec2 dir = len > 0.0 ? d / len : vec2(0.0, 1.0);
    A += dir * a_trim.x;
    B -= dir * a_trim.y;
  } else if (u_shape == 2) {
    cut = vec2(curveCut(a_trim.x, A, B, mid, false), curveCut(a_trim.y, A, B, mid, true));
  } else {
    A.y += sy * a_trim.x;
    B.y -= sy * a_trim.y;
  }
  float across = abs(B.x - A.x);
  float r1 = max(0.0, min(u_corner, min(abs(mid - A.y), across) * 0.5));
  float r2 = max(0.0, min(u_corner, min(abs(B.y - mid), across) * 0.5));
  a = transpose(u_axis) * pointAt(part, A, B, mid, r1, r2, sx, sy, straight, cut);
  b = transpose(u_axis) * pointAt(part + 1, A, B, mid, r1, r2, sx, sy, straight, cut);
}

// ---- radial pieces: out along the source's spoke, round the ring halfway between, in along the target's spoke

uniform vec2 u_centre;
uniform bool u_morphing;
const float ARC_STEP = 0.06; // radians per chord along a ring arc, as the CPU traces them

vec2 ray(float angle) {
  return vec2(cos(angle), sin(angle));
}

vec2 cubicAt(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  float u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
}

// Where a cubic is reach from its start (or, fromB, its end).
float cubicCut(float reach, vec2 p0, vec2 p1, vec2 p2, vec2 p3, bool fromB) {
  if (reach <= 0.0) return fromB ? 1.0 : 0.0;
  vec2 end = fromB ? p3 : p0;
  float lo = 0.0, hi = 0.5;
  for (int k = 0; k < 12; k++) {
    float m = (lo + hi) * 0.5;
    if (length(cubicAt(fromB ? 1.0 - m : m, p0, p1, p2, p3) - end) < reach) lo = m;
    else hi = m;
  }
  return fromB ? 1.0 - lo : lo;
}

// Point i (0–29) of a radial step: the source end, a rounded corner (4 points), the ring arc (20), a rounded
// corner (4), the target end. Each corner is a quadratic curve through the spoke and ring meeting point.
vec2 radialStepAt(int i, vec2 A, vec2 B, float as_, float at, float delta, float rm, float f1, float f2, float turn) {
  vec2 c = u_centre;
  if (i == 0) return A;
  if (i == 29) return B;
  if (i <= 4) {
    float k = float(i - 1) / 3.0;
    vec2 q = c + ray(as_) * (rm - f1), j = c + ray(as_) * rm, r = c + ray(as_ + turn * f1 / rm) * rm;
    return mix(mix(q, j, k), mix(j, r, k), k);
  }
  if (i >= 25) {
    float k = float(i - 25) / 3.0;
    vec2 r = c + ray(at - turn * f2 / rm) * rm, j = c + ray(at) * rm, q = c + ray(at) * (rm + f2);
    return mix(mix(r, j, k), mix(j, q, k), k);
  }
  // Round the short way: from the source's angle by the (wrapped) turn between them.
  float from = as_ + turn * f1 / rm, to = as_ + delta - turn * f2 / rm;
  return c + ray(mix(from, to, float(i - 5) / 19.0)) * rm;
}

// How far a radial step has turned into a curve (0–1): stepCurveWeight in geometry.js.
float stepCurveWeight(float rs, float rt, float hs, float ht, float arc, float chord) {
  float gap = abs(ht - hs);
  float slack = max(gap / 4.0, 1e-6);
  float off = u_morphing ? 0.0 : smoothstep(0.5, 1.5, max(abs(rs - hs), abs(rt - ht)) / slack);
  float inside = smoothstep(-gap / 4.0, 1.0, rs - rt);
  float loops = smoothstep(0.9, 1.0, arc / (1.75 * chord + 10.0));
  return max(off, max(inside, loops));
}

void radialPart(int part, vec4 s, vec4 t, out vec2 a, out vec2 b) {
  vec2 c = u_centre;
  vec2 S = s.xy, T = t.xy;
  float rs = length(S - c), rt = length(T - c);
  float at = atan(T.y - c.y, T.x - c.x);
  // A source at the centre (or laid out there) has no angle of its own: its edges are spokes.
  bool centred = rs < 1e-6 || length(s.zw - c) < 1e-6;
  float as_ = centred ? at : atan(S.y - c.y, S.x - c.x);
  float rm = (rs + rt) * 0.5;
  float delta = at - as_;
  if (delta > 3.14159265) delta -= 6.28318531;
  if (delta < -3.14159265) delta += 6.28318531;
  int mode = u_shape; // 0 straight, 1 step, 2 curve
  float w = 0.0; // a step's way to a curve
  if (mode == 1) {
    if (centred) mode = 0;
    else {
      // Off its ring (unless a layout morph is moving it), inside its parent, or an arc that would loop: it eases
      // into a curve.
      w = stepCurveWeight(rs, rt, length(s.zw - c), length(t.zw - c), rm * abs(delta), length(T - S));
      if (w >= 1.0) mode = 2;
    }
  }
  if (mode == 0) {
    vec2 d = T - S;
    float len = length(d);
    vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
    a = part == 0 ? S + dir * a_trim.x : T - dir * a_trim.y;
    b = T - dir * a_trim.y;
    return;
  }
  if (mode == 2) {
    vec2 c1 = c + ray(as_) * rm, c2 = c + ray(at) * rm;
    float t0 = cubicCut(a_trim.x, S, c1, c2, T, false), t1 = cubicCut(a_trim.y, S, c1, c2, T, true);
    if (part >= 15) {
      a = b = T;
      return;
    }
    a = cubicAt(mix(t0, t1, float(part) / 15.0), S, c1, c2, T);
    b = cubicAt(mix(t0, t1, float(part + 1) / 15.0), S, c1, c2, T);
    return;
  }
  vec2 A = S + ray(as_) * a_trim.x, B = T - ray(at) * a_trim.y;
  float turn = delta >= 0.0 ? 1.0 : -1.0;
  // Corners as big as the edge's corner radius, but no more than half the spoke or of the first chord of the arc.
  float chord = rm * abs(delta) / max(1.0, ceil(abs(delta) / ARC_STEP));
  float f1 = max(0.0, min(u_corner, min(rm - length(A - c), chord) * 0.5));
  float f2 = max(0.0, min(u_corner, min(length(B - c) - rm, chord) * 0.5));
  a = radialStepAt(part, A, B, as_, at, delta, rm, f1, f2, turn);
  b = radialStepAt(part + 1, A, B, as_, at, delta, rm, f1, f2, turn);
  if (w <= 0.0) return;
  // Partway to a curve: each point slides towards the curve's point as far along it as the point is along the step.
  vec2 c1 = c + ray(as_) * rm, c2 = c + ray(at) * rm;
  float t0 = cubicCut(a_trim.x, S, c1, c2, T, false), t1 = cubicCut(a_trim.y, S, c1, c2, T, true);
  vec2 previous = A;
  float run = 0.0, alongA = 0.0, alongB = 0.0;
  for (int i = 1; i < 30; i++) {
    vec2 p = radialStepAt(i, A, B, as_, at, delta, rm, f1, f2, turn);
    run += length(p - previous);
    previous = p;
    if (i == part) alongA = run;
    if (i == part + 1) alongB = run;
  }
  float total = max(run, 1e-6);
  a = mix(a, cubicAt(mix(t0, t1, alongA / total), S, c1, c2, T), w);
  b = mix(b, cubicAt(mix(t0, t1, alongB / total), S, c1, c2, T), w);
}

void main() {
  int part = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  vec4 s = nodeAt(a_nodes.x), t = nodeAt(a_nodes.y);
  vec2 a, b;
  if (u_radial) radialPart(part, s, t, a, b);
  else treePart(part, s, t, a, b);
  vec2 along = b - a;
  float length_ = length(along);
  if (length_ < 1e-6 && part > 0) {
    // Nothing to draw here (a straight piece's spare parts, a corner with no radius).
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Two triangles: corners (-1,-1) (1,-1) (-1,1) / (-1,1) (1,-1) (1,1).
  vec2 c = vec2(corner == 1 || corner == 4 || corner == 5 ? 1.0 : -1.0,
                corner == 2 || corner == 3 || corner == 5 ? 1.0 : -1.0);
  vec2 dir = length_ > 0.0 ? along / length_ : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float pad = a_half + 2.0 * u_pixel;
  float along_ = mix(-pad, length_ + pad, c.x * 0.5 + 0.5);
  vec2 world = a + dir * along_ + normal * c.y * pad;
  gl_Position = toClip(world);
  v_world = world;
  v_ends = vec4(a, b);
  v_half = vec2(a_half);
  v_colour = vec4(a_colour, a_alpha);
}`;

/** An edge's end (arrowhead or dot) on the GPU: the tip is the target's edge, pointing the way the edge arrives. */
export const TIP_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_stop;   // the last stop before the target
layout(location = 2) in vec2 a_nodes;
layout(location = 3) in vec3 a_shape;  // target radius, size, kind
layout(location = 4) in vec3 a_colour;
layout(location = 5) in float a_alpha;
${COMMON_VERTEX}
${STOPS}
uniform int u_shape;
uniform mat2 u_axis;
uniform bool u_radial;
uniform vec2 u_centre;

out vec2 v_local;
flat out vec2 v_shape;
flat out vec4 v_colour;

void main() {
  vec4 s = nodeAt(a_nodes.x), t = nodeAt(a_nodes.y);
  vec2 from = stopAt(a_stop, s, t), to = t.xy;
  vec2 dir;
  vec2 q = u_axis * (to - from);
  bool centred = length(s.xy - u_centre) < 1e-6 || length(s.zw - u_centre) < 1e-6;
  if (u_radial)
    // Steps and curves arrive along the target's spoke; straight edges and spokes from the centre, from the source.
    dir = u_shape == 0 || centred ? normalize(to - from + vec2(0.0, 1e-9)) : normalize(to - u_centre + vec2(0.0, 1e-9));
  else if (u_shape == 0 || abs(q.x) < 1e-6) dir = normalize(to - from + vec2(0.0, 1e-9));
  else dir = transpose(u_axis) * vec2(0.0, q.y >= 0.0 ? 1.0 : -1.0);
  vec2 tip = to - dir * a_shape.x;
  vec2 normal = vec2(-dir.y, dir.x);
  float size = a_shape.y;
  vec2 local = vec2(0.45 * size, 0.0) + a_corner * (0.75 * size + 2.0 * u_pixel);
  gl_Position = toClip(tip - dir * local.x + normal * local.y);
  v_local = local;
  v_shape = a_shape.yz;
  v_colour = vec4(a_colour, a_alpha);
}`;
