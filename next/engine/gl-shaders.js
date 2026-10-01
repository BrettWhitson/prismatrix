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
layout(location = 3) in vec4 a_colour;
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
  v_colour = a_colour;
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
layout(location = 3) in vec4 a_colour;
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
  v_colour = a_colour;
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
