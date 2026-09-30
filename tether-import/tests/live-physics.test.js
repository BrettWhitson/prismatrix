// The physics after the layout: dragging in both modes, shaking, floating in, stopping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutGraph } from "../src/layout-graph.js";
import { runLayout } from "../src/run-layout.js";
import { LivePhysics } from "../src/live-physics.js";

const LINKS = [
  ["root", "a"],
  ["root", "b"],
  ["a", "c"],
  ["a", "d"],
  ["b", "e"],
].map(([source, target]) => ({ source, target }));
const IDS = ["root", "a", "b", "c", "d", "e", "loner"];

/** A laid-out graph and physics on it; `positions` is what a renderer would be showing. */
function setUp(physicsMode, settle = true) {
  const settings = {
    direction: "TB",
    physicsMode,
    centerForce: 0.2,
    repelForce: 8,
    linkForce: 0.5,
    linkDistance: 120,
  };
  const graph = new LayoutGraph(
    IDS.map((id, i) => ({ id, w: 40, h: 40, root: i === 0 })),
    LINKS,
  );
  const physics = new LivePhysics(settings);
  physics.simulation = runLayout(graph, settings, { settle });
  const positions = new Map(IDS.map((id) => [id, graph.positionOf(id)]));
  const positionOf = (id) => ({ ...positions.get(id) });
  /** Step until still (or `frames` run out), applying what moved; returns the frames taken. */
  const run = (frames = 2000) => {
    let n = 0;
    while (physics.active && n++ < frames)
      for (const [id, x, y] of physics.step().moved)
        positions.set(id, { x, y });
    return n;
  };
  const graphOnScreen = { ids: IDS, links: LINKS, positionOf };
  return { physics, settings, positions, positionOf, run, graphOnScreen };
}

const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

test("elastic: a dragged node pulls its neighbours, the pull fades by link, and the unlinked stay put", () => {
  const { physics, positions, positionOf, run, graphOnScreen } =
    setUp("elastic");
  const start = new Map(IDS.map((id) => [id, positionOf(id)]));
  physics.grab("a", graphOnScreen);
  assert.ok(physics.active);
  const target = { x: start.get("a").x + 200, y: start.get("a").y };
  positions.set("a", target); // the renderer moves the held node itself
  physics.drag("a", target);
  run();
  physics.release("a");
  run();
  assert.equal(physics.active, false);
  assert.equal(physics.elasticNet, null, "let go and still: the net is done");

  const moved = (id) => distance(positions.get(id), start.get(id));
  assert.ok(moved("c") > 20, "a child follows");
  assert.ok(moved("root") > 1, "the parent gives a little");
  assert.ok(moved("c") > moved("e"), "two links away moves less than one");
  assert.equal(moved("loner"), 0, "not linked: not moved");
});

test("floating: grabbing wakes the whole simulation, and it settles after release", () => {
  const { physics, positions, positionOf, run, graphOnScreen } =
    setUp("floating");
  const start = positionOf("a");
  physics.grab("a", graphOnScreen);
  const target = { x: start.x + 150, y: start.y + 40 };
  positions.set("a", target);
  physics.drag("a", target);
  for (let i = 0; i < 30; i++) physics.step();
  assert.ok(physics.active, "still live while held");
  physics.release("a");
  const frames = run();
  assert.equal(physics.active, false, `settled (after ${frames} frames)`);
});

test("shake scatters and settles; floatIn runs a seed layout into place; stop stops", () => {
  const { physics, positionOf, run } = setUp("floating", false);
  assert.ok(physics.floatIn());
  run();
  assert.equal(physics.active, false);

  assert.ok(physics.shake(positionOf, { heat: 0.8, scatter: 100 }));
  const first = physics.step();
  assert.ok(first.moving && first.moved.length === physics.simulation.count);
  run();
  assert.equal(physics.active, false);

  physics.shake(positionOf);
  physics.stop();
  assert.equal(physics.active, false);
  assert.deepEqual(physics.step(), { moving: false, moved: [] });
});

test("without a simulation, floating and shaking do nothing", () => {
  const physics = new LivePhysics({
    direction: "TB",
    physicsMode: "floating",
    linkForce: 0.5,
    centerForce: 0.2,
  });
  assert.equal(physics.floatIn(), false);
  assert.equal(
    physics.shake(() => ({ x: 0, y: 0 })),
    false,
  );
  physics.drag("a", { x: 1, y: 1 });
  physics.release("a");
  assert.equal(physics.active, false);
});

test("a drag stays in the mode it started in, even if the setting changes before it ends", () => {
  const { physics, settings, positions, positionOf, run, graphOnScreen } =
    setUp("floating");
  physics.grab("a", graphOnScreen);
  settings.physicsMode = "elastic"; // changed mid-drag
  const p = positionOf("a");
  positions.set("a", { x: p.x + 50, y: p.y });
  physics.drag("a", { x: p.x + 50, y: p.y });
  physics.release("a");
  run();
  assert.equal(physics.active, false, "the simulation cooled and stopped");
  const i = physics.simulation.indexById.get("a");
  assert.ok(Number.isNaN(physics.simulation.fx[i]), "the node was let go");
});

test("stop lets go of a held node; a new simulation stops the old run; release without a grab does nothing", () => {
  const { physics, graphOnScreen } = setUp("floating");
  physics.grab("a", graphOnScreen);
  const simulation = physics.simulation;
  physics.stop();
  const i = simulation.indexById.get("a");
  assert.ok(Number.isNaN(simulation.fx[i]));
  assert.equal(simulation.alphaTarget, 0);

  physics.grab("a", graphOnScreen);
  physics.simulation = null; // the graph was replaced mid-drag
  assert.equal(physics.active, false);
  assert.deepEqual(physics.step(), { moving: false, moved: [] });
  assert.ok(Number.isNaN(simulation.fx[i]), "the old simulation let go too");

  physics.release("nobody");
  physics.drag("nobody", { x: 0, y: 0 });
  assert.equal(physics.active, false);
});

test("elastic: nodes without a position sit the drag out instead of breaking it", () => {
  const { physics, positionOf, run } = setUp("elastic");
  const partial = (id) => (id === "e" ? undefined : positionOf(id));
  physics.grab("a", { ids: IDS, links: LINKS, positionOf: partial });
  assert.ok(physics.active);
  physics.drag("a", { x: positionOf("a").x + 80, y: positionOf("a").y });
  physics.release("a");
  run();
  assert.equal(physics.active, false);
  // Grabbing a node with no position does nothing.
  physics.grab("e", { ids: IDS, links: LINKS, positionOf: partial });
  assert.equal(physics.active, false);
});

test("floating in always ends, after floatInTicks at most", () => {
  const { physics, run } = setUp("floating", false);
  physics.tuning = { floatInTicks: 50, stillness: 0 }; // stillness 0: it would never go still on its own
  assert.ok(physics.floatIn());
  const frames = run(1000);
  assert.equal(physics.active, false);
  assert.ok(frames <= 50, `${frames} frames`);
});

test("floating: touching and letting go moves nothing; a drag settles quickly, without the far graph wandering", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const nodes = [],
    edges = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push({
      id: `n${i}`,
      w: 48,
      h: 48,
      fullW: 48 + random() * 120,
      fullH: 64,
      root: i === 0,
    });
    if (i)
      edges.push({
        source: `n${Math.floor(random() ** 1.5 * i)}`,
        target: `n${i}`,
      });
  }
  for (const direction of ["LR", "radial"]) {
    const settings = {
      direction,
      physicsMode: "floating",
      centerForce: 0.2,
      repelForce: 8,
      linkForce: 0.5,
      linkDistance: 120,
    };
    const run = (drag) => {
      const graph = new LayoutGraph(nodes, edges);
      const physics = new LivePhysics(settings);
      physics.simulation = runLayout(graph, settings);
      const start = graph.positions();
      const now = new Map(start);
      physics.grab("n333", {
        ids: graph.ids,
        links: edges,
        positionOf: (id) => now.get(id),
      });
      const p = start.get("n333");
      for (let f = 0; f < 30; f++) {
        if (drag) physics.drag("n333", { x: p.x + f * 3, y: p.y });
        for (const [id, x, y] of physics.step().moved) now.set(id, { x, y });
      }
      physics.release("n333");
      let frames = 0;
      while (physics.active && frames++ < 1000)
        for (const [id, x, y] of physics.step().moved) now.set(id, { x, y });
      const moved = [...start].map(([id, a]) =>
        Math.hypot(now.get(id).x - a.x, now.get(id).y - a.y),
      );
      return { frames, moved: moved.sort((a, b) => b - a) };
    };
    const touched = run(false);
    assert.equal(touched.moved[0], 0, `${direction}: a touch moves nothing`);
    const dragged = run(true);
    assert.ok(
      dragged.frames < 200,
      `${direction}: settles in ${dragged.frames} frames`,
    );
    // Most of the graph stays exactly where it was.
    const still = dragged.moved.filter((d) => d < 0.5).length;
    assert.ok(
      still > nodes.length * 0.6,
      `${direction}: ${still} of ${nodes.length} nodes stay put`,
    );
  }
});

test("floating: a dragged leaf tugs its product, more the further it's pulled; a radial graph doesn't spin", () => {
  const nodes = [{ id: "r", w: 48, h: 48, root: true }],
    edges = [];
  for (let p = 0; p < 3; p++) {
    nodes.push({ id: `p${p}`, w: 48, h: 48 });
    edges.push({ source: "r", target: `p${p}` });
    for (let l = 0; l < 6; l++) {
      nodes.push({ id: `l${p}${l}`, w: 48, h: 48 });
      edges.push({ source: `p${p}`, target: `l${p}${l}` });
    }
  }
  for (const direction of ["TB", "radial"]) {
    const response = (nudge) => {
      const settings = {
        direction,
        physicsMode: "floating",
        centerForce: 0.2,
        repelForce: 8,
        linkForce: 0.5,
        linkDistance: 120,
      };
      const graph = new LayoutGraph(nodes, edges);
      const physics = new LivePhysics(settings);
      physics.simulation = runLayout(graph, settings);
      const start = graph.positions();
      const now = new Map(start);
      physics.grab("l10", {
        ids: graph.ids,
        links: edges,
        positionOf: (id) => now.get(id),
      });
      const leaf = start.get("l10"),
        product = start.get("p1");
      const dx = leaf.x - product.x,
        dy = leaf.y - product.y,
        length = Math.hypot(dx, dy);
      physics.drag("l10", {
        x: leaf.x + (dx / length) * nudge,
        y: leaf.y + (dy / length) * nudge,
      });
      for (let f = 0; f < 90; f++)
        for (const [id, x, y] of physics.step().moved) now.set(id, { x, y });
      const moved = (id) =>
        Math.hypot(
          now.get(id).x - start.get(id).x,
          now.get(id).y - start.get(id).y,
        );
      return {
        product: moved("p1"),
        others: Math.max(...["p0", "p2", "l00", "l25"].map(moved)),
      };
    };
    const small = response(20),
      medium = response(40),
      large = response(80);
    assert.ok(
      small.product > 0.5,
      `${direction}: a 20-unit pull moves the product (${small.product})`,
    );
    assert.ok(
      small.product < medium.product && medium.product < large.product,
      `${direction}: the further the pull, the more the product follows (${small.product}, ${medium.product}, ${large.product})`,
    );
    assert.ok(
      large.others < large.product,
      `${direction}: other branches move less than the pulled one`,
    );
  }
});
