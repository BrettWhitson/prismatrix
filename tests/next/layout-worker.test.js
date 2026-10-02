// Layouts off the page's thread: the worker's job gives the same layout as running it in place, and a controller
// keeps showing the graph it has until a layout arrives, and uses only the newest. The worker gets one job at a
// time and only the newest waits; if it can't be used, layouts run on the spot and the view still gets one.
//
// Comparisons of homes use the tree layout: the merged layout works to wall-clock budgets (to be replaced), so at
// any size where a budget can run out, two runs of it may differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import { LAYOUTS } from "../../next/engine/layouts.js";
import { resolve } from "../../next/engine/schema.js";
import {
  graphFromStructure,
  runLayout,
  sizingFrom,
  structureOf,
  unpackRouting,
} from "../../next/engine/layout-job.js";
import { GraphController } from "../../next/engine/controller.js";
import { Layouter } from "../../next/engine/layouter.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A recipe-like graph: a tree plus shared ingredients. */
function recipes(count, shared, seed = 3) {
  const r = rng(seed);
  const nodes = [{ id: "n0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: `n${i}`, label: `item ${i}` });
    edges.push({ source: `n${Math.floor(r() ** 1.3 * i)}`, target: `n${i}` });
  }
  for (let k = 0; k < shared; k++) {
    const a = Math.floor(r() * count),
      b = Math.floor(r() * count);
    if (a !== b)
      edges.push({
        source: `n${Math.min(a, b)}`,
        target: `n${Math.max(a, b)}`,
      });
  }
  return { nodes, edges };
}

const spec = (g) => ({
  widths: Float64Array.from(g.nodes, (n) => 6 * n.label.length),
  reach: new Float64Array(g.nodes.length).fill(8),
  height: 14,
  gap: 4,
  labels: "below",
  collide: true,
});

test("a layout across the worker boundary (structure in, packed result out) is the layout run in place", () => {
  // The merged tree on a graph small enough that its time budgets don't run out even on a busy machine.
  for (const [name, input] of [
    ["tree", recipes(300, 60)],
    ["radial", recipes(300, 60)],
    ["merged", recipes(120, 24)],
  ]) {
    const options = resolve(LAYOUTS[name].options);
    const here = new Graph(GraphModel.from(input));
    const sizing = spec(here);
    const routingHere = LAYOUTS[name].run(here, options, sizingFrom(sizing));
    // The worker gets only the structure and the sizing, and builds its own graph.
    const there = graphFromStructure(structureOf(here));
    const result = runLayout(there, name, options, sizing);
    assert.deepEqual([...result.homeX], [...here.matrix.homeX], name);
    assert.deepEqual([...result.homeY], [...here.matrix.homeY], name);
    const routing = unpackRouting(result.routing, here);
    assert.equal(routing.kind, routingHere.kind);
    if (name === "merged") {
      for (const e of here.edges)
        assert.deepEqual(
          routing.bends.get(e) ?? [],
          routingHere.bends.get(e) ?? [],
        );
      assert.deepEqual(
        routing.references.map((r) => [r.edge, r.x, r.y]),
        routingHere.references.map((r) => [r.edge, r.x, r.y]),
      );
    }
  }
});

let modules = 0;

/**
 * Stand-ins for the browser's Worker, running the real worker's code (layout-worker.js, a fresh copy of it for each
 * call): messages cross both ways as structured clones, with their transfers (so a moved array is left empty on the
 * side that sent it), and a worker handles what it was sent only when `flush` (or its `step`) is called.
 * @param {{ throws?: string }} [options] throws: the Worker constructor throws this (a page whose policy forbids
 *   workers, a bundler that didn't bundle the script)
 */
async function fakeWorkers({ throws } = {}) {
  const scope = {};
  globalThis.self = scope;
  const url = new URL("../../next/engine/layout-worker.js", import.meta.url);
  url.search = `fake=${modules++}`;
  await import(url.href);
  delete globalThis.self;
  const handle = scope.onmessage;
  const workers = [];
  const sent = []; // every message posted to a worker, as posted (before it was cloned)
  let jobs = 0; // layouts the workers have worked out
  class FakeWorker {
    constructor(url) {
      if (throws) throw new Error(throws);
      this.url = url;
      this.inbox = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(data, transfer = []) {
      sent.push(data);
      if (!this.terminated)
        this.inbox.push(structuredClone(data, { transfer }));
    }
    /** Handle the messages waiting, and pass the answers back. */
    step() {
      for (const data of this.inbox.splice(0)) {
        if (this.terminated) return;
        const answers = [];
        scope.postMessage = (message, transfer = []) =>
          answers.push(structuredClone(message, { transfer }));
        globalThis.self = scope;
        try {
          handle({ data });
        } finally {
          delete globalThis.self;
        }
        if (answers.some((a) => a.result)) jobs++;
        for (const answer of answers)
          if (!this.terminated) this.onmessage?.({ data: answer });
      }
    }
    terminate() {
      this.terminated = true;
    }
  }
  const live = () => workers.filter((w) => !w.terminated);
  return {
    FakeWorker,
    workers,
    sent,
    jobs: () => jobs,
    /** Let the workers work until none has anything left (an answer can bring the next request). */
    flush() {
      while (live().some((w) => w.inbox.length))
        for (const w of live()) w.step();
    },
    pending: () => live().reduce((n, w) => n + w.inbox.length, 0),
  };
}

/** Let promise callbacks run. */
const settle = () => new Promise((done) => setImmediate(done));

/** Run `body` with `Worker` standing for `FakeWorker`. */
async function withWorker(FakeWorker, body) {
  globalThis.Worker = FakeWorker;
  try {
    await body();
  } finally {
    delete globalThis.Worker;
  }
}

const treeOptions = resolve(LAYOUTS.tree.options);

/** A working graph for `input`. */
const graphOf = (input) => new Graph(GraphModel.from(input));

/** The tree layout of `input`, worked out on the spot. */
function onTheSpot(input) {
  const g = graphOf(input);
  return runLayout(g, "tree", treeOptions, spec(g));
}

/**
 * The homes a controller that never uses a worker gives the last of `inputs`, shown one after the other (each
 * layout keeps the one before in place: its hint).
 */
function homesHere(...inputs) {
  const c = new GraphController(new GraphModel(inputs[0]), null, {
    worker: false,
  });
  c.setViewport(800, 600);
  for (const input of inputs.slice(1)) c.setGraph(input);
  const homes = [...c.graph.matrix.homeX];
  c.destroy();
  return homes;
}

test("with layouts in a worker, the graph on screen stays as it is until its layout arrives, and only the newest is used", async () => {
  const { FakeWorker, flush, pending } = await fakeWorkers();
  await withWorker(FakeWorker, async () => {
    const time = 1000;
    const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
      worker: true,
      clock: () => time,
    });
    c.setViewport(800, 600);
    assert.equal(
      c.graph.nodes.length,
      0,
      "nothing shown before the first layout",
    );
    assert.equal(c.tick(time).state, "laying out");
    flush();
    await settle();
    assert.equal(c.graph.nodes.length, 50);
    const first = c.graph;

    // Three changes in a row: while their layouts are worked out, the old graph stays.
    c.setGraph(recipes(60, 5));
    c.setGraph(recipes(70, 5));
    c.setGraph(recipes(80, 5));
    assert.equal(c.graph, first);
    assert.equal(pending(), 1, "the worker is given one job at a time");
    flush();
    await settle();
    assert.equal(
      c.graph.nodes.length,
      80,
      "the newest layout was put in place",
    );
    assert.equal(c.layoutPending, false);
    // It's laid out: every node has a home, and they don't all sit in one place.
    const xs = new Set([...c.graph.matrix.homeX].map(Math.round));
    assert.ok(xs.size > 10);
    // Nodes the old graph had glide from where they were.
    for (let i = 0; i < 50; i++) {
      const before = first.byId.get(`n${i}`);
      const now = c.graph.byId.get(`n${i}`);
      assert.equal(now.x, before.x);
    }
    c.destroy();
  });
});

test("quick updates while the worker is busy: only the job running and the newest are worked out", async () => {
  const { FakeWorker, flush, jobs } = await fakeWorkers();
  await withWorker(FakeWorker, async () => {
    const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
      worker: true,
    });
    c.setViewport(800, 600);
    flush();
    await settle();
    const before = jobs();
    for (let k = 1; k <= 10; k++) c.setGraph(recipes(50 + k, 5));
    flush();
    await settle();
    assert.equal(jobs() - before, 2, "the first update's job, then the newest");
    assert.equal(c.graph.nodes.length, 60, "the newest graph is shown");
    assert.equal(c.layoutPending, false);
    // The newest was asked for while the first graph was on screen: laid out with that graph's homes as its hint.
    assert.deepEqual(
      [...c.graph.matrix.homeX],
      homesHere(recipes(50, 5), recipes(60, 5)),
    );
    c.destroy();
  });

  // The layouter on its own: a request that's been replaced resolves to null; the newest to its layout.
  const fake = await fakeWorkers();
  await withWorker(fake.FakeWorker, async () => {
    const layouter = new Layouter({ worker: true });
    const graphs = [40, 50, 60].map((n) => graphOf(recipes(n, 4)));
    const run = (g) => layouter.run(g, "tree", treeOptions, spec(g));
    const runs = graphs.map(run);
    fake.flush();
    const [a, b, c] = await Promise.all(runs);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(c.homeX.length, 60);
    assert.equal(fake.jobs(), 2, "the second request never reached the worker");
    // A layout on the spot (a small graph) replaces the ones still on their way too.
    const running = run(graphs[0]);
    const waiting = run(graphs[1]);
    layouter.mode = "auto";
    assert.ok(!(run(graphs[2]) instanceof Promise));
    assert.equal(await running, null);
    assert.equal(await waiting, null);
    layouter.dispose();
  });
});

test("the structure goes to the worker only when it changes, moved rather than copied; the sizing spec stays the caller's", async () => {
  const { FakeWorker, flush, sent } = await fakeWorkers();
  await withWorker(FakeWorker, async () => {
    const layouter = new Layouter({ worker: true });
    const one = graphOf(recipes(40, 4));
    const two = graphOf(recipes(50, 4));
    const requests = [one, one, two].map((g) => [g, spec(g)]);
    const results = [];
    for (const [graph, sizing] of requests) {
      const result = layouter.run(graph, "tree", treeOptions, sizing);
      flush();
      results.push(await result);
    }
    assert.deepEqual(
      sent.map((m) => [m.version, !!m.structure]),
      [
        [1, true],
        [1, false],
        [2, true],
      ],
    );
    // Moved: the arrays the structure was sent in are left empty here (nothing here uses them again).
    assert.equal(sent[0].structure.from.length, 0);
    assert.equal(sent[0].structure.to.length, 0);
    // The spec was copied: still whole, for the caller to use.
    for (const [graph, sizing] of requests) {
      assert.equal(sizing.widths.length, graph.nodes.length);
      assert.equal(sizing.reach.length, graph.nodes.length);
    }
    // Each result is for the structure it was asked for.
    assert.deepEqual(
      results.map((r) => r.homeX.length),
      [40, 40, 50],
    );
    layouter.dispose();
  });

  // The worker never lays out a structure other than the one a request was for.
  const fake = await fakeWorkers();
  const worker = new fake.FakeWorker();
  const answers = [];
  worker.onmessage = ({ data }) => answers.push(data);
  worker.postMessage({ type: "layout", id: 7, version: 3, layout: "tree" });
  fake.flush();
  assert.deepEqual(answers[0], { id: 7, started: true });
  assert.match(answers[1].error, /no structure for this version/);
});

test("if a worker can't be started, layouts run on the spot (said once) and the view and the model agree", async () => {
  const { FakeWorker } = await fakeWorkers({ throws: "blocked by policy" });
  await withWorker(FakeWorker, async () => {
    const errors = [];
    const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
      worker: true,
      onEvent: (type, detail) => type === "error" && errors.push(detail),
    });
    c.setViewport(800, 600);
    assert.equal(c.graph.nodes.length, 50, "laid out at once");
    c.update({
      addNodes: [{ id: "fresh" }],
      addEdges: [{ source: "n0", target: "fresh" }],
    });
    assert.ok(c.graph.byId.has("fresh"));
    assert.equal(c.layoutPending, false);
    await settle(); // the report comes just after, as an "error" event
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /blocked by policy/);
    c.destroy();

    const reports = [];
    const layouter = new Layouter({
      worker: true,
      onFallback: (m) => reports.push(m),
    });
    const g = graphOf(recipes(40, 4));
    for (let k = 0; k < 3; k++)
      assert.equal(
        layouter.run(g, "tree", treeOptions, spec(g)).homeX.length,
        40,
      );
    await settle();
    assert.equal(reports.length, 1, "reported once");
  });
});

for (const how of ["onerror", "onmessageerror"])
  test(`a worker that fails mid-job (${how}) is given up on, and the layout waiting is worked out on the spot`, async () => {
    const { FakeWorker, workers, flush } = await fakeWorkers();
    const errors = [];
    await withWorker(FakeWorker, async () => {
      const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
        worker: true,
        onEvent: (type, detail) => type === "error" && errors.push(detail),
      });
      c.setViewport(800, 600);
      flush();
      await settle();
      c.setGraph(recipes(70, 5));
      c.setGraph(recipes(80, 5));
      assert.equal(c.graph.nodes.length, 50);
      workers[0][how]({ message: "out of memory" });
      await settle();
      assert.ok(workers[0].terminated);
      assert.equal(c.graph.nodes.length, 80, "the newest layout is in place");
      assert.equal(c.layoutPending, false);
      assert.deepEqual(
        [...c.graph.matrix.homeX],
        homesHere(recipes(50, 5), recipes(80, 5)),
      );
      // From then on, on the spot.
      c.setGraph(recipes(90, 5));
      assert.equal(c.graph.nodes.length, 90);
      assert.equal(workers.length, 1, "no new worker");
      // Said once, as an "error" event; the layout itself didn't fail.
      assert.equal(errors.length, 1);
      assert.match(
        errors[0].message,
        /^layout worker .*page.s thread instead$/,
      );
      c.destroy();
    });
  });

test("a worker that never picks up a job is given up on after the timeout, and the layout is worked out on the spot", async () => {
  const { FakeWorker, workers } = await fakeWorkers();
  await withWorker(FakeWorker, async () => {
    const reports = [];
    const layouter = new Layouter({
      worker: true,
      timeout: 20,
      onFallback: (m) => reports.push(m),
    });
    const g = graphOf(recipes(60, 6));
    const result = await layouter.run(g, "tree", treeOptions, spec(g));
    assert.deepEqual([...result.homeX], [...onTheSpot(recipes(60, 6)).homeX]);
    assert.ok(workers[0].terminated);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /didn't pick up a layout in 20 ms/);
  });
});

test("destroying a controller while a layout is in the worker: the worker stops, and nothing arrives afterwards", async () => {
  const { FakeWorker, workers, flush } = await fakeWorkers();
  await withWorker(FakeWorker, async () => {
    const events = [];
    const c = new GraphController(new GraphModel(recipes(50, 5)), null, {
      worker: true,
      onEvent: (type) => events.push(type),
    });
    c.setViewport(800, 600);
    flush();
    await settle();
    const shown = c.graph;
    c.setGraph(recipes(70, 5));
    events.length = 0;
    c.destroy();
    assert.ok(workers[0].terminated);
    // Even if the stopped worker still answered, its answer would be dropped.
    workers[0].terminated = false;
    workers[0].step();
    await settle();
    assert.equal(c.graph, shown);
    assert.deepEqual(events, []);
  });

  // The layouter on its own: the promise of a layout in the worker never settles, and no timer is left behind.
  const fake = await fakeWorkers();
  await withWorker(fake.FakeWorker, async () => {
    const layouter = new Layouter({ worker: true, timeout: 5 });
    const g = graphOf(recipes(40, 4));
    let settled = false;
    layouter.run(g, "tree", treeOptions, spec(g)).then(
      () => (settled = true),
      () => (settled = true),
    );
    layouter.dispose();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(settled, false);
    assert.equal(layouter.failed, null, "disposing isn't a failure");
  });
});
