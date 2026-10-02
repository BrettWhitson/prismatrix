// Physics at scale: busy nodes stay stable, the simulation falls asleep and then costs nothing, and the grid that
// finds near pairs finds exactly the pairs a brute-force search does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { radialLayout, treeLayout } from "../../next/engine/layouts.js";
import {
  NearGrid,
  Simulation,
  physicsOptions,
  referencedEdges,
} from "../../next/engine/physics.js";
import { GraphController } from "../../next/engine/controller.js";
import { GraphModel } from "../../next/engine/model.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** One busy ingredient used by `degree` recipes. */
function star(degree) {
  const ids = ["hub", ...Array.from({ length: degree }, (_, i) => `r${i}`)];
  return new Graph(
    ids.map((id) => ({ id })),
    ids.slice(1).map((source) => ({ source, target: "hub" })),
  );
}

/** A recipe-shaped graph: a tree plus shared ingredients. */
function recipes(count, shared, seed = 3) {
  const r = rng(seed);
  const nodes = [{ id: "n0", label: "root item" }],
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

/**
 * Drag a star's hub 150 px off, hold it half a second, let go, and run for `seconds`. Returns the furthest any node
 * got from home after the release, where the hub ended up, and when the simulation fell asleep (-1: never).
 */
function dragHub(
  degree,
  layout,
  { links = 200, unitMass = false, seconds = 6 } = {},
) {
  const g = star(degree);
  (layout === "tree" ? treeLayout : radialLayout)(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  sim.configure(
    "elastic",
    physicsOptions(layout, "elastic", { links, collide: false }),
  );
  if (unitMass) sim.inverseMass.fill(1);
  const hub = g.byId.get("hub");
  sim.held.add(hub.index);
  hub.x += 150;
  for (let s = 0; s < 60; s++) sim.step(1 / 120);
  sim.held.delete(hub.index);
  sim.wake();
  let worst = 0,
    asleep = -1;
  for (let s = 0; s < seconds * 120; s++) {
    sim.step(1 / 120);
    for (const n of g.nodes) {
      const off = Math.hypot(n.x - n.homeX, n.y - n.homeY);
      if (!(off <= worst)) worst = off; // NaN counts as worst
    }
    if (asleep < 0 && sim.asleep) asleep = s / 120;
  }
  const hubOff = Math.hypot(hub.x - hub.homeX, hub.y - hub.homeY);
  return { worst, hubOff, asleep, mass: 1 / sim.inverseMass[hub.index] };
}

// ---- stability around busy nodes ----------------------------------------------------------------------------

test("a hub used 1,000 to 5,000 times at the strongest links stays bounded, springs home and sleeps", () => {
  for (const layout of ["tree", "radial"])
    for (const degree of [1000, 2500, 5000]) {
      const r = dragHub(degree, layout);
      const what = `${layout}, degree ${degree}`;
      assert.ok(r.mass > 1, `${what}: the hub is heavier`);
      assert.ok(
        r.worst <= 165,
        `${what}: nothing overshot the 150 px drag by much (${r.worst})`,
      );
      assert.ok(r.hubOff < 1, `${what}: the hub is home (${r.hubOff})`);
      assert.ok(
        r.asleep >= 0 && r.asleep < 4,
        `${what}: asleep after ${r.asleep}s`,
      );
    }
});

test("the same hub with unit mass is what blew up: it never settles", () => {
  const r = dragHub(1000, "tree", { unitMass: true, seconds: 4 });
  assert.equal(r.asleep, -1);
  assert.ok(r.hubOff > 5, `still shaking ${r.hubOff} px from home`);
});

test("ordinary nodes keep unit mass; only a node too busy for the step gets heavier, just enough", () => {
  const g = star(300);
  treeLayout(g, {});
  const sim = new Simulation(g);
  const opts = physicsOptions("tree", "elastic"); // links 40, anchor 60
  sim.configure("elastic", opts);
  assert.ok(
    sim.inverseMass.every((v) => v === 1),
    "300 users at the default stiffness",
  );

  const busy = star(1000);
  treeLayout(busy, {});
  const heavy = new Simulation(busy);
  heavy.configure("elastic", opts);
  const h = 1 / 120;
  const mass = 1 / heavy.inverseMass[busy.byId.get("hub").index];
  const bound = h * h * ((2 * opts.links * 1000) / mass + opts.anchor);
  assert.ok(
    Math.abs(bound - 2) < 1e-9,
    "h²·(2·links·d/m + anchor) is held at 2",
  );
  assert.equal(heavy.inverseMass[busy.byId.get("r0").index], 1);

  // Static has no springs, so nothing needs mass.
  heavy.configure("static", physicsOptions("tree", "static"));
  assert.ok(heavy.inverseMass.every((v) => v === 1));
});

test("floating keeps a busy hub stable too", () => {
  const g = star(2000);
  radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const sim = new Simulation(g);
  sim.configure(
    "floating",
    physicsOptions("radial", "floating", { links: 200, collide: false }),
  );
  const hub = g.byId.get("hub");
  hub.x += 100;
  sim.wake();
  let t = 0,
    furthest = 0;
  for (; t < 20 && !sim.asleep; t += 1 / 60) {
    sim.advance(1 / 60);
    for (const n of g.nodes)
      furthest = Math.max(furthest, Math.hypot(n.x - n.homeX, n.y - n.homeY));
  }
  assert.ok(sim.asleep, "it settles");
  // Floating forgets the layout, so nodes drift a little; nothing is flung off.
  assert.ok(
    Number.isFinite(furthest) && furthest < 200,
    `bounded (${furthest})`,
  );
});

test("edges drawn as references have no spring: dragging a recipe doesn't tug its far-away ingredient", () => {
  // a uses c directly and b, which also uses c; a → c is drawn as a reference.
  const g = new Graph(
    ["a", "b", "c"].map((id) => ({ id })),
    [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
    ],
  );
  treeLayout(g, {});
  const mask = referencedEdges(g, [{ edge: g.edges[2] }]);
  assert.deepEqual([...mask], [0, 0, 1]);
  assert.equal(referencedEdges(g, []), null);
  assert.equal(referencedEdges(g, undefined), null);

  const pull = (loose) => {
    for (const n of g.nodes) [n.x, n.y, n.vx, n.vy] = [n.homeX, n.homeY, 0, 0];
    const sim = new Simulation(g);
    sim.configure(
      "elastic",
      physicsOptions("tree", "elastic"),
      null,
      null,
      loose,
    );
    const [a, , c] = g.nodes;
    sim.held.add(a.index);
    a.x += 300;
    sim.step(1 / 120);
    return c.vx;
  };
  assert.ok(pull(null) > 0, "with every spring, c is pulled straight away");
  assert.equal(
    pull(mask),
    0,
    "without the reference's spring, nothing reaches c in one step",
  );
});

// ---- sleep -------------------------------------------------------------------------------------------------

test("a big graph shaken in every mode falls asleep, and asleep costs nothing until it's woken", () => {
  for (const [layout, physics] of [
    ["tree", "elastic"],
    ["radial", "elastic"],
    ["radial", "floating"],
  ]) {
    const c = new GraphController(new GraphModel(recipes(3000, 300)), null, {
      layout,
      physics,
      worker: false,
      clock: () => 1000,
    });
    c.setViewport(1200, 800);
    c.run(1000, { start: 1000 });
    const { sim } = c;
    assert.ok(sim.collision, "collisions on");
    const m = c.graph.matrix;
    const r = rng(11);
    for (let i = 0; i < m.count; i++) {
      m.vx[i] = (r() - 0.5) * 400;
      m.vy[i] = (r() - 0.5) * 400;
    }
    sim.wake();
    let t = 0;
    for (; t < 15 && !sim.asleep; t += 1 / 60) sim.advance(1 / 60);
    assert.ok(sim.asleep, `${layout}/${physics} asleep (${t.toFixed(1)}s)`);

    // Asleep, a frame does nothing at all: not even a node put somewhere else springs back.
    const x = m.x.slice();
    m.x[5] += 50;
    const steps = sim.time;
    sim.advance(1 / 60);
    assert.equal(sim.time, steps, "no steps run");
    assert.equal(sim.moved, false);
    assert.equal(m.x[5], x[5] + 50);
    // Woken, it does.
    sim.wake();
    sim.advance(1 / 60);
    assert.ok(sim.time > steps);
  }
});

test("physics allocates nothing per step: its grids and columns are kept and reused", () => {
  const g = new Graph(recipes(500, 50).nodes, recipes(500, 50).edges);
  radialLayout(g, {});
  const r = rng(5);
  for (const n of g.nodes) {
    [n.x, n.y] = [n.homeX + r() * 20, n.homeY + r() * 20];
    n.box = { x0: -8, y0: -8, x1: 30 + r() * 60, y1: 8 };
  }
  g.nodes[7].box = { x0: -8, y0: -8, x1: 5000, y1: 8 }; // one huge label
  const sim = new Simulation(g);
  sim.configure("floating", physicsOptions("radial", "floating"), null, {
    boxes: true,
    padding: 4,
  });
  const arrays = () => [
    sim.cx,
    sim.hw,
    sim.pushX,
    ...[...sim.collisionGrids, sim.repulsionGrid].flatMap((grid) =>
      ["start", "items", "cellX", "placeX", "gx", "slot", "seen"].map(
        (a) => grid[a],
      ),
    ),
  ];
  sim.step(1 / 120);
  const before = arrays();
  for (let s = 0; s < 50; s++) sim.step(1 / 120);
  const after = arrays();
  after.forEach((a, k) =>
    assert.equal(a, before[k], `array ${k} was replaced`),
  );
});

// ---- the near-pairs grid -----------------------------------------------------------------------------------

/** Every unordered pair the grid visits, as "i,j", failing on any pair visited twice or out of order. */
function gridPairs(grid) {
  const seen = new Set();
  grid.eachPair((i, j) => {
    assert.ok(i < j, `pair ${i},${j} in order`);
    const key = `${i},${j}`;
    assert.ok(!seen.has(key), `pair ${key} visited once`);
    seen.add(key);
  });
  return seen;
}

test("the grid finds every pair within a cell of each other, each once, wherever the points are", () => {
  const r = rng(42);
  for (const [count, spread, cell] of [
    [400, 1000, 50], // dense
    [400, 1e6, 50], // sparse: cells far apart share slots in the table
    [64, 3e5, 1], // tiny cells, far more cells than slots
    [300, 200, 500], // everything in a few cells
  ]) {
    const px = Float64Array.from({ length: count }, () => (r() - 0.5) * spread);
    const py = Float64Array.from({ length: count }, () => (r() - 0.5) * spread);
    // Some points stacked exactly, some on cell borders.
    px[1] = px[0];
    py[1] = py[0];
    px[2] = cell * 3;
    px[3] = cell * 3 - 1e-9;
    py[2] = py[3] = 0;
    const grid = new NearGrid();
    grid.build(px, py, count, cell);
    const found = gridPairs(grid);
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++)
        if (Math.abs(px[i] - px[j]) < cell && Math.abs(py[i] - py[j]) < cell)
          assert.ok(
            found.has(`${i},${j}`),
            `missed ${i},${j} (${count} in ${spread})`,
          );
  }
});

test("a grid built again for fewer or more points, or with some left out, still finds exactly its pairs", () => {
  const r = rng(9);
  const grid = new NearGrid();
  for (const count of [200, 50, 900]) {
    const px = Float64Array.from({ length: count }, () => r() * 600);
    const py = Float64Array.from({ length: count }, () => r() * 600);
    const skip = Uint8Array.from({ length: count }, () => (r() < 0.2 ? 1 : 0));
    grid.build(px, py, count, 40, skip);
    const found = gridPairs(grid);
    for (const key of found) {
      const [i, j] = key.split(",").map(Number);
      assert.ok(!skip[i] && !skip[j], "left-out points have no pairs");
    }
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++)
        if (
          !skip[i] &&
          !skip[j] &&
          Math.abs(px[i] - px[j]) < 40 &&
          Math.abs(py[i] - py[j]) < 40
        )
          assert.ok(found.has(`${i},${j}`));
  }
});

test("eachIn finds exactly the points inside a rectangle, each once, small or huge", () => {
  const r = rng(3);
  const count = 500;
  const px = Float64Array.from({ length: count }, () => (r() - 0.5) * 4000);
  const py = Float64Array.from({ length: count }, () => (r() - 0.5) * 4000);
  const grid = new NearGrid();
  grid.build(px, py, count, 30);
  for (const [x0, y0, x1, y1] of [
    [-100, -100, 100, 100],
    [-2000, -50, 2000, 50], // one long label
    [-1e6, -1e6, 1e6, 1e6], // more cells than points: a plain scan
  ]) {
    const got = [];
    grid.eachIn(x0, y0, x1, y1, (i) => got.push(i));
    const want = [];
    for (let i = 0; i < count; i++)
      if (px[i] >= x0 && px[i] <= x1 && py[i] >= y0 && py[i] <= y1)
        want.push(i);
    assert.deepEqual(
      got.sort((a, b) => a - b),
      want,
    );
  }
});

test("collision tries every overlapping pair exactly once, huge labels included, and only nearby ones", () => {
  const r = rng(17);
  for (const boxes of [true, false]) {
    const count = 600;
    const g = new Graph(
      Array.from({ length: count }, (_, i) => ({ id: `n${i}` })),
      [],
    );
    for (const n of g.nodes) {
      [n.x, n.y] = [r() * 1500, r() * 1500];
      n.radius = 4 + r() * 10;
      // Every tenth label long, the rest short: footprints of every size class.
      const long = r() < 0.1 ? 150 + r() * 400 : r() * 80;
      n.box = {
        x0: -n.radius,
        y0: -n.radius,
        x1: n.radius + long,
        y1: n.radius,
      };
    }
    // A label as wide as the whole graph, two far wider still, and big circles.
    g.nodes[13].box = { x0: -10, y0: -10, x1: 20000, y1: 10 };
    g.nodes[15].box = { x0: -10, y0: -10, x1: 1e6, y1: 10 };
    g.nodes[16].box = { x0: -1e6, y0: -10, x1: 10, y1: 10 };
    g.nodes[16].y = g.nodes[15].y + 5;
    g.nodes[14].radius = 400;
    g.nodes[17].radius = 3e5;
    const sim = new Simulation(g);
    const padding = 4;
    sim.configure(
      "floating",
      physicsOptions("radial", "floating", {
        repulsion: 0,
        links: 0,
        memory: 0,
      }),
      null,
      { boxes, padding },
    );
    // Record what collision is offered, without pushing anything (so the overlaps stay as they were).
    const offered = new Map();
    sim.separate = (a, b) => {
      assert.ok(a < b);
      const key = `${a},${b}`;
      offered.set(key, (offered.get(key) ?? 0) + 1);
    };
    sim.step(1 / 120);
    const m = g.matrix;
    let overlaps = 0;
    for (let a = 0; a < count; a++)
      for (let b = a + 1; b < count; b++) {
        const overlap = boxes
          ? Math.min(m.x[a] + m.boxX1[a], m.x[b] + m.boxX1[b]) -
              Math.max(m.x[a] + m.boxX0[a], m.x[b] + m.boxX0[b]) +
              padding >
              0 &&
            Math.min(m.y[a] + m.boxY1[a], m.y[b] + m.boxY1[b]) -
              Math.max(m.y[a] + m.boxY0[a], m.y[b] + m.boxY0[b]) +
              padding >
              0
          : Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]) <
            m.radius[a] + m.radius[b] + padding;
        if (!overlap) continue;
        overlaps++;
        assert.equal(
          offered.get(`${a},${b}`),
          1,
          `${boxes ? "boxes" : "circles"}: ${a},${b} once`,
        );
      }
    assert.ok(overlaps > 50, "the test has overlaps to find");
    for (const n of offered.values()) assert.equal(n, 1);
    // Candidates stay local: within a few of their own sizes and a couple of typical cells of each other (one huge
    // label used to make the cells huge, and every pair a candidate).
    const { cx, cy, hw, hh, level } = sim;
    const size = (i) => Math.max(hw[i], hh[i]);
    const sizes = Array.from({ length: count }, (_, i) => size(i)).sort(
      (a, b) => a - b,
    );
    const cell = sim.collisionGrids[0].cell;
    assert.ok(cell <= 8 * sizes[count >> 1], `cells stay small (${cell})`);
    assert.ok(new Set(level).size >= 3, "footprints at several levels");
    assert.ok(level.includes(255), "and some too big for any");
    for (const key of offered.keys()) {
      const [a, b] = key.split(",").map(Number);
      const near = 4 * (size(a) + size(b)) + 2 * cell;
      assert.ok(Math.abs(cx[a] - cx[b]) <= near, key);
      assert.ok(Math.abs(cy[a] - cy[b]) <= near, key);
    }
    assert.ok(
      offered.size < (count * (count - 1)) / 20,
      `${offered.size} candidates`,
    );
  }
});

test("collision with a huge label and many long ones still pushes the nodes under it out, in about linear time", () => {
  const time = (count) => {
    const g = new Graph(
      Array.from({ length: count }, (_, i) => ({ id: `n${i}` })),
      [],
    );
    g.nodes.forEach((n, i) => {
      [n.x, n.y] = [(i % 200) * 30, Math.floor(i / 200) * 30];
      // Every tenth label is long: footprints well over the typical size, but far too many to try against each other.
      n.box = { x0: -8, y0: -8, x1: i % 10 === 5 ? 200 : 8, y1: 8 };
    });
    g.nodes[0].box = { x0: -8, y0: -8, x1: 1e6, y1: 8 }; // reaches across everything
    const sim = new Simulation(g);
    sim.configure(
      "floating",
      physicsOptions("radial", "floating", {
        repulsion: 0,
        links: 0,
        memory: 0,
      }),
      null,
      { boxes: true, padding: 4 },
    );
    sim.step(1 / 120);
    const start = performance.now();
    for (let s = 0; s < 5; s++) sim.step(1 / 120);
    return { ms: performance.now() - start, g };
  };
  const { g } = time(2000);
  // Every node on the huge label's row was pushed off it.
  const label = g.nodes[0];
  for (let i = 1; i < 200; i++) {
    const n = g.nodes[i];
    assert.ok(
      Math.abs(n.y - label.y) >= 8 + 8 + 4 - 1e-6,
      `n${i} pushed off the label`,
    );
  }
  const small = time(4000).ms,
    big = time(40000).ms;
  assert.ok(
    big < small * 40,
    `10× the nodes took ${(big / small).toFixed(1)}× as long`,
  );
});
