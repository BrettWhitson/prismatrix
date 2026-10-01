// Renderers: the screen. A renderer owns a canvas and everything about it: its size, the pointer and the wheel over
// it, the frame loop, measuring text, and drawing. A controller (controller.js) is attached to one: the renderer
// turns input into controller calls, and each frame asks the controller to tick and draws the scene it builds.
//
//   const renderer = glRenderer(canvas);                 // WebGL2, or Canvas 2D where there's no WebGL2
//   const model = new GraphModel(json, { node, edge });
//   const controller = new GraphController(model, renderer, { layout: "tree" });
//
// The drawing itself is a painter's: WebGLPainter (webgl.js) or CanvasPainter (render.js).

import { CanvasPainter } from "./render.js";
import { WebGLPainter, webglAvailable } from "./webgl.js";

/**
 * @typedef {object} FrameStats
 * @property {number} fps        smoothed
 * @property {number} dt         seconds since the previous frame, unclamped (0 for the first after a rest)
 * @property {number} simMs      time spent moving nodes this frame
 * @property {number} drawMs     time spent drawing this frame
 * @property {number} energy     mean squared node speed
 * @property {string} state      "moving to layout", "dragging", "moving" or "at rest"
 *
 * @typedef {object} RendererOptions
 * @property {"display" | "uncapped"} [frameRate] "display" (the default) draws once per screen refresh
 */

/** A WebGL2 renderer on `canvas`; Canvas 2D where WebGL2 isn't available or fails to start. */
export function glRenderer(canvas, options) {
  let painter = null;
  if (webglAvailable()) {
    try {
      painter = new WebGLPainter(canvas);
    } catch (error) {
      console.warn(
        `Prismatrix: WebGL renderer failed (${error.message}); using Canvas 2D`,
      );
    }
  }
  return new Renderer(canvas, painter ?? new CanvasPainter(canvas), options);
}

/** A Canvas 2D renderer on `canvas`: slower, but works everywhere, and is the reference the WebGL one is checked against. */
export function canvasRenderer(canvas, options) {
  return new Renderer(canvas, new CanvasPainter(canvas), options);
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ name: string, draw(scene: object): void, resize(w: number, h: number, dpr: number): void,
   *   dispose(): void, pending?: boolean }} painter
   * @param {RendererOptions} [options]
   */
  constructor(canvas, painter, { frameRate = "display" } = {}) {
    this.canvas = canvas;
    this.painter = painter;
    /** @type {import("./controller.js").GraphController | null} */
    this.controller = null;
    this.frame = 0;
    this.fps = 60;
    this.frameRate = "display";
    this.setFrameRate(frameRate);
    const ctx = document.createElement("canvas").getContext("2d");
    /** A label's width at a font size: the model measures its labels with this once a controller connects them. */
    this.measureText = (text, size) => {
      ctx.font = `${size}px system-ui, sans-serif`;
      return ctx.measureText(text).width;
    };
  }

  /** "webgl" or "canvas". */
  get name() {
    return this.painter.name;
  }

  /** Take over the screen for `controller` (a controller does this when it's given the renderer). */
  attach(controller) {
    if (this.controller === controller) return;
    this.detach();
    this.controller = controller;
    this.resizer = new ResizeObserver(() => this.#resize());
    this.resizer.observe(this.canvas);
    this.#resize();
    this.#bindPointer();
    this.invalidate();
  }

  /** Let go of the screen: no more input or frames for the controller. */
  detach() {
    if (!this.controller) return;
    this.resizer?.disconnect();
    this.unbind?.();
    if (this.frame > 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.controller = null;
  }

  /** Detach, and free what the painter holds (GPU buffers, its own canvas). The renderer can't be used again. */
  dispose() {
    this.controller?.setRenderer(null);
    this.detach();
    this.channel?.port1.close();
    this.painter.dispose();
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
    this.invalidate();
    return this.frameRate;
  }

  /** Something changed: draw a frame soon (the controller calls this). */
  invalidate() {
    if (this.frame || !this.controller) return;
    if (this.frameRate === "uncapped" && !document.hidden) {
      this.frame = -1;
      this.channel.port2.postMessage(0);
    } else this.frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(now) {
    this.frame = 0;
    const c = this.controller;
    if (!c) return;
    const result = c.tick(now);
    if (result.gap > 0)
      this.fps += (1 / Math.min(result.gap, 0.1) - this.fps) * 0.1;
    const drawStart = performance.now();
    this.painter.draw(c.scene);
    c.onFrame?.({
      fps: this.fps,
      dt: result.gap,
      simMs: result.simMs,
      drawMs: performance.now() - drawStart,
      energy: result.energy,
      state: result.state,
    });
    this.canvas.style.cursor = c.cursor;
    // Labels still being drawn into the atlas keep the frames coming until they're all in.
    if (result.busy || this.painter.pending) this.invalidate();
    else c.rest();
  }

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(rect.width, 1),
      height = Math.max(rect.height, 1);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.painter.resize(width, height, dpr);
    this.controller?.setViewport(width, height, dpr);
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
      this.controller?.pointerDown(local(e));
    };
    const move = (e) => this.controller?.pointerMove(local(e));
    const up = (e) => this.controller?.pointerUp(local(e));
    const leave = () => this.controller?.pointerLeave();
    const wheel = (e) => {
      e.preventDefault();
      this.controller?.wheel({ ...local(e), deltaY: e.deltaY });
    };
    const dbl = (e) => this.controller?.doubleClick(local(e));
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
      this.unbind = null;
    };
  }
}
