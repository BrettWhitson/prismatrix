// The controller without a screen: interaction, morphs, hover and snapshots, driven on a clock of our own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphController } from "../../next/engine/controller.js";
import { GraphModel } from "../../next/engine/model.js";

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

/** A controller on an 800×600 viewport, its clock, and a way to let time pass. */
function setup(graph = SMALL) {
  let time = 1000;
  const events = [];
  const c = new GraphController(new GraphModel(graph), null, {
    clock: () => time,
    onEvent: (type, detail) => events.push({ type, detail }),
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
  return { c, events, wait, now: () => time };
}

const node = (c, id) => c.graph.byId.get(id);
const onScreen = (c, id) => {
  const n = node(c, id);
  return c.toScreen(n.x, n.y);
};
const near = (a, b, tolerance = 0.5) =>
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

test("a first graph grows into its layout, framed, and comes to rest", () => {
  const { c, wait, events } = setup();
  assert.ok(c.framed);
  const result = wait(3000);
  assert.equal(result.busy, false);
  assert.equal(result.state, "at rest");
  for (const n of c.graph.nodes)
    assert.ok(near(n, { x: n.homeX, y: n.homeY }), n.id);
  // Everything is inside the viewport.
  for (const n of c.graph.nodes) {
    const p = c.toScreen(n.x, n.y);
    assert.ok(p.x > 0 && p.x < 800 && p.y > 0 && p.y < 600, n.id);
  }
  assert.equal(events.find((e) => e.type === "graph").detail.nodes, 6);
});

test("toWorld and toScreen undo each other", () => {
  const { c, wait } = setup();
  wait(1000);
  const w = c.toWorld(123, 456);
  const s = c.toScreen(w.x, w.y);
  assert.ok(near(s, { x: 123, y: 456 }, 1e-9));
});

test("dragging a node in static mode carries its subtree, and it stays where it's put", () => {
  const { c, wait, now, events } = setup();
  wait(1000);
  const before = {
    a: onScreen(c, "a"),
    a1: onScreen(c, "a1"),
    b: onScreen(c, "b"),
  };
  c.pointerDown({ ...before.a, time: now() });
  assert.equal(c.cursor, "grabbing");
  for (let i = 1; i <= 10; i++) {
    c.pointerMove({
      x: before.a.x + i * 5,
      y: before.a.y + i * 3,
      time: now(),
    });
    wait(16);
  }
  wait(200); // stop before letting go: no throw
  c.pointerUp({ time: now() });
  wait(2000);
  assert.ok(
    near(onScreen(c, "a"), { x: before.a.x + 50, y: before.a.y + 30 }, 1),
  );
  assert.ok(
    near(onScreen(c, "a1"), { x: before.a1.x + 50, y: before.a1.y + 30 }, 1),
  );
  assert.ok(
    near(onScreen(c, "b"), before.b, 1),
    "nodes outside the subtree don't move",
  );
  const end = events.find((e) => e.type === "dragEnd").detail;
  assert.equal(end.node, "a");
  assert.equal(end.thrown, false);
});

test("in elastic mode a dragged node springs back home after it's let go", () => {
  const { c, wait, now } = setup();
  c.setPhysics("elastic");
  wait(1500);
  const home = onScreen(c, "a1");
  c.pointerDown({ ...home, time: now() });
  // Straight down: dragged sideways past its sibling, collision would keep the two swapped.
  c.pointerMove({ x: home.x, y: home.y + 120, time: now() });
  wait(300);
  assert.ok(onScreen(c, "a1").y > home.y + 100, "it follows the pointer");
  c.pointerUp({ time: now() });
  const result = wait(6000);
  assert.ok(near(onScreen(c, "a1"), home, 2));
  assert.equal(result.busy, false);
});

test("a fast release throws the node in static mode", () => {
  const { c, wait, now } = setup();
  wait(1000);
  const start = onScreen(c, "b1");
  c.pointerDown({ ...start, time: now() });
  for (let i = 1; i <= 5; i++) {
    wait(16);
    c.pointerMove({ x: start.x + i * 20, y: start.y, time: now() });
  }
  c.pointerUp({ time: now() });
  const released = onScreen(c, "b1").x;
  wait(3000);
  assert.ok(onScreen(c, "b1").x > released + 10, "it glides on after release");
});

test("hovering a node dims everything outside its lineage, easing in", () => {
  const { c, wait } = setup();
  wait(1000);
  c.pointerMove(onScreen(c, "a1"));
  assert.equal(c.hover, node(c, "a1").index);
  assert.equal(c.cursor, "grab");
  wait(16);
  const b = node(c, "b").index;
  assert.ok(c.shade[b] > 0 && c.shade[b] < 1, "part way after one frame");
  wait(1000);
  assert.equal(c.shade[b], 0);
  for (const id of ["root", "a", "a1"])
    assert.equal(c.shade[node(c, id).index], 1, id);
  c.pointerLeave();
  wait(1000);
  assert.equal(c.shade[b], 1);
});

test("a changed graph morphs: kept nodes glide, new ones grow from their parent, removed ones fold away", () => {
  const { c, wait, now } = setup();
  wait(1000);
  const a = { x: node(c, "a").x, y: node(c, "a").y };
  c.setGraph({
    nodes: [...SMALL.nodes.filter((n) => n.id !== "b1"), { id: "a3" }],
    edges: [
      ...SMALL.edges.filter((e) => e.target !== "b1"),
      { source: "a", target: "a3" },
    ],
  });
  // The new node starts on its parent; the removed one is a ghost.
  assert.ok(near(node(c, "a3"), a));
  assert.equal(c.ghosts.length, 1);
  assert.equal(c.ghosts[0].id, "b1");
  c.tick(now() + 16);
  assert.equal(
    c.scene.graph.nodes.length,
    7,
    "the ghost is drawn with the rest",
  );
  wait(c.anim.transition + 100);
  assert.equal(c.ghosts.length, 0);
  assert.equal(c.scene.graph.nodes.length, 6);
  const a3 = node(c, "a3");
  assert.ok(near(a3, { x: a3.homeX, y: a3.homeY }));
});

test("a radial morph keeps nodes on their way round the rings", () => {
  const { c, wait, now } = setup();
  wait(1000);
  c.setLayout("radial");
  const { cx, cy } = c.routing;
  const leaf = node(c, "a1");
  const r0 = Math.hypot(leaf.x - cx, leaf.y - cy);
  const r1 = Math.hypot(leaf.homeX - cx, leaf.homeY - cy);
  c.tick(now() + c.anim.transition / 2);
  const mid = Math.hypot(leaf.x - cx, leaf.y - cy);
  assert.ok(mid >= Math.min(r0, r1) - 1 && mid <= Math.max(r0, r1) + 1);
  wait(c.anim.transition + 100);
  assert.ok(near(leaf, { x: leaf.homeX, y: leaf.homeY }));
});

test("the wheel zooms about the pointer; panning moves the camera and lets it glide", () => {
  const { c, wait, now } = setup();
  wait(1000);
  const under = c.toWorld(300, 200);
  const k = c.camera.k;
  c.wheel({ x: 300, y: 200, deltaY: -200 });
  assert.ok(c.camera.k > k);
  assert.ok(near(c.toWorld(300, 200), under, 1e-9));
  assert.equal(c.framed, false);

  // A pan from empty space (the corner).
  const camera = { ...c.camera };
  c.pointerDown({ x: 2, y: 2, time: now() });
  for (let i = 1; i <= 5; i++) {
    wait(16);
    c.pointerMove({ x: 2 + i * 10, y: 2, time: now() });
  }
  const dragged = c.camera.x;
  assert.ok(
    near(
      { x: dragged, y: c.camera.y },
      { x: camera.x - 50 / c.camera.k, y: camera.y },
      1e-6,
    ),
  );
  c.pointerUp({ time: now() });
  wait(2000);
  assert.ok(c.camera.x < dragged, "the camera coasts on after a flick");
  // A double-click on empty space frames the graph again.
  c.doubleClick({ x: 2, y: 2 });
  assert.equal(c.framed, true);
});

test("each element's style reaches the scene", () => {
  const { c, wait } = setup({
    nodes: [
      { id: "r", style: { color: "#ff0000", size: 40, shape: "diamond" } },
      { id: "x" },
    ],
    edges: [
      { source: "r", target: "x", style: { color: "#00ff00", width: 6 } },
    ],
  });
  wait(100);
  const { looks } = c.scene;
  assert.equal(looks.fill[0], "#ff0000");
  assert.equal(looks.radius[0], 20);
  assert.equal(looks.shape[0], "diamond");
  assert.equal(looks.shape[1], c.node.shape);
  assert.equal(looks.edgeColour[0], "#00ff00");
  assert.equal(looks.edgeWidth[0], 6);
  // View options change what isn't overridden, and keep what is.
  c.setEdgeStyle({ ...c.edge, width: 3 });
  assert.equal(c.looks.edgeWidth[0], 6);
});

test("a snapshot restores the same graph, settings, camera and positions", () => {
  const { c, wait } = setup();
  c.setLayout("radial");
  c.setPhysics("floating");
  wait(1500);
  c.wheel({ x: 400, y: 300, deltaY: 120 });
  const snap = c.snapshot("test");

  const other = setup({ nodes: [{ id: "lonely" }], edges: [] });
  other.c.restore(snap);
  assert.equal(other.c.layout, "radial");
  assert.equal(other.c.mode, "floating");
  assert.ok(near(other.c.camera, c.camera, 0.01));
  assert.equal(other.c.camera.k, c.camera.k);
  assert.equal(other.c.graph.nodes.length, 6);
  for (const n of c.graph.nodes)
    assert.ok(near(node(other.c, n.id), n, 0.01), n.id);
});

test("references are drawn as chips that follow their source, and pointing at one lights its ingredient", () => {
  // root, a and d all use hub. root → hub is its tree edge (found first) and d → hub is short, so only a → hub,
  // four layers long, gets a reference.
  const nodes = ["root", "a", "b", "c", "d", "hub"].map((id) => ({ id }));
  const edges = [
    ["root", "a"],
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
    ["d", "hub"],
    ["root", "hub"],
    ["a", "hub"],
  ].map(([source, target]) => ({ source, target }));
  const { c, wait, now } = setup({ nodes, edges });
  c.setLayout("merged", { references: "hubs", shareMin: 3 });
  wait(1500);
  const refs = c.routing.references;
  assert.equal(refs.length, 1);
  assert.equal(c.scene.graph.nodes.length, 6 + 1);
  const chip = c.scene.graph.nodes[6];
  assert.equal(c.scene.looks.shape[6], "ring");
  assert.equal(c.scene.graph.nodes[chip.parent].id, "a");
  // The referenced edge ends at the chip, at the same index.
  const ei = c.graph.edges.indexOf(refs[0].edge);
  assert.equal(c.scene.graph.edges[ei].target, 6);

  // Drag the chip's source: the chip moves with it.
  const source = c.graph.nodes[refs[0].source];
  const before = { x: chip.x, y: chip.y };
  const at = c.toScreen(source.x, source.y);
  c.pointerDown({ ...at, time: now() });
  c.pointerMove({ x: at.x + 40, y: at.y, time: now() });
  wait(300);
  c.pointerUp({ time: now() });
  wait(50);
  const moved = c.scene.graph.nodes[6];
  assert.ok(Math.abs(moved.x - before.x - (source.x - source.homeX)) < 1);

  // Pointing at a chip lights up its ingredient.
  c.pointerMove(c.toScreen(moved.x, moved.y));
  assert.equal(c.graph.nodes[c.hover].id, "hub");
  assert.equal(c.cursor, "default");
});

test("a data or colour change with the same nodes and edges restyles in place: no relayout, nothing moves", () => {
  const { c, wait, now, events } = setup();
  c.setLayout("merged");
  wait(1500);
  // Move a node off home, then change data and a colour.
  const at = onScreen(c, "b1");
  c.pointerDown({ ...at, time: now() });
  c.pointerMove({ x: at.x + 50, y: at.y, time: now() });
  wait(300);
  c.pointerUp({ time: now() });
  wait(200);
  const routing = c.routing;
  const before = c.graph.nodes.map((n) => [n.x, n.y]);
  c.pointerMove(onScreen(c, "a1"));
  const hover = c.hover;
  c.setGraph({
    nodes: SMALL.nodes.map((n) =>
      n.id === "a"
        ? { ...n, data: { price: 12 }, style: { color: "#ff0000" } }
        : n,
    ),
    edges: SMALL.edges,
  });
  assert.equal(c.routing, routing, "no new layout");
  assert.equal(c.tween, null, "no morph");
  assert.equal(c.hover, hover, "hover kept");
  c.graph.nodes.forEach((n, i) => assert.deepEqual([n.x, n.y], before[i]));
  assert.equal(node(c, "a").data.price, 12);
  assert.equal(c.looks.fill[node(c, "a").index], "#ff0000");
  assert.equal(c.model.node("a").data.price, 12);
  assert.equal(events.at(-1).type, "graphRestyle");
  assert.equal(events.at(-1).detail.nodes, 1);
});

test("anything that changes a node's room, or the nodes and edges themselves, still lays out again", () => {
  const { c, wait } = setup();
  wait(1000);
  const changes = [
    // a label (labels are shown), a size, a shape, an edge moved, a node added
    (n) => (n.id === "a" ? { ...n, label: "a much longer label" } : n),
    (n) => (n.id === "a" ? { ...n, style: { size: 60 } } : n),
    (n) => (n.id === "a" ? { ...n, style: { shape: "diamond" } } : n),
  ];
  for (const change of changes) {
    const routing = c.routing;
    c.setGraph({ nodes: SMALL.nodes.map(change), edges: SMALL.edges });
    assert.notEqual(c.routing, routing);
    c.setGraph(SMALL);
  }
  let routing = c.routing;
  c.setGraph({
    nodes: SMALL.nodes,
    edges: [...SMALL.edges.slice(1), { source: "b", target: "a" }],
  });
  assert.notEqual(c.routing, routing);
  routing = c.routing;
  c.setGraph({ nodes: [...SMALL.nodes, { id: "z" }], edges: SMALL.edges });
  assert.notEqual(c.routing, routing);
  // With labels off, a new label doesn't change the room a node takes.
  c.setGraph(SMALL);
  c.setNodeStyle({ ...c.node, labels: "off" });
  routing = c.routing;
  c.setGraph({ nodes: SMALL.nodes.map(changes[0]), edges: SMALL.edges });
  assert.equal(c.routing, routing);
  assert.equal(node(c, "a").label, "a much longer label");
});
