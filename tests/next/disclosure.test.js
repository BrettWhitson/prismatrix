// Progressive disclosure: collapsing and expanding as view state (the model keeps every node), headless. Also the
// small things that came with it: linear ghosts for long removed chains, per-layout edge defaults, the selection and
// collapsed nodes in snapshots, and the "fit" event for a fit that waited for a layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphController } from "../../next/engine/controller.js";
import { GraphModel } from "../../next/engine/model.js";
import { Graph } from "../../next/engine/graph.js";
import { departures, withGhosts } from "../../next/engine/ghosts.js";
import {
  collapsedAt,
  disclose,
  hiddenBelow,
} from "../../next/engine/disclosure.js";
import { graphFromStructure, runLayout } from "../../next/engine/layout-job.js";

const graphOf = (ids, pairs) => ({
  nodes: ids.map((id) => ({ id })),
  edges: pairs.map(([source, target]) => ({ source, target })),
});

/** root → a, b; a → a1, a2; a1 → a11; b → b1 */
const TREE = graphOf(
  ["root", "a", "b", "a1", "a2", "a11", "b1"],
  [
    ["root", "a"],
    ["root", "b"],
    ["a", "a1"],
    ["a", "a2"],
    ["a1", "a11"],
    ["b", "b1"],
  ],
);

/** Two recipes sharing an ingredient: root → r1, r2; r1 → x; r2 → x; x → y; r1 → own. */
const SHARED = graphOf(
  ["root", "r1", "r2", "x", "y", "own"],
  [
    ["root", "r1"],
    ["root", "r2"],
    ["r1", "x"],
    ["r2", "x"],
    ["x", "y"],
    ["r1", "own"],
  ],
);

/** A controller on an 800×600 viewport, its clock, its events, and a way to let time pass. */
function setup(graph = TREE, options = {}) {
  let time = 1000;
  const events = [];
  const c = new GraphController(new GraphModel(graph), null, {
    clock: () => time,
    onEvent: (type, detail) => events.push({ type, detail }),
    ...options,
  });
  c.setViewport(800, 600);
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

const ids = (c) => c.graph.nodes.map((n) => n.id).sort();
const edgeIds = (c) => c.graph.edges.map((e) => e.id).sort();
/** The scene's marks for node `id`: [collapsed flag, hidden count]. */
const marks = (c, id) => {
  const i = c.graph.byId.get(id).index;
  return [c.scene.collapsed?.[i] ?? 0, c.scene.hidden?.[i] ?? 0];
};

test("collapse folds a node's subtree into it as ghosts; expand grows it back out of it; the model keeps everything", () => {
  const { c, wait, of, now } = setup();
  wait(1500);
  c.wheel({ x: 400, y: 300, deltaY: -120 }); // a camera of the user's own: it holds still on what opens or closes
  wait(1500);
  assert.equal(c.collapse("a"), true);
  assert.equal(c.collapse("a"), false, "already collapsed");
  assert.equal(c.collapse("b1"), false, "a leaf has nothing to fold");
  assert.deepEqual(ids(c), ["a", "b", "b1", "root"]);
  assert.equal(c.model.size, 7, "the model is untouched");
  assert.ok(c.isCollapsed("a") && c.isHidden("a11") && !c.isHidden("a"));
  assert.deepEqual(c.collapsed, ["a"]);
  assert.equal(c.hiddenCount("a"), 3);
  assert.deepEqual(
    c.ghosts.map((g) => g.id).sort(),
    ["a1", "a11", "a2"],
    "what's folded away leaves as ghosts",
  );
  c.tick(now() + 16);
  assert.deepEqual(marks(c, "a"), [1, 3], "the scene has a +3 for painters");
  assert.deepEqual(marks(c, "b"), [0, 0]);
  assert.equal(c.scene.collapsed.length, c.graph.nodes.length);
  assert.deepEqual(of("collapse").at(-1).detail, {
    node: "a",
    visible: 4,
    hidden: 3,
  });
  wait(2000);
  assert.equal(c.ghosts.length, 0);

  const screenOf = (id) => {
    const n = c.graph.byId.get(id);
    return c.toScreen(n.x, n.y);
  };
  const a = screenOf("a");
  assert.equal(c.expand("a"), true);
  assert.equal(c.graph.nodes.length, 6, "one level: a1 comes back collapsed");
  assert.ok(c.isCollapsed("a1") && c.isHidden("a11"));
  const a1 = c.graph.byId.get("a1");
  const at = c.graph.byId.get("a");
  assert.ok(
    Math.abs(a1.x - at.x) < 1e-6 && Math.abs(a1.y - at.y) < 1e-6,
    "a new child starts on its parent",
  );
  assert.equal(of("expand").at(-1).detail.node, "a");
  wait(300);
  const mid = screenOf("a");
  assert.ok(
    Math.hypot(mid.x - a.x, mid.y - a.y) < 0.5,
    "a stays put on screen",
  );
  assert.equal(c.expand("a1", { depth: Infinity }), true);
  assert.equal(c.graph.nodes.length, 7);
  c.tick(now() + 16);
  assert.equal(c.scene.collapsed, null, "nothing collapsed, no marks");
  assert.equal(c.scene.hidden, null);
});

test("shared ingredients: hidden only when every path to them passes through a collapsed node", () => {
  const { c } = setup(SHARED, { layout: "merged" });
  c.collapse("r1");
  assert.deepEqual(
    ids(c),
    ["r1", "r2", "root", "x", "y"],
    "x is still used by r2",
  );
  assert.ok(!edgeIds(c).includes("r1>x"), "a collapsed node draws no children");
  assert.equal(c.hiddenCount("r1"), 1, "only its own ingredient is hidden");
  c.collapse("r2");
  assert.deepEqual(ids(c), ["r1", "r2", "root"]);
  assert.equal(c.hiddenCount("r1"), 3);
  assert.equal(c.hiddenCount("r2"), 2, "x and y count for both");
  c.toggle("r2");
  assert.deepEqual(ids(c), ["r1", "r2", "root", "x"]);
  assert.ok(c.isCollapsed("x"), "one level: x comes back collapsed");

  // The pure rule, straight from the model.
  const model = new GraphModel(SHARED);
  const d = disclose(model, new Set(["r1", "r2"]));
  assert.deepEqual(
    [...d.nodes].map((i) => model.nodes[i].id),
    ["root", "r1", "r2"],
  );
  assert.equal(disclose(model, new Set(["own", "nope"])).all, true);
  assert.equal(hiddenBelow(model, d)[model.index.get("r1")], 3);
});

test("an initial depth shows the top levels; collapseTo and expandAll move between them", () => {
  const { c, of } = setup(TREE, { depth: 1 });
  assert.deepEqual(ids(c), ["a", "b", "root"]);
  assert.deepEqual(c.collapsed.sort(), ["a", "b"]);
  c.tick(2000);
  assert.deepEqual(marks(c, "a"), [1, 3]);
  assert.deepEqual(marks(c, "b"), [1, 1]);
  c.collapseTo(0);
  assert.deepEqual(ids(c), ["root"]);
  assert.deepEqual(of("collapse").at(-1).detail, {
    node: null,
    depth: 0,
    visible: 1,
    hidden: 6,
  });
  c.collapseTo(2);
  assert.deepEqual(ids(c), ["a", "a1", "a2", "b", "b1", "root"]);
  assert.deepEqual(c.collapsed, ["a1"]);
  c.expandAll();
  assert.equal(c.graph.nodes.length, 7);
  assert.equal(c.collapseTo(2) && c.collapseTo(2), false, "no change");

  // A graph that shares nothing with the last starts at the depth again; one that shares nodes doesn't.
  c.expandAll();
  c.setGraph(
    graphOf(
      ["p", "q", "r"],
      [
        ["p", "q"],
        ["q", "r"],
      ],
    ),
  );
  assert.deepEqual(ids(c), ["p", "q"]);
  c.expandAll();
  c.update({
    addNodes: [{ id: "s" }],
    addEdges: [{ source: "r", target: "s" }],
  });
  assert.equal(c.graph.nodes.length, 4);

  // Depth counts edges from the nearest root, so a shortcut keeps a node shallow.
  const model = new GraphModel(
    graphOf(
      ["r", "m", "d", "deep"],
      [
        ["r", "m"],
        ["m", "d"],
        ["r", "d"],
        ["d", "deep"],
      ],
    ),
  );
  assert.deepEqual([...collapsedAt(model, 1)], ["d"]);
});

test("model changes while collapsed: new nodes under a collapsed one stay hidden and count; removed ones leave the set", () => {
  const { c, of } = setup();
  c.collapse("a");
  const shown = ids(c);
  c.update({
    addNodes: [{ id: "a3" }],
    addEdges: [{ source: "a", target: "a3" }],
  });
  assert.deepEqual(ids(c), shown, "a3 is hidden");
  assert.ok(c.isHidden("a3"));
  assert.equal(c.hiddenCount("a"), 4);
  c.tick(5000);
  assert.deepEqual(marks(c, "a"), [1, 4]);
  // A data change on a hidden node patches nothing on screen, and it's there once shown.
  c.update({ changeNodes: [{ id: "a11", data: { price: 3 } }] });
  assert.equal(of("graphData").length, 1);
  c.expand("a", { depth: Infinity });
  assert.equal(c.graph.byId.get("a11").data.price, 3);
  // A collapsed node that leaves the model leaves the set.
  c.collapse("b");
  c.update({ removeNodes: ["b"] });
  assert.deepEqual(c.collapsed, []);
  assert.ok(c.graph.byId.has("b1"), "b1 is a root now");
});

test("focus on a hidden node opens the way to it first (only the path), then glides there", () => {
  const graph = graphOf(
    ["root", "a", "a1", "a11", "a2", "a21", "b", "b1"],
    [
      ["root", "a"],
      ["a", "a1"],
      ["a1", "a11"],
      ["a", "a2"],
      ["a2", "a21"],
      ["root", "b"],
      ["b", "b1"],
    ],
  );
  const { c, of, wait } = setup(graph, { depth: 1 });
  wait(1500);
  assert.ok(c.isHidden("a11"));
  assert.equal(c.focus("a11"), true);
  assert.ok(!c.isHidden("a11"));
  assert.deepEqual(ids(c), ["a", "a1", "a11", "a2", "b", "root"]);
  assert.ok(
    c.isCollapsed("a2"),
    "a sibling the path brings in starts collapsed",
  );
  assert.ok(c.isCollapsed("b"), "the rest stays as it was");
  assert.equal(of("expand").at(-1).detail.reveal, true);
  assert.equal(of("focus").at(-1).detail.node, "a11");
  wait(2000);
  const n = c.graph.byId.get("a11");
  const p = c.toScreen(n.x, n.y);
  assert.ok(Math.abs(p.x - 400) < 1e-6 && Math.abs(p.y - 300) < 1e-6);
  assert.equal(c.reveal("a11"), false, "already shown");
});

test("selection, hover and drags of nodes folded away", () => {
  const { c, wait } = setup();
  wait(1500);
  c.select(["a1", "b"]);
  c.collapse("a");
  assert.deepEqual(c.selected, ["a1", "b"], "a folded node stays selected");
  c.tick(4000);
  const i = c.graph.byId.get("b").index;
  assert.equal(c.scene.selected[i], 1);
  assert.equal(c.scene.selected.length, c.graph.nodes.length);
  c.expand("a");
  c.tick(5000);
  assert.equal(c.scene.selected[c.graph.byId.get("a1").index], 1);
});

test("a double tap on a node toggles it when doubleTapToggles is on", () => {
  for (const doubleTapToggles of [false, true]) {
    const { c, wait, now } = setup(TREE, { doubleTapToggles });
    wait(1500);
    const n = c.graph.byId.get("a");
    const s = c.toScreen(n.x, n.y);
    for (const dt of [0, 150]) {
      c.pointerDown({ ...s, time: now() + dt });
      c.pointerUp({ ...s, time: now() + dt + 30 });
    }
    assert.equal(c.isCollapsed("a"), doubleTapToggles);
  }
});

test("ghosts are linear in what left: a 20k chain folds away in a few ms", () => {
  const n = 20000;
  const nodes = Array.from({ length: n + 1 }, (_, i) => ({ id: `n${i}` }));
  const edges = Array.from({ length: n }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
  }));
  const before = new Graph(GraphModel.from({ nodes, edges }));
  const after = new Graph(GraphModel.from({ nodes: [{ id: "n0" }] }));
  const looks = { radius: new Float64Array(n + 1).fill(5), fill: [] };
  const t0 = performance.now();
  const gone = departures(before, after, looks, 0);
  const shown = withGhosts(
    after,
    gone,
    { looks: { radius: [5], fill: ["#fff"] } },
    10,
    100,
    (t) => t,
  );
  const ms = performance.now() - t0;
  assert.equal(gone.length, n);
  assert.equal(gone[0].id, "n1");
  assert.equal(gone.at(-1).depth, n);
  assert.deepEqual(gone[2].ancestors, ["n2", "n1", "n0"]);
  assert.equal(shown.graph.nodes.length, n + 1);
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

test("edge defaults per layout: the merged tree curves unless the edge shape was set on purpose", () => {
  const { c, of } = setup(SHARED, { layout: "merged" });
  assert.equal(c.edge.shape, "curve");
  c.setLayout("tree");
  assert.equal(c.edge.shape, "step");
  c.setLayout("merged");
  c.tick(9000);
  assert.equal(c.scene.edge.shape, "curve");
  // Set on purpose, even to the engine's own default: it wins over the layout's.
  c.setEdgeStyle({ shape: "step" });
  assert.equal(c.edge.shape, "step");
  assert.deepEqual(of("edgeStyle").at(-1).detail, { shape: "step" });
  c.setEdgeStyle({ width: 3 });
  assert.equal(c.edge.shape, "step");
  // Given to the model up front counts too; a reset forgets it.
  const set = setup(SHARED, { layout: "merged" });
  set.c.model.setOptions({ edge: { shape: "fan" } });
  assert.equal(set.c.edge.shape, "fan");
  set.c.model.setOptions({ edge: { width: 2 } }, { reset: true });
  assert.equal(set.c.edge.shape, "curve");
  assert.equal(set.c.edge.width, 2);
  const given = new GraphController(
    new GraphModel(SHARED, { edge: { shape: "straight" } }),
    null,
    { layout: "merged" },
  );
  assert.equal(given.edge.shape, "straight");
});

test("a snapshot keeps the selection, the collapsed nodes and which options were set on purpose", () => {
  const { c, wait } = setup(TREE, { layout: "merged" });
  c.setNodeStyle({ size: 20 });
  c.collapse("a");
  c.select(["b", "a2"]);
  wait(1500);
  const snap = c.snapshot("test");
  assert.deepEqual(snap.selection, ["b", "a2"]);
  assert.deepEqual(snap.collapsed, ["a"]);
  assert.equal(snap.settings.edge.shape, "curve");
  assert.deepEqual(snap.settings.explicit, { node: ["size"], edge: [] });
  assert.equal(Object.keys(snap.state).length, 4, "state for the shown nodes");
  const json = JSON.parse(JSON.stringify(snap));

  const other = setup(graphOf(["lonely"], []), { layout: "tree" });
  other.c.setEdgeStyle({ shape: "fan" });
  other.c.restore(json);
  assert.deepEqual(other.c.selected, ["b", "a2"]);
  assert.deepEqual(other.c.collapsed, ["a"]);
  assert.deepEqual(ids(other.c), ids(c));
  for (const n of c.graph.nodes) {
    const o = other.c.graph.byId.get(n.id);
    assert.ok(Math.abs(o.x - n.x) < 0.01 && Math.abs(o.y - n.y) < 0.01, n.id);
  }
  assert.equal(other.c.node.size, 20);
  assert.equal(other.c.edge.shape, "curve", "the fan set before is gone");
  other.c.setLayout("tree");
  assert.equal(
    other.c.edge.shape,
    "step",
    "and the merged tree's curve was its default",
  );
});

test("a fit asked for while a layout is on its way: one fit event now (pending), one when it lands", async () => {
  const queue = [];
  globalThis.Worker = class {
    postMessage(data) {
      if (data.type !== "layout") return;
      if (data.structure) this.graph = graphFromStructure(data.structure);
      const graph = this.graph;
      queue.push(() => {
        this.onmessage?.({ data: { id: data.id, started: true } });
        const result = runLayout(graph, data.layout, data.options, data.sizing);
        this.onmessage?.({ data: { id: data.id, result } });
      });
    }
    terminate() {}
  };
  const flush = () => {
    while (queue.length) queue.shift()();
  };
  const later = () => new Promise((done) => setImmediate(done));
  try {
    const { c, of, wait } = setup(TREE, { worker: true });
    flush();
    await later();
    wait(1500);
    c.wheel({ x: 400, y: 300, deltaY: -600 });
    c.collapse("a"); // a structural change in the worker
    assert.ok(c.layoutPending);
    c.fit();
    assert.equal(of("fit").length, 1);
    assert.equal(of("fit")[0].detail.pending, true);
    flush();
    await later();
    assert.equal(of("fit").length, 2);
    assert.equal(of("fit")[1].detail.pending, undefined);
    assert.equal(of("fit")[1].detail.k, c.cameraTween.to.k);
    assert.deepEqual(ids(c), ["a", "b", "b1", "root"]);
    c.destroy();
  } finally {
    delete globalThis.Worker;
  }
});
