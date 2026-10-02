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
 * @property {number} simMs      wall time spent moving nodes this frame (morph and physics), ms
 * @property {number} drawMs     time spent drawing this frame
 * @property {number} energy     mean squared node speed
 * @property {string} state      "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest"
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
   *   dispose(): void, pending?: boolean, wake?: (() => void) | null }} painter
   * @param {RendererOptions} [options]
   */
  constructor(canvas, painter, { frameRate = "display" } = {}) {
    this.canvas = canvas;
    this.painter = painter;
    // Painters ask for a frame of their own when something they wait for comes in (an icon).
    painter.wake = () => this.invalidate();
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
    // The canvas takes every touch itself (drags, pans, pinches): the browser mustn't scroll or zoom the page.
    this.touchAction = this.canvas.style.touchAction;
    this.canvas.style.touchAction = "none";
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
    this.canvas.style.touchAction = this.touchAction ?? "";
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

  /**
   * Pointer, wheel and gesture events on the canvas, as controller calls. Every pointer is passed on by its id (each
   * finger has its own): the controller works out drags, pans, pinches, taps, double taps and long presses.
   */
  #bindPointer() {
    const c = this.canvas;
    let touching = false; // a touch is down: its long press mustn't open the page's context menu
    const local = (e) => {
      const rect = c.getBoundingClientRect();
      return {
        id: e.pointerId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        time: e.timeStamp,
        pointerType: e.pointerType,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
      };
    };
    const down = (e) => {
      touching = e.pointerType === "touch";
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the browser no longer tracks (or a synthetic one) can't be captured; the drag still works.
      }
      this.controller?.pointerDown(local(e));
    };
    const move = (e) => this.controller?.pointerMove(local(e));
    const up = (e) => this.controller?.pointerUp(local(e));
    const cancel = (e) => this.controller?.pointerCancel(local(e));
    const leave = (e) => this.controller?.pointerLeave(local(e));
    const wheel = (e) => {
      e.preventDefault();
      this.controller?.wheel({
        ...local(e),
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        wheelDeltaY: e.wheelDeltaY,
      });
    };
    const menu = (e) => {
      if (touching) e.preventDefault();
    };
    // Safari sends a trackpad pinch as gesture events (other browsers send ctrl+wheel): zoom by the change in scale.
    let scale = 1;
    const gestureStart = (e) => {
      e.preventDefault();
      scale = 1;
    };
    const gestureChange = (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      this.controller?.zoomBy(
        e.scale / scale,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      scale = e.scale;
    };
    const listeners = [
      ["pointerdown", down],
      ["pointermove", move],
      ["pointerup", up],
      ["pointercancel", cancel],
      ["pointerleave", leave],
      ["wheel", wheel, { passive: false }],
      ["contextmenu", menu],
      ["gesturestart", gestureStart],
      ["gesturechange", gestureChange],
    ];
    for (const [type, fn, options] of listeners)
      c.addEventListener(type, fn, options);
    this.unbind = () => {
      for (const [type, fn] of listeners) c.removeEventListener(type, fn);
      this.unbind = null;
    };
  }
}
