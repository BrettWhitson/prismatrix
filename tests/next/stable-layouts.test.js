// Stable layouts under deltas: given the layout before a change as a hint, a layout keeps
// what stays where it was. The merged tree keeps its order and pulls kept nodes back; trees and radial trees move as
// a whole. With no hint, every layout is what it always was; with one, it's the same on the spot and in a worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import { LAYOUTS } from "../../next/engine/layouts.js";
import { resolve } from "../../next/engine/schema.js";
import { GraphController } from "../../next/engine/controller.js";
import {
  graphFromStructure,
  hintFrom,
  runLayout,
  sizingFrom,
  structureOf,
  unpackRouting,
  usableHint,
} from "../../next/engine/layout-job.js";

/** A fixture graph as prismatrix-graph JSON. */
const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/graphs/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const spec = (count) => ({
  widths: new Float64Array(count).fill(40),
  reach: new Float64Array(count).fill(8),
  height: 14,
  gap: 4,
  labels: "below",
  collide: true,
});

const options = (name, extra = {}) => ({
  ...resolve(LAYOUTS[name].options),
  ...extra,
});

/** Lay `json` out with layout `name`, with the layout `before` (if any) as its hint. */
function lay(json, name = "merged", before = null, extra = {}) {
  const g = new Graph(GraphModel.from(json));
  const hint = before ? hintFrom(before.g, g, before.routing) : null;
  const routing = LAYOUTS[name].run(
    g,
    options(name, extra),
    sizingFrom(spec(g.nodes.length)),
    hint,
  );
  return { g, routing, hint };
}

/** The share of `after`'s nodes also in `before` that moved more than 2 px, and their mean move. */
function moves(before, after) {
  let moved = 0,
    kept = 0,
    shift = 0;
  for (const n of after.g.nodes) {
    const was = before.g.byId.get(n.id);
    if (!was) continue;
    const d = Math.hypot(n.homeX - was.homeX, n.homeY - was.homeY);
    if (d > 2) moved++;
    shift += d;
    kept++;
  }
  return { moved: moved / kept, shift: shift / kept };
}

/** One-leaf changes: a new leaf under the node `at` of the way through, and the removal of the nearest leaf there. */
function oneLeafChanges(json, at) {
  const from = Math.floor(json.nodes.length * at);
  const parent = json.nodes[from].id;
  const users = new Set(json.edges.map((e) => e.source));
  let leaf = null;
  for (let d = 0; !leaf && d < json.nodes.length; d++)
    for (const i of [from + d, from - d])
      if (!leaf && json.nodes[i] && !users.has(json.nodes[i].id))
        leaf = json.nodes[i].id;
  return [
    {
      nodes: [...json.nodes, { id: "test-new" }],
      edges: [...json.edges, { source: parent, target: "test-new" }],
    },
    {
      nodes: json.nodes.filter((n) => n.id !== leaf),
      edges: json.edges.filter((e) => e.source !== leaf && e.target !== leaf),
    },
  ];
}

test("one leaf added or removed moves only a local neighbourhood of the merged tree, without adding crossings", () => {
  for (const name of [
    "crafting-medium",
    "crafting-shared-parts",
    "crafting-heavy-hubs",
    "crafting-large",
  ]) {
    const json = fixture(name);
    const before = lay(json);
    for (const at of [0.25, 0.5, 0.75])
      for (const changed of oneLeafChanges(json, at)) {
        const after = lay(changed, "merged", before);
        const { moved, shift } = moves(before, after);
        assert.ok(moved < 0.2, `${name} @${at}: ${moved * 100}% moved`);
        assert.ok(shift < 30, `${name} @${at}: mean move ${shift} px`);
        assert.ok(
          after.routing.crossings <= before.routing.crossings * 1.05 + 2,
          `${name} @${at}: ${before.routing.crossings} → ${after.routing.crossings} crossings`,
        );
        // Without the hint, nearly everything moves (what the hint is for).
        if (at === 0.5 && name === "crafting-medium")
          assert.ok(moves(before, lay(changed)).moved > 0.5);
      }
  }
});

test("collapsing and expanding a recipe in the merged tree keeps everything else in place", () => {
  const json = fixture("crafting-medium");
  const model = GraphModel.from(json);
  const forest = model.forest();
  // Recipes with a few ingredients under them, from different parts of the graph.
  const recipes = [0.2, 0.5, 0.8].map((at) => {
    const n = model.nodes.length;
    for (let d = 0; d < n; d++)
      for (const i of [Math.floor(n * at) + d, Math.floor(n * at) - d])
        if (forest.descendants[i] >= 3 && forest.descendants[i] <= 30)
          return model.nodes[i].id;
    return null;
  });
  const c = new GraphController(model, null, {
    worker: false,
    layout: "merged",
  });
  c.setViewport(800, 600);
  const homes = () =>
    new Map(c.graph.nodes.map((n) => [n.id, [n.homeX, n.homeY]]));
  const share = (a, b) => {
    let moved = 0,
      kept = 0;
    for (const [id, [x, y]] of b) {
      const was = a.get(id);
      if (!was) continue;
      if (Math.hypot(x - was[0], y - was[1]) > 2) moved++;
      kept++;
    }
    return moved / kept;
  };
  for (const id of recipes) {
    const start = homes();
    c.collapse(id);
    const folded = homes();
    assert.ok(folded.size < start.size, `${id} hid something`);
    assert.ok(share(start, folded) < 0.1, `collapsing ${id}`);
    c.expand(id, { depth: Infinity });
    const open = homes();
    assert.equal(open.size, start.size);
    assert.ok(share(folded, open) < 0.1, `expanding ${id}`);
    assert.ok(share(start, open) < 0.1, `${id} back about where it started`);
  }
  c.destroy();
});

test("with no hint every layout is as it was; with a hint at stability 0, the merged tree is the fresh drawing moved into place", () => {
  const json = fixture("crafting-shared-parts");
  const before = lay(json);
  const [changed] = oneLeafChanges(json, 0.5);
  const fresh = lay(changed);
  const placed = lay(changed, "merged", before, { stability: 0 });
  const dx = placed.g.nodes[0].homeX - fresh.g.nodes[0].homeX,
    dy = placed.g.nodes[0].homeY - fresh.g.nodes[0].homeY;
  for (const n of fresh.g.nodes) {
    const m = placed.g.nodes[n.index];
    assert.ok(Math.abs(m.homeX - n.homeX - dx) < 1e-6);
    assert.ok(Math.abs(m.homeY - n.homeY - dy) < 1e-6);
  }
  assert.equal(placed.routing.crossings, fresh.routing.crossings);
  // A hint is used only when it fits the graph: one that doesn't is ignored, as if there were none.
  const g = new Graph(GraphModel.from(changed));
  const bad = { x: new Float64Array(3), y: new Float64Array(3) };
  assert.equal(usableHint(bad, g.nodes.length, g.edges.length), false);
  const result = runLayout(
    g,
    "merged",
    options("merged"),
    spec(g.nodes.length),
    bad,
  );
  assert.deepEqual([...result.homeX], [...fresh.g.matrix.homeX]);
  // Nothing kept (every id new): nothing to hold, no hint.
  const other = new Graph(
    GraphModel.from({ nodes: [{ id: "elsewhere" }], edges: [] }),
  );
  assert.equal(hintFrom(before.g, other), null);
});

test("the same graph and hint give the same layout every time, on the spot and as a worker's job", () => {
  for (const name of ["merged", "tree", "radial"]) {
    const json = fixture("crafting-medium");
    const before = lay(json, name);
    for (const changed of oneLeafChanges(json, 0.4)) {
      const here = lay(changed, name, before);
      const again = lay(changed, name, before);
      assert.deepEqual([...again.g.matrix.homeX], [...here.g.matrix.homeX]);
      assert.deepEqual([...again.g.matrix.homeY], [...here.g.matrix.homeY]);
      // As a worker runs it: the structure alone, and the hint copied across as a worker would get it.
      const there = graphFromStructure(structureOf(here.g));
      const job = runLayout(
        there,
        name,
        options(name),
        spec(there.nodes.length),
        structuredClone(here.hint),
      );
      assert.deepEqual([...job.homeX], [...here.g.matrix.homeX], name);
      assert.deepEqual([...job.homeY], [...here.g.matrix.homeY], name);
      if (name === "merged") {
        const routing = unpackRouting(job.routing, here.g);
        assert.equal(routing.crossings, here.routing.crossings);
        assert.deepEqual(
          routing.references.map((r) => [r.edge.id, r.x, r.y]),
          here.routing.references.map((r) => [r.edge.id, r.x, r.y]),
        );
        for (const e of here.g.edges)
          assert.deepEqual(
            routing.bends.get(e) ?? [],
            here.routing.bends.get(e) ?? [],
          );
      }
    }
  }
});

test("the hint is found by id: homes, reference chips and bends, NaN for what's new; it works across partial graphs", () => {
  const json = fixture("crafting-heavy-hubs");
  const before = lay(json);
  const [changed] = oneLeafChanges(json, 0.3);
  const g = new Graph(GraphModel.from(changed));
  const hint = hintFrom(before.g, g, before.routing);
  assert.ok(usableHint(hint, g.nodes.length, g.edges.length));
  for (const n of g.nodes) {
    const was = before.g.byId.get(n.id);
    if (!was) assert.ok(Number.isNaN(hint.x[n.index]), "new: NaN");
    else {
      assert.equal(hint.x[n.index], was.homeX);
      assert.equal(hint.y[n.index], was.homeY);
    }
  }
  const index = new Map(g.edges.map((e, i) => [e.id, i]));
  for (const r of before.routing.references) {
    const i = index.get(r.edge.id);
    assert.equal(hint.refX[i], r.x);
    assert.equal(hint.refY[i], r.y);
  }
  for (const [e, points] of before.routing.bends) {
    const i = index.get(e.id);
    if (i === undefined) continue;
    const from = hint.bendStart[i];
    assert.equal(hint.bendStart[i + 1] - from, points.length);
    points.forEach(([x, y], k) => {
      assert.equal(hint.bendXY[(from + k) * 2], x);
      assert.equal(hint.bendXY[(from + k) * 2 + 1], y);
    });
  }
  // A partial graph (part of the model shown) is matched by id just the same.
  const model = GraphModel.from(json);
  const shown = [...Array(model.nodes.length).keys()].filter((i) => i % 3);
  const keep = new Set(shown);
  const edges = [];
  model.edges.forEach((_, i) => {
    const [s, t] = model.ends[i];
    if (keep.has(s) && keep.has(t)) edges.push(i);
  });
  const part = new Graph(model, {
    nodes: Int32Array.from(shown),
    edges: Int32Array.from(edges),
    key: "every third hidden",
  });
  const partHint = hintFrom(before.g, part, before.routing);
  for (const n of part.nodes)
    assert.equal(partHint.x[n.index], before.g.byId.get(n.id).homeX);
});

test("a tree and a radial tree move as a whole into place: kept nodes move less with the hint than without", () => {
  for (const name of ["tree", "radial"])
    for (const fixtureName of ["crafting-medium", "crafting-small"]) {
      const json = fixture(fixtureName);
      const before = lay(json, name);
      let withHint = 0,
        without = 0;
      for (const at of [0.25, 0.5, 0.75])
        for (const changed of oneLeafChanges(json, at)) {
          withHint += moves(before, lay(changed, name, before)).shift;
          without += moves(before, lay(changed, name)).shift;
        }
      assert.ok(
        withHint <= without + 1e-9,
        `${name} ${fixtureName}: ${withHint} vs ${without}`,
      );
    }
  // A tree's shape doesn't change with the hint: only where it is.
  const json = fixture("crafting-small");
  const before = lay(json, "tree");
  const [changed] = oneLeafChanges(json, 0.5);
  const fresh = lay(changed, "tree"),
    placed = lay(changed, "tree", before);
  const dx = placed.g.nodes[0].homeX - fresh.g.nodes[0].homeX;
  for (const n of fresh.g.nodes)
    assert.ok(Math.abs(placed.g.nodes[n.index].homeX - n.homeX - dx) < 1e-6);
  assert.ok(
    moves(before, placed).moved <= moves(before, fresh).moved,
    "no more nodes move",
  );
});

test("stability is a merged-tree option, 0 to 1 (0.5 by default)", () => {
  const opts = resolve(LAYOUTS.merged.options);
  assert.equal(opts.stability, 0.5);
  assert.equal(
    resolve(LAYOUTS.merged.options, { stability: 3 }, () => {}).stability,
    1,
  );
  // Stability 1: kept nodes don't move at all for a new leaf with room beside it.
  const json = fixture("crafting-medium");
  const before = lay(json);
  const [added] = oneLeafChanges(json, 0.5);
  const after = lay(added, "merged", before, { stability: 1 });
  assert.ok(moves(before, after).moved < 0.05);
});
