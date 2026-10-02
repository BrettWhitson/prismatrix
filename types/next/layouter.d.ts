/** Graphs with at least this many nodes lay out in the worker. */
export declare const WORKER_MIN = 2000;
export type LayouterOptions = {
  /**
   * "auto" (the default): a worker for big graphs, where workers exist; true:
   * always a worker; false: always on the spot
   */
  worker?: boolean | "auto";
  /**
   * where the worker's script is, for bundlers that don't follow
   * `new URL("./layout-worker.js", import.meta.url)` (it must be a module worker running layout-worker.js)
   */
  workerUrl?: string | URL;
  /**
   * how long, in ms, the worker may take to pick up a job before it's given up on
   * (10 s: it picks one up as soon as it gets it, so this only catches a worker that never started)
   */
  timeout?: number;
  /**
   * told once, when the worker is given up on (by default a
   * console warning)
   */
  onFallback?: (message: string) => void;
};
export type Request = {
  id: number;
  /**
   * the working graph it's for (on this thread)
   */
  graph: import("./graph.js").Graph;
  layout: string;
  options: object;
  sizing: import("./layout-job.js").SizingSpec;
  /**
   * the previous layout's homes, if any
   */
  hint: import("./layout-job.js").LayoutHint | null;
  resolve: (result: object | null) => void;
  reject: (error: Error) => void;
  /**
   * false once a newer request has replaced it (it has resolved to null)
   */
  live: boolean;
};
/**
 * @typedef {object} LayouterOptions
 * @property {boolean | "auto"} [worker] "auto" (the default): a worker for big graphs, where workers exist; true:
 *   always a worker; false: always on the spot
 * @property {string | URL} [workerUrl] where the worker's script is, for bundlers that don't follow
 *   `new URL("./layout-worker.js", import.meta.url)` (it must be a module worker running layout-worker.js)
 * @property {number} [timeout] how long, in ms, the worker may take to pick up a job before it's given up on
 *   (10 s: it picks one up as soon as it gets it, so this only catches a worker that never started)
 * @property {(message: string) => void} [onFallback] told once, when the worker is given up on (by default a
 *   console warning)
 */
/**
 * @typedef {object} Request a layout for the worker
 * @property {number} id
 * @property {import("./graph.js").Graph} graph the working graph it's for (on this thread)
 * @property {string} layout
 * @property {object} options
 * @property {import("./layout-job.js").SizingSpec} sizing
 * @property {import("./layout-job.js").LayoutHint | null} hint the previous layout's homes, if any
 * @property {(result: object | null) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {boolean} live false once a newer request has replaced it (it has resolved to null)
 */
export declare class Layouter {
  #private;
  mode: "auto" | boolean;
  workerUrl: string | URL;
  timeout: number;
  onFallback: (message: string) => void;
  worker: any;
  /** Why the worker was given up on: from then on, layouts run on the spot. */
  failed: any;
  versions: number;
  sent: any;
  /** @type {Request | null} the job the worker is working on (or about to) */
  running: Request | null;
  /** @type {Request | null} the newest request, waiting for the worker to be free */
  waiting: Request | null;
  timer: number;
  next: number;
  /** @param {LayouterOptions} [options] */
  constructor({ worker, workerUrl, timeout, onFallback }?: LayouterOptions);
  /** Whether `graph` would lay out in the worker. */
  usesWorker(graph: any): boolean;
  /**
   * Lay out `graph`. On the spot: the result, now. In the worker: a promise of it, which resolves to null instead if
   * a newer layout is asked for before it starts (or while it runs). The result's homes are arrays to copy in; the
   * routing is packed (layout-job.js). The sizing spec and the hint are copied to the worker, never moved: they're
   * still the caller's (and still whole if the worker fails and the layout has to run here instead).
   */
  run(
    graph: any,
    layout: any,
    options: any,
    sizing: any,
    hint?: any,
  ):
    | Promise<any>
    | {
        homeX: Float64Array<ArrayBuffer>;
        homeY: Float64Array<ArrayBuffer>;
        routing: any;
      };
  /** Stop the worker. Layouts still on their way never arrive (their promises never settle). */
  dispose(): void;
}
