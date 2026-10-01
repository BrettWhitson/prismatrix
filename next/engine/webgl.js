// The WebGL2 renderer, built up a layer at a time. Today the GPU draws the nodes; edges and labels are still drawn
// with Canvas 2D on layers below and above it, so the scene stacks up as:
//
//   edge layer (2D, background + edges)  →  GL layer (nodes)  →  the view's own canvas (2D, labels; takes input)
//
// Each node is one instance of a unit quad. The fragment shader draws its shape as a signed distance field (how far a
// pixel is outside the shape), which gives smooth, resolution-independent edges and outlines at any zoom.

import { clearTo, drawEdges, drawLabels } from "./render.js";

/** Shape names to the ids the shader switches on. */
export const SHAPE_IDS = {
  circle: 0,
  square: 1,
  rounded: 2,
  diamond: 3,
  hexagon: 4,
  ring: 5,
};

/** Floats per node instance: centre x, y; radius; colour r, g, b, a (a carries dimming); shape id. */
export const NODE_STRIDE = 8;

const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_centre;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_colour;
layout(location = 4) in float a_shape;

uniform vec2 u_view;      // canvas size in CSS px
uniform vec3 u_camera;    // world x, y at the centre of the view, and zoom
uniform float u_outline;  // outline width, world px
uniform float u_pixel;    // one device pixel, in world px

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
  vec2 css = (a_centre + local - u_camera.xy) * u_camera.z + u_view * 0.5;
  vec2 clip = css / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_local = local;
  v_radius = a_radius;
  v_colour = a_colour;
  v_shape = a_shape;
}`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec2 v_local;
flat in float v_radius;
flat in vec4 v_colour;
flat in float v_shape;

uniform float u_outline;
uniform float u_pixel;
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

// Coverage of a pixel whose centre is d world px outside an edge.
float cover(float d) {
  return clamp(0.5 - d / u_pixel, 0.0, 1.0);
}

void main() {
  vec2 p = v_local;
  float r = v_radius;
  vec3 colour = v_colour.rgb;
  float alpha;
  if (v_shape == 5.0) {
    // A ring: background inside, a stroke in the node's colour around it.
    float half_ = max(1.5, r * 0.35) * 0.5;
    float d = length(p) - r;
    float stroke = cover(abs(d) - half_);
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
      float half_ = u_outline * 0.5;
      alpha = cover(d - half_);
      float line = cover(abs(d) - half_);
      colour = mix(colour, u_background, alpha > 0.0 ? line / alpha : 0.0);
    } else alpha = cover(d);
  }
  alpha *= v_colour.a;
  outColour = vec4(colour * alpha, alpha); // premultiplied
}`;

/** "#rrggbb" to [r, g, b] in 0–1. */
export function parseColour(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Every node as instance data for the shader, into `out` (grown if too small). Pure: no GL, so it can be tested.
 * @returns {Float32Array}
 */
export function packNodes(scene, out) {
  const { graph, node, looks, focus } = scene;
  const count = graph.nodes.length;
  if (!out || out.length < count * NODE_STRIDE)
    out = new Float32Array(Math.max(count, 64) * NODE_STRIDE);
  const shape = SHAPE_IDS[node.shape] ?? 0;
  const colours = new Map();
  for (const n of graph.nodes) {
    const fill = looks.fill[n.index];
    let rgb = colours.get(fill);
    if (!rgb) colours.set(fill, (rgb = parseColour(fill)));
    const o = n.index * NODE_STRIDE;
    out[o] = n.x;
    out[o + 1] = n.y;
    out[o + 2] = looks.radius[n.index];
    out[o + 3] = rgb[0];
    out[o + 4] = rgb[1];
    out[o + 5] = rgb[2];
    out[o + 6] = !focus || focus.has(n.index) ? 1 : 0.25;
    out[o + 7] = shape;
  }
  return out;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Prismatrix shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function program(gl, vertex, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`Prismatrix shader link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** True when this browser can give us a WebGL2 context. */
export function webglAvailable() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

/** Nodes drawn with WebGL2 on a canvas of their own. */
class NodeLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.data = null;
    this.lost = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // ask for it back
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.#init();
    });
    this.#init();
  }

  #init() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: false, // the shaders anti-alias themselves
      premultipliedAlpha: true,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.program = program(gl, VERTEX, FRAGMENT);
    this.uniforms = Object.fromEntries(
      ["u_view", "u_camera", "u_outline", "u_pixel", "u_background"].map(
        (name) => [name, gl.getUniformLocation(this.program, name)],
      ),
    );
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const bytes = NODE_STRIDE * 4;
    const attribute = (location, size, offset) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        bytes,
        offset * 4,
      );
      gl.vertexAttribDivisor(location, 1);
    };
    attribute(1, 2, 0); // centre
    attribute(2, 1, 2); // radius
    attribute(3, 4, 3); // colour
    attribute(4, 1, 7); // shape
    gl.bindVertexArray(null);
    this.capacity = 0;
  }

  draw(scene) {
    if (this.lost) return;
    const { gl } = this;
    const { width, height, dpr, camera, node, background, graph } = scene;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const count = graph.nodes.length;
    if (!count) return;

    this.data = packNodes(scene, this.data);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    if (this.data.byteLength > this.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      this.capacity = this.data.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, count * NODE_STRIDE);

    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform2f(u.u_view, width, height);
    gl.uniform3f(u.u_camera, camera.x, camera.y, camera.k);
    gl.uniform1f(u.u_outline, node.outline);
    gl.uniform1f(u.u_pixel, 1 / (camera.k * dpr));
    gl.uniform3f(u.u_background, ...parseColour(background));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** A canvas laid exactly over `under`'s box, beneath it, ignoring the pointer. */
function layerBeneath(top) {
  const layer = document.createElement("canvas");
  Object.assign(layer.style, { position: "absolute", pointerEvents: "none" });
  top.parentElement.insertBefore(layer, top);
  return layer;
}

/**
 * The WebGL renderer for a view's canvas. It adds two canvases beneath the view's own (an edge layer and the GL
 * node layer) and draws labels on the view's canvas, which stays on top to take the pointer.
 */
export class WebGLRenderer {
  constructor(canvas) {
    this.name = "webgl";
    this.top = canvas;
    this.topCtx = canvas.getContext("2d");
    this.edgeCanvas = layerBeneath(canvas);
    this.edgeCtx = this.edgeCanvas.getContext("2d");
    this.glCanvas = layerBeneath(canvas);
    // Positioned, so it paints after (above) the absolutely positioned layers before it.
    this.previousPosition = canvas.style.position;
    if (getComputedStyle(canvas).position === "static")
      canvas.style.position = "relative";
    this.nodes = new NodeLayer(this.glCanvas);
  }

  resize(width, height, dpr) {
    for (const layer of [this.edgeCanvas, this.glCanvas]) {
      Object.assign(layer.style, {
        left: `${this.top.offsetLeft}px`,
        top: `${this.top.offsetTop}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      layer.width = Math.round(width * dpr);
      layer.height = Math.round(height * dpr);
    }
  }

  draw(scene) {
    clearTo(this.edgeCtx, scene, scene.background);
    drawEdges(this.edgeCtx, scene);
    this.nodes.draw(scene);
    clearTo(this.topCtx, scene, null);
    drawLabels(this.topCtx, scene);
  }

  dispose() {
    this.nodes.dispose();
    this.edgeCanvas.remove();
    this.glCanvas.remove();
    this.top.style.position = this.previousPosition;
  }
}
