// GraphView: a GraphController on a canvas. The controller (controller.js) holds the graph, the settings and all
// the state, and does the work; the view measures label text, turns pointer and wheel events into controller calls,
// runs the frame loop, and hands each frame's scene to a renderer.

import { GraphController } from "./controller.js";
import { CanvasRenderer } from "./render.js";
import { WebGLRenderer, webglAvailable } from "./webgl.js";

export { alongRings } from "./controller.js";

export class GraphView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [hooks]
   * @param {(stats: FrameStats) => void} [hooks.onFrame] after every drawn frame
   * @param {(type: string, detail?: object) => void} [hooks.onEvent] settings changes and interactions
   * @param {object} [options]
   * @param {"webgl" | "canvas"} [options.renderer] "webgl" (the default) falls back to "canvas" without WebGL2
   * @param {"display" | "uncapped"} [options.frameRate] "display" (the default) draws once per screen refresh
   *
   * @typedef {object} FrameStats
   * @property {number} fps        smoothed
   * @property {number} dt         seconds since the previous frame, unclamped (0 for the first after a rest)
   * @property {number} simMs      time spent moving nodes this frame
   * @property {number} drawMs     time spent drawing this frame
   * @property {number} energy     mean squared node speed
   * @property {string} state      "moving to layout", "dragging", "moving" or "at rest"
   */
  constructor(
    canvas,
    hooks = {},
    { renderer = "webgl", frameRate = "display" } = {},
  ) {
    this.canvas = canvas;
    this.hooks = hooks;
    const measure = document.createElement("canvas").getContext("2d");
    this.controller = new GraphController({
      measureText: (text, size) => {
        measure.font = `${size}px system-ui, sans-serif`;
        return measure.measureText(text).width;
      },
      onEvent: (type, detail) => hooks.onEvent?.(type, detail),
      onChange: () => this.#wake(),
    });
    this.frame = 0;
    this.fps = 60;
    this.renderer = null;
    this.frameRate = "display";
    this.setRenderer(renderer);
    if (frameRate === "uncapped") this.setFrameRate(frameRate);
    this.resizer = new ResizeObserver(() => this.#resize());
    this.resizer.observe(canvas);
    this.#resize();
    this.#bindPointer();
  }

  // The controller's state, read through the view (the sandbox and telemetry look at these).
  get graph() {
    return this.controller.graph;
  }
  get model() {
    return this.controller.model;
  }
  get sim() {
    return this.controller.sim;
  }
  get camera() {
    return this.controller.camera;
  }
  get layout() {
    return this.controller.layout;
  }
  get layoutOpts() {
    return this.controller.layoutOpts;
  }
  get mode() {
    return this.controller.mode;
  }
  get modeOpts() {
    return this.controller.modeOpts;
  }
  get node() {
    return this.controller.node;
  }
  get edge() {
    return this.controller.edge;
  }
  get anim() {
    return this.controller.anim;
  }
  get routing() {
    return this.controller.routing;
  }
  get hover() {
    return this.controller.hover;
  }

  // Settings and changes: see GraphController.
  setGraph(input) {
    this.controller.setGraph(input);
  }
  setLayout(name, opts) {
    this.controller.setLayout(name, opts);
  }
  setPhysics(mode, opts) {
    this.controller.setPhysics(mode, opts);
  }
  setNodeStyle(opts) {
    this.controller.setNodeStyle(opts);
  }
  setEdgeStyle(opts) {
    this.controller.setEdgeStyle(opts);
  }
  setAnimation(opts) {
    this.controller.setAnimation(opts);
  }
  reset() {
    this.controller.reset();
  }
  fit(animate = true) {
    this.controller.fit(animate);
  }
  snapshot(note = "") {
    return this.controller.snapshot(note, { renderer: this.renderer?.name });
  }
  restore(snapshot) {
    this.controller.restore(snapshot);
  }

  /** A point on the page (client coordinates) in world coordinates. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this.controller.toWorld(clientX - rect.left, clientY - rect.top);
  }

  /**
   * Switch how frames are drawn. Asking for "webgl" where WebGL2 isn't available (or fails to start) gives "canvas".
   * @returns {"webgl" | "canvas"} the renderer now in use
   */
  setRenderer(name) {
    if (this.renderer?.name === name) return name;
    this.renderer?.dispose();
    this.renderer = null;
    if (name === "webgl" && webglAvailable()) {
      try {
        this.renderer = new WebGLRenderer(this.canvas);
      } catch (error) {
        console.warn(
          `Prismatrix: WebGL renderer failed (${error.message}); using Canvas 2D`,
        );
      }
    }
    this.renderer ??= new CanvasRenderer(this.canvas);
    const { width, height, dpr } = this.controller;
    this.renderer.resize(width, height, dpr);
    this.#wake();
    this.hooks.onEvent?.("renderer", { renderer: this.renderer.name });
    return this.renderer.name;
  }

  /**
   * "display" draws once per screen refresh (requestAnimationFrame). "uncapped" draws again as soon as a frame is
   * done, for benchmarking: the screen still only shows one frame per refresh, so the extra frames cost power and
   * show nothing, but the frame rate shows how much headroom the engine has. A hidden page always waits for the
   * display.
   */
  setFrameRate(mode) {
    this.frameRate = mode === "uncapped" ? "uncapped" : "display";
    if (this.frameRate === "uncapped" && !this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.#tick(performance.now());
    }
    this.hooks.onEvent?.("frameRate", { frameRate: this.frameRate });
    this.#wake();
    return this.frameRate;
  }

  destroy() {
    this.renderer?.dispose();
    if (this.frame > 0) cancelAnimationFrame(this.frame);
    this.channel?.port1.close();
    this.resizer.disconnect();
    this.unbind?.();
  }

  #wake() {
    if (this.frame) return;
    if (this.frameRate === "uncapped" && !document.hidden) {
      this.frame = -1;
      this.channel.port2.postMessage(0);
    } else this.frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(now) {
    this.frame = 0;
    const c = this.controller;
    const result = c.tick(now);
    if (result.gap > 0)
      this.fps += (1 / Math.min(result.gap, 0.1) - this.fps) * 0.1;
    const drawStart = performance.now();
    this.renderer.draw(c.scene);
    this.hooks.onFrame?.({
      fps: this.fps,
      dt: result.gap,
      simMs: result.simMs,
      drawMs: performance.now() - drawStart,
      energy: result.energy,
      state: result.state,
    });
    this.canvas.style.cursor = c.cursor;
    // Labels still being drawn into the atlas keep the frames coming until they're all in.
    if (result.busy || this.renderer.pending) this.#wake();
    else c.rest();
  }

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(rect.width, 1),
      height = Math.max(rect.height, 1);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.renderer?.resize(width, height, dpr);
    this.controller.setViewport(width, height, dpr);
  }

  #bindPointer() {
    const c = this.canvas;
    const local = (e) => {
      const rect = c.getBoundingClientRect();
      return {
        id: e.pointerId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        time: e.timeStamp,
      };
    };
    const down = (e) => {
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the browser no longer tracks (or a synthetic one) can't be captured; the drag still works.
      }
      this.controller.pointerDown(local(e));
    };
    const move = (e) => this.controller.pointerMove(local(e));
    const up = (e) => this.controller.pointerUp(local(e));
    const leave = () => this.controller.pointerLeave();
    const wheel = (e) => {
      e.preventDefault();
      this.controller.wheel({ ...local(e), deltaY: e.deltaY });
    };
    const dbl = (e) => this.controller.doubleClick(local(e));
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    this.unbind = () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
    };
  }
}
