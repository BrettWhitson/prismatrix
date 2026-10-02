// The layouter: where a controller's layouts run. Small graphs lay out on the spot (a worker's round trip would
// cost more than the layout); big ones in a worker (layout-worker.js), so the page keeps drawing and taking input
// while they're worked out. Without workers (Node, tests, an old browser) everything runs on the spot.
//
// Either way the same code runs (layout-job.js), so the result is the same.
//
// Only the newest layout matters (each one is for the graph as it is now), so the worker is given one job at a
// time: while it's busy, a new request waits, and replaces any request already waiting. A request that's been
// replaced resolves to null, and its job, if the worker had already started it, runs to the end unused (a worker
// can't be interrupted part way). However many requests come in while the worker is busy, the newest one starts as
// soon as the current one is done.
//
// If the worker can't be used (it can't be created, it fails, or it doesn't pick up a job in time), layouts run on
// the spot from then on, starting with the one that was waiting, so the view is never left without one. That's
// reported once, through `onFallback`.

import { graphFromStructure, runLayout, structureOf } from "./layout-job.js";

/** Graphs with at least this many nodes lay out in the worker. */
export const WORKER_MIN = 2000;

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
 * @property {(result: object | null) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {boolean} live false once a newer request has replaced it (it has resolved to null)
 */

export class Layouter {
  /** @param {LayouterOptions} [options] */
  constructor({
    worker = "auto",
    workerUrl = null,
    timeout = 10_000,
    onFallback = (message) => console.warn(message),
  } = {}) {
    this.mode = worker;
    this.workerUrl = workerUrl;
    this.timeout = timeout;
    this.onFallback = onFallback;
    this.worker = null;
    /** Why the worker was given up on: from then on, layouts run on the spot. */
    this.failed = null;
    this.versions = 0; // structures sent to the worker, counted
    // The structure the worker has: the model and structure version it came from, and its number.
    this.sent = null;
    /** @type {Request | null} the job the worker is working on (or about to) */
    this.running = null;
    /** @type {Request | null} the newest request, waiting for the worker to be free */
    this.waiting = null;
    this.timer = null; // gives up on the worker if it doesn't pick up the running job in time
    this.next = 0;
  }

  /** Whether `graph` would lay out in the worker. */
  usesWorker(graph) {
    if (this.mode === false || this.failed || typeof Worker === "undefined")
      return false;
    return this.mode === true || graph.nodes.length >= WORKER_MIN;
  }

  /**
   * Lay out `graph`. On the spot: the result, now. In the worker: a promise of it, which resolves to null instead if
   * a newer layout is asked for before it starts (or while it runs). The result's homes are arrays to copy in; the
   * routing is packed (layout-job.js). The sizing spec is copied to the worker, never moved: it's still the caller's.
   */
  run(graph, layout, options, sizing) {
    this.#supersede();
    if (this.usesWorker(graph) && this.#worker())
      return new Promise((resolve, reject) => {
        const id = this.next++;
        this.waiting = {
          id,
          graph,
          layout,
          options,
          sizing,
          resolve,
          reject,
          live: true,
        };
        if (!this.running) this.#send();
      });
    return runLayout(graph, layout, options, sizing);
  }

  /** A newer layout has been asked for: the ones before it resolve to null (the worker's current job runs on). */
  #supersede() {
    for (const request of [this.waiting, this.running])
      if (request?.live) {
        request.live = false;
        request.resolve(null);
      }
    this.waiting = null;
  }

  /** Give the worker the waiting request, with the structure it needs if the worker doesn't have it yet. */
  #send() {
    const request = (this.running = this.waiting);
    this.waiting = null;
    const { graph } = request;
    const message = {
      type: "layout",
      id: request.id,
      version: this.sent?.version,
      layout: request.layout,
      options: request.options,
      sizing: request.sizing,
    };
    const transfer = [];
    if (
      this.sent?.model !== graph.model ||
      this.sent?.structure !== graph.structure
    ) {
      // Made for this message and moved to the worker (nothing here keeps it: once sent, its arrays are empty).
      message.structure = structureOf(graph);
      message.version = ++this.versions;
      transfer.push(message.structure.from.buffer, message.structure.to.buffer);
      this.sent = {
        model: graph.model,
        structure: graph.structure,
        version: message.version,
      };
    }
    this.timer = setTimeout(
      () => this.#fail(`didn't pick up a layout in ${this.timeout} ms`),
      this.timeout,
    );
    try {
      this.worker.postMessage(message, transfer);
    } catch (error) {
      this.#fail(`couldn't be sent a layout (${error.message})`);
    }
  }

  /** The worker, started the first time it's needed; null if it can't be (layouts then run on the spot). */
  #worker() {
    if (this.worker) return this.worker;
    let worker;
    try {
      // The default keeps this exact form, which bundlers recognise and bundle the worker's script for.
      worker = this.workerUrl
        ? new Worker(this.workerUrl, { type: "module" })
        : new Worker(new URL("./layout-worker.js", import.meta.url), {
            type: "module",
          });
    } catch (error) {
      this.#fail(`couldn't be started (${error.message})`);
      return null;
    }
    this.worker = worker;
    this.sent = null;
    // Messages from a worker that has since been stopped or replaced are ignored.
    worker.onmessage = ({ data }) => {
      if (worker === this.worker) this.#answer(data);
    };
    worker.onerror = (event) => {
      if (worker === this.worker)
        this.#fail(`failed (${event?.message || "error"})`);
    };
    worker.onmessageerror = () => {
      if (worker === this.worker)
        this.#fail("sent a message that couldn't be read");
    };
    return worker;
  }

  /** A message from the worker: it has picked up the running job, or here is its result (or error). */
  #answer(data) {
    const request = this.running;
    if (data.id !== request?.id) return;
    clearTimeout(this.timer);
    if (data.started) return;
    this.running = null;
    if (this.waiting) this.#send(); // the newest request starts straight away
    if (!request.live) return;
    request.live = false;
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  }

  /**
   * Give up on the worker: stop it, say so (once), and lay out the request that was still wanted here instead, the
   * same job the worker would have run (on a working graph of its own, so the caller's graph is left as it is).
   */
  #fail(reason) {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.sent = null;
    if (!this.failed) {
      this.failed = reason;
      // Said just after, so a report that throws can't stop the layout below.
      const message = `layout worker ${reason}: laying out on the page's thread instead`;
      queueMicrotask(() => this.onFallback(message));
    }
    const request = this.waiting ?? this.running;
    this.waiting = this.running = null;
    if (!request?.live) return;
    request.live = false;
    try {
      request.resolve(
        runLayout(
          graphFromStructure(structureOf(request.graph)),
          request.layout,
          request.options,
          request.sizing,
        ),
      );
    } catch (error) {
      request.reject(error);
    }
  }

  /** Stop the worker. Layouts still on their way never arrive (their promises never settle). */
  dispose() {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.sent = null;
    this.running = this.waiting = null;
  }
}
