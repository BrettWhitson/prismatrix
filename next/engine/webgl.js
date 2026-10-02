// The WebGL2 renderer. The GPU draws everything (background, edges, arrowheads, nodes, labels) on a canvas of its
// own, beneath the view's canvas, which stays on top, transparent, to take the pointer.
//
// Edges are drawn onto a texture keeping, at each pixel, the brightest edge there (a MAX blend), and the texture
// onto the scene at the edge opacity: where edges overlap they don't add up to brighter lines, whatever each
// edge's own brightness (dimmed by hover, fading in). The Canvas 2D renderer gets the same result another way.
//
// Most edges are built on the GPU (gl-edges.js): each frame only the nodes' positions go up, in a texture, and the
// vertex shaders trace every edge from them, bundled cross-links included; the edges' pieces and spans are sent
// again only when the layout or the styles change. The shapes the shaders don't trace (fans, tapers) are traced
// on the CPU into segments, as before.
//
// Everything is drawn relative to an origin in the middle of the layout (nodes, labels, CPU segments and GPU
// pieces alike), so 32-bit floats stay precise far from the world's 0, 0.

import { clearTo, edgeAlpha, labelAlpha } from "./render.js";
import { LABEL_STRIDE, LabelLayer } from "./gl-text.js";
import {
  END_STRIDE,
  NODE_STRIDE,
  SEGMENT_STRIDE,
  edgeBrightness,
  packEdges,
  packNodes,
  parseColour,
} from "./gl-pack.js";
import {
  BUNDLE_TIP_STRIDE,
  PIECE_POINTS,
  PIECE_STRIDE,
  POSITION_COLUMNS,
  RADIAL_POINTS,
  SPAN_STRIDE,
  TIP_STRIDE,
  bundleSteps,
  gpuEdges,
  packPieces,
  packPositions,
} from "./gl-edges.js";
import { BUNDLE_STEPS, BUNDLE_STRENGTH } from "./geometry.js";
import {
  BUNDLE_TIP_VERTEX,
  BUNDLE_VERTEX,
  COMPOSITE_FRAGMENT,
  COMPOSITE_VERTEX,
  END_FRAGMENT,
  END_VERTEX,
  LABEL_FRAGMENT,
  LABEL_VERTEX,
  NODE_FRAGMENT,
  NODE_VERTEX,
  PIECE_VERTEX,
  SEGMENT_FRAGMENT,
  SEGMENT_VERTEX,
  TIP_VERTEX,
} from "./gl-shaders.js";

export {
  NODE_STRIDE,
  SHAPE_IDS,
  packEdges,
  packNodes,
  parseColour,
} from "./gl-pack.js";

/** Label text colour. */
const LABEL_COLOUR = "#d5d9e4";

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
 * Instances of a unit quad (or, without `corners`, of `vertices` vertices the shader places itself), each with
 * attributes read from one buffer of floats.
 * @param {[location: number, size: number, offset: number][]} layout attribute location, floats, float offset
 */
class InstancedQuads {
  /**
   * @param {number | null} [alphaLocation] a per-instance float read from a buffer of its own (uploadAlpha)
   * @param {{ mode?: number, vertices?: number }} [shape] how each instance is drawn (default: a 4-vertex strip)
   */
  constructor(gl, corners, stride, layout, alphaLocation = null, shape = {}) {
    this.gl = gl;
    this.stride = stride;
    this.layout = layout;
    this.alphaLocation = alphaLocation;
    this.mode = shape.mode ?? gl.TRIANGLE_STRIP;
    this.vertices = shape.vertices ?? 4;
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    this.capacity = 0;
    this.alphaBuffer = alphaLocation === null ? null : gl.createBuffer();
    this.alphaCapacity = 0;
    gl.bindVertexArray(this.vao);
    if (corners) {
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [location] of layout) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    if (this.alphaBuffer) {
      gl.enableVertexAttribArray(alphaLocation);
      gl.vertexAttribDivisor(alphaLocation, 1);
    }
    this.#point(0);
    gl.bindVertexArray(null);
  }

  /** Point the attributes at instance `first`: how a range is drawn without base-instance support. */
  #point(first) {
    const { gl } = this;
    const bytes = this.stride * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [location, size, offset] of this.layout)
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        bytes,
        first * bytes + offset * 4,
      );
    if (this.alphaBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.alphaBuffer);
      gl.vertexAttribPointer(
        this.alphaLocation,
        1,
        gl.FLOAT,
        false,
        4,
        first * 4,
      );
    }
  }

  /** The per-instance alpha, one float each. */
  uploadAlpha(data, count) {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.alphaBuffer);
    if (count * 4 > this.alphaCapacity) {
      this.alphaCapacity = Math.max(count * 4, this.alphaCapacity * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.alphaCapacity, gl.DYNAMIC_DRAW);
    }
    if (count) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count);
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

  /** Draw instances [first, end), each of `vertices` vertices (default: as constructed). */
  draw(first, end, vertices = this.vertices) {
    if (end <= first) return;
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    this.#point(first);
    gl.drawArraysInstanced(this.mode, 0, vertices, end - first);
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
    this.scene = null; // the last scene drawn, drawn again when a lost context comes back
    this.timing = false; // measure the GPU's time per pass (EXT_disjoint_timer_query_webgl2), see gpuTimes
    this.gpuTimes = null;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // ask for it back
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.#init();
      // Nothing asks for a frame when the context comes back: draw what was on screen again.
      if (this.scene) this.draw(this.scene);
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
    this.pieceProgram = program(gl, PIECE_VERTEX, SEGMENT_FRAGMENT);
    this.tipProgram = program(gl, TIP_VERTEX, END_FRAGMENT);
    this.bundleProgram = program(gl, BUNDLE_VERTEX, SEGMENT_FRAGMENT);
    this.bundleTipProgram = program(gl, BUNDLE_TIP_VERTEX, END_FRAGMENT);

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
    this.segments = new InstancedQuads(
      gl,
      corners,
      SEGMENT_STRIDE,
      [
        [1, 4, 0], // ends
        [2, 2, 4], // half-widths
        [3, 3, 6], // colour
      ],
      4, // brightness, in a buffer of its own
    );
    this.ends = new InstancedQuads(
      gl,
      corners,
      END_STRIDE,
      [
        [1, 4, 0], // tip, direction
        [2, 2, 4], // size, kind
        [3, 3, 6], // colour
      ],
      4, // brightness
    );
    // Edge pieces: no corner buffer; each instance is up to PIECE_POINTS - 1 capsules of two triangles (how many
    // is chosen per draw: a straight piece needs one, a radial one more).
    this.pieces = new InstancedQuads(
      gl,
      null,
      PIECE_STRIDE,
      [
        [0, 4, 0], // stop A
        [1, 4, 4], // stop B
        [2, 2, 8], // source, target
        [3, 2, 10], // trims
        [4, 1, 12], // half-width
        [5, 3, 13], // colour
      ],
      6,
      { mode: gl.TRIANGLES, vertices: (PIECE_POINTS - 1) * 6 },
    );
    this.tips = new InstancedQuads(
      gl,
      corners,
      TIP_STRIDE,
      [
        [1, 4, 0], // last stop
        [2, 2, 4], // source, target
        [3, 3, 6], // target radius, size, kind
        [4, 3, 9], // colour
      ],
      5,
    );
    // Bundled cross-links: a span of the spline per instance, BUNDLE_STEPS capsules each.
    this.spans = new InstancedQuads(
      gl,
      null,
      SPAN_STRIDE,
      [
        [0, 4, 0], // control nodes
        [1, 4, 4], // how far along the path each is
        [2, 2, 8], // source, target
        [3, 2, 10], // trims
        [4, 1, 12], // half-width
        [5, 3, 13], // colour
      ],
      6,
      { mode: gl.TRIANGLES, vertices: BUNDLE_STEPS * 6 },
    );
    this.bundleTips = new InstancedQuads(
      gl,
      corners,
      BUNDLE_TIP_STRIDE,
      [
        [1, 4, 0], // the last four control nodes
        [2, 4, 4], // how far along the path each is
        [3, 2, 8], // source, target
        [4, 3, 10], // target radius, size, kind
        [5, 3, 13], // colour
      ],
      6,
    );
    this.positions = { texture: gl.createTexture(), rows: 0, data: null };
    this.gpu = null; // the GPU's edge pieces, and what they were built for
    this.geometry = null; // what the origin and the pieces were built for
    this.origin = { x: 0, y: 0 };
    this.labelProgram = program(gl, LABEL_VERTEX, LABEL_FRAGMENT);
    this.labels = new InstancedQuads(gl, corners, LABEL_STRIDE, [
      [1, 4, 0], // box
      [2, 4, 4], // uv
      [3, 1, 8], // alpha
    ]);
    // A new context has none of the old one's textures: the atlas starts again.
    this.labelLayer = new LabelLayer(gl);
    this.labelGroups = [];
    this.labelKey = null;
    this.pending = false;
    this.emptyVao = gl.createVertexArray();
    this.target = null; // the offscreen texture edges are drawn onto
    this.built = null; // what the buffers hold; nothing yet (or after a lost context)
    this.perEdge = null; // each edge's brightness, as last uploaded
    this.timer = {
      ext: gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      pending: [], // queries waiting for the GPU: { query, pass }
      frame: null, // this frame's passes, as they're measured
    };
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

  /**
   * Set the uniforms every program shares. Everything the layer draws is relative to its origin, so the camera
   * is too.
   */
  #use({ program: p, uniforms: u }, scene) {
    const { gl } = this;
    const { width, height, dpr, camera } = scene;
    gl.useProgram(p);
    if (u.u_view) gl.uniform2f(u.u_view, width, height);
    if (u.u_camera)
      gl.uniform3f(
        u.u_camera,
        camera.x - this.origin.x,
        camera.y - this.origin.y,
        camera.k,
      );
    if (u.u_pixel) gl.uniform1f(u.u_pixel, 1 / (camera.k * dpr));
    return u;
  }

  draw(scene) {
    this.scene = scene;
    if (this.lost) return;
    const { gl } = this;
    const { edge, node, background, graph } = scene;
    this.#readTimers();
    const bg = parseColour(background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // The graph the buffers were built from. The view hands over a display graph (references, ghosts) that may be
    // a new object every frame around the same working graph, so it's known by the working graph's matrix (or the
    // graph itself, without one) and its size, not by the display graph's identity.
    const base = scene.matrix ?? graph;
    const nodeCount = graph.nodes.length,
      edgeCount = graph.edges.length;
    // The origin and the GPU's edge pieces change only with the layout, the styles or the graph itself.
    const gpu = gpuEdges(scene);
    const geometry = this.geometry;
    const regeometry =
      scene.geometryVersion === undefined ||
      !geometry ||
      geometry.version !== scene.geometryVersion ||
      geometry.base !== base ||
      geometry.nodes !== nodeCount ||
      geometry.edges !== edgeCount ||
      geometry.gpu !== gpu;
    if (regeometry) {
      // Everything is packed again relative to the new origin (fresh, below).
      this.origin = originOf(scene);
      this.geometry = {
        version: scene.geometryVersion,
        base,
        nodes: nodeCount,
        edges: edgeCount,
        gpu,
      };
      this.#buildPieces(scene, gpu);
    }
    // Rebuild what goes to the GPU only when something changed besides the camera: positions when nodes, styles
    // or the graph changed (version), just the brightness when only the hover or a fade did (shadeVersion).
    const built = this.built;
    const fresh =
      regeometry ||
      scene.version === undefined ||
      !built ||
      scene.version !== built.version ||
      base !== built.base ||
      nodeCount !== built.nodes ||
      edgeCount !== built.edges;
    const shaded =
      fresh ||
      scene.shadeVersion === undefined ||
      scene.shadeVersion !== built.shadeVersion;
    if (fresh) {
      if (this.gpu) this.#uploadPositions(scene);
      // Only what the GPU doesn't trace goes as segments (everything, when it traces nothing).
      this.edgeData = packEdges(
        scene,
        this.edgeData,
        this.gpu ? this.gpu.cpu : null,
        this.origin,
      );
      this.segments.upload(this.edgeData.segments, this.edgeData.segmentCount);
      this.ends.upload(this.edgeData.ends, this.edgeData.endCount);
    }
    if (shaded) {
      // Each edge's brightness; the GPU's pieces and spans take it again only when it changed (or they did).
      let perEdge = this.perEdge;
      const same = perEdge?.length === edgeCount && !regeometry;
      if (!same) perEdge = new Float32Array(edgeCount);
      let changed = !same;
      for (let i = 0; i < edgeCount; i++) {
        const a = Math.fround(edgeAlpha(scene, graph.edges[i]));
        if (perEdge[i] !== a) {
          perEdge[i] = a;
          changed = true;
        }
      }
      this.perEdge = perEdge;
      this.brightness = edgeBrightness(
        scene,
        this.edgeData,
        this.brightness,
        perEdge,
      );
      this.segments.uploadAlpha(
        this.brightness.segmentAlpha,
        this.edgeData.segmentCount,
      );
      this.ends.uploadAlpha(this.brightness.endAlpha, this.edgeData.endCount);
      if (this.gpu && changed) this.#shadePieces(perEdge);
      this.nodeData = packNodes(scene, this.nodeData, this.origin);
      this.nodes.upload(this.nodeData, nodeCount);
    }
    this.built = {
      version: scene.version,
      shadeVersion: scene.shadeVersion,
      base,
      nodes: nodeCount,
      edges: edgeCount,
    };
    const e = { ...this.edgeData, bright: this.brightness.bright };
    const g = this.gpu?.data;
    const gpuCount = g
      ? g.pieceCount + g.tipCount + g.spanCount + g.bundleTipCount
      : 0;
    this.#time("edges");
    const drawEdges = () => {
      this.#use(this.segmentProgram, scene);
      this.segments.draw(0, e.segmentCount);
      this.#use(this.endProgram, scene);
      this.ends.draw(0, e.endCount);
      if (gpuCount) this.#drawGpuEdges(scene);
    };
    if (e.bright && edge.opacity >= 1) {
      drawEdges();
    } else if (e.segmentCount || e.endCount || gpuCount) {
      const target = this.#edgeTarget();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendEquation(gl.MAX);
      drawEdges();
      gl.blendEquation(gl.FUNC_ADD);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const u = this.#use(this.compositeProgram, scene);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.uniform1i(u.u_texture, 0);
      gl.uniform1f(u.u_alpha, edge.opacity);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    // Nodes
    this.#time("nodes");
    const u = this.#use(this.nodeProgram, scene);
    gl.uniform1f(u.u_outline, node.outline);
    gl.uniform3f(u.u_background, ...bg);
    this.nodes.draw(0, nodeCount);

    this.#time("labels");
    this.#drawLabels(scene, shaded);
    this.#time(null);
  }

  /** The GPU's pieces, spans and ends take each edge's brightness. */
  #shadePieces(perEdge) {
    const g = this.gpu.data;
    const fill = (index, count, buffer) => {
      if (!buffer || buffer.length < count) buffer = new Float32Array(count);
      for (let i = 0; i < count; i++) buffer[i] = perEdge[index[i]];
      return buffer;
    };
    const a = (this.gpu.alpha ??= {});
    a.pieces = fill(g.pieceEdge, g.pieceCount, a.pieces);
    this.pieces.uploadAlpha(a.pieces, g.pieceCount);
    a.tips = fill(g.tipEdge, g.tipCount, a.tips);
    this.tips.uploadAlpha(a.tips, g.tipCount);
    a.spans = fill(g.spanEdge, g.spanCount, a.spans);
    this.spans.uploadAlpha(a.spans, g.spanCount);
    a.bundleTips = fill(g.bundleTipEdge, g.bundleTipCount, a.bundleTips);
    this.bundleTips.uploadAlpha(a.bundleTips, g.bundleTipCount);
  }

  /**
   * The GPU's edge pieces, spans and ends for this layout and these styles (or none, when the GPU can't trace
   * this edge shape), relative to the layer's origin.
   */
  #buildPieces(scene, gpu) {
    this.perEdge = null; // the new pieces need their brightness
    if (!gpu) {
      this.gpu = null;
      return;
    }
    const data = packPieces(scene, this.origin);
    this.pieces.upload(data.pieces, data.pieceCount);
    this.tips.upload(data.tips, data.tipCount);
    this.spans.upload(data.spans, data.spanCount);
    this.bundleTips.upload(data.bundleTips, data.bundleTipCount);
    this.gpu = { data, cpu: data.cpu };
  }

  /** Every display node's position and home, relative to the origin, into the positions texture. */
  #uploadPositions(scene) {
    const { gl } = this;
    const p = this.positions;
    p.data = packPositions(scene, this.origin, p.data);
    const rows = p.data.length / (POSITION_COLUMNS * 4);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, p.texture);
    if (rows !== p.rows) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        POSITION_COLUMNS,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        p.data,
      );
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      p.rows = rows;
    } else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        POSITION_COLUMNS,
        rows,
        gl.RGBA,
        gl.FLOAT,
        p.data,
      );
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * The GPU-built edges: the edge shape's pieces and ends, then cross-links drawn straight, then bundles and their
   * ends. Each range is drawn with as many vertices as its shape needs (a straight piece is one capsule).
   */
  #drawGpuEdges(scene) {
    const g = this.gpu.data;
    const capsules = (shape) =>
      shape === 0 ? 1 : (g.radial ? RADIAL_POINTS : PIECE_POINTS) - 1;
    for (const [first, end, shape] of [
      [0, g.shapedPieces, g.shape],
      [g.shapedPieces, g.pieceCount, 0],
    ]) {
      if (end <= first) continue;
      this.#useEdges(this.pieceProgram, scene, shape);
      this.pieces.draw(first, end, capsules(shape) * 6);
    }
    for (const [first, end, shape] of [
      [0, g.shapedTips, g.shape],
      [g.shapedTips, g.tipCount, 0],
    ]) {
      if (end <= first) continue;
      this.#useEdges(this.tipProgram, scene, shape);
      this.tips.draw(first, end);
    }
    if (g.spanCount) {
      const u = this.#useEdges(this.bundleProgram, scene, g.shape);
      const steps = bundleSteps(scene.camera.k);
      this.gl.uniform1f(u.u_steps, steps);
      this.spans.draw(0, g.spanCount, steps * 6);
    }
    if (g.bundleTipCount) {
      this.#useEdges(this.bundleTipProgram, scene, g.shape);
      this.bundleTips.draw(0, g.bundleTipCount);
    }
  }

  /** A GPU edge program: positions from texture unit 1, and the layout's routing. */
  #useEdges(prog, scene, shape) {
    const { gl } = this;
    const u = this.#use(prog, scene);
    const { routing } = scene;
    const g = this.gpu.data;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.positions.texture);
    gl.uniform1i(u.u_positions, 1);
    gl.uniform1i(u.u_columns, POSITION_COLUMNS);
    if (u.u_shape) gl.uniform1i(u.u_shape, shape);
    if (u.u_axis) gl.uniformMatrix2fv(u.u_axis, false, g.axis);
    if (u.u_corner) gl.uniform1f(u.u_corner, scene.edge.corner);
    if (u.u_radial) gl.uniform1i(u.u_radial, g.radial ? 1 : 0);
    if (u.u_centre)
      gl.uniform2f(
        u.u_centre,
        (routing.cx ?? 0) - this.origin.x,
        (routing.cy ?? 0) - this.origin.y,
      );
    if (u.u_morphing) gl.uniform1i(u.u_morphing, routing.morphing ? 1 : 0);
    if (u.u_strength) gl.uniform1f(u.u_strength, BUNDLE_STRENGTH);
    gl.activeTexture(gl.TEXTURE0);
    return u;
  }

  /**
   * Labels with room kept for them (label collision) always show; otherwise they drop out when too small to read.
   * They're rebuilt when anything moved, the zoom crossed a raster step, or some are still waiting for the atlas.
   */
  #drawLabels(scene, fresh) {
    const { gl } = this;
    const { node, camera } = scene;
    this.pending = false;
    if (
      node.labels === "off" ||
      (!node.labelCollide && node.labelSize * camera.k < 6)
    )
      return;
    // Labels are built for the view plus half a view around it: rebuild when the zoom crosses a raster step or
    // the camera has moved about half a view (measured at the step's zoom, so zooming within a step doesn't).
    const step = Math.ceil(Math.log2(camera.k));
    const cellW = scene.width / 2 ** step / 2,
      cellH = scene.height / 2 ** step / 2;
    const key = `${node.labelSize}|${step}|${Math.floor(camera.x / cellW)}|${Math.floor(camera.y / cellH)}`;
    if (fresh || this.labelPending || key !== this.labelKey) {
      const built = this.labelLayer.build(scene, labelAlpha, this.origin);
      this.labels.upload(built.data, built.count);
      this.labelGroups = built.groups;
      this.labelPending = built.pending;
      this.labelKey = key;
    }
    this.pending = this.labelPending;
    const u = this.#use(this.labelProgram, scene);
    gl.uniform3f(u.u_colour, ...parseColour(LABEL_COLOUR));
    gl.uniform1i(u.u_atlas, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const group of this.labelGroups) {
      gl.bindTexture(gl.TEXTURE_2D, group.page.texture);
      this.labels.draw(group.first, group.first + group.count);
    }
  }

  /**
   * GPU timing (when `timing` is on and the browser has EXT_disjoint_timer_query_webgl2): end the pass being
   * measured and start measuring `pass` (null: just end). Queries can't overlap, so passes run one after another.
   */
  #time(pass) {
    const { gl, timer } = this;
    if (!timer.ext) return;
    if (timer.frame?.open) {
      gl.endQuery(timer.ext.TIME_ELAPSED_EXT);
      timer.frame.open = false;
    }
    if (!this.timing || pass === null) {
      if (timer.frame) timer.pending.push(timer.frame);
      timer.frame = null;
      return;
    }
    // Too many frames waiting on the GPU (it's far behind, or results never came): stop adding to them.
    if (!timer.frame && timer.pending.length > 8) return;
    timer.frame ??= { queries: [], open: false };
    const query = gl.createQuery();
    gl.beginQuery(timer.ext.TIME_ELAPSED_EXT, query);
    timer.frame.queries.push({ query, pass });
    timer.frame.open = true;
  }

  /**
   * Collect the GPU times of frames the GPU has finished, into gpuTimes: each pass's milliseconds, smoothed over
   * frames, and their total. A disjoint frame (the GPU was interrupted) is thrown away.
   */
  #readTimers() {
    const { gl, timer } = this;
    if (!timer.ext) return;
    while (timer.pending.length) {
      const frame = timer.pending[0];
      const last = frame.queries.at(-1).query;
      if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) break;
      timer.pending.shift();
      const disjoint = gl.getParameter(timer.ext.GPU_DISJOINT_EXT);
      const times = (this.gpuTimes ??= { total: 0 });
      let total = 0;
      for (const { query, pass } of frame.queries) {
        const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
        if (disjoint) continue;
        total += ms;
        times[pass] =
          times[pass] === undefined ? ms : times[pass] * 0.9 + ms * 0.1;
      }
      if (!disjoint) times.total = times.total * 0.9 + total * 0.1;
    }
  }

  dispose() {
    this.labelLayer?.dispose();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * Where everything the layer draws is measured from: the middle of the layout (its nodes' homes). 32-bit floats
 * there stay precise however far out the drawing reaches; absolute world positions a hundred thousand px out
 * would only land on sixteenths of a pixel.
 */
function originOf(scene) {
  const m = scene.matrix;
  if (!m?.count) return { x: 0, y: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < m.count; i++) {
    const x = m.homeX[i],
      y = m.homeY[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX + maxX + minY + maxY)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * The WebGL painter for a renderer's canvas. It adds a GL canvas beneath the renderer's own, which stays on top to
 * take the pointer.
 */
export class WebGLPainter {
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
    // The view's own canvas only takes the pointer now: clear it once (after a switch from Canvas 2D).
    if (!this.cleared) {
      clearTo(this.topCtx, scene, null);
      this.cleared = true;
    }
  }

  /** True while labels are still being drawn into the atlas: the view keeps frames coming until they're done. */
  get pending() {
    return this.layer.pending;
  }

  /**
   * Debugging: measure how long the GPU spends on each pass (edges, nodes, labels), where the browser offers
   * EXT_disjoint_timer_query_webgl2. In the sandbox's console: `renderer.painter.timing = true`, move something,
   * then read `renderer.painter.gpuTimes` (milliseconds, smoothed over frames). Off by default.
   */
  get timing() {
    return this.layer.timing;
  }

  set timing(on) {
    this.layer.timing = !!on;
    if (!this.layer.timer.ext && on)
      console.warn(
        "Prismatrix: this browser has no EXT_disjoint_timer_query_webgl2",
      );
  }

  /** `{ edges, nodes, labels, total }` GPU milliseconds while `timing` is on (null until the first results). */
  get gpuTimes() {
    return this.layer.gpuTimes;
  }

  dispose() {
    this.layer.dispose();
    this.glCanvas.remove();
    this.top.style.position = this.previousPosition;
    this.cleared = false;
  }
}
