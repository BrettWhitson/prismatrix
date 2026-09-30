// The force simulation's edge cases: settling is deterministic, and nothing piles up on one point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutGraph } from "../src/layout-graph.js";
import { runLayout } from "../src/run-layout.js";
import { ForceSimulation } from "../src/physics.js";
import { PHYSICS_TUNING } from "../src/tuning.js";

const SETTINGS = {
  direction: "BT",
  physicsMode: "floating",
  centerForce: 0.2,
  repelForce: 8,
  linkForce: 0.5,
  linkDistance: 120,
};

function tree(count) {
  return new LayoutGraph(
    Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      w: 40,
      h: 40,
      root: i === 0,
    })),
    Array.from({ length: count - 1 }, (_, i) => ({
      source: `n${Math.floor(i / 3)}`,
      target: `n${i + 1}`,
    })),
  );
}

test("floating graphs settle by a work budget, not the clock: the same graph always lands the same", () => {
  const a = tree(120),
    b = tree(120);
  runLayout(a, SETTINGS);
  runLayout(b, SETTINGS);
  assert.deepEqual([...a.x], [...b.x]);
  assert.deepEqual([...a.y], [...b.y]);
  // A tiny budget caps the ticks: count × ticks ≤ settleWork (at least one tick).
  const tuning = { ...PHYSICS_TUNING, settleWork: 120 * 3, stillness: 0 };
  const capped = tree(120),
    manual = tree(120);
  runLayout(capped, SETTINGS, { tuning });
  const simulation = runLayout(manual, SETTINGS, { tuning, settle: false });
  simulation.run(); // what simulateForces does first, then equilibrate:
  simulation.alpha = simulation.alphaTarget = tuning.dragHeat;
  for (let k = 0; k < 3; k++) simulation.tick(0);
  simulation.writeTo(manual);
  assert.deepEqual([...capped.x], [...manual.x]);
});

test("nodes stacked on one point push apart", () => {
  const graph = new LayoutGraph(
    Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, w: 0, h: 0 })),
    [],
  );
  const simulation = new ForceSimulation(graph, {
    center: 0.2,
    repel: 8,
    link: 0,
    distance: 120,
  });
  simulation.run();
  const spots = new Set(
    simulation.ids.map(
      (_, i) => `${simulation.x[i].toFixed(1)},${simulation.y[i].toFixed(1)}`,
    ),
  );
  assert.equal(spots.size, 80);
});

test("parts of the graph the root doesn't reach are placed like any other branch", () => {
  const graph = new LayoutGraph(
    ["root", "a", "b", "c", "d"].map((id, i) => ({
      id,
      w: 40,
      h: 40,
      root: i === 0,
    })),
    [
      { source: "root", target: "a" },
      { source: "root", target: "b" },
      { source: "c", target: "d" }, // not reached from the root
    ],
  );
  runLayout(graph, {
    ...SETTINGS,
    physicsMode: "elastic",
    direction: "radial",
  });
  const root = graph.positionOf("root");
  const distance = (id) => {
    const p = graph.positionOf(id);
    return Math.hypot(p.x - root.x, p.y - root.y);
  };
  assert.ok(distance("c") > 0.8 * distance("a"), "c sits on the first ring");
  assert.ok(distance("d") > distance("c"), "d sits further out, under c");
  for (const id of graph.ids) {
    const p = graph.positionOf(id);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});
