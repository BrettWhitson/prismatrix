// Removed nodes fold back into what's left of their family.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import {
  departures,
  foldTarget,
  withGhosts,
} from "../../next/engine/ghosts.js";

const graphOf = (nodes, edges = []) =>
  new Graph(GraphModel.from({ nodes, edges }));

/** root → a → a1 → a11, root → b. */
const big = () =>
  graphOf(
    ["root", "a", "b", "a1", "a11"].map((id) => ({ id, label: id })),
    [
      ["root", "a"],
      ["root", "b"],
      ["a", "a1"],
      ["a1", "a11"],
    ].map(([source, target]) => ({ source, target })),
  );
const looksOf = (g) => ({
  radius: g.nodes.map(() => 5),
  fill: g.nodes.map(() => "#ffffff"),
});
const place = (g) =>
  g.nodes.forEach((n, i) => ([n.x, n.y] = [i * 100, i * 10]));

test("departures: the nodes that left, parents first, each with its ancestors' ids", () => {
  const before = big();
  place(before);
  const after = graphOf(
    ["root", "b"].map((id) => ({ id })),
    [{ source: "root", target: "b" }],
  );
  const gone = departures(before, after, looksOf(before), 1000);
  assert.deepEqual(
    gone.map((g) => g.id),
    ["a", "a1", "a11"],
  );
  assert.deepEqual(gone[2].ancestors, ["a1", "a", "root"]);
  assert.deepEqual([gone[1].x0, gone[1].y0], [300, 30], "where it was");
});

test("a ghost folds to its nearest ancestor that's still there, or a ghost still leaving, or nowhere", () => {
  const after = graphOf(
    ["root", "b"].map((id) => ({ id })),
    [{ source: "root", target: "b" }],
  );
  const ghost = { ancestors: ["a1", "a", "root"] };
  assert.equal(foldTarget(ghost, after, new Set()).node.id, "root");
  assert.deepEqual(foldTarget(ghost, after, new Set(["a"])), { ghost: "a" });
  assert.equal(foldTarget({ ancestors: ["x"] }, after, new Set()), null);
});

test("ghosts glide onto their target, fading out, and are gone after the morph", () => {
  const before = big();
  place(before);
  const after = graphOf(
    ["root", "b"].map((id) => ({ id })),
    [{ source: "root", target: "b" }],
  );
  after.byId.get("root").x = 7;
  after.byId.get("root").y = 9;
  const ghosts = departures(before, after, looksOf(before), 0);
  const base = { looks: looksOf(after), shade: null, appear: null };
  const linear = (t) => t;
  const start = withGhosts(after, ghosts, base, 0, 500, linear);
  assert.equal(start.graph.nodes.length, 5, "two real nodes and three ghosts");
  const a = start.graph.nodes.find((n) => n.id === "a" && n.ghost);
  assert.deepEqual([a.x, a.y], [100, 10], "starts where it was");
  assert.equal(start.appear[a.index], 1);
  // A ghost edge from root (real) to a, and from a (ghost) to a1 (ghost).
  assert.equal(start.graph.edges.filter((e) => e.ghost).length, 3);

  const half = withGhosts(after, ghosts, base, 250, 500, linear);
  const a2 = half.graph.nodes.find((n) => n.id === "a" && n.ghost);
  assert.deepEqual(
    [a2.x, a2.y],
    [(100 + 7) / 2, (10 + 9) / 2],
    "halfway to root",
  );
  assert.equal(half.appear[a2.index], 0.5);
  // a1 follows a, which is itself halfway: a1 heads for wherever a is now.
  const a1 = half.graph.nodes.find((n) => n.id === "a1");
  assert.deepEqual([a1.x, a1.y], [(300 + a2.x) / 2, (30 + a2.y) / 2]);

  const done = withGhosts(after, ghosts, base, 500, 500, linear);
  assert.equal(done.graph, after, "the real graph again");
  assert.equal(done.live.length, 0);
});

test("no morph time, no ghosts", () => {
  const before = big();
  const after = graphOf([{ id: "root" }], []);
  const ghosts = departures(before, after, looksOf(before), 0);
  const out = withGhosts(
    after,
    ghosts,
    { looks: looksOf(after) },
    0,
    0,
    (t) => t,
  );
  assert.equal(out.graph, after);
});
