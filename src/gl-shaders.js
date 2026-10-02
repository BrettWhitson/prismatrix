// GLSL for the WebGL renderer. Every shape is drawn as a signed distance field: the fragment shader works out how
// far each pixel is outside the shape, and turns that into coverage. That gives smooth, resolution-independent
// edges at any zoom without multisampling.
//
// Shared uniforms: u_view (canvas size, CSS px), u_camera (world x, y at the view's centre, and zoom), u_pixel (one
// device pixel in world px). All colours are written premultiplied. World positions are relative to the layer's
// origin (the middle of the layout), and so is u_camera: 32-bit floats stay precise however far out a drawing
// reaches.

import {
  ARC_STEP,
  BUNDLE_STEPS,
  BUNDLE_STRENGTH,
  END_ROOM,
} from "./geometry.js";
import {
  CORNER_POINTS,
  CUT_STEPS,
  PIECE_POINTS,
  POSITION_COLUMNS,
  RADIAL_ARC_POINTS,
  RADIAL_CORNER_POINTS,
  RADIAL_POINTS,
} from "./gl-edges.js";
import { GLYPH_MIN_PX, LINK } from "./references.js";
import { AURA_ALPHA, AURA_RINGS, MARKS, STACK_FADE } from "./render.js";
import {
  ICON_FADE_PX,
  ICON_MIN_PX,
  ROUNDED_CORNER,
  TILE_CORNER,
} from "./icons.js";

// Numbers from the JavaScript (gl-edges.js, geometry.js, the shaders' twins in tests/helpers/gl-twins.js), written
// into the GLSL: a float literal, and the points of a piece (PIECE_POINTS: two ends and a rounded corner of
// CORNER_POINTS each) and of a radial step (RADIAL_POINTS: two ends, a corner of RC points at each end of an arc of
// RA).
const float = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const LAST = PIECE_POINTS - 1;
const RC = RADIAL_CORNER_POINTS,
  RA = RADIAL_ARC_POINTS,
  RADIAL_LAST = RADIAL_POINTS - 1;

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

/**
 * Exact distances to the node shapes (negative inside), so the same shape can be filled, outlined, or ringed at a
 * distance (a selection halo): shape ids as SHAPE_IDS, r the node's radius. A ring (5) is its circle.
 */
const NODE_SHAPES = `
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

// A diamond with its points r from the centre on both axes (Inigo Quilez's rhombus).
float diamond(vec2 p, float r) {
  vec2 b = vec2(r);
  p = abs(p);
  vec2 q = b - 2.0 * p;
  float h = clamp((q.x * b.x - q.y * b.y) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

float shapeDistance(vec2 p, float r, float shape) {
  return shape == 1.0 ? box(p, vec2(r))
    : shape == 2.0 ? roundedBox(p, vec2(r), r * ${ROUNDED_CORNER.toFixed(3)})
    : shape == 6.0 ? roundedBox(p, vec2(r), r * ${TILE_CORNER.toFixed(3)})
    : shape == 3.0 ? diamond(p, r * 1.25)
    : shape == 4.0 ? hexagon(p, r * 1.1)
    : length(p) - r;
}

// How far past the radius a shape reaches (a diamond's and a hexagon's points stick out), and a ring's half stroke.
float shapeReach(float shape) {
  return shape == 3.0 ? 1.25 : shape == 4.0 ? 1.1 : 1.0;
}

float ringHalfStroke(float r) {
  return max(1.5, r * 0.35) * 0.5;
}`;

/** The marks round a node (render.js MARKS: the ring's gap and width, the aura's reach), for radius r. */
const NODE_MARKS = `
float ringGap(float r) {
  return max(${float(MARKS.ringGapMin)}, r * ${float(MARKS.ringGap)});
}

float ringWidth(float r) {
  return max(${float(MARKS.ringWidthMin)}, r * ${float(MARKS.ringWidth)});
}

float auraReach(float r) {
  return max(${float(MARKS.auraReachMin)}, r * ${float(MARKS.auraReach)});
}`;

/**
 * A node: its aura, a stacked copy behind it and its ring; then its shape filled (at its opacity), its icon (a layer
 * of the icon atlas, a texture array) in its box and clipped to the shape, a border inside the shape's edge (dashed
 * or dotted by its style), the outline; and its badge image on top. Instances as packNodes packs them.
 */
export const NODE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_centre;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_colour;
layout(location = 4) in float a_shape;
layout(location = 5) in vec4 a_stroke;  // colour r, g, b, width (world px, 0 for none)
layout(location = 6) in vec4 a_uv;      // the icon's rectangle in its atlas page
layout(location = 7) in vec3 a_icon;    // page (-1 for no icon), half the icon box's width and height
layout(location = 8) in vec4 a_ring;    // colour r, g, b, 1 (0: none)
layout(location = 9) in vec4 a_aura;    // colour r, g, b, 1 (0: none)
layout(location = 10) in vec3 a_style;  // border style (0 solid, 1 dashed, 2 dotted), stack (1: yes), fill opacity
layout(location = 11) in vec4 a_badgeUv; // the badge image's rectangle in its atlas page
layout(location = 12) in float a_badgePage; // -1 for none
${COMMON_VERTEX}
${NODE_SHAPES}
${NODE_MARKS}
uniform float u_outline;

out vec2 v_local;
flat out float v_radius;
flat out vec4 v_colour;
flat out float v_shape;
flat out vec4 v_stroke;
flat out vec4 v_uv;
flat out vec4 v_icon;  // page, box half width, box half height, how much of the icon shows
flat out vec4 v_ring;
flat out vec4 v_aura;
flat out vec3 v_style;
flat out vec4 v_badgeUv;
flat out vec2 v_badge; // page, how much of the badge shows

void main() {
  float ring = a_shape == 5.0 ? ringHalfStroke(a_radius) : 0.0;
  float reach = a_radius * shapeReach(a_shape) + ring;
  // Big enough for the shape, half its outline or ring stroke, its marks, and a couple of pixels of anti-aliasing.
  float marks = u_outline * 0.5;
  if (a_aura.w > 0.0) marks = max(marks, auraReach(a_radius));
  if (a_ring.w > 0.0) marks = max(marks, ringGap(a_radius) + ringWidth(a_radius));
  if (a_style.y > 0.0) marks = max(marks, a_radius * ${float(MARKS.stackShift * 1.5)});
  float extent = reach + marks;
  if (a_badgePage >= 0.0)
    extent = max(extent, a_radius * ${float(MARKS.badgeAt + MARKS.badgeRadius)});
  extent += 2.0 * u_pixel;
  vec2 local = a_corner * extent;
  gl_Position = toClip(a_centre + local);
  v_local = local;
  v_radius = a_radius;
  v_colour = a_colour;
  v_shape = a_shape;
  v_stroke = a_stroke;
  v_uv = a_uv;
  v_ring = a_ring;
  v_aura = a_aura;
  v_style = a_style;
  v_badgeUv = a_badgeUv;
  // Icons fade in from ICON_MIN_PX across on screen to ICON_MIN_PX + ICON_FADE_PX (iconShown in icons.js).
  float shown = clamp((2.0 * a_radius * u_camera.z - ${ICON_MIN_PX.toFixed(1)}) / ${ICON_FADE_PX.toFixed(1)}, 0.0, 1.0);
  v_icon = vec4(a_icon, a_icon.x < 0.0 ? 0.0 : shown);
  float badgeShown = clamp((2.0 * a_radius * ${float(MARKS.badgeRadius)} * u_camera.z - ${ICON_MIN_PX.toFixed(1)}) / ${ICON_FADE_PX.toFixed(1)}, 0.0, 1.0);
  v_badge = vec2(a_badgePage, a_badgePage < 0.0 ? 0.0 : badgeShown);
}`;

export const NODE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_radius;
flat in vec4 v_colour;
flat in float v_shape;
flat in vec4 v_stroke;
flat in vec4 v_uv;
flat in vec4 v_icon;
flat in vec4 v_ring;
flat in vec4 v_aura;
flat in vec3 v_style;
flat in vec4 v_badgeUv;
flat in vec2 v_badge;
${COMMON_FRAGMENT}
${NODE_SHAPES}
${NODE_MARKS}
uniform float u_outline;
uniform vec3 u_background;
uniform mediump sampler2DArray u_icons;
out vec4 outColour;

// Premultiplied colour \`top\` over \`under\`.
vec4 over(vec4 top, vec4 under) {
  return top + under * (1.0 - top.a);
}

// How much of a border style's dash is drawn at this point (1 for solid): dashes spaced evenly by angle round the
// shape, as the Canvas 2D painter spaces them along its outline.
float dashMask(vec2 p, float style) {
  if (style == 0.0) return 1.0;
  float count = style == 1.0 ? ${float(MARKS.dashes)} : ${float(MARKS.dots)};
  float on = style == 1.0 ? ${float(MARKS.dashOn)} : ${float(MARKS.dotOn)};
  float t = (atan(p.y, p.x) / 6.28318531 + 0.5) * count;
  float f = fract(t);
  float aa = max(fwidth(t), 1e-4);
  float mask = clamp(f / aa, 0.0, 1.0) * clamp((on - f) / aa, 0.0, 1.0);
  // Dashes smaller than a pixel blur into their average, rather than flicker out.
  return mix(mask, on, clamp(aa / on - 0.5, 0.0, 1.0));
}

// A shape's distance at p, a ring measured from its stroke's outside.
float outerDistance(vec2 p, float r, float shape) {
  return shape == 5.0 ? length(p) - r - ringHalfStroke(r) : shapeDistance(p, r, shape);
}

void main() {
  vec2 p = v_local;
  float r = v_radius;
  float d0 = outerDistance(p, r, v_shape);
  vec4 result = vec4(0.0);
  if (v_aura.w > 0.0) {
    // A glow fading out over its reach: the smooth form of the Canvas 2D painter's rings of falling strength.
    float reach = auraReach(r);
    float rings = ${float(AURA_RINGS)} * clamp(1.0 - d0 / reach, 0.0, 1.0);
    float a = 1.0 - pow(1.0 - ${float(AURA_ALPHA / AURA_RINGS)}, rings);
    result = vec4(v_aura.rgb * a, a);
  }
  if (v_style.y > 0.0) {
    // A copy of the shape, shifted right and up, toward the background: there's more behind this one.
    float shift = r * ${float(MARKS.stackShift)};
    float a = cover(outerDistance(p - vec2(shift, -shift), r, v_shape));
    vec3 c = mix(v_colour.rgb, u_background, ${float(STACK_FADE)});
    result = over(vec4(c * a, a), result);
  }
  if (v_ring.w > 0.0) {
    float width = ringWidth(r);
    float a = cover(abs(d0 - ringGap(r) - width * 0.5) - width * 0.5);
    result = over(vec4(v_ring.rgb * a, a), result);
  }
  vec4 body;
  if (v_shape == 5.0) {
    // A ring: background inside, a stroke in the node's colour around it.
    float halfStroke = ringHalfStroke(r);
    float d = length(p) - r;
    float stroke = cover(abs(d) - halfStroke) * dashMask(p, v_style.x);
    float alpha = max(cover(d), stroke);
    vec3 colour = mix(u_background, v_colour.rgb, alpha > 0.0 ? stroke / alpha : 0.0);
    body = vec4(colour * alpha, alpha);
  } else {
    float d = d0;
    // Premultiplied, layer over layer: the fill (at its opacity), the icon, the border, the outline; then the
    // shape's coverage.
    vec4 colour = vec4(v_colour.rgb, 1.0) * v_style.z;
    if (v_icon.w > 0.0) {
      // The icon's box, 0 to 1 across; outside it, no icon.
      vec2 q = p / (2.0 * v_icon.yz) + 0.5;
      vec4 icon = texture(u_icons, vec3(mix(v_uv.xy, v_uv.zw, clamp(q, 0.0, 1.0)), v_icon.x));
      vec2 inside = step(vec2(0.0), q) * step(q, vec2(1.0));
      icon *= inside.x * inside.y * v_icon.w;
      // A tile is its icon: its fill only shows while the icon is too small to.
      if (v_shape == 6.0) colour *= 1.0 - v_icon.w;
      colour = icon + colour * (1.0 - icon.a);
    }
    if (v_stroke.w > 0.0) {
      // The border: the band v_stroke.w wide inside the shape's edge.
      float band = (1.0 - cover(d + v_stroke.w)) * dashMask(p, v_style.x);
      colour = mix(colour, vec4(v_stroke.rgb, 1.0), band);
    }
    float alpha;
    if (u_outline > 0.0) {
      // An outline in the background colour, centred on the shape's edge.
      float halfLine = u_outline * 0.5;
      alpha = cover(d - halfLine);
      float line = cover(abs(d) - halfLine);
      colour = mix(colour, vec4(u_background, 1.0), alpha > 0.0 ? line / alpha : 0.0);
    } else alpha = cover(d);
    body = colour * alpha;
  }
  result = over(body, result);
  if (v_badge.y > 0.0) {
    // The badge image: a disc of the background on the top-right diagonal, the image covering it, clipped round.
    float at = r * ${float(MARKS.badgeAt)}, br = r * ${float(MARKS.badgeRadius)};
    vec2 b = p - vec2(at, -at);
    float a = cover(length(b) - br) * v_badge.y;
    vec2 size = (v_badgeUv.zw - v_badgeUv.xy);
    float aspect = size.y > 0.0 ? size.x / size.y : 1.0;
    vec2 box = aspect >= 1.0 ? vec2(br * aspect, br) : vec2(br, br / aspect);
    vec2 q = clamp(b / (2.0 * box) + 0.5, 0.0, 1.0);
    vec4 icon = texture(u_icons, vec3(mix(v_badgeUv.xy, v_badgeUv.zw, q), v_badge.x));
    vec4 disc = icon + vec4(u_background, 1.0) * (1.0 - icon.a);
    result = over(disc * a, result);
  }
  outColour = result * v_colour.a;
}`;

/**
 * A selection halo: a ring u_halo.x world px outside a node's shape (its exact offset, so corners come out round),
 * u_halo.y wide, in the node's colour. Instances are the selected nodes, packed as nodes are (packHalos).
 */
export const HALO_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_centre;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_colour;
layout(location = 4) in float a_shape;
${COMMON_VERTEX}
${NODE_SHAPES}
uniform vec2 u_halo; // gap, width (world px)

out vec2 v_local;
flat out float v_radius;
flat out vec4 v_colour;
flat out float v_shape;

void main() {
  float ring = a_shape == 5.0 ? ringHalfStroke(a_radius) : 0.0;
  float extent = a_radius * shapeReach(a_shape) + ring + u_halo.x + u_halo.y + 2.0 * u_pixel;
  vec2 local = a_corner * extent;
  gl_Position = toClip(a_centre + local);
  v_local = local;
  v_radius = a_radius;
  v_colour = a_colour;
  v_shape = a_shape;
}`;

export const HALO_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_radius;
flat in vec4 v_colour;
flat in float v_shape;
${COMMON_FRAGMENT}
${NODE_SHAPES}
uniform vec2 u_halo;
out vec4 outColour;

void main() {
  // Distance from the node's outer edge (a ring's stroke reaches past its circle).
  float d = v_shape == 5.0
    ? length(v_local) - v_radius - ringHalfStroke(v_radius)
    : shapeDistance(v_local, v_radius, v_shape);
  float alpha = cover(abs(d - u_halo.x - u_halo.y * 0.5) - u_halo.y * 0.5) * v_colour.a;
  outColour = vec4(v_colour.rgb * alpha, alpha);
}`;

/**
 * What an edge capsule hands SEGMENT_FRAGMENT, and corner c (x and y each -1 or 1) of the quad round the capsule
 * from a to b, pad past it all round.
 */
const CAPSULE_CORNER = `
out vec2 v_world;
flat out vec4 v_ends;
flat out vec2 v_half;
flat out vec4 v_colour;

vec2 capsuleCorner(vec2 a, vec2 b, vec2 c, float pad) {
  vec2 along = b - a;
  float length_ = length(along);
  vec2 dir = length_ > 0.0 ? along / length_ : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float t = mix(-pad, length_ + pad, c.x * 0.5 + 0.5);
  return a + dir * t + normal * c.y * pad;
}`;

/** An edge segment: a capsule whose radius runs from one half-width to the other, so joints come out round. */
export const SEGMENT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_ends;
layout(location = 2) in vec2 a_half;
layout(location = 3) in vec3 a_colour;
layout(location = 4) in float a_alpha;
${COMMON_VERTEX}
${CAPSULE_CORNER}

void main() {
  vec2 world = capsuleCorner(a_ends.xy, a_ends.zw, a_corner, max(a_half.x, a_half.y) + 2.0 * u_pixel);
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

/**
 * An edge end's quad (for END_FRAGMENT), at its tip pointing along dir; shape is its size and kind. Reads the
 * instance's a_corner, a_colour and a_alpha.
 */
const END_QUAD = `
out vec2 v_local;
flat out vec2 v_shape;
flat out vec4 v_colour;

void endQuad(vec2 tip, vec2 dir, vec2 shape) {
  vec2 normal = vec2(-dir.y, dir.x);
  float size = shape.x;
  // Local frame: x runs back from the tip along the edge, y across it.
  vec2 local = vec2(0.45 * size, 0.0) + a_corner * (0.75 * size + 2.0 * u_pixel);
  gl_Position = toClip(tip - dir * local.x + normal * local.y);
  v_local = local;
  v_shape = shape;
  v_colour = vec4(a_colour, a_alpha);
}`;

/** An edge's end: an arrowhead (a triangle pointing along the edge) or a dot, just short of the target. */
export const END_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_tip;    // tip x, y, direction x, y
layout(location = 2) in vec2 a_shape;  // size, kind
layout(location = 3) in vec3 a_colour;
layout(location = 4) in float a_alpha;
${COMMON_VERTEX}
${END_QUAD}

void main() {
  endQuad(a_tip.xy, a_tip.zw, a_shape);
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

/**
 * A piece of text: a quad cut from the text atlas (gl-text.js), placed from its anchor in its own units (world px,
 * or screen px for text pinned to a size on screen, divided by the zoom here).
 */
export const LABEL_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_anchor; // x, y (world), units are screen px when z is 1
layout(location = 2) in vec4 a_box;    // left, middle, width, height (from the anchor, in its units)
layout(location = 3) in vec4 a_uv;     // u0, v0, u1, v1
layout(location = 4) in float a_alpha;
layout(location = 5) in vec3 a_colour; // the text
layout(location = 6) in vec3 a_under;  // the halo or pill
${COMMON_VERTEX}

out vec2 v_uv;
flat out float v_alpha;
flat out vec3 v_colour;
flat out vec3 v_under;

void main() {
  vec2 t = a_corner * 0.5 + 0.5;
  vec2 offset = vec2(a_box.x + t.x * a_box.z, a_box.y + a_corner.y * 0.5 * a_box.w);
  if (a_anchor.z > 0.5) offset /= u_camera.z;
  gl_Position = toClip(a_anchor.xy + offset);
  v_uv = mix(a_uv.xy, a_uv.zw, t);
  v_alpha = a_alpha;
  v_colour = a_colour;
  v_under = a_under;
}`;

/**
 * The atlas holds coverages, premultiplied: red the glyphs, green what's under them (a halo round the glyphs, or a
 * pill). The text is laid over the halo, both in their own colours.
 */
export const LABEL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
flat in float v_alpha;
flat in vec3 v_colour;
flat in vec3 v_under;
uniform sampler2D u_atlas;
out vec4 outColour;

void main() {
  vec4 texel = texture(u_atlas, v_uv);
  float text = texel.r;
  float under = max(texel.g, texel.r) * (1.0 - text);
  outColour = vec4(v_colour * text + v_under * under, text + under) * v_alpha;
}`;

/**
 * A reference chip's link glyph: two interlocked links (stadiums, stroked), turned 45 degrees, as a distance field.
 * The shapes are in units of the glyph's radius (LINK in references.js: offset of each link's centre, length,
 * height, stroke), as the Canvas 2D painter strokes them. Glyphs smaller on screen than GLYPH_MIN_PX CSS px are left
 * out.
 */
export const GLYPH_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_glyph;  // centre x, y, radius (world)
layout(location = 2) in vec4 a_colour; // r, g, b, alpha
${COMMON_VERTEX}

out vec2 v_local;
flat out float v_radius;
flat out vec4 v_colour;

void main() {
  float r = a_glyph.z;
  vec2 local = a_corner * (r + 2.0 * u_pixel);
  gl_Position = r * u_camera.z < ${float(GLYPH_MIN_PX)} ? vec4(0.0) : toClip(a_glyph.xy + local);
  v_local = local;
  v_radius = r;
  v_colour = a_colour;
}`;

export const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_radius;
flat in vec4 v_colour;
${COMMON_FRAGMENT}
const vec4 LINK = vec4(${[LINK.offset, LINK.length, LINK.height, LINK.stroke].map(float)});
out vec4 outColour;

// Distance to a stadium centred at (cx, 0): a bar hl long each way, rounded at radius r.
float stadium(vec2 q, float cx, float hl, float r) {
  vec2 p = q - vec2(cx, 0.0);
  p.x = max(abs(p.x) - (hl - r), 0.0);
  return length(p) - r;
}

void main() {
  vec2 p = v_local / v_radius;
  // Undo the turn: the links lie along x before it.
  vec2 q = vec2(p.x - p.y, p.x + p.y) * 0.70710678;
  float hl = LINK.y * 0.5, r = LINK.z * 0.5;
  float d = min(abs(stadium(q, -LINK.x, hl, r)), abs(stadium(q, LINK.x, hl, r))) - LINK.w * 0.5;
  float alpha = cover(d * v_radius) * v_colour.a;
  outColour = vec4(v_colour.rgb * alpha, alpha);
}`;

/**
 * Positions of every display node, relative to the edge origin: one RGBA32F texel per node (x, y, homeX, homeY).
 * A stop is a node (where it is this frame) or a bend (where the layout put it, moved along with the edge's ends,
 * each end's share by how far along the edge the bend is).
 */
const STOPS = `
uniform highp sampler2D u_positions;
const int COLUMNS = ${POSITION_COLUMNS};

vec4 nodeAt(float index) {
  int i = int(index + 0.5);
  return texelFetch(u_positions, ivec2(i % COLUMNS, i / COLUMNS), 0);
}

vec2 stopAt(vec4 stop, vec4 s, vec4 t) {
  if (stop.w > 0.5) return stop.z < 0.5 ? s.xy : t.xy;
  return stop.xy + (s.xy - s.zw) * (1.0 - stop.z) + (t.xy - t.zw) * stop.z;
}`;

/**
 * The capsule from a to b that six vertices of an edge instance draw (gl_VertexID % 6 picks the corner), as the
 * segment shader draws one; nothing when draw is false. Reads the instance's a_half, a_colour and a_alpha.
 */
const CAPSULE = `${CAPSULE_CORNER}

void capsule(vec2 a, vec2 b, bool draw) {
  if (!draw) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  int corner = gl_VertexID % 6;
  // Two triangles: corners (-1,-1) (1,-1) (-1,1) / (-1,1) (1,-1) (1,1).
  vec2 c = vec2(corner == 1 || corner == 4 || corner == 5 ? 1.0 : -1.0,
                corner == 2 || corner == 3 || corner == 5 ? 1.0 : -1.0);
  vec2 world = capsuleCorner(a, b, c, a_half + 2.0 * u_pixel);
  gl_Position = toClip(world);
  v_world = world;
  v_ends = vec4(a, b);
  v_half = vec2(a_half);
  v_colour = vec4(a_colour, a_alpha);
}`;

/**
 * Bundled edges: control points (a node on the tree path, pulled towards the line between the edge's ends), a
 * point of a uniform cubic B-spline span, and trimming a capsule off a node's disc.
 */
const SPLINE = `
const float STEPS = ${BUNDLE_STEPS}.0;
const float STRENGTH = ${float(BUNDLE_STRENGTH)};

vec2 control(float node, float along, vec2 S, vec2 T) {
  return mix(mix(S, T, along), nodeAt(node).xy, STRENGTH);
}

vec2 splineAt(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  float t2 = t * t, t3 = t2 * t;
  float w0 = (1.0 - 3.0 * t + 3.0 * t2 - t3) / 6.0, w1 = (4.0 - 6.0 * t2 + 3.0 * t3) / 6.0;
  float w2 = (1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3) / 6.0, w3 = t3 / 6.0;
  return w0 * p0 + w1 * p1 + w2 * p2 + w3 * p3;
}

// Cut the part of a to b inside the disc around c of radius r off; false when nothing is left. The curve crosses
// the disc's edge once near the node it starts or ends at, so a capsule there has one end in and one out.
bool clipDisc(inout vec2 a, inout vec2 b, vec2 c, float r) {
  if (r <= 0.0) return true;
  bool inA = length(a - c) < r, inB = length(b - c) < r;
  if (inA && inB) return false;
  if (!inA && !inB) return true;
  vec2 d = b - a, f = a - c;
  float A = dot(d, d), B = 2.0 * dot(f, d), C = dot(f, f) - r * r;
  float root = sqrt(max(B * B - 4.0 * A * C, 0.0));
  if (inA) a += d * ((-B + root) / (2.0 * A));
  else b = a + d * ((-B - root) / (2.0 * A));
  return true;
}`;

/**
 * The curves edge pieces and their ends share: a cubic (a tree curve is one in the layout's axis frame, leaving and
 * arriving along the axis through (A.x, mid) and (B.x, mid), mid halfway between; a radial curve bends at the ring
 * halfway between), where it is cut a distance from its end, how far a radial step has turned into a curve, and a
 * radial piece's frame.
 */
const CURVES = `
uniform vec2 u_centre;
uniform bool u_morphing;
uniform int u_shape;

vec2 ray(float angle) {
  return vec2(cos(angle), sin(angle));
}

vec2 cubicAt(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  float u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
}

// The way a cubic runs at t (unnormalised; zero only where the curve stops).
vec2 cubicTangent(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  float u = 1.0 - t;
  return u * u * (p1 - p0) + 2.0 * u * t * (p2 - p1) + t * t * (p3 - p2);
}

// Where a cubic is reach from its start (or, fromB, its end): the curve is cut there, off the node, as the CPU
// cuts its traced curves.
float cubicCut(float reach, vec2 p0, vec2 p1, vec2 p2, vec2 p3, bool fromB) {
  if (reach <= 0.0) return fromB ? 1.0 : 0.0;
  vec2 end = fromB ? p3 : p0;
  float lo = 0.0, hi = 0.5;
  for (int k = 0; k < ${CUT_STEPS}; k++) {
    float m = (lo + hi) * 0.5;
    if (length(cubicAt(fromB ? 1.0 - m : m, p0, p1, p2, p3) - end) < reach) lo = m;
    else hi = m;
  }
  return fromB ? 1.0 - lo : lo;
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

// A radial piece from S to T round the centre (s and t: its nodes, with their homes): the angles of its ends, the
// ring halfway between (rm), the turn between them the short way round (delta), and how far a step has eased into
// a curve (w; 1 for a curve). Returns whether the source is at the centre (or laid out there): it has no angle of
// its own, and its edges are spokes.
bool radialFrame(vec2 S, vec2 T, vec4 s, vec4 t, out float as_, out float at, out float rm, out float delta, out float w) {
  vec2 c = u_centre;
  float rs = length(S - c), rt = length(T - c);
  at = atan(T.y - c.y, T.x - c.x);
  bool centred = rs < 1e-6 || length(s.zw - c) < 1e-6;
  as_ = centred ? at : atan(S.y - c.y, S.x - c.x);
  rm = (rs + rt) * 0.5;
  delta = at - as_;
  if (delta > 3.14159265) delta -= 6.28318531;
  if (delta < -3.14159265) delta += 6.28318531;
  // Off its ring (unless a layout morph is moving it), inside its parent, or an arc that would loop: a step eases
  // into a curve.
  w = u_shape == 2 ? 1.0
    : u_shape == 1 && !centred ? stepCurveWeight(rs, rt, length(s.zw - c), length(t.zw - c), rm * abs(delta), length(T - S))
    : 0.0;
  return centred;
}`;

/**
 * An edge piece, built on the GPU: from its two stops (looked up in the positions texture), the shader traces the
 * piece's shape (u_shape: 0 straight, 1 step with rounded corners, 2 curve) in the layout's axis frame (u_axis: y
 * runs from parent to child) as 16 points, and each instance's vertices draw the capsule between two of them
 * (gl_VertexID / 6 picks which). The same geometry as piecePoints in tests/helpers/gl-twins.js.
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
${CAPSULE}
${CURVES}
uniform mat2 u_axis;
uniform float u_corner;
uniform bool u_radial;

const float HALF_PI = 1.5707963;

// Point i (0–${LAST}) of the piece from A to B, in the axis frame. Curves run between t0 and t1.
vec2 pointAt(int i, vec2 A, vec2 B, float mid, float r1, float r2, float sx, float sy, bool straight, vec2 cut) {
  if (straight) return i == 0 ? A : B;
  if (u_shape == 2) return cubicAt(mix(cut.x, cut.y, float(i) / ${float(LAST)}), A, vec2(A.x, mid), vec2(B.x, mid), B);
  if (i == 0) return A;
  if (i == ${LAST}) return B;
  if (i <= ${CORNER_POINTS}) {
    float th = float(i - 1) / ${float(CORNER_POINTS - 1)} * HALF_PI;
    return vec2(A.x + sx * r1 - sx * r1 * cos(th), mid - sy * r1 + sy * r1 * sin(th));
  }
  float th = float(i - ${CORNER_POINTS + 1}) / ${float(CORNER_POINTS - 1)} * HALF_PI;
  return vec2(B.x - sx * r2 + sx * r2 * sin(th), mid + sy * r2 - sy * r2 * cos(th));
}

// The capsule numbered part of a tree or layered piece (its points 0–${LAST}), in world px relative to the origin.
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
    vec2 p1 = vec2(A.x, mid), p2 = vec2(B.x, mid);
    cut = vec2(cubicCut(a_trim.x, A, p1, p2, B, false), cubicCut(a_trim.y, A, p1, p2, B, true));
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

const float ARC_STEP = ${ARC_STEP}; // radians per chord along a ring arc, as the CPU traces them

// Point i (0–${RADIAL_LAST}) of a radial step: the source end, a rounded corner (${RC} points), the ring arc (${RA}), a rounded
// corner (${RC}), the target end. Each corner is a quadratic curve through the spoke and ring meeting point.
vec2 radialStepAt(int i, vec2 A, vec2 B, float as_, float at, float delta, float rm, float f1, float f2, float turn) {
  vec2 c = u_centre;
  if (i == 0) return A;
  if (i == ${RADIAL_LAST}) return B;
  if (i <= ${RC}) {
    float k = float(i - 1) / ${float(RC - 1)};
    vec2 q = c + ray(as_) * (rm - f1), j = c + ray(as_) * rm, r = c + ray(as_ + turn * f1 / rm) * rm;
    return mix(mix(q, j, k), mix(j, r, k), k);
  }
  if (i >= ${1 + RC + RA}) {
    float k = float(i - ${1 + RC + RA}) / ${float(RC - 1)};
    vec2 r = c + ray(at - turn * f2 / rm) * rm, j = c + ray(at) * rm, q = c + ray(at) * (rm + f2);
    return mix(mix(r, j, k), mix(j, q, k), k);
  }
  // Round the short way: from the source's angle by the (wrapped) turn between them.
  float from = as_ + turn * f1 / rm, to = as_ + delta - turn * f2 / rm;
  return c + ray(mix(from, to, float(i - ${1 + RC}) / ${float(RA - 1)})) * rm;
}

// How far point i of a radial step is along it, as radialStepAt places them: from A, round the first corner (the
// quadratic q1, j1, r1: points 1-${RC}), along the arc (points ${1 + RC}-${RC + RA}, ${RA - 1} equal chords; it starts where the corner
// ends), round the second corner (r2, j2, q2: points ${1 + RC + RA}-${2 * RC + RA}) and on to B.
float stepAlong(int i, vec2 A, vec2 B, vec2 q1, vec2 j1, vec2 r1, vec2 q2, vec2 j2, vec2 r2, float arcChord) {
  if (i <= 0) return 0.0;
  float run = 0.0;
  vec2 previous = A;
  for (int k = 0; k < ${RC}; k++) {
    float f = float(k) / ${float(RC - 1)};
    vec2 p = mix(mix(q1, j1, f), mix(j1, r1, f), f);
    run += length(p - previous);
    previous = p;
    if (i == k + 1) return run;
  }
  if (i <= ${RC + RA}) return run + float(i - ${1 + RC}) * arcChord;
  run += ${float(RA - 1)} * arcChord;
  previous = r2;
  for (int k = 0; k < ${RC}; k++) {
    float f = float(k) / ${float(RC - 1)};
    vec2 p = mix(mix(r2, j2, f), mix(j2, q2, f), f);
    run += length(p - previous);
    previous = p;
    if (i == k + ${1 + RC + RA}) return run;
  }
  return run + length(B - previous);
}

void radialPart(int part, vec4 s, vec4 t, out vec2 a, out vec2 b) {
  vec2 c = u_centre;
  vec2 S = s.xy, T = t.xy;
  float as_, at, rm, delta, w;
  bool centred = radialFrame(S, T, s, t, as_, at, rm, delta, w);
  int mode = u_shape; // 0 straight, 1 step, 2 curve
  if (mode == 1) mode = centred ? 0 : w >= 1.0 ? 2 : 1;
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
    if (part >= ${LAST}) {
      a = b = T;
      return;
    }
    a = cubicAt(mix(t0, t1, float(part) / ${float(LAST)}), S, c1, c2, T);
    b = cubicAt(mix(t0, t1, float(part + 1) / ${float(LAST)}), S, c1, c2, T);
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
  // The corners' points (quadratics through where spoke and ring meet) and the arc's equal chords: enough to
  // measure along the step without tracing all ${RADIAL_POINTS} of its points for every vertex.
  vec2 q1 = c + ray(as_) * (rm - f1), r1 = c + ray(as_ + turn * f1 / rm) * rm;
  vec2 q2 = c + ray(at) * (rm + f2), r2 = c + ray(at - turn * f2 / rm) * rm;
  float from = as_ + turn * f1 / rm, to = as_ + delta - turn * f2 / rm;
  float arcChord = 2.0 * rm * abs(sin((to - from) / ${float(2 * (RA - 1))}));
  float total = max(stepAlong(${RADIAL_LAST}, A, B, q1, c1, r1, q2, c2, r2, arcChord), 1e-6);
  float alongA = stepAlong(part, A, B, q1, c1, r1, q2, c2, r2, arcChord);
  float alongB = stepAlong(part + 1, A, B, q1, c1, r1, q2, c2, r2, arcChord);
  a = mix(a, cubicAt(mix(t0, t1, alongA / total), S, c1, c2, T), w);
  b = mix(b, cubicAt(mix(t0, t1, alongB / total), S, c1, c2, T), w);
}

void main() {
  int part = gl_VertexID / 6;
  vec4 s = nodeAt(a_nodes.x), t = nodeAt(a_nodes.y);
  vec2 a, b;
  if (u_radial) radialPart(part, s, t, a, b);
  else treePart(part, s, t, a, b);
  // Nothing to draw past the first capsule when it has no length (a straight piece's spare parts, a corner with
  // no radius).
  capsule(a, b, length(b - a) >= 1e-6 || part == 0);
}`;

/**
 * A bundled cross-link's span, built on the GPU: a uniform cubic B-spline span whose four control points are nodes
 * on the tree path between the edge's ends (looked up in the positions texture), each pulled towards the straight
 * line between the ends by (1 - BUNDLE_STRENGTH). Each instance draws the span as u_steps capsules (BUNDLE_STEPS
 * close up, fewer zoomed out: bundleSteps in gl-edges.js); each capsule is cut where it enters the disc of its
 * source or target (the trims), so the edge stops at the nodes. The same geometry as bspline in geometry.js (and
 * bundleSpanCapsules, its twin in tests/helpers/gl-twins.js).
 */
export const BUNDLE_VERTEX = `#version 300 es
layout(location = 0) in vec4 a_controls;
layout(location = 1) in vec4 a_along;
layout(location = 2) in vec2 a_nodes;
layout(location = 3) in vec2 a_trim;
layout(location = 4) in float a_half;
layout(location = 5) in vec3 a_colour;
layout(location = 6) in float a_alpha;
${COMMON_VERTEX}
${STOPS}
${CAPSULE}
${SPLINE}
uniform float u_steps;

void main() {
  int part = gl_VertexID / 6;
  vec2 S = nodeAt(a_nodes.x).xy, T = nodeAt(a_nodes.y).xy;
  vec2 p0 = control(a_controls.x, a_along.x, S, T), p1 = control(a_controls.y, a_along.y, S, T);
  vec2 p2 = control(a_controls.z, a_along.z, S, T), p3 = control(a_controls.w, a_along.w, S, T);
  vec2 a = splineAt(float(part) / u_steps, p0, p1, p2, p3);
  vec2 b = splineAt(float(part + 1) / u_steps, p0, p1, p2, p3);
  bool keep = clipDisc(a, b, S, a_trim.x) && clipDisc(a, b, T, a_trim.y);
  capsule(a, b, keep && length(b - a) >= 1e-6);
}`;

/**
 * A bundled cross-link's end (arrowhead or dot): walking back from the target along the curve's last three spans
 * (its last four control nodes), the first point at least the target's radius plus the end's room from the
 * target; the tip sits that room on from where the curve crosses that distance, pointing the way the curve runs
 * there. The same as bundleTip in tests/helpers/gl-twins.js.
 */
export const BUNDLE_TIP_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_controls;
layout(location = 2) in vec4 a_along;
layout(location = 3) in vec2 a_nodes;
layout(location = 4) in vec3 a_shape;  // target radius, size, kind
layout(location = 5) in vec3 a_colour;
layout(location = 6) in float a_alpha;
${COMMON_VERTEX}
${STOPS}
${SPLINE}
${END_QUAD}

void main() {
  vec2 S = nodeAt(a_nodes.x).xy, T = nodeAt(a_nodes.y).xy;
  vec2 q0 = control(a_controls.x, a_along.x, S, T), q1 = control(a_controls.y, a_along.y, S, T);
  vec2 q2 = control(a_controls.z, a_along.z, S, T), q3 = control(a_controls.w, a_along.w, S, T);
  float end = a_shape.y * ${END_ROOM};
  float reach = a_shape.x + end;
  int steps = int(STEPS);
  vec2 previous = T, tip, dir;
  bool found = false;
  for (int k = 1; k <= 3 * steps; k++) {
    int span = 2 - (k - 1) / steps;
    float t = 1.0 - float((k - 1) % steps + 1) / STEPS;
    vec2 p = span == 2 ? splineAt(t, q2, q3, q3, q3)
      : span == 1 ? splineAt(t, q1, q2, q3, q3)
      : splineAt(t, q0, q1, q2, q3);
    if (length(p - T) >= reach) {
      vec2 a = p, b = previous;
      clipDisc(a, b, T, reach);
      dir = normalize(previous - p + vec2(0.0, 1e-9));
      tip = b + dir * end;
      found = true;
      break;
    }
    previous = p;
  }
  if (!found) {
    // The whole end of the curve is inside the target: point along the last stretch.
    dir = normalize(T - previous + vec2(0.0, 1e-9));
    tip = T - dir * (reach - end);
  }
  endQuad(tip, dir, a_shape.yz);
}`;

/**
 * An edge's end (arrowhead or dot) on the GPU: just off the target, pointing the way the edge runs where it's cut
 * off the target (the target's radius plus the end's room away), as the CPU puts it. A step arrives along the
 * axis (or the target's spoke); a curve along its tangent there, which a curve that has a long way across still
 * leans along; a radial step easing into a curve, between the two.
 */
export const TIP_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_stop;   // the last stop before the target
layout(location = 2) in vec2 a_nodes;
layout(location = 3) in vec3 a_shape;  // target radius, size, kind
layout(location = 4) in vec3 a_colour;
layout(location = 5) in float a_alpha;
${COMMON_VERTEX}
${STOPS}
${CURVES}
${END_QUAD}
uniform mat2 u_axis;
uniform bool u_radial;

const vec2 TINY = vec2(0.0, 1e-9);

void main() {
  vec4 s = nodeAt(a_nodes.x), t = nodeAt(a_nodes.y);
  vec2 from = stopAt(a_stop, s, t), to = t.xy;
  float end = a_shape.y * ${END_ROOM};
  float reach = a_shape.x + end;
  vec2 dir;
  // Where the edge is cut off the target: straight back along dir unless a curve says otherwise.
  vec2 cut = vec2(0.0);
  bool curved = false;
  if (u_radial) {
    vec2 c = u_centre;
    float as_, at, rm, delta, w;
    bool centred = radialFrame(from, to, s, t, as_, at, rm, delta, w);
    if (u_shape == 0 || centred) dir = normalize(to - from + TINY);
    else {
      // Steps arrive along the target's spoke, curves along their tangent; a step easing into a curve, between.
      vec2 spoke = normalize(to - c + TINY);
      dir = spoke;
      if (w > 0.0) {
        vec2 c1 = c + ray(as_) * rm, c2 = c + ray(at) * rm;
        float t1 = cubicCut(reach, from, c1, c2, to, true);
        dir = normalize(mix(spoke, normalize(cubicTangent(t1, from, c1, c2, to) + TINY), w) + TINY);
        if (w >= 1.0) {
          cut = cubicAt(t1, from, c1, c2, to);
          curved = true;
        }
      }
    }
  } else {
    vec2 A = u_axis * from, B = u_axis * to;
    if (u_shape == 0 || abs(B.x - A.x) < 1e-6) dir = normalize(to - from + TINY);
    else if (u_shape == 1) dir = transpose(u_axis) * vec2(0.0, B.y >= A.y ? 1.0 : -1.0);
    else {
      float mid = (A.y + B.y) * 0.5;
      vec2 p1 = vec2(A.x, mid), p2 = vec2(B.x, mid);
      float t1 = cubicCut(reach, A, p1, p2, B, true);
      dir = transpose(u_axis) * normalize(cubicTangent(t1, A, p1, p2, B) + TINY);
      cut = transpose(u_axis) * cubicAt(t1, A, p1, p2, B);
      curved = true;
    }
  }
  endQuad(curved ? cut + dir * end : to - dir * a_shape.x, dir, a_shape.yz);
}`;
