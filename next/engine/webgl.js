// The WebGL2 renderer, built up a step at a time. The GPU draws the background, edges and nodes on a canvas of its
// own, beneath the view's canvas; labels are still drawn on the view's canvas with Canvas 2D:
//
//   GL layer (background, edges, arrowheads, nodes)  →  the view's own canvas (2D labels; takes the pointer)
//
// Edges are drawn onto a texture and the texture onto the scene at the edge opacity, so where edges overlap they
// don't add up to brighter lines (the Canvas 2D renderer does the same with an offscreen canvas).

import { clearTo, drawLabels } from "./render.js";
import {
  END_STRIDE,
  NODE_STRIDE,
  SEGMENT_STRIDE,
  packEdges,
  packNodes,
  parseColour,
} from "./gl-pack.js";
import {
  COMPOSITE_FRAGMENT,
  COMPOSITE_VERTEX,
  END_FRAGMENT,
  END_VERTEX,
  NODE_FRAGMENT,
  NODE_VERTEX,
  SEGMENT_FRAGMENT,
  SEGMENT_VERTEX,
} from "./gl-shaders.js";

export {
  NODE_STRIDE,
  SHAPE_IDS,
  packEdges,
  packNodes,
  parseColour,
} from "./gl-pack.js";

/** Dimmed edges (outside the hovered lineage) are drawn at this share of the edge opacity. */
const DIM_EDGES = 0.15;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Prismatrix shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

/** A linked program and its uniform locations. */
function program(gl, vertex, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`Prismatrix shader link: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(p, i);
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, uniforms };
}

/** True when this browser can give us a WebGL2 context. */
export function webglAvailable() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Instances of a unit quad, each with attributes read from one buffer of floats.
 * @param {[location: number, size: number, offset: number][]} layout attribute location, floats, float offset
 */
class InstancedQuads {
  constructor(gl, corners, stride, layout) {
    this.gl = gl;
    this.stride = stride;
    this.layout = layout;
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    this.capacity = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [location] of layout) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    this.#point(0);
    gl.bindVertexArray(null);
  }

  /** Point the attributes at instance `first`: how a range is drawn without base-instance support. */
  #point(first) {
    const { gl } = this;
    const bytes = this.stride * 4;
    for (const [location, size, offset] of this.layout)
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        bytes,
        first * bytes + offset * 4,
      );
  }

  upload(data, count) {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const bytes = count * this.stride * 4;
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, this.capacity * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    if (count)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * this.stride);
  }

  /** Draw instances [first, end). */
  draw(first, end) {
    if (end <= first) return;
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    this.#point(first);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - first);
    gl.bindVertexArray(null);
  }
}

/** Background, edges and nodes, drawn with WebGL2 on one canvas. */
class GLLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.lost = false;
    this.edgeData = {};
    this.nodeData = null;
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
      alpha: false, // the background is opaque
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.nodeProgram = program(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.segmentProgram = program(gl, SEGMENT_VERTEX, SEGMENT_FRAGMENT);
    this.endProgram = program(gl, END_VERTEX, END_FRAGMENT);
    this.compositeProgram = program(gl, COMPOSITE_VERTEX, COMPOSITE_FRAGMENT);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.nodes = new InstancedQuads(gl, corners, NODE_STRIDE, [
      [1, 2, 0], // centre
      [2, 1, 2], // radius
      [3, 4, 3], // colour
      [4, 1, 7], // shape
    ]);
    this.segments = new InstancedQuads(gl, corners, SEGMENT_STRIDE, [
      [1, 4, 0], // ends
      [2, 2, 4], // half-widths
      [3, 3, 6], // colour
    ]);
    this.ends = new InstancedQuads(gl, corners, END_STRIDE, [
      [1, 4, 0], // tip, direction
      [2, 2, 4], // size, kind
      [3, 3, 6], // colour
    ]);
    this.emptyVao = gl.createVertexArray();
    this.target = null; // the offscreen texture edges are drawn onto
    this.built = null; // what the buffers hold; nothing yet (or after a lost context)
  }

  /** The offscreen texture and framebuffer, the size of the canvas. */
  #edgeTarget() {
    const { gl } = this;
    const { width, height } = this.canvas;
    if (this.target?.width === width && this.target?.height === height)
      return this.target;
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.texture);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.target = { width, height, texture, framebuffer };
    return this.target;
  }

  /** Set the uniforms every program shares. */
  #use({ program: p, uniforms: u }, scene) {
    const { gl } = this;
    const { width, height, dpr, camera } = scene;
    gl.useProgram(p);
    if (u.u_view) gl.uniform2f(u.u_view, width, height);
    if (u.u_camera) gl.uniform3f(u.u_camera, camera.x, camera.y, camera.k);
    if (u.u_pixel) gl.uniform1f(u.u_pixel, 1 / (camera.k * dpr));
    return u;
  }

  draw(scene) {
    if (this.lost) return;
    const { gl } = this;
    const { edge, node, background, graph } = scene;
    const bg = parseColour(background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Rebuild what goes to the GPU only when something changed besides the camera.
    const fresh =
      scene.version === undefined ||
      scene.version !== this.built?.version ||
      scene.focusKey !== this.built.focusKey ||
      scene.graph !== this.built.graph;
    if (fresh) {
      this.edgeData = packEdges(scene, this.edgeData);
      this.segments.upload(this.edgeData.segments, this.edgeData.segmentCount);
      this.ends.upload(this.edgeData.ends, this.edgeData.endCount);
      this.nodeData = packNodes(scene, this.nodeData);
      this.nodes.upload(this.nodeData, graph.nodes.length);
      this.built = {
        version: scene.version,
        focusKey: scene.focusKey,
        graph: scene.graph,
      };
    }
    const e = this.edgeData;
    const drawEdges = (s0, s1, e0, e1) => {
      this.#use(this.segmentProgram, scene);
      this.segments.draw(s0, s1);
      this.#use(this.endProgram, scene);
      this.ends.draw(e0, e1);
    };
    if (!scene.focus && edge.opacity >= 1) {
      drawEdges(0, e.segmentCount, 0, e.endCount);
    } else {
      const target = this.#edgeTarget();
      const pass = (s0, s1, e0, e1, strength) => {
        if (s1 <= s0 && e1 <= e0) return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        drawEdges(s0, s1, e0, e1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const u = this.#use(this.compositeProgram, scene);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.uniform1i(u.u_texture, 0);
        gl.uniform1f(u.u_alpha, edge.opacity * strength);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
      };
      pass(0, e.dimSegments, 0, e.dimEnds, DIM_EDGES);
      pass(e.dimSegments, e.segmentCount, e.dimEnds, e.endCount, 1);
    }

    // Nodes
    const count = graph.nodes.length;
    const u = this.#use(this.nodeProgram, scene);
    gl.uniform1f(u.u_outline, node.outline);
    gl.uniform3f(u.u_background, ...bg);
    this.nodes.draw(0, count);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * The WebGL renderer for a view's canvas. It adds a GL canvas beneath the view's own, and draws labels on the
 * view's canvas, which stays on top to take the pointer.
 */
export class WebGLRenderer {
  constructor(canvas) {
    this.name = "webgl";
    this.top = canvas;
    this.topCtx = canvas.getContext("2d");
    this.glCanvas = document.createElement("canvas");
    Object.assign(this.glCanvas.style, {
      position: "absolute",
      pointerEvents: "none",
    });
    canvas.parentElement.insertBefore(this.glCanvas, canvas);
    // Positioned, so it paints after (above) the absolutely positioned layer before it.
    this.previousPosition = canvas.style.position;
    if (getComputedStyle(canvas).position === "static")
      canvas.style.position = "relative";
    this.layer = new GLLayer(this.glCanvas);
  }

  resize(width, height, dpr) {
    Object.assign(this.glCanvas.style, {
      left: `${this.top.offsetLeft}px`,
      top: `${this.top.offsetTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.glCanvas.width = Math.round(width * dpr);
    this.glCanvas.height = Math.round(height * dpr);
  }

  draw(scene) {
    this.layer.draw(scene);
    clearTo(this.topCtx, scene, null);
    drawLabels(this.topCtx, scene);
  }

  dispose() {
    this.layer.dispose();
    this.glCanvas.remove();
    this.top.style.position = this.previousPosition;
  }
}
