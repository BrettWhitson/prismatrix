// The ground-up engine's pure parts: the forest, the layouts, the physics modes and the edge geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import {
  LAYOUTS,
  constrainer,
  radialLayout,
  treeLayout,
} from "../../next/engine/layouts.js";
import {
  PHYSICS,
  Simulation,
  physicsOptions,
  physicsSchema,
} from "../../next/engine/physics.js";
import { edgePoints, fanJunctions, trim } from "../../next/engine/geometry.js";
import { resolve } from "../../next/engine/schema.js";

/** root → a, b; a → a1, a2; b → b1 */
function small() {
  const ids = ["root", "a", "b", "a1", "a2", "b1"];
  return new Graph(
    ids.map((id) => ({ id })),
    [
      ["root", "a"],
      ["root", "b"],
      ["a", "a1"],
      ["a", "a2"],
      ["b", "b1"],
    ].map(([source, target]) => ({ source, target })),
  );
}

const at = (g, id) => g.byId.get(id);

test("the graph reads its edges as a forest", () => {
  const g = small();
  assert.deepEqual(g.roots, [0]);
  assert.equal(at(g, "a1").depth, 2);
  assert.equal(at(g, "a1").parent, at(g, "a").index);
  assert.equal(at(g, "root").leaves, 3);
  assert.equal(at(g, "root").descendants, 5);
  assert.equal(g.maxDepth, 2);
});

test("an edge into a node that already has a parent is a cross-link, and cycles still get a root", () => {
  const g = new Graph(
    ["x", "y", "z"].map((id) => ({ id })),
    [
      { source: "x", target: "y" },
      { source: "y", target: "z" },
      { source: "z", target: "x" },
    ],
  );
  assert.equal(g.roots.length, 1);
  assert.equal(g.edges.filter((e) => e.tree).length, 2);
  assert.equal(g.order.length, 3);
});

test("edges to unknown nodes and self-loops are dropped", () => {
  const g = new Graph(
    [{ id: "a" }],
    [
      { source: "a", target: "a" },
      { source: "a", target: "nope" },
    ],
  );
  assert.equal(g.edges.length, 0);
});

test("tree: levels are evenly spaced and every parent is centred over its children", () => {
  const g = small();
  treeLayout(g, { direction: "TB", levelGap: 100, siblingGap: 50 });
  assert.equal(at(g, "a1").homeY, 200);
  assert.equal(at(g, "a").homeX, (at(g, "a1").homeX + at(g, "a2").homeX) / 2);
  assert.equal(
    at(g, "a2").homeX - at(g, "a1").homeX,
    16 + 50,
    "two 16px footprints, 50 apart",
  );
  const lr = small();
  treeLayout(lr, { direction: "LR", levelGap: 100, siblingGap: 50 });
  assert.equal(at(lr, "a1").homeX, 200);
});

test("radial: one root sits in the middle, depth is the ring, and siblings never share an angle", () => {
  const g = small();
  radialLayout(g, { ringGap: 80, sweep: 360, rotation: 0 });
  assert.equal(at(g, "root").homeX, 0);
  assert.equal(at(g, "root").homeY, 0);
  for (const id of ["a1", "a2", "b1"]) {
    const n = at(g, id);
    assert.ok(Math.abs(Math.hypot(n.homeX, n.homeY) - 160) < 1e-9);
  }
  const angle = (id) => Math.atan2(at(g, id).homeY, at(g, id).homeX);
  assert.notEqual(angle("a1"), angle("a2"));
});

test("radial: separate trees share the first ring around an empty centre", () => {
  const g = new Graph(
    ["p", "q"].map((id) => ({ id })),
    [],
  );
  radialLayout(g, { ringGap: 50 });
  for (const n of g.nodes)
    assert.ok(Math.abs(Math.hypot(n.homeX, n.homeY) - 50) < 1e-9);
});

test("each layout lists its own physics: trees are static or elastic, radials can also float", () => {
  assert.deepEqual(Object.keys(LAYOUTS.tree.physics), ["static", "elastic"]);
  assert.deepEqual(Object.keys(LAYOUTS.radial.physics), [
    "static",
    "elastic",
    "floating",
  ]);
  assert.throws(() => physicsSchema("tree", "floating"));
  const keys = (l, m) => physicsSchema(l, m).map((o) => o.key);
  assert.ok(keys("tree", "elastic").includes("levelLock"));
  assert.ok(keys("radial", "elastic").includes("ringLock"));
  assert.ok(!keys("tree", "elastic").includes("ringLock"));
  for (const mode of Object.keys(PHYSICS))
    assert.ok(PHYSICS[mode].options.length);
});

test("a layout's defaults override the mode's", () => {
  assert.equal(
    physicsOptions("tree", "elastic").anchor,
    LAYOUTS.tree.physics.elastic.defaults.anchor,
  );
  assert.equal(
    physicsOptions("tree", "elastic", { anchor: "strong" }).anchor,
    LAYOUTS.tree.physics.elastic.defaults.anchor,
    "a value that isn't usable takes the layout's default",
  );
  assert.equal(
    physicsOptions("tree", "elastic", { anchor: 999 }).anchor,
    physicsSchema("tree", "elastic").find((o) => o.key === "anchor").max,
    "a number out of range is clamped",
  );
});

function settle(sim, seconds) {
  for (let t = 0; t < seconds; t += 1 / 60) sim.advance(1 / 60);
}

test("elastic: a displaced node springs home and drags its neighbours on the way", () => {
  const g = small();
  treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  sim.configure("elastic", physicsOptions("tree", "elastic"));
  const a = at(g, "a");
  a.x += 300;
  sim.advance(1 / 30);
  assert.ok(at(g, "a1").vx > 0, "the child is pulled after its parent");
  settle(sim, 6);
  assert.ok(Math.hypot(a.x - a.homeX, a.y - a.homeY) < 1);
  assert.ok(sim.asleep);
});

test("elastic: a held node stays where the pointer has it", () => {
  const g = small();
  treeLayout(g, {});
  const sim = new Simulation(g);
  sim.configure("elastic", physicsOptions("tree", "elastic"));
  const a = at(g, "a");
  a.x = 500;
  a.y = 500;
  sim.held.add(a.index);
  settle(sim, 1);
  assert.deepEqual([a.x, a.y], [500, 500]);
  assert.ok(!sim.asleep);
});

test("tree elastic with the level lock only moves nodes along their level", () => {
  const g = small();
  const routing = treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const opts = physicsOptions("tree", "elastic", { levelLock: true });
  const sim = new Simulation(g);
  sim.configure("elastic", opts, constrainer(routing, opts));
  const a = at(g, "a");
  sim.held.add(a.index);
  a.x += 200;
  a.y += 200;
  settle(sim, 0.5);
  for (const n of g.nodes) if (n !== a) assert.equal(n.y, n.homeY);
});

test("radial elastic with the ring lock keeps nodes on their ring", () => {
  const g = small();
  const routing = radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const opts = physicsOptions("radial", "elastic", { ringLock: true });
  const sim = new Simulation(g);
  sim.configure("elastic", opts, constrainer(routing, opts));
  const a1 = at(g, "a1");
  a1.vx = 400;
  settle(sim, 0.5);
  const ring = Math.hypot(a1.homeX, a1.homeY);
  assert.ok(Math.abs(Math.hypot(a1.x, a1.y) - ring) < 1e-6);
});

test("floating: nodes stacked on one spot push apart, and without memory or drift it comes to rest", () => {
  const g = small();
  radialLayout(g, {});
  g.nodes.forEach((n, i) => ([n.x, n.y] = [i * 0.1, 0]));
  const sim = new Simulation(g);
  sim.configure(
    "floating",
    physicsOptions("radial", "floating", { memory: 0, drift: 0 }),
  );
  settle(sim, 10);
  const b = g.bounds();
  assert.ok(b.maxX - b.minX > 50);
  assert.ok(sim.asleep);
});

test("floating with drift never sleeps", () => {
  const g = small();
  const sim = new Simulation(g);
  sim.configure(
    "floating",
    physicsOptions("radial", "floating", { drift: 10 }),
  );
  assert.ok(!sim.asleep);
});

test("static has no forces: a node put somewhere stays there", () => {
  const g = small();
  const sim = new Simulation(g);
  sim.configure("static", physicsOptions("tree", "static"));
  at(g, "a").x = 999;
  settle(sim, 1);
  assert.equal(at(g, "a").x, 999);
  assert.ok(sim.asleep);
});

test("rest needs a run of still steps, so a frame that runs no step can't put a thrown node to sleep", () => {
  const g = small();
  const sim = new Simulation(g);
  sim.configure("static", physicsOptions("tree", "static"));
  settle(sim, 1);
  assert.ok(sim.asleep);
  // A release: speed given, the simulation woken, and the next frame too short for a whole step.
  at(g, "a").vx = 500;
  sim.wake();
  sim.advance(0.001);
  assert.ok(!sim.asleep);
  settle(sim, 0.1);
  assert.ok(at(g, "a").x > 10, "it glides");
});

test("elastic: a node let go at a standstill, away from home, still springs back", () => {
  const g = small();
  treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  sim.configure("elastic", physicsOptions("tree", "elastic"));
  settle(sim, 1);
  assert.ok(sim.asleep);
  const a = at(g, "a");
  a.x += 200; // put there and released with no speed
  sim.wake();
  assert.ok(!sim.asleep);
  settle(sim, 6);
  assert.ok(Math.abs(a.x - a.homeX) < 1);
});

test("step edges: right angles halfway between levels in a tree", () => {
  const s = { x: 0, y: 0 },
    t = { x: 40, y: 100 };
  assert.deepEqual(
    edgePoints({ kind: "tree", direction: "TB" }, "step", s, t),
    [0, 0, 0, 50, 40, 50, 40, 100],
  );
  assert.deepEqual(
    edgePoints({ kind: "tree", direction: "LR" }, "step", s, { x: 100, y: 40 }),
    [0, 0, 50, 0, 50, 40, 100, 40],
  );
  assert.deepEqual(
    edgePoints({ kind: "tree", direction: "TB" }, "straight", s, t),
    [0, 0, 40, 100],
  );
});

test("step edges in a radial run round the ring halfway between", () => {
  const routing = { kind: "radial", cx: 0, cy: 0 };
  const pts = edgePoints(routing, "step", { x: 100, y: 0 }, { x: 0, y: 200 });
  assert.deepEqual(pts.slice(0, 2), [100, 0]);
  assert.deepEqual(pts.slice(-2), [0, 200]);
  for (let i = 2; i < pts.length - 2; i += 2) {
    assert.ok(Math.abs(Math.hypot(pts[i], pts[i + 1]) - 150) < 1e-9);
  }
});

test("trim cuts along the polyline and gives up when the ends meet", () => {
  assert.deepEqual(trim([0, 0, 0, 10, 10, 10], 5, 5), [0, 5, 0, 10, 5, 10]);
  assert.equal(trim([0, 0, 10, 0], 6, 6), null);
});

test("resolve clamps numbers out of range and drops unknown keys", () => {
  const schema = physicsSchema("radial", "floating");
  const warnings = [];
  const out = resolve(
    schema,
    { repulsion: -5, friction: 3, bogus: 1 },
    (message, warning) => warnings.push(warning),
  );
  assert.equal(out.repulsion, schema.find((o) => o.key === "repulsion").min);
  assert.deepEqual(
    warnings.map((w) => [w.kind, w.key]),
    [
      ["clamped", "repulsion"],
      ["unknown", "bogus"],
    ],
  );
  assert.equal(out.friction, 3);
  assert.ok(!("bogus" in out));
});

test("friction brings a thrown node in static to a full stop, and it stays where it stopped", () => {
  const g = small();
  treeLayout(g, {});
  const sim = new Simulation(g);
  sim.configure("static", physicsOptions("tree", "static"));
  const a = at(g, "a");
  a.vx = 800;
  settle(sim, 0.2);
  const partway = a.x;
  assert.ok(partway > 0 && a.vx < 800, "it glides and slows");
  settle(sim, 10);
  assert.equal(a.vx, 0);
  assert.ok(sim.asleep);
  assert.ok(a.x > partway);
});

test("floating with no drift eases to a stop", () => {
  const g = small();
  radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y, n.vx] = [n.homeX, n.homeY, 300];
  const sim = new Simulation(g);
  sim.configure("floating", physicsOptions("radial", "floating"));
  settle(sim, 20);
  assert.ok(sim.asleep);
});

test("collision pushes overlapping circles apart, and a held node doesn't give way", () => {
  const g = new Graph([{ id: "a" }, { id: "b" }], []);
  for (const n of g.nodes) {
    n.radius = 10;
    n.box = { x0: -10, y0: -10, x1: 10, y1: 10 };
    n.homeX = n.x = 0;
  }
  g.nodes[1].x = 5;
  const sim = new Simulation(g);
  const opts = physicsOptions("radial", "floating", {
    memory: 0,
    repulsion: 0,
  });
  sim.configure("floating", opts, null, { boxes: false, padding: 4 });
  sim.held.add(0);
  sim.step(1 / 120);
  assert.equal(g.nodes[0].x, 0);
  assert.ok(Math.abs(g.nodes[1].x - 24) < 1e-9, "radii plus padding apart");
});

test("label boxes collide on the axis they overlap least", () => {
  const g = new Graph([{ id: "a" }, { id: "b" }], []);
  for (const n of g.nodes) n.box = { x0: -5, y0: -5, x1: 60, y1: 5 }; // a long label to the right
  g.nodes[1].x = 40;
  g.nodes[1].y = 2;
  const sim = new Simulation(g);
  const opts = physicsOptions("radial", "floating", {
    memory: 0,
    repulsion: 0,
    links: 0,
  });
  sim.configure("floating", opts, null, { boxes: true, padding: 0 });
  sim.step(1 / 120);
  const [a, b] = g.nodes;
  assert.ok(
    Math.abs(b.y - a.y) >= 10 - 1e-9,
    "pushed apart vertically, the short way",
  );
});

test("collision is off when the mode's collide option is", () => {
  const sim = new Simulation(small());
  sim.configure(
    "elastic",
    physicsOptions("tree", "elastic", { collide: false }),
    null,
    { boxes: false, padding: 0 },
  );
  assert.equal(sim.collision, null);
});

test("tree: wide labels push siblings apart and deep labels push levels apart", () => {
  const g = small();
  const wide = {
    gap: 0,
    box: (i) =>
      i === at(g, "a1").index
        ? { x0: -40, y0: -8, x1: 40, y1: 120 }
        : { x0: -8, y0: -8, x1: 8, y1: 8 },
  };
  treeLayout(g, { levelGap: 50, siblingGap: 10 }, wide);
  assert.ok(at(g, "a2").homeX - at(g, "a1").homeX >= 40 + 10 + 8);
  // a1's level is the deepest, so nothing below it needs to move; but b1 shares a1's level.
  assert.equal(at(g, "b1").homeY, at(g, "a1").homeY);
});

test("tree: subtrees nest under each other's overhangs (contours, not slots)", () => {
  // root → [x → x1..x4], [y]. y sits beside x, and its single child-free node can tuck in close.
  const ids = ["root", "x", "y", "x1", "x2", "x3", "x4"];
  const g = new Graph(
    ids.map((id) => ({ id })),
    ["x", "y"]
      .map((t) => ({ source: "root", target: t }))
      .concat(
        ["x1", "x2", "x3", "x4"].map((t) => ({ source: "x", target: t })),
      ),
  );
  treeLayout(g, { siblingGap: 10 });
  // y only has to clear x itself on its level, not x's wide row of children below.
  assert.ok(
    at(g, "y").homeX - at(g, "x").homeX <
      at(g, "x4").homeX - at(g, "x").homeX + 26,
  );
  assert.ok(at(g, "y").homeX - at(g, "x").homeX >= 16 + 10);
});

test("radial: rings grow when the nodes on them wouldn't fit side by side", () => {
  const ids = ["root", ...Array.from({ length: 40 }, (_, i) => `c${i}`)];
  const g = new Graph(
    ids.map((id) => ({ id })),
    ids.slice(1).map((t) => ({ source: "root", target: t })),
  );
  radialLayout(
    g,
    { ringGap: 20 },
    { gap: 0, box: () => ({ x0: -10, y0: -10, x1: 10, y1: 10 }) },
  );
  const r = Math.hypot(at(g, "c0").homeX, at(g, "c0").homeY);
  const neighbour = Math.hypot(
    at(g, "c1").homeX - at(g, "c0").homeX,
    at(g, "c1").homeY - at(g, "c0").homeY,
  );
  assert.ok(r > 20, "further out than the ring gap asks");
  assert.ok(neighbour >= 20, "neighbours don't overlap");
});

test("fan: one shared junction per parent; none when children surround it", () => {
  const g = small();
  const routing = treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const j = fanJunctions(g, routing);
  const a = at(g, "a");
  assert.equal(
    j[a.index * 2],
    a.x,
    "a tree's junction is straight down the axis",
  );
  assert.ok(j[a.index * 2 + 1] > a.y);
  assert.ok(Number.isNaN(j[at(g, "a1").index * 2]), "leaves have none");

  const star = new Graph(
    ["c", "n", "e", "s", "w"].map((id) => ({ id })),
    ["n", "e", "s", "w"].map((t) => ({ source: "c", target: t })),
  );
  const radial = radialLayout(star, {});
  for (const n of star.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  assert.ok(
    Number.isNaN(fanJunctions(star, radial)[0]),
    "children all round: plain spokes",
  );

  // Pull a child behind its parent: the parent's fan gives up rather than doubling back.
  at(g, "a1").y = a.y - 50;
  assert.ok(Number.isNaN(fanJunctions(g, routing)[a.index * 2]));
});

test("floating fades its forces over the settle time, so even a stretched graph stops soon after", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const g = new Graph(
    ids.map((id) => ({ id })),
    ids.slice(1).map((t, i) => ({ source: ids[Math.floor(i / 2)], target: t })),
  );
  radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  // Twice the layout's link length: a slow relaxation that used to creep on for half a minute.
  sim.configure(
    "floating",
    physicsOptions("radial", "floating", { linkLength: 2, settle: 3 }),
  );
  let t = 0;
  for (; t < 30 && !sim.asleep; t += 1 / 60) sim.advance(1 / 60);
  assert.ok(t < 6, `settled after ${t.toFixed(1)}s`);
  assert.equal(sim.heat, 0);
  sim.wake();
  assert.equal(sim.heat, 1, "a disturbance brings the forces back");
});

test("level and ring locks hold even when collisions push nodes", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
  for (const [layout, run, lock] of [
    ["tree", treeLayout, "levelLock"],
    ["radial", radialLayout, "ringLock"],
  ]) {
    const g = new Graph(
      ids.map((id) => ({ id })),
      ids.slice(1).map((t) => ({ source: "n0", target: t })),
    );
    for (const n of g.nodes) {
      n.radius = 8;
      n.box = { x0: -8, y0: -8, x1: 8, y1: 8 };
    }
    const routing = run(g, {});
    for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
    const opts = physicsOptions(layout, "elastic", { [lock]: true });
    const sim = new Simulation(g);
    sim.configure("elastic", opts, constrainer(routing, opts), {
      boxes: false,
      padding: 4,
    });
    const [, a, b] = g.nodes;
    sim.held.add(a.index);
    [a.x, a.y] = [b.x, b.y]; // dropped right on its neighbour
    for (let i = 0; i < 600; i++) {
      sim.step(1 / 120);
      for (const n of g.nodes) {
        if (n === a) continue;
        const off =
          layout === "tree"
            ? Math.abs(n.y - n.homeY)
            : Math.abs(Math.hypot(n.x, n.y) - Math.hypot(n.homeX, n.homeY));
        assert.ok(off < 1e-6, `${layout}: ${n.id} pushed ${off} off`);
      }
    }
  }
});

test("a big floating graph can't lock up a frame: repulsion stays local and physics keeps to a time budget", () => {
  // Depth 7, branching 4: the graph that froze the sandbox (21,845 nodes) under all-pairs repulsion.
  const nodes = [{ id: "0" }];
  const edges = [];
  let level = [0];
  for (let d = 0; d < 7; d++) {
    const next = [];
    for (const p of level)
      for (let b = 0; b < 4; b++) {
        const id = nodes.length;
        nodes.push({ id: String(id) });
        edges.push({ source: String(p), target: String(id) });
        next.push(id);
      }
    level = next;
  }
  const g = new Graph(nodes, edges);
  radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  sim.configure("floating", physicsOptions("radial", "floating"));
  const start = performance.now();
  sim.advance(1 / 20); // a frame owed six steps
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `one frame took ${Math.round(ms)}ms`);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x + n.y)));
});

test("repulsion pushes close nodes apart and ignores far ones", () => {
  const g = new Graph(
    ["a", "b", "far"].map((id) => ({ id })),
    [],
  );
  const [a, b, far] = g.nodes;
  [a.x, b.x, far.x] = [0, 30, 100000];
  const sim = new Simulation(g);
  sim.configure(
    "floating",
    physicsOptions("radial", "floating", { memory: 0, collide: false }),
  );
  sim.step(1 / 120);
  assert.ok(a.vx < 0 && b.vx > 0, "the close pair pushes apart");
  assert.equal(far.vx, 0, "the far node feels nothing");
});

test("one node still moving among many keeps the simulation awake", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `n${i}`);
  const g = new Graph(
    ids.map((id) => ({ id })),
    [],
  );
  g.nodes.forEach((n, i) => ([n.x, n.y] = [i * 100, 0]));
  const sim = new Simulation(g);
  sim.configure("static", physicsOptions("tree", "static", { friction: 0.5 }));
  g.nodes[0].vx = 20; // its share of the mean squared speed: 0.2, under the old threshold
  for (let i = 0; i < 60; i++) sim.step(1 / 120);
  assert.ok(!sim.asleep);
});

// ---- radial wedges sized by need ----------------------------------------------------------------------------

import { footprint as footprintOf } from "../../next/engine/boxes.js";

function randomGraph(seed, count, bushiness) {
  let s = seed >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const nodes = [{ id: "0", label: "root" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: String(i), label: String(i) });
    edges.push({
      source: String(Math.floor(r() ** bushiness * i)),
      target: String(i),
    });
  }
  return new Graph(nodes, edges);
}

/** Footprints like the view's: a node of radius 8 with its label below, 6 px per character. */
const labelSizing = (g) => ({
  gap: 4,
  box: () => footprintOf(8, Math.PI / 2, 0, 14),
  boxOf: (i) => footprintOf(8, Math.PI / 2, 6 * g.nodes[i].label.length, 14),
});
const sized = (g) => {
  const s = labelSizing(g);
  return { gap: s.gap, box: (i) => s.boxOf(i) };
};

function overlapsAtHome(g, sizing) {
  let count = 0;
  const boxes = g.nodes.map((n) => sizing.box(n.index, Math.PI / 2));
  for (let i = 0; i < g.nodes.length; i++)
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i],
        b = g.nodes[j];
      const ox =
        Math.min(a.homeX + boxes[i].x1, b.homeX + boxes[j].x1) -
        Math.max(a.homeX + boxes[i].x0, b.homeX + boxes[j].x0);
      const oy =
        Math.min(a.homeY + boxes[i].y1, b.homeY + boxes[j].y1) -
        Math.max(a.homeY + boxes[i].y0, b.homeY + boxes[j].y0);
      if (ox > 0.5 && oy > 0.5) count++;
    }
  return count;
}

const meanDistance = (g) =>
  g.nodes.reduce((sum, n) => sum + Math.hypot(n.homeX, n.homeY), 0) /
  g.nodes.length;

test("radial tidy spacing: no overlaps, and never less compact than leaf-count wedges", () => {
  for (const [seed, count, bushiness] of [
    [7, 80, 1.4],
    [3, 300, 1],
    [11, 200, 3],
    [5, 200, 0.4],
    [9, 150, 2],
  ]) {
    const byNeed = randomGraph(seed, count, bushiness);
    const byLeaves = randomGraph(seed, count, bushiness);
    radialLayout(byNeed, {}, sized(byNeed));
    radialLayout(byLeaves, { spacing: "leaves" }, sized(byLeaves));
    assert.equal(overlapsAtHome(byNeed, sized(byNeed)), 0, `seed ${seed}`);
    assert.ok(
      meanDistance(byNeed) <= meanDistance(byLeaves) + 1e-6,
      `seed ${seed}`,
    );
  }
});

test("radial tidy spacing pulls a crowded first ring well in", () => {
  // A root with 60 leaf children and a few deep, narrow subtrees: by leaves, the deep ones hog the angle.
  const nodes = [{ id: "r", label: "root" }],
    edges = [];
  for (let i = 0; i < 60; i++) {
    nodes.push({ id: `l${i}`, label: `${i}` });
    edges.push({ source: "r", target: `l${i}` });
  }
  for (let t = 0; t < 4; t++)
    for (let d = 0; d < 5; d++)
      for (let k = 0; k < 3; k++) {
        const id = `t${t}-${d}-${k}`;
        nodes.push({ id, label: id.slice(0, 4) });
        edges.push({
          source: k ? `t${t}-${d}-0` : d ? `t${t}-${d - 1}-0` : "r",
          target: id,
        });
      }
  const ring1 = (g) =>
    Math.hypot(g.byId.get("l0").homeX, g.byId.get("l0").homeY);
  const a = new Graph(nodes, edges),
    b = new Graph(nodes, edges);
  radialLayout(a, {}, sized(a));
  radialLayout(b, { spacing: "leaves" }, sized(b));
  assert.ok(ring1(a) < ring1(b) * 0.9, `ring 1 at ${ring1(a)} vs ${ring1(b)}`);
  assert.equal(overlapsAtHome(a, sized(a)), 0);
});

test("radial: a balanced tree still fans out evenly, and children stay inside their parent's angle", () => {
  const nodes = [{ id: "r" }],
    edges = [];
  let level = ["r"];
  for (let d = 0; d < 3; d++) {
    const next = [];
    for (const p of level)
      for (let k = 0; k < 3; k++) {
        nodes.push({ id: p + k });
        edges.push({ source: p, target: p + k });
        next.push(p + k);
      }
    level = next;
  }
  const g = new Graph(nodes, edges);
  radialLayout(g, {});
  const angle = (id) => {
    const n = g.byId.get(id);
    return (Math.atan2(n.homeY, n.homeX) + Math.PI * 2.5) % (Math.PI * 2);
  };
  const first = ["r0", "r1", "r2"].map(angle).sort((x, y) => x - y);
  const gaps = [first[1] - first[0], first[2] - first[1]];
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 1e-9, "equal subtrees, equal angles");
  // r1's grandchildren sit between r0's and r2's.
  const inner = ["r10", "r11", "r12"].map(angle);
  for (const a of inner)
    assert.ok(
      a > Math.min(angle("r00"), angle("r20")) &&
        a < Math.max(angle("r02"), angle("r22")),
    );
});

test("radial: a lopsided tree with wide footprints doesn't leave the middle empty", () => {
  // The sandbox case that showed it: one root child with nearly everything under it, one small, one leaf, and a
  // collision radius of 60.
  const g = randomGraph(1, 357, 0.9);
  const sizing = { gap: 60, box: () => footprintOf(8, Math.PI / 2, 20, 8) };
  radialLayout(g, { ringGap: 20 }, sizing);
  const ring = (d) => {
    const n = g.nodes.find((x) => x.depth === d);
    return Math.hypot(n.homeX, n.homeY);
  };
  const outer = Math.max(...g.nodes.map((n) => Math.hypot(n.homeX, n.homeY)));
  assert.ok(
    ring(1) < outer * 0.2,
    `ring 1 at ${Math.round(ring(1))} of ${Math.round(outer)}`,
  );
  assert.equal(overlapsAtHome(g, sizing), 0);
});

test("radial: partial sweeps and forests lay out without overlaps, inside the sweep", () => {
  const g = randomGraph(4, 150, 1.2);
  radialLayout(g, { sweep: 180 }, sized(g));
  assert.equal(overlapsAtHome(g, sized(g)), 0);
  for (const n of g.nodes) {
    if (!n.depth) continue;
    // A half circle centred on "up": every node at or above the centre line.
    assert.ok(n.homeY <= 1e-6, `${n.id} below the line`);
  }
  const forest = new Graph(
    Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `n${i}` })),
    Array.from({ length: 30 }, (_, i) => i)
      .filter((i) => i % 10)
      .map((i) => ({ source: `n${i - 1}`, target: `n${i}` })),
  );
  radialLayout(forest, {}, sized(forest));
  assert.equal(overlapsAtHome(forest, sized(forest)), 0);
});

// ---- radial edges that don't loop, and bundled cross-links -------------------------------------------------

import {
  bspline,
  bundledPoints,
  edgeRoute,
  stepCurveWeight,
} from "../../next/engine/geometry.js";

test("a radial step edge falls back to a curve when it would loop", () => {
  const routing = { kind: "radial", cx: 0, cy: 0 };
  // Laid out normally: parent on ring 100, child on ring 200 nearby. The arc runs at radius 150.
  const normal = edgePoints(
    routing,
    "step",
    { x: 100, y: 0 },
    { x: 0, y: 200 },
  );
  const middle = normal.slice(2, -2);
  for (let i = 0; i < middle.length; i += 2)
    assert.ok(Math.abs(Math.hypot(middle[i], middle[i + 1]) - 150) < 1e-6);
  // The child dragged inside the parent's ring: no arc, so nothing doubles back round the centre.
  const inward = edgePoints(
    routing,
    "step",
    { x: 200, y: 0 },
    { x: -50, y: 10 },
  );
  const radii = [];
  for (let i = 0; i < inward.length; i += 2)
    radii.push(Math.hypot(inward[i], inward[i + 1]));
  assert.ok(
    !radii.slice(1, -1).every((r) => Math.abs(r - 125) < 1e-6),
    "not the ring arc",
  );
  assert.ok(Math.max(...radii) <= 200 + 1e-6, "stays inside the outer end");
  assert.equal(stepCurveWeight(200, 50, 200, 50, 10, 100), 1, "child inside");
  assert.equal(
    stepCurveWeight(100, 200, 100, 200, 300, 150),
    1,
    "an arc much longer than the way across",
  );
  assert.equal(stepCurveWeight(100, 200, 100, 200, 200, 150), 0);
});

/** root → a → a1, root → b → b1, plus a cross-link a1 → b1 (a shared ingredient). */
function sharedIngredient() {
  const g = new Graph(
    ["root", "a", "b", "a1", "b1"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["root", "b"],
      ["a", "a1"],
      ["b", "b1"],
      ["a1", "b1"],
    ].map(([source, target]) => ({ source, target })),
  );
  radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  return g;
}

test("a cross-link bundles along the tree: from one end to the other via their common ancestor", () => {
  const g = sharedIngredient();
  const cross = g.edges.find((e) => !e.tree);
  assert.ok(cross, "the second way into b1 is a cross-link");
  const pts = bundledPoints(g, cross, 1);
  const s = g.byId.get("a1"),
    t = g.byId.get("b1"),
    root = g.byId.get("root");
  assert.deepEqual(pts.slice(0, 2), [s.x, s.y]);
  assert.deepEqual(pts.slice(-2), [t.x, t.y]);
  // Fully bundled, it bends in towards the root (the common ancestor), well off the straight line.
  let nearest = Infinity;
  for (let i = 0; i < pts.length; i += 2)
    nearest = Math.min(
      nearest,
      Math.hypot(pts[i] - root.x, pts[i + 1] - root.y),
    );
  const chordMid = Math.hypot(
    (s.x + t.x) / 2 - root.x,
    (s.y + t.y) / 2 - root.y,
  );
  assert.ok(nearest < chordMid * 0.7, `${nearest} vs ${chordMid}`);
  // Strength 0 is the straight line (sampled).
  const flat = bundledPoints(g, cross, 0);
  for (let i = 0; i < flat.length; i += 2) {
    const cross2 =
      (t.x - s.x) * (flat[i + 1] - s.y) - (t.y - s.y) * (flat[i] - s.x);
    assert.ok(Math.abs(cross2) / Math.hypot(t.x - s.x, t.y - s.y) < 1e-6);
  }
});

test("cross-links between separate trees go straight; straight edges stay straight; tree edges keep their shape", () => {
  const g = new Graph(
    ["a", "a1", "b", "b1"].map((id) => ({ id })),
    [
      ["a", "a1"],
      ["b", "b1"],
      ["a1", "b1"],
    ].map(([source, target]) => ({ source, target })),
  );
  // b's tree is reachable from a's through the cross-link, so the forest decides what's a root; whatever it
  // decides, a route must start and end at its nodes.
  const routing = radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  for (const e of g.edges) {
    const pts = edgeRoute(g, routing, "curve", e);
    assert.deepEqual(pts.slice(0, 2), [
      g.nodes[e.source].x,
      g.nodes[e.source].y,
    ]);
    assert.deepEqual(pts.slice(-2), [g.nodes[e.target].x, g.nodes[e.target].y]);
  }
  const shared = sharedIngredient();
  const cross = shared.edges.find((e) => !e.tree);
  assert.equal(
    edgeRoute(shared, { kind: "radial", cx: 0, cy: 0 }, "straight", cross)
      .length,
    4,
  );
});

test("step arcs never fall back on a radial tree nobody has moved", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = randomGraph(seed, 20 + seed * 5, 0.3 + (seed % 10) * 0.3);
    radialLayout(g, { spacing: seed % 2 ? "tidy" : "leaves" });
    for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
    for (const e of g.edges) {
      const s = g.nodes[e.source],
        t = g.nodes[e.target];
      const rs = Math.hypot(s.x, s.y),
        rt = Math.hypot(t.x, t.y);
      if (rs < 1e-6) continue;
      let d = Math.atan2(t.y, t.x) - Math.atan2(s.y, s.x);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const arc = ((rs + rt) / 2) * Math.abs(d);
      assert.equal(
        stepCurveWeight(rs, rt, rs, rt, arc, Math.hypot(t.x - s.x, t.y - s.y)),
        0,
        `seed ${seed}`,
      );
    }
  }
});

test("a clamped B-spline starts and ends on its end points", () => {
  const pts = bspline([
    [0, 0],
    [50, 100],
    [100, 0],
  ]);
  assert.deepEqual(pts.slice(0, 2), [0, 0]);
  assert.ok(Math.abs(pts.at(-2) - 100) < 1e-9 && Math.abs(pts.at(-1)) < 1e-9);
});

test("the root's radial edges stay spokes when physics nudges it off the centre", () => {
  const routing = { kind: "radial", cx: 0, cy: 0 };
  const root = { x: 20, y: -15, homeX: 0, homeY: 0 };
  const child = { x: 0, y: 150, homeX: 0, homeY: 150 };
  assert.deepEqual(
    edgePoints(routing, "step", root, child),
    [20, -15, 0, 150],
    "straight out",
  );
  // The curve leaves along the direction of the child, not of the drift.
  const pts = edgePoints(routing, "curve", root, child);
  for (let i = 0; i < pts.length; i += 2)
    assert.ok(pts[i + 1] >= -15 - 1e-9, "never swings back past the root");
});

test("a radial step edge whose ends have left their rings is drawn as a curve", () => {
  const routing = { kind: "radial", cx: 0, cy: 0 };
  const parent = { x: 100, y: 0, homeX: 100, homeY: 0 };
  const onRing = { x: 0, y: 200, homeX: 0, homeY: 200 };
  const arc = edgePoints(routing, "step", parent, onRing);
  assert.ok(
    Math.abs(Math.hypot(arc[4], arc[5]) - 150) < 1e-6,
    "on its ring: the ring arc",
  );
  const drifted = { x: 0, y: 140, homeX: 0, homeY: 200 }; // 60 in from its ring, more than a quarter of 100
  const curved = edgePoints(routing, "step", parent, drifted);
  assert.deepEqual(curved, edgePoints(routing, "curve", parent, drifted));
});

test("during a layout morph, step edges keep their arcs even off their rings (no curve-to-step blink)", () => {
  const parent = { x: 100, y: 0, homeX: 100, homeY: 0 };
  const travelling = { x: 0, y: 140, homeX: 0, homeY: 200 }; // between rings, on its way
  const settled = edgePoints(
    { kind: "radial", cx: 0, cy: 0 },
    "step",
    parent,
    travelling,
  );
  const morphing = edgePoints(
    { kind: "radial", cx: 0, cy: 0, morphing: true },
    "step",
    parent,
    travelling,
  );
  assert.deepEqual(
    settled,
    edgePoints({ kind: "radial", cx: 0, cy: 0 }, "curve", parent, travelling),
    "settled: off its ring, so a curve",
  );
  assert.ok(
    Math.abs(Math.hypot(morphing[4], morphing[5]) - 120) < 1e-6,
    "morphing: the arc, at the ring halfway",
  );
});
