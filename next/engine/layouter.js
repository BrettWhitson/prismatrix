// The layouter: where a controller's layouts run. Small graphs lay out on the spot (a worker's round trip would
// cost more than the layout); big ones in a worker (layout-worker.js), so the page keeps drawing and taking input
// while they're worked out. Without workers (Node, tests, an old browser) everything runs on the spot.
//
// Either way the same code runs (layout-job.js), so the result is the same.

import { runLayout, structureOf } from "./layout-job.js";

/** Graphs with at least this many nodes lay out in the worker. */
export const WORKER_MIN = 2000;

export class Layouter {
  /** @param {{ worker?: boolean | "auto" }} [options] "auto": a worker for big graphs, where workers exist */
  constructor({ worker = "auto" } = {}) {
    this.mode = worker;
    this.worker = null;
    this.versions = 0; // structures sent to the worker, counted
    this.sentGraph = null; // the graph (model and structure version) the worker's structure came from
    this.sentStructure = -1;
    this.sentVersion = -1;
    this.waiting = new Map(); // request id → { resolve, reject }
    this.next = 0;
  }

  /** Whether `graph` would lay out in the worker. */
  usesWorker(graph) {
    if (this.mode === false || typeof Worker === "undefined") return false;
    return this.mode === true || graph.nodes.length >= WORKER_MIN;
  }

  /**
   * Lay out `graph`. On the spot: the result, now. In the worker: a promise of it. The result's homes are arrays to
   * copy in; the routing is packed (layout-job.js).
   */
  run(graph, layout, options, sizing) {
    if (!this.usesWorker(graph))
      return runLayout(graph, layout, options, sizing);
    const worker = this.#worker();
    // The worker keeps the last structure it was sent: send it again only when it's a different one.
    const version = ++this.versions;
    if (
      this.sentGraph?.model !== graph.model ||
      this.sentStructure !== graph.structure
    ) {
      const structure = structureOf(graph);
      worker.postMessage({ type: "structure", version, structure }, [
        structure.from.buffer,
        structure.to.buffer,
      ]);
      this.sentGraph = graph;
      this.sentStructure = graph.structure;
      this.sentVersion = version;
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({
        type: "layout",
        id,
        version: this.sentVersion,
        layout,
        options,
        sizing,
      });
    });
  }

  #worker() {
    if (!this.worker) {
      this.worker = new Worker(new URL("./layout-worker.js", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = ({ data }) => {
        const waiting = this.waiting.get(data.id);
        if (!waiting) return;
        this.waiting.delete(data.id);
        if (data.error) waiting.reject(new Error(data.error));
        else waiting.resolve(data.result);
      };
    }
    return this.worker;
  }

  /** Stop the worker (pending layouts never arrive). */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.sentGraph = null;
  }
}
