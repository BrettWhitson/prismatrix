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

import { HALO_GAP, HALO_WIDTH, clearTo, flowShift } from "./render.js";
import { LABEL_STRIDE, LabelLayer, textKey } from "./gl-text.js";
import {
  END_STRIDE,
  GLYPH_STRIDE,
  NODE_STRIDE,
  SEGMENT_STRIDE,
  edgeBrightness,
  edgeStates,
  packEdges,
  packGlyphs,
  packHalos,
  packNodes,
  parseColour,
  patchEdges,
  patchNodes,
  room,
  runsOf,
} from "./gl-pack.js";
import { IconAtlas } from "./gl-icons.js";
import { iconStore } from "./icons.js";
import { DEFAULT_THEME } from "./theme.js";
import { CARD } from "./cards.js";
import {
  BUNDLE_TIP_STRIDE,
  KINDS,
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
  restylePieces,
} from "./gl-edges.js";
import { BUNDLE_STEPS } from "./geometry.js";
import {
  BUNDLE_TIP_VERTEX,
  BUNDLE_VERTEX,
  COMPOSITE_FRAGMENT,
  COMPOSITE_VERTEX,
  END_FRAGMENT,
  END_VERTEX,
  GLYPH_FRAGMENT,
  GLYPH_VERTEX,
  HALO_FRAGMENT,
  HALO_VERTEX,
  LABEL_FRAGMENT,
  LABEL_VERTEX,
  NODE_FRAGMENT,
  NODE_VERTEX,
  PIECE_VERTEX,
  SEGMENT_FRAGMENT,
  SEGMENT_VERTEX,
  TIP_VERTEX,
} from "./gl-shaders.js";

/** The texture unit the icon atlas is bound to (labels use 0, the positions texture 1). */
const ICON_UNIT = 2;

/**
 * Which nodes and edges to restyle in place since style version `from` (the restyle log the view keeps on its
 * scene: `restyles`, newest last, each `{ version, nodes, edges }`), or null when that can't be told (a restyle of
 * everything, or one the log no longer holds): then everything is built again.
 * @returns {{ nodes: Int32Array, edges: Int32Array } | null}
 */
export function restylesSince(restyles, from, to) {
  if (!restyles?.length) return null;
  const since = restyles.filter((r) => r.version > from && r.version <= to);
  // Every restyle in between, one per version.
  if (!since.length || since.length !== to - from) return null;
  const nodes = new Set(),
    edges = new Set();
  for (const r of since) {
    if (!r.nodes || !r.edges) return null;
    for (const i of r.nodes) nodes.add(i);
    for (const i of r.edges) edges.add(i);
  }
  return {
    nodes: Int32Array.from(nodes).sort(),
    edges: Int32Array.from(edges).sort(),
  };
}

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

  /** Just instances `runs` ([first, end) each) of `data`, into a buffer already holding the rest. */
  uploadRuns(data, runs) {
    if (!runs.length) return;
    const { gl, stride } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [first, end] of runs)
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        first * stride * 4,
        data,
        first * stride,
        (end - first) * stride,
      );
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

/**
 * The WebGL painter for a renderer's canvas: background, edges, nodes and text, drawn with WebGL2 on a canvas of its
 * own (glCanvas) beneath the renderer's, which stays on top to take the pointer.
 */
export class WebGLPainter {
  #timing = false;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ icons?: import("./icons.js").IconStore }} [options] where icons come from (default: the page's shared
   *   store)
   */
  constructor(canvas, { icons = iconStore() } = {}) {
    this.name = "webgl";
    /** Set by the renderer: asks for a frame (an icon came in). */
    this.wake = null;
    this.top = canvas;
    this.topCtx = canvas.getContext("2d");
    const glCanvas = (this.glCanvas = document.createElement("canvas"));
    Object.assign(glCanvas.style, {
      position: "absolute",
      pointerEvents: "none",
    });
    canvas.parentElement.insertBefore(glCanvas, canvas);
    // Positioned, so it paints after (above) the absolutely positioned layer before it.
    this.previousPosition = canvas.style.position;
    if (getComputedStyle(canvas).position === "static")
      canvas.style.position = "relative";
    this.icons = icons;
    this.lost = false;
    // The CPU's edge segments and ends, from the last frame (empty until the first).
    this.edgeData = /** @type {ReturnType<typeof packEdges>} */ ({});
    this.nodeData = null;
    this.scene = null; // the last scene drawn, drawn again when a lost context comes back
    /** `{ edges, nodes, labels, total }` GPU milliseconds while `timing` is on (null until the first results). */
    this.gpuTimes = null;
    glCanvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // ask for it back
      this.lost = true;
    });
    glCanvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.#init();
      // Nothing asks for a frame when the context comes back: draw what was on screen again.
      if (this.scene) this.draw(this.scene);
    });
    this.#init();
    this.unlisten = icons.onReady(() => {
      this.iconsArrived = true;
      this.wake?.();
    });
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

  /**
   * Debugging: measure how long the GPU spends on each pass (edges, nodes, labels), where the browser offers
   * EXT_disjoint_timer_query_webgl2. In the sandbox's console: `renderer.painter.timing = true`, move something,
   * then read `renderer.painter.gpuTimes` (milliseconds, smoothed over frames). Off by default.
   */
  get timing() {
    return this.#timing;
  }

  set timing(on) {
    this.#timing = !!on;
    if (!this.timer.ext && on)
      console.warn(
        "Prismatrix: this browser has no EXT_disjoint_timer_query_webgl2",
      );
  }

  #init() {
    const gl = this.glCanvas.getContext("webgl2", {
      antialias: false, // the shaders anti-alias themselves
      premultipliedAlpha: true,
      alpha: false, // the background is opaque
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.nodeProgram = program(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.haloProgram = program(gl, HALO_VERTEX, HALO_FRAGMENT);
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
    const nodeLayout = [
      [1, 2, 0], // centre
      [2, 1, 2], // radius
      [3, 4, 3], // colour
      [4, 1, 7], // shape
      [5, 4, 8], // border
      [6, 4, 12], // icon rectangle
      [7, 3, 16], // icon page, box
      [8, 4, 19], // ring
      [9, 4, 23], // aura
      [10, 3, 27], // border style, stack, fill opacity
      [11, 4, 30], // badge image rectangle
      [12, 1, 34], // badge image page
      [13, 1, 35], // a card
    ];
    // A new context has none of the old one's textures: icons are copied in again as nodes ask for them.
    this.iconAtlas = new IconAtlas(gl, this.icons);
    this.nodes = new InstancedQuads(gl, corners, NODE_STRIDE, nodeLayout);
    // Selection halos: the selected nodes, packed as nodes are.
    this.halos = new InstancedQuads(gl, corners, NODE_STRIDE, nodeLayout);
    this.haloData = { data: null, count: 0 };
    this.segments = new InstancedQuads(
      gl,
      corners,
      SEGMENT_STRIDE,
      [
        [1, 4, 0], // ends
        [2, 2, 4], // half-widths
        [3, 3, 6], // colour
        [5, 3, 9], // how far along its edge, dash style, glow
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
    // Edge pieces and bundle spans share a layout (PIECE_STRIDE, SPAN_STRIDE).
    const pieceLayout = [
      [0, 4, 0], // stop A, or the span's control nodes
      [1, 4, 4], // stop B, or how far along the path each control node is
      [2, 2, 8], // source, target
      [3, 2, 10], // trims
      [4, 1, 12], // half-width
      [5, 3, 13], // colour
      [7, 2, 16], // dash style, glow
    ];
    // Edge pieces: no corner buffer; each instance is up to PIECE_POINTS - 1 capsules of two triangles (how many
    // is chosen per draw: a straight piece needs one, a radial one more).
    this.pieces = new InstancedQuads(gl, null, PIECE_STRIDE, pieceLayout, 6, {
      mode: gl.TRIANGLES,
      vertices: (PIECE_POINTS - 1) * 6,
    });
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
    this.spans = new InstancedQuads(gl, null, SPAN_STRIDE, pieceLayout, 6, {
      mode: gl.TRIANGLES,
      vertices: BUNDLE_STEPS * 6,
    });
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
    this.gpu = null; // the GPU's edge pieces, spans and ends (packPieces)
    this.gpuAlpha = {}; // their brightness, by kind
    this.geometry = null; // what the origin and the pieces were built for
    this.origin = { x: 0, y: 0 };
    this.labelProgram = program(gl, LABEL_VERTEX, LABEL_FRAGMENT);
    this.labels = new InstancedQuads(gl, corners, LABEL_STRIDE, [
      [1, 3, 0], // anchor, units
      [2, 4, 3], // box
      [3, 4, 7], // uv
      [4, 1, 11], // alpha
      [5, 3, 12], // text colour
      [6, 3, 15], // halo or pill colour
    ]);
    // Reference chips' link glyphs.
    this.glyphProgram = program(gl, GLYPH_VERTEX, GLYPH_FRAGMENT);
    this.glyphs = new InstancedQuads(gl, corners, GLYPH_STRIDE, [
      [1, 3, 0], // centre, radius
      [2, 4, 3], // colour, alpha
    ]);
    this.glyphData = { data: null, count: 0 };
    // A new context has none of the old one's textures: the atlas starts again.
    this.labelLayer = new LabelLayer(gl);
    this.labelGroups = [];
    this.labelKey = null;
    this.pending = false; // labels still being drawn into the atlas: the view keeps frames coming until they are in
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
    const { width, height } = this.glCanvas;
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
    if (u.u_ancestors) {
      const theme = scene.theme ?? DEFAULT_THEME;
      gl.uniform3f(u.u_ancestors, ...parseColour(theme.ancestors));
      gl.uniform3f(u.u_descendants, ...parseColour(theme.descendants));
    }
    if (u.u_card) {
      const theme = scene.theme ?? DEFAULT_THEME;
      const n = scene.node;
      gl.uniform3f(
        u.u_card,
        n?.cardWidth ?? 0,
        n?.cardHeight ?? 0,
        CARD.corner,
      );
      gl.uniform3f(u.u_cardFace, ...parseColour(theme.card));
      gl.uniform3f(u.u_cardBorder, ...parseColour(theme.cardBorder));
    }
    if (u.u_flow) {
      const { shift, sign } = flowShift(scene);
      gl.uniform2f(u.u_flow, shift, sign);
    }
    return u;
  }

  draw(scene) {
    // The view's own canvas only takes the pointer now: clear it once (after a switch from Canvas 2D).
    if (!this.cleared) {
      clearTo(this.topCtx, scene, null);
      this.cleared = true;
    }
    this.scene = scene;
    if (this.lost) return;
    const { gl } = this;
    const { edge, node, graph } = scene;
    const background =
      scene.background ?? (scene.theme ?? DEFAULT_THEME).background;
    this.#readTimers();
    const bg = parseColour(background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
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
    // A restyle of a few nodes and edges (the scene's restyle log) is patched into the buffers built before it; one
    // the log can't account for rebuilds everything.
    let restyle = null;
    const styled = this.built?.styleVersion;
    if (styled !== undefined && scene.styleVersion !== styled) {
      restyle = restylesSince(scene.restyles, styled, scene.styleVersion);
      if (!restyle) this.geometry = null;
    }
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
      scene.shadeVersion !== built.shadeVersion ||
      scene.selectionVersion !== built.selectionVersion;
    if (fresh) {
      if (this.gpu) this.#uploadPositions(scene);
      // Only what the GPU doesn't trace goes as segments (everything, when it traces nothing).
      this.edgeData = packEdges(
        scene,
        this.edgeData,
        this.gpu ? [] : null,
        this.origin,
      );
      this.segments.upload(this.edgeData.segments, this.edgeData.segmentCount);
      this.ends.upload(this.edgeData.ends, this.edgeData.endCount);
    } else if (restyle?.edges.length) {
      const runs = patchEdges(scene, this.edgeData, restyle.edges, this.origin);
      this.segments.uploadRuns(this.edgeData.segments, runs.segments);
      this.ends.uploadRuns(this.edgeData.ends, runs.ends);
    }
    if (restyle?.edges.length && this.gpu && !regeometry) {
      const dirty = new Uint8Array(edgeCount);
      for (const i of restyle.edges) dirty[i] = 1;
      const runs = restylePieces(scene, this.gpu, dirty);
      for (const [kind] of KINDS)
        this[kind].uploadRuns(this.gpu[kind], runs[kind]);
    }
    // Icons that came in since the last frame go into the atlas as their nodes are packed again.
    const iconsArrived = this.iconsArrived;
    this.iconsArrived = false;
    if (shaded || iconsArrived) this.#packNodes(scene);
    else if (restyle) {
      // The restyled nodes, and the display-only ones past the real graph (references take their ingredient's
      // colour).
      const real = Math.min(scene.matrix?.count ?? nodeCount, nodeCount);
      const indices = [...restyle.nodes];
      for (let i = real; i < nodeCount; i++) indices.push(i);
      const moved = this.iconAtlas.moved;
      const iconAt = (source) => this.iconAtlas.lookup(source);
      patchNodes(scene, this.nodeData, indices, this.origin, iconAt);
      // An icon that came in grew the atlas: every node's icon rectangle changed.
      if (this.iconAtlas.moved !== moved) this.#packNodes(scene);
      else this.nodes.uploadRuns(this.nodeData, runsOf(indices));
      this.haloData = packHalos(scene, this.nodeData, this.haloData.data);
      this.halos.upload(this.haloData.data, this.haloData.count);
    }
    if (shaded) {
      // Each edge's brightness; the GPU's pieces and spans take it again only when it changed (or they did).
      let perEdge = this.perEdge;
      const same = perEdge?.length === edgeCount && !regeometry;
      if (!same) perEdge = new Float32Array(edgeCount);
      let changed = !same;
      const states = (this.states = edgeStates(scene, this.states));
      for (let i = 0; i < edgeCount; i++) {
        if (perEdge[i] !== states[i]) {
          perEdge[i] = states[i];
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
      this.haloData = packHalos(scene, this.nodeData, this.haloData.data);
      this.halos.upload(this.haloData.data, this.haloData.count);
      this.glyphData = packGlyphs(scene, this.glyphData.data, this.origin);
      this.glyphs.upload(this.glyphData.data, this.glyphData.count);
    }
    this.built = {
      version: scene.version,
      shadeVersion: scene.shadeVersion,
      selectionVersion: scene.selectionVersion,
      styleVersion: scene.styleVersion,
      base,
      nodes: nodeCount,
      edges: edgeCount,
    };
    const e = { ...this.edgeData, bright: this.brightness.bright };
    const g = this.gpu;
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
    this.iconAtlas.bind(ICON_UNIT);
    gl.uniform1i(u.u_icons, ICON_UNIT);
    this.nodes.draw(0, nodeCount);
    if (this.haloData.count) {
      // Selected nodes: a ring a few screen px outside each.
      const h = this.#use(this.haloProgram, scene);
      const k = scene.camera.k;
      gl.uniform2f(h.u_halo, HALO_GAP / k, HALO_WIDTH / k);
      this.halos.draw(0, this.haloData.count);
    }
    if (this.glyphData.count) {
      this.#use(this.glyphProgram, scene);
      this.glyphs.draw(0, this.glyphData.count);
    }

    this.#time("labels");
    this.#drawLabels(scene, shaded);
    this.#time(null);
  }

  /**
   * Every node into the node buffer, icons copied into the atlas as nodes ask for them. If one grows the atlas
   * (every icon's rectangle changes), the nodes packed before it are packed again.
   */
  #packNodes(scene) {
    const atlas = this.iconAtlas;
    const iconAt = (source) => atlas.lookup(source);
    for (let pass = 0; pass < 2; pass++) {
      const moved = atlas.moved;
      this.nodeData = packNodes(scene, this.nodeData, this.origin, iconAt);
      if (atlas.moved === moved) break;
    }
    this.nodes.upload(this.nodeData, scene.graph.nodes.length);
  }

  /** The GPU's pieces, spans and ends take each edge's brightness. */
  #shadePieces(perEdge) {
    const g = this.gpu;
    for (const [kind, edgesOf, countOf] of KINDS) {
      const edges = g[edgesOf],
        count = g[countOf];
      const alpha = (this.gpuAlpha[kind] = room(this.gpuAlpha[kind], count));
      for (let i = 0; i < count; i++) alpha[i] = perEdge[edges[i]];
      this[kind].uploadAlpha(alpha, count);
    }
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
    for (const [kind, , countOf] of KINDS)
      this[kind].upload(data[kind], data[countOf]);
    this.gpu = data;
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
    const g = this.gpu;
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
    const g = this.gpu;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.positions.texture);
    gl.uniform1i(u.u_positions, 1);
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
    gl.activeTexture(gl.TEXTURE0);
    return u;
  }

  /**
   * Text (labels.js plans it, as for Canvas 2D: node and edge labels, counts, badges, pinned labels). It's rebuilt
   * when anything moved or was shaded, the zoom crossed a raster step or changed what shows (textKey), or some is
   * still waiting for the atlas.
   */
  #drawLabels(scene, fresh) {
    const { gl } = this;
    const { node, camera } = scene;
    // Text is built for the view plus half a view around it: rebuild when the zoom crosses a raster step or the
    // camera has moved about half a view (measured at the step's zoom, so zooming within a step doesn't).
    const step = Math.ceil(Math.log2(camera.k));
    const cellW = scene.width / 2 ** step / 2,
      cellH = scene.height / 2 ** step / 2;
    const key = `${node.labelSize}|${step}|${Math.floor(camera.x / cellW)}|${Math.floor(camera.y / cellH)}|${textKey(scene)}|${scene.foldVersion}`;
    if (fresh || this.pending || key !== this.labelKey) {
      const built = this.labelLayer.build(scene, this.origin);
      this.labels.upload(built.data, built.count);
      this.labelGroups = built.groups;
      this.pending = built.pending;
      this.labelKey = key;
    }
    if (!this.labelGroups.length) return;
    const u = this.#use(this.labelProgram, scene);
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
    this.unlisten();
    this.labelLayer?.dispose();
    this.iconAtlas?.dispose();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.glCanvas.remove();
    this.top.style.position = this.previousPosition;
    this.cleared = false;
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
