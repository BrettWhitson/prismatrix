export type FrameStats = {
  /**
   * smoothed
   */
  fps: number;
  /**
   * seconds since the previous frame, unclamped (0 for the first after a rest)
   */
  dt: number;
  /**
   * wall time spent moving nodes this frame (morph and physics), ms
   */
  simMs: number;
  /**
   * time spent drawing this frame
   */
  drawMs: number;
  /**
   * mean squared node speed
   */
  energy: number;
  /**
   * "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest"
   */
  state: string;
};
export type RendererOptions = {
  /**
   * "display" (the default) draws once per screen refresh
   */
  frameRate?: "display" | "uncapped";
};
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
export declare function glRenderer(canvas: any, options: any): Renderer;
/** A Canvas 2D renderer on `canvas`: slower, but works everywhere, and is the reference the WebGL one is checked against. */
export declare function canvasRenderer(canvas: any, options: any): Renderer;
export declare class Renderer {
  #private;
  canvas: HTMLCanvasElement;
  painter: {
    name: string;
    draw(scene: object): void;
    resize(w: number, h: number, dpr: number): void;
    dispose(): void;
    pending?: boolean;
    wake?: (() => void) | null;
  };
  /** @type {import("./controller.js").GraphController | null} */
  controller: import("./controller.js").GraphController | null;
  frame: number;
  fps: number;
  /** A label's width at a font size: the model measures its labels with this once a controller connects them. */
  measureText: (text: any, size: any) => number;
  touchAction: string;
  resizer: ResizeObserver;
  frameRate: string;
  channel: MessageChannel;
  unbind: () => void;
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ name: string, draw(scene: object): void, resize(w: number, h: number, dpr: number): void,
   *   dispose(): void, pending?: boolean, wake?: (() => void) | null }} painter
   * @param {RendererOptions} [options]
   */
  constructor(
    canvas: HTMLCanvasElement,
    painter: {
      name: string;
      draw(scene: object): void;
      resize(w: number, h: number, dpr: number): void;
      dispose(): void;
      pending?: boolean;
      wake?: (() => void) | null;
    },
    { frameRate }?: RendererOptions,
  );
  /** "webgl" or "canvas". */
  get name(): string;
  /** Take over the screen for `controller` (a controller does this when it's given the renderer). */
  attach(controller: any): void;
  /** Let go of the screen: no more input or frames for the controller. */
  detach(): void;
  /** Detach, and free what the painter holds (GPU buffers, its own canvas). The renderer can't be used again. */
  dispose(): void;
  /**
   * "display" draws once per screen refresh (requestAnimationFrame). "uncapped" draws again as soon as a frame is
   * done, for benchmarking: the screen still only shows one frame per refresh, so the extra frames cost power and
   * show nothing, but the frame rate shows how much headroom the engine has. A hidden page always waits for the
   * display.
   */
  setFrameRate(mode: any): string;
  /** Something changed: draw a frame soon (the controller calls this). */
  invalidate(): void;
}
