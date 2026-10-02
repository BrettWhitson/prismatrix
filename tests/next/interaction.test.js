// The controller's interaction layer, headless: several pointers at once, gestures that survive the graph changing
// under them, taps, selection and focus, the wheel, the camera holding its place, and knowing when a layout has
// landed and the view has settled (at every graph size).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphController } from "../../next/engine/controller.js";
import { GraphModel } from "../../next/engine/model.js";
import { graphFromStructure, runLayout } from "../../next/engine/layout-job.js";

/** root → a, b; a → a1, a2; b → b1 */
const SMALL = {
  nodes: ["root", "a", "b", "a1", "a2", "b1"].map((id) => ({ id })),
  edges: [
    ["root", "a"],
    ["root", "b"],
    ["a", "a1"],
    ["a", "a2"],
    ["b", "b1"],
  ].map(([source, target]) => ({ source, target })),
};

/** A controller on an 800×600 viewport, its clock, its events, and a way to let time pass. */
function setup(graph = SMALL, options = {}) {
  let time = 1000;
  const events = [];
  const c = new GraphController(new GraphModel(graph), null, {
    clock: () => time,
    onEvent: (type, detail) => events.push({ type, detail }),
    ...options,
  });
  c.setViewport(800, 600);
  /** Tick 60 times a second for `ms`; returns the last tick's result. */
  const wait = (ms) => {
    let result;
    const end = time + ms;
    while (time < end) {
      time += 1000 / 60;
      result = c.tick(time);
    }
    return result;
  };
  const of = (type) => events.filter((e) => e.type === type);
  return { c, events, of, wait, now: () => time };
}

const node = (c, id) => c.graph.byId.get(id);
const onScreen = (c, id) => {
  const n = node(c, id);
  return c.toScreen(n.x, n.y);
};
const near = (a, b, tolerance = 0.5) =>
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
/** A point on screen with no node near it. */
const EMPTY = { x: 4, y: 4 };

/** Let promise callbacks run. */
const later = () => new Promise((done) => setImmediate(done));

/**
 * A stand-in for the browser's Worker that runs the same layout job, answering only when `flush` is called (and
 * saying it has started first, as the real one does).
 */
function fakeWorker() {
  const queue = [];
  class FakeWorker {
    postMessage(data) {
      if (data.type !== "layout") return;
      if (data.structure) this.graph = graphFromStructure(data.structure);
      const graph = this.graph;
      queue.push(() => {
        this.onmessage?.({ data: { id: data.id, started: true } });
        const result = runLayout(
          graph,
          data.layout,
          data.options,
          data.sizing,
          data.hint,
        );
        this.onmessage?.({ data: { id: data.id, result } });
      });
    }
    terminate() {
      queue.length = 0;
    }
  }
  return {
    FakeWorker,
    flush: () => {
      while (queue.length) queue.shift()();
    },
  };
}

async function withWorker(body) {
  const fake = fakeWorker();
  globalThis.Worker = fake.FakeWorker;
  try {
    await body(fake);
  } finally {
    delete globalThis.Worker;
  }
}

// ---- several pointers -------------------------------------------------------------------------------------------

for (const physics of ["static", "elastic"])
  test(`a second finger turns a drag into a pinch, and once both lift nothing is held (${physics})`, () => {
    const { c, wait, now, of } = setup(SMALL, { physics });
    wait(1500);
    const a1 = onScreen(c, "a1");
    c.pointerDown({ id: 1, ...a1, time: now(), pointerType: "touch" });
    c.pointerMove({ id: 1, x: a1.x + 30, y: a1.y, time: now() });
    assert.equal(c.sim.held.size, 1);
    c.pointerDown({ id: 2, x: 600, y: 500, time: now(), pointerType: "touch" });
    assert.equal(c.sim.held.size, 0, "the drag ends when the pinch starts");
    assert.ok(c.pinch);
    assert.equal(of("dragEnd").length, 1);
    assert.equal(of("dragEnd")[0].detail.cancelled, true);
    c.pointerUp({ id: 1, time: now() });
    c.pointerUp({ id: 2, time: now() });
    assert.equal(c.pointers.size, 0);
    assert.equal(c.sim.held.size, 0);
    const result = wait(6000);
    assert.equal(result.busy, false, "the view comes to rest");
    assert.equal(result.state, "at rest");
  });

test("a pinch zooms about the fingers' midpoint and pans with it; the finger left down pans on", () => {
  const { c, wait, now, of } = setup();
  wait(1000);
  const k = c.camera.k;
  c.pointerDown({ id: 1, x: 300, y: 300, time: now(), pointerType: "touch" });
  c.pointerDown({ id: 2, x: 500, y: 300, time: now(), pointerType: "touch" });
  const under = c.toWorld(400, 300);
  // Spread from 200 px to 300 px apart, the midpoint moving 50 px right.
  c.pointerMove({ id: 2, x: 600, y: 300, time: now() });
  assert.ok(Math.abs(c.camera.k - k * 1.5) < 1e-9);
  assert.ok(near(c.toWorld(450, 300), under, 1e-9), "the anchor follows");
  assert.equal(c.framed, false);
  assert.equal(c.tick(now() + 16).state, "zooming");
  // One finger lifts: the other pans from where it is, no jump.
  c.pointerUp({ id: 2, time: now() });
  assert.equal(of("pinchStart").length, 1);
  assert.equal(of("pinchEnd").length, 1);
  const camera = { ...c.camera };
  c.pointerMove({ id: 1, x: 320, y: 300, time: now() });
  assert.ok(Math.abs(c.camera.x - (camera.x - 20 / c.camera.k)) < 1e-9);
  c.pointerUp({ id: 1, time: now() });
  assert.equal(of("tap").length, 0, "no finger of a pinch taps");
});

test("a third finger is ignored, and a lost release is cleaned up by the next press", () => {
  const { c, wait, now } = setup();
  wait(1000);
  c.pointerDown({ id: 1, x: 300, y: 300, time: now() });
  c.pointerDown({ id: 2, x: 500, y: 300, time: now() });
  const camera = { ...c.camera };
  c.pointerDown({ id: 3, x: 100, y: 100, time: now() });
  c.pointerMove({ id: 3, x: 200, y: 200, time: now() });
  assert.deepEqual(c.camera, camera);
  for (const id of [1, 2, 3]) c.pointerUp({ id, time: now() });
  // A press whose release never came (the window lost focus): the same id pressing again starts afresh.
  const b1 = onScreen(c, "b1");
  c.pointerDown({ id: 4, ...b1, time: now() });
  c.pointerDown({ id: 4, ...b1, time: now() });
  assert.equal(c.pointers.size, 1);
  assert.equal(c.sim.held.size, 1);
  c.pointerCancel({ id: 4, time: now() });
  assert.equal(c.sim.held.size, 0);
  assert.equal(wait(3000).busy, false);
});

test("reset lets go of a node being dragged", () => {
  const { c, wait, now } = setup(SMALL, { physics: "elastic" });
  wait(1500);
  const a1 = onScreen(c, "a1");
  c.pointerDown({ ...a1, time: now() });
  c.pointerMove({ x: a1.x + 40, y: a1.y + 40, time: now() });
  c.reset();
  assert.equal(c.sim.held.size, 0);
  wait(3000);
  assert.ok(near(onScreen(c, "a1"), a1, 1));
});

// ---- gestures across graph changes -----------------------------------------------------------------------------

test("a structural update mid-drag keeps the drag: the same node stays under the pointer, and one dragEnd", () => {
  const { c, wait, now, of } = setup(SMALL, { physics: "elastic" });
  wait(1500);
  // The view is framed: a layout landing under a drag mustn't frame again and move the drawing under the pointer.
  const s = onScreen(c, "a1");
  c.pointerDown({ ...s, time: now() });
  c.pointerMove({ x: s.x + 50, y: s.y, time: now() });
  wait(100);
  c.update({
    addNodes: [{ id: "new" }],
    addEdges: [{ source: "b", target: "new" }],
  });
  assert.ok(c.pointer, "the press carries on");
  assert.ok(c.sim.held.has(node(c, "a1").index), "held, at its new row");
  c.pointerMove({ x: s.x + 100, y: s.y, time: now() });
  wait(300);
  assert.ok(near(onScreen(c, "a1"), { x: s.x + 100, y: s.y }, 1));
  c.pointerUp({ time: now() });
  assert.equal(of("dragStart").length, 1);
  assert.equal(of("dragEnd").length, 1);
  assert.equal(of("dragEnd")[0].detail.node, "a1");
  assert.equal(wait(6000).busy, false);
});

test("a pan carries on through a structural update, and hover and shading are kept by id", () => {
  const { c, wait, now } = setup();
  wait(1000);
  c.pointerMove(onScreen(c, "a1"));
  wait(1000);
  const b = node(c, "b").index;
  assert.equal(c.shade[b], 0);
  c.update({
    addNodes: [{ id: "z" }],
    addEdges: [{ source: "b1", target: "z" }],
  });
  assert.equal(c.hover, node(c, "a1").index, "hover kept");
  assert.equal(c.shade[node(c, "b").index], 0, "no flash: shading kept");
  c.pointerLeave();

  c.pointerDown({ ...EMPTY, time: now() });
  c.pointerMove({ x: EMPTY.x + 20, y: EMPTY.y, time: now() });
  c.update({ addNodes: [{ id: "y" }] });
  const camera = { ...c.camera };
  c.pointerMove({ x: EMPTY.x + 40, y: EMPTY.y, time: now() });
  assert.ok(c.pointer, "still panning");
  assert.ok(Math.abs(c.camera.x - (camera.x - 20 / c.camera.k)) < 1e-6);
  c.pointerUp({ time: now() });
});

test("when the node being dragged is removed, its drag ends (cancelled) and the pointer pans on", () => {
  const { c, wait, now, of } = setup();
  wait(1000);
  const s = onScreen(c, "b1");
  c.pointerDown({ ...s, time: now() });
  c.pointerMove({ x: s.x + 30, y: s.y, time: now() });
  c.update({ removeNodes: ["b1"] });
  assert.equal(of("dragEnd").length, 1);
  assert.equal(of("dragEnd")[0].detail.cancelled, true);
  assert.equal(c.sim.held.size, 0);
  assert.equal(c.pointer.role, "pan");
  c.pointerUp({ time: now() });
  assert.equal(wait(3000).busy, false);
});

// ---- taps, selection, hover events, focus ---------------------------------------------------------------------

test("a tap selects the node under it (with its id, and screen and world points); empty space clears", () => {
  const { c, wait, now, of } = setup();
  wait(1000);
  const s = onScreen(c, "a1");
  c.pointerDown({ ...s, time: now() });
  c.pointerUp({ ...s, time: now() + 50 });
  const tap = of("tap")[0].detail;
  assert.equal(tap.node, "a1");
  assert.ok(near(tap, s, 1e-9));
  assert.ok(near(tap.world, node(c, "a1"), 6));
  assert.deepEqual(c.selected, ["a1"]);
  assert.deepEqual(of("select").at(-1).detail.selected, ["a1"]);
  assert.equal(of("dragStart").length, 0, "a tap isn't a drag");
  // Shift adds; shift again on the same node removes it.
  const b = onScreen(c, "b");
  wait(500);
  c.pointerDown({ ...b, time: now(), shiftKey: true });
  c.pointerUp({ ...b, time: now() });
  assert.deepEqual(c.selected, ["a1", "b"]);
  wait(500);
  c.pointerDown({ ...b, time: now(), metaKey: true });
  c.pointerUp({ ...b, time: now() });
  assert.deepEqual(c.selected, ["a1"]);
  // The scene carries it for painters, and with nothing hovered it lights the selection's lineage.
  c.tick(now() + 16);
  assert.equal(c.scene.selected[node(c, "a1").index], 1);
  assert.equal(c.scene.selected[node(c, "b").index], 0);
  wait(1000);
  assert.equal(c.shade[node(c, "b1").index], 0);
  assert.equal(c.shade[node(c, "a").index], 1);
  wait(500);
  c.pointerDown({ ...EMPTY, time: now() });
  c.pointerUp({ ...EMPTY, time: now() });
  assert.deepEqual(c.selected, []);
  assert.equal(of("tap").at(-1).detail.node, null);
  c.tick(now() + 16);
  assert.equal(c.scene.selected, null);
});

test("a press that wanders is a drag or pan, not a tap; a long press is a long press, not a tap", () => {
  const { c, wait, now, of } = setup();
  wait(1000);
  const s = onScreen(c, "a1");
  c.pointerDown({ ...s, time: now(), pointerType: "touch" });
  c.pointerMove({ x: s.x + 6, y: s.y, time: now() }); // inside a finger's slop
  assert.equal(of("dragStart").length, 0);
  c.pointerMove({ x: s.x + 30, y: s.y, time: now() });
  assert.equal(of("dragStart").length, 1);
  c.pointerUp({ time: now() });
  assert.equal(of("tap").length, 0);

  const b = onScreen(c, "b");
  c.pointerDown({ ...b, time: now(), pointerType: "touch" });
  wait(600);
  assert.equal(of("longPress").length, 1);
  assert.equal(of("longPress")[0].detail.node, "b");
  c.pointerUp({ time: now() });
  assert.equal(of("tap").length, 0);
  assert.equal(of("longPress").length, 1, "said once");
});

test("a double tap on empty space frames the graph; on a node it's reported", () => {
  const { c, wait, now, of } = setup();
  wait(1000);
  c.wheel({ x: 400, y: 300, deltaY: 300 });
  assert.equal(c.framed, false);
  for (const dt of [0, 120]) {
    c.pointerDown({ ...EMPTY, time: now() + dt });
    c.pointerUp({ ...EMPTY, time: now() + dt + 30 });
  }
  assert.equal(of("doubleTap").length, 1);
  assert.equal(c.framed, true);
  wait(1000);
  const s = onScreen(c, "a");
  for (const dt of [0, 150]) {
    c.pointerDown({ ...s, time: now() + dt });
    c.pointerUp({ ...s, time: now() + dt + 30 });
  }
  assert.equal(of("doubleTap").at(-1).detail.node, "a");
  // Too slow is two taps.
  wait(1000);
  for (const dt of [0, 500]) {
    c.pointerDown({ ...s, time: now() + dt });
    c.pointerUp({ ...s, time: now() + dt + 30 });
  }
  assert.equal(of("doubleTap").length, 2);
});

test("hover enter and leave are reported with node ids; listeners can come and go, and a throwing one is contained", (t) => {
  const { c, wait } = setup();
  wait(1000);
  const heard = [];
  const off = c.on("hoverEnter", ({ node }) => heard.push(node));
  const error = t.mock.method(console, "error", () => {});
  c.on("hoverLeave", () => {
    throw new Error("an app bug");
  });
  c.pointerMove(onScreen(c, "a"));
  c.pointerMove(onScreen(c, "b"));
  assert.deepEqual(heard, ["a", "b"]);
  assert.equal(error.mock.callCount(), 1, "reported");
  assert.equal(c.hover, node(c, "b").index, "and the hover still moved");
  off();
  c.pointerMove(onScreen(c, "a"));
  assert.deepEqual(heard, ["a", "b"]);
  c.pointerLeave();
  assert.equal(c.hover, -1);
});

test("select() by id: replace, add, toggle; unknown ids are skipped; removed nodes leave the selection", () => {
  const { c, of } = setup();
  assert.equal(c.select(["a", "nope"]), true);
  assert.deepEqual(c.selected, ["a"]);
  assert.equal(c.select("a"), false, "no change, no event");
  c.select("b", { add: true });
  c.select(["a", "b1"], { toggle: true });
  assert.deepEqual(c.selected, ["b", "b1"]);
  const sent = of("select").length;
  c.update({ removeNodes: ["b1"] });
  assert.deepEqual(c.selected, ["b"]);
  assert.equal(of("select").length, sent + 1);
  c.select(null);
  assert.deepEqual(c.selected, []);
});

test("focus(id) glides the camera to a node, zoomed in enough to read it", () => {
  const { c, wait } = setup();
  wait(1000);
  c.wheel({ x: 400, y: 300, deltaY: 900 }); // zoomed well out
  assert.equal(c.focus("nope"), false);
  assert.equal(c.focus("a2"), true);
  wait(c.anim.camera / 2);
  assert.ok(!near(onScreen(c, "a2"), { x: 400, y: 300 }, 1), "on its way");
  wait(c.anim.camera);
  assert.ok(near(onScreen(c, "a2"), { x: 400, y: 300 }, 1e-6));
  assert.equal(c.camera.k, 1);
  c.focus("b", { zoom: 3, animate: false });
  assert.equal(c.camera.k, 3);
  assert.ok(near(onScreen(c, "b"), { x: 400, y: 300 }, 1e-6));
});

// ---- the wheel ------------------------------------------------------------------------------------------------

test("the wheel zooms the same in every browser: lines and pages are turned into pixels", () => {
  const { c, wait } = setup();
  wait(1000);
  const zoomBy = (input) => {
    const k = c.camera.k;
    c.wheel({ x: 400, y: 300, time: 0, ...input });
    const step = c.camera.k / k;
    c.camera.k = k;
    return step;
  };
  const pixels = zoomBy({ deltaY: 99 });
  assert.ok(pixels < 1);
  assert.ok(Math.abs(zoomBy({ deltaY: 3, deltaMode: 1 }) - pixels) < 1e-9);
  assert.ok(zoomBy({ deltaY: 1, deltaMode: 2 }) < pixels, "a page is a lot");
});

test("a trackpad's two-finger scroll pans and its pinch (ctrl+wheel) zooms; the wheel option can force either", () => {
  const { c, wait } = setup();
  wait(1000);
  const camera = { ...c.camera };
  // A trackpad: wheelDeltaY is exactly -3 × deltaY.
  c.wheel({ x: 400, y: 300, deltaY: 10, wheelDeltaY: -30, time: 0 });
  assert.equal(c.camera.k, camera.k);
  assert.ok(Math.abs(c.camera.y - (camera.y + 10 / camera.k)) < 1e-9);
  // Later events of the same gesture pan too, whatever they look like.
  c.wheel({ x: 400, y: 300, deltaY: 120, wheelDeltaY: -120, time: 50 });
  assert.equal(c.camera.k, camera.k);
  c.wheel({ x: 400, y: 300, deltaX: 25, time: 400 });
  assert.equal(c.camera.k, camera.k, "sideways pans");
  c.wheel({ x: 400, y: 300, deltaY: 4, ctrlKey: true, time: 800 });
  assert.ok(c.camera.k < camera.k, "a pinch zooms");
  // A mouse wheel notch (multiples of 120) zooms.
  const k = c.camera.k;
  c.wheel({ x: 400, y: 300, deltaY: 100, wheelDeltaY: -120, time: 1200 });
  assert.ok(c.camera.k < k);
  c.wheelMode = "pan";
  const k2 = c.camera.k;
  c.wheel({ x: 400, y: 300, deltaY: 100, wheelDeltaY: -120, time: 1600 });
  assert.equal(c.camera.k, k2);
});

// ---- the camera ------------------------------------------------------------------------------------------------

/** A root with `count` leaves: very wide, one level deep. */
const wide = (count) => ({
  nodes: [
    { id: "r" },
    ...Array.from({ length: count }, (_, i) => ({ id: `l${i}` })),
  ],
  edges: Array.from({ length: count }, (_, i) => ({
    source: "r",
    target: `l${i}`,
  })),
});

test("Fit frames a graph however wide it is, and the zoom can reach that far out", () => {
  const { c, wait } = setup(wide(2500), { worker: false });
  wait(1500);
  assert.ok(c.camera.k < 0.05, `fit at ${c.camera.k}`);
  const m = c.graph.matrix;
  for (let i = 0; i < m.count; i++) {
    const a = c.toScreen(m.x[i] + m.boxX0[i], m.y[i] + m.boxY0[i]);
    const b = c.toScreen(m.x[i] + m.boxX1[i], m.y[i] + m.boxY1[i]);
    assert.ok(a.x >= 0 && b.x <= 800 && a.y >= 0 && b.y <= 600, `node ${i}`);
  }
  assert.ok(c.zoomLimits().min <= c.camera.k / 2);
  const fit = c.camera.k;
  c.wheel({ x: 400, y: 300, deltaY: 50 });
  assert.ok(c.camera.k < fit, "the wheel can zoom out past the old floor");
});

test("on a structural change the camera holds its place: a selected node stays put on screen, all through the morph", () => {
  const { c, wait } = setup();
  wait(1000);
  c.wheel({ x: 400, y: 300, deltaY: -100 }); // the user's own view
  c.select("b1");
  const before = onScreen(c, "b1");
  const home = { x: node(c, "b1").homeX, y: node(c, "b1").homeY };
  c.update({
    addNodes: ["x1", "x2", "x3", "x4"].map((id) => ({ id })),
    addEdges: ["x1", "x2", "x3", "x4"].map((id) => ({
      source: "a",
      target: id,
    })),
  });
  const moved = Math.hypot(
    node(c, "b1").homeX - home.x,
    node(c, "b1").homeY - home.y,
  );
  assert.ok(moved > 5, `its home moved ${moved} px`);
  wait(c.anim.transition / 3);
  assert.ok(near(onScreen(c, "b1"), before, 0.5), "mid-morph");
  wait(c.anim.transition);
  assert.ok(near(onScreen(c, "b1"), before, 1e-6), "at the end");
  assert.equal(c.shift, null);
});

test("with nothing hovered or selected, the node nearest the middle of the view holds still", () => {
  const { c, wait } = setup();
  wait(1000);
  const a = onScreen(c, "a");
  c.pointerDown({ ...a, time: 0 }); // pan so that "a" is in the middle
  c.pointerMove({ x: 400, y: 300, time: 0 });
  c.pointerUp({ time: 5000 });
  c.wheel({ x: 400, y: 300, deltaY: -150 });
  c.update({
    addNodes: [{ id: "b2" }, { id: "b3" }, { id: "b4" }],
    addEdges: ["b2", "b3", "b4"].map((id) => ({ source: "b", target: id })),
  });
  wait(c.anim.transition + 100);
  assert.ok(near(onScreen(c, "a"), { x: 400, y: 300 }, 1e-6));
});

test("a framed view frames the new layout instead", () => {
  const { c, wait } = setup();
  wait(1000);
  assert.ok(c.framed);
  c.update({
    addNodes: ["x1", "x2", "x3", "x4"].map((id) => ({ id })),
    addEdges: ["x1", "x2", "x3", "x4"].map((id) => ({
      source: "a",
      target: id,
    })),
  });
  assert.ok(c.cameraTween);
  assert.equal(c.shift, null);
});

// ---- layouts landing and the view settling ---------------------------------------------------------------------

test("small graphs: laidOut() resolves at once, settled() once the morph is done, with a settled event", async () => {
  const { c, wait, of } = setup();
  wait(2000);
  assert.equal(of("settled").length, 1);
  c.update({
    addNodes: [{ id: "n" }],
    addEdges: [{ source: "a", target: "n" }],
  });
  let laid = false,
    settled = false;
  c.laidOut().then(() => (laid = true));
  c.settled().then(() => (settled = true));
  await later();
  assert.ok(laid);
  assert.ok(node(c, "n"));
  assert.equal(of("laidOut").at(-1).detail.nodes, 7);
  assert.equal(settled, false);
  wait(c.anim.transition / 2);
  await later();
  assert.equal(settled, false, "not mid-morph");
  wait(c.anim.transition + 1000);
  await later();
  assert.ok(settled);
  assert.equal(of("settled").length, 2);
  // Already settled: at once.
  let again = false;
  c.settled().then(() => (again = true));
  await later();
  assert.ok(again);
});

test("big graphs (worker): laidOut() waits for the worker; settled() for the morph after it; fit() asked meanwhile frames what arrives", async () => {
  await withWorker(async ({ flush }) => {
    const { c, wait, of } = setup(wide(40), { worker: true });
    assert.equal(c.graph.nodes.length, 0);
    let laid = false;
    c.laidOut().then(() => (laid = true));
    await later();
    assert.equal(laid, false);
    flush();
    await later();
    assert.ok(laid);
    assert.equal(c.graph.nodes.length, 41);
    wait(2000);
    // The user zooms in, then asks for Fit while a bigger graph is on its way.
    c.wheel({ x: 400, y: 300, deltaY: -600 });
    c.setGraph(wide(400));
    assert.ok(c.layoutPending);
    let settled = false;
    c.settled().then(() => (settled = true));
    c.fit();
    wait(1000);
    await later();
    assert.equal(settled, false, "the layout isn't in yet");
    assert.equal(c.graph.nodes.length, 41);
    flush();
    await later();
    assert.equal(c.graph.nodes.length, 401);
    assert.ok(c.cameraTween, "framing the new layout");
    wait(3000);
    await later();
    assert.ok(settled);
    const box = c.homeBox;
    const a = c.toScreen(box.minX, box.minY),
      b = c.toScreen(box.maxX, box.maxY);
    assert.ok(a.x >= 0 && b.x <= 800 && a.y >= 0 && b.y <= 600);
    assert.ok(of("laidOut").length >= 2);
    c.destroy();
  });
});

test("focus(id) on a node still being laid out focuses it once it's in place", async () => {
  await withWorker(async ({ flush }) => {
    const { c, wait } = setup(wide(10), { worker: true });
    flush();
    await later();
    wait(1000);
    c.update({
      addNodes: [{ id: "late" }],
      addEdges: [{ source: "l3", target: "late" }],
    });
    assert.equal(c.focus("late"), true);
    flush();
    await later();
    wait(2000);
    assert.ok(near(onScreen(c, "late"), { x: 400, y: 300 }, 1e-6));
    c.destroy();
  });
});

// ---- settings ------------------------------------------------------------------------------------------------

test("setPhysics with a mode the layout doesn't offer throws and changes nothing", () => {
  const { c } = setup();
  c.setPhysics("elastic", { friction: 3 });
  assert.throws(() => c.setPhysics("floating"), /no "floating" physics/);
  assert.equal(c.mode, "elastic");
  assert.equal(c.sim.mode, "elastic");
  assert.equal(c.snapshot().settings.physics, "elastic");
  assert.equal(c.modeOpts.friction, 3);
});

test("settings merge: what's given changes, the rest stays (a new layout or mode starts from its defaults)", () => {
  const { c } = setup();
  c.setLayout("tree", { direction: "LR", levelGap: 150 });
  c.setLayout("tree", { levelGap: 200 });
  assert.equal(c.layoutOpts.direction, "LR");
  assert.equal(c.layoutOpts.levelGap, 200);
  c.setAnimation({ transition: 100 });
  c.setAnimation({ easing: "linear" });
  assert.equal(c.anim.transition, 100);
  assert.equal(c.anim.easing, "linear");
  c.setPhysics("elastic", { friction: 3 });
  c.setPhysics(null, { anchor: 50 });
  assert.equal(c.mode, "elastic");
  assert.equal(c.modeOpts.friction, 3);
  assert.equal(c.modeOpts.anchor, 50);
  c.setLayout("radial");
  assert.equal(c.layoutOpts.direction, undefined, "radial's own options");
});

// ---- time ------------------------------------------------------------------------------------------------------

test("a frame stamped before a morph started doesn't move nodes backwards; simMs is time spent, not the clock", () => {
  const { c, wait, now } = setup();
  wait(1000);
  c.setLayout("tree", { direction: "LR" });
  const start = c.graph.nodes.map((n) => [n.x, n.y]);
  const result = c.tick(now() - 50);
  c.graph.nodes.forEach((n, i) => assert.deepEqual([n.x, n.y], start[i]));
  assert.ok(result.simMs >= 0 && result.simMs < 500, `${result.simMs}`);
  assert.ok(c.tick(5).simMs < 500, "a test clock far from performance.now()");
});

test("new nodes find where to grow from in one pass: a long new chain costs about what fading it in does", () => {
  const chain = (length) => ({
    nodes: Array.from({ length }, (_, i) => ({ id: `c${i}` })),
    edges: Array.from({ length: length - 1 }, (_, i) => ({
      source: `c${i}`,
      target: `c${i + 1}`,
    })),
  });
  const time = (enter) => {
    const { c } = setup(chain(2), { worker: false });
    c.setAnimation({ enter });
    const t0 = performance.now();
    c.setGraph(chain(12_000));
    const ms = performance.now() - t0;
    return { c, ms };
  };
  const fade = time("fade");
  const grow = time("grow");
  assert.ok(
    grow.ms < fade.ms * 3 + 150,
    `grow ${grow.ms} ms, fade ${fade.ms} ms`,
  );
  // Every new node starts where its nearest kept ancestor (c1) was.
  const { c } = grow;
  const c1 = c.tween;
  const at = node(c, "c1").index;
  for (const id of ["c2", "c500", "c11999"]) {
    const i = node(c, id).index;
    assert.deepEqual([c1.x[i], c1.y[i]], [c1.x[at], c1.y[at]], id);
  }
});

// ---- model changes that move nothing ----------------------------------------------------------------------------

test("a data-only change patches the records it touched: no frame, no rebuild, a graphData event", () => {
  let frames = 0;
  const { c, wait, of } = setup(SMALL, { onChange: () => frames++ });
  wait(1000);
  const before = {
    version: c.version,
    geometry: c.geometryVersion,
    looks: c.looks,
    routing: c.routing,
    b: node(c, "b").record,
  };
  frames = 0;
  c.update({ changeNodes: [{ id: "a", data: { price: 12 } }] });
  assert.equal(node(c, "a").data.price, 12);
  assert.equal(node(c, "b").record, before.b, "untouched records stay");
  assert.equal(c.version, before.version);
  assert.equal(c.geometryVersion, before.geometry);
  assert.equal(c.looks, before.looks);
  assert.equal(c.routing, before.routing);
  assert.equal(frames, 0, "no frame asked for");
  assert.deepEqual(of("graphData").at(-1).detail, { nodes: 1, edges: 0 });
  c.update({ changeEdges: [{ id: "a>a1", data: { count: 3 } }] });
  assert.equal(c.graph.edges[c.model.edgeIndex.get("a>a1")].data.count, 3);
  // A colour is drawn: a restyle, with the record patched the same way.
  c.update({ changeNodes: [{ id: "b", style: { color: "#ff0000" } }] });
  assert.equal(c.looks.fill[node(c, "b").index], "#ff0000");
  assert.equal(of("graphRestyle").length, 1);
});

test("the graph event's stats are only worked out if a listener reads them", (t) => {
  const { c, of } = setup();
  const stats = t.mock.method(c.model, "stats");
  c.update({
    addNodes: [{ id: "z" }],
    addEdges: [{ source: "b", target: "z" }],
  });
  const detail = of("graph").at(-1).detail;
  assert.deepEqual(
    { nodes: detail.nodes, edges: detail.edges, added: detail.added },
    { nodes: 7, edges: 6, added: 1 },
  );
  assert.equal(stats.mock.callCount(), 0);
  assert.equal(detail.stats.roots, 1);
  assert.equal(detail.stats.nodes, 7);
  detail.stats;
  assert.equal(stats.mock.callCount(), 1, "once");
});

test("frames at rest (hover fades) don't step a sleeping simulation; a release wakes it", (t) => {
  const { c, wait, now } = setup(SMALL, { physics: "elastic" });
  wait(3000);
  assert.ok(c.sim.asleep);
  const advance = t.mock.method(c.sim, "advance");
  c.pointerMove(onScreen(c, "a1"));
  assert.equal(wait(500).busy, false);
  assert.equal(advance.mock.callCount(), 0);
  const s = onScreen(c, "b1");
  c.pointerDown({ ...s, time: now() });
  c.pointerMove({ x: s.x + 40, y: s.y, time: now() });
  c.pointerUp({ time: now() + 500 });
  wait(100);
  assert.ok(advance.mock.callCount() > 0);
});
