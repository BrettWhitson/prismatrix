// The merged tree: a layered drawing (Sugiyama) of a graph where nodes can have several parents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graph } from "../../next/engine/graph.js";
import { GraphModel } from "../../next/engine/model.js";
import {
  countCrossings,
  layeredLayout,
  project,
} from "../../next/engine/layered.js";
import { edgeRoute } from "../../next/engine/geometry.js";
import { lineage } from "../../next/engine/render.js";
import { networkSimplex } from "../../next/engine/simplex.js";
import { globalSifting } from "../../next/engine/sifting.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A random tree plus `shared` extra edges from earlier to later nodes: shared ingredients, no cycles. */
function recipes(seed, count, shared) {
  const r = rng(seed);
  const nodes = [{ id: "0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: String(i) });
    edges.push({
      source: String(Math.floor(r() ** 1.3 * i)),
      target: String(i),
    });
  }
  for (let k = 0; k < shared; k++) {
    const a = Math.floor(r() * count),
      b = Math.floor(r() * count);
    if (a !== b)
      edges.push({
        source: String(Math.min(a, b)),
        target: String(Math.max(a, b)),
      });
  }
  return new Graph(nodes, edges);
}

const sizing = { gap: 0, box: () => ({ x0: -8, y0: -8, x1: 8, y1: 8 }) };

test("every edge points down at least one layer, and shared nodes sit below everything that uses them", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = recipes(seed, 30 + seed * 3, seed);
    const routing = layeredLayout(g, {}, sizing);
    for (const e of g.edges) {
      assert.ok(
        routing.layerOf[e.target] > routing.layerOf[e.source],
        `seed ${seed}`,
      );
      assert.ok(
        g.nodes[e.target].homeY > g.nodes[e.source].homeY,
        `seed ${seed}: drawn below`,
      );
    }
  }
});

test("nothing overlaps on a layer, checked pair by pair", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = recipes(seed, 80, 20);
    const routing = layeredLayout(g, { nodeGap: 10 }, sizing);
    const byLayer = new Map();
    g.nodes.forEach((n) =>
      byLayer.set(routing.layerOf[n.index], [
        ...(byLayer.get(routing.layerOf[n.index]) ?? []),
        n,
      ]),
    );
    for (const list of byLayer.values()) {
      list.sort((a, b) => a.homeX - b.homeX);
      for (let i = 1; i < list.length; i++)
        assert.ok(
          list[i].homeX - list[i - 1].homeX >= 16 + 10 - 1e-6,
          `seed ${seed}`,
        );
    }
  }
});

test("ordering never ends with more crossings than it started with, and usually removes some", () => {
  let improved = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = recipes(seed, 60, 25);
    const routing = layeredLayout(g, {}, sizing);
    assert.ok(routing.crossings <= routing.initialCrossings, `seed ${seed}`);
    if (routing.crossings < routing.initialCrossings) improved++;
  }
  assert.ok(improved >= 20, `fewer crossings in ${improved} of 40`);
});

test("a plain tree lays out with no crossings and no bends", () => {
  const g = recipes(5, 100, 0);
  const routing = layeredLayout(g, {}, sizing);
  assert.equal(routing.crossings, 0);
  for (const e of g.edges) assert.equal(routing.bends.get(e).length, 0);
});

test("long edges get one bend per layer they cross, in order down the edge", () => {
  // root → a → b → c, and root → c directly: the long edge crosses two layers.
  const g = new Graph(
    ["root", "a", "b", "c"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["a", "b"],
      ["b", "c"],
      ["root", "c"],
    ].map(([source, target]) => ({ source, target })),
  );
  const routing = layeredLayout(g, { levelGap: 50 }, sizing);
  const long = g.edges.find(
    (e) => g.nodes[e.source].id === "root" && g.nodes[e.target].id === "c",
  );
  const bends = routing.bends.get(long);
  assert.equal(bends.length, 2);
  assert.deepEqual(
    bends.map((b) => b[1]),
    [g.byId.get("a").homeY, g.byId.get("b").homeY],
  );
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const pts = edgeRoute(g, routing, "straight", long);
  assert.equal(pts.length, 8, "root, two bends, c");
});

test("cycles are laid out anyway (a reversed edge), and the same input gives the same output", () => {
  const make = () =>
    new Graph(
      ["a", "b", "c"].map((id) => ({ id })),
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ].map(([source, target]) => ({ source, target })),
    );
  const g = make();
  layeredLayout(g, {}, sizing);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.homeX + n.homeY)));
  const a = recipes(9, 120, 30),
    b = recipes(9, 120, 30);
  layeredLayout(a, {}, sizing);
  layeredLayout(b, {}, sizing);
  assert.deepEqual(
    a.nodes.map((n) => [n.homeX, n.homeY]),
    b.nodes.map((n) => [n.homeX, n.homeY]),
  );
});

test("bends move with their edge's ends when the nodes are dragged", () => {
  const g = new Graph(
    ["root", "a", "b"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["a", "b"],
      ["root", "b"],
    ].map(([source, target]) => ({ source, target })),
  );
  const routing = layeredLayout(g, {}, sizing);
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const long = g.edges[2];
  const [bend] = routing.bends.get(long);
  g.byId.get("b").x += 100; // drag the end
  const pts = edgeRoute(g, routing, "straight", long);
  assert.ok(
    Math.abs(pts[2] - (bend[0] + 50)) < 1e-9,
    "the middle bend moves halfway",
  );
});

test("hovering a shared ingredient lights up every recipe that uses it", () => {
  const g = new Graph(
    ["sword", "shield", "ingot", "ore"].map((id) => ({ id })),
    [
      ["sword", "ingot"],
      ["shield", "ingot"],
      ["ingot", "ore"],
    ].map(([source, target]) => ({ source, target })),
  );
  const lit = lineage(g, g.byId.get("ingot").index);
  for (const id of ["sword", "shield", "ingot", "ore"])
    assert.ok(lit.has(g.byId.get(id).index), id);
});

test("crossings and the order-keeping projection, on their own", () => {
  // Two layers, two edges crossing: (0 → 1') and (1 → 0').
  const pos = Float64Array.of(0, 1, 1, 0);
  assert.equal(
    countCrossings(
      [
        [0, 1],
        [2, 3],
      ],
      [[2], [3], [], []],
      pos,
    ),
    1,
  );
  // Desired positions on top of each other: pushed apart symmetrically, in order.
  const out = project([10, 10, 10], [5, 5], [1, 1, 1]);
  assert.deepEqual([...out], [5, 10, 15]);
  // Already far enough apart: left where they are.
  assert.deepEqual([...project([0, 50], [10], [1, 1])], [0, 50]);
});

test("2,000 nodes with shared ingredients lay out in well under a second", () => {
  const g = recipes(3, 2000, 400);
  const start = performance.now();
  layeredLayout(g, {}, sizing);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});

test("network simplex: feasible, never longer in total than longest path, optimal on a known case", () => {
  // a → b → c → d, and a → d: longest path is already optimal (total 4).
  let r = networkSimplex(
    4,
    [0, 1, 2, 0],
    [1, 2, 3, 3],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  );
  assert.deepEqual([...r.rank], [0, 1, 2, 3]);
  assert.ok(r.optimal);
  // Source s only feeds the bottom node: simplex brings it down next to it (longest path leaves it at the top).
  // a → b → c, s → c
  r = networkSimplex(4, [0, 1, 3], [1, 2, 2], [1, 1, 1], [1, 1, 1]);
  assert.equal(r.rank[3], r.rank[2] - 1);
  // Random DAGs: every edge at least its minimum, total no worse than longest path.
  for (let seed = 1; seed <= 20; seed++) {
    const g = recipes(seed, 80, 30);
    const tail = g.edges.map((e) => e.source),
      head = g.edges.map((e) => e.target);
    const ones = tail.map(() => 1);
    const { rank, optimal } = networkSimplex(
      g.nodes.length,
      tail,
      head,
      ones,
      ones,
    );
    assert.ok(optimal);
    let simplexTotal = 0;
    tail.forEach((a, i) => {
      assert.ok(rank[head[i]] - rank[a] >= 1);
      simplexTotal += rank[head[i]] - rank[a];
    });
    const longest = layeredLayout(recipes(seed, 80, 30), {
      ranking: "longest",
    }).layerOf;
    const longestTotal = tail.reduce(
      (s, a, i) => s + longest[head[i]] - longest[a],
      0,
    );
    assert.ok(simplexTotal <= longestTotal, `seed ${seed}`);
  }
});

test("simplex layering leaves fewer long edges than longest path", () => {
  let simplex = 0,
    longest = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const count = (opts) =>
      [...layeredLayout(recipes(seed, 120, 25), opts).bends.values()].reduce(
        (s, b) => s + b.length,
        0,
      );
    simplex += count({ ranking: "simplex" });
    longest += count({ ranking: "longest" });
  }
  assert.ok(simplex < longest * 0.95, `${simplex} vs ${longest}`);
});

test("global sifting keeps each long edge in one place and doesn't add crossings", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const bary = layeredLayout(recipes(seed, 120, 25), {
      ordering: "barycenter",
    });
    const g = recipes(seed, 120, 25);
    const sifted = layeredLayout(g, { ordering: "sifting" });
    assert.ok(sifted.crossings <= bary.crossings * 1.05, `seed ${seed}`);
    // A long edge's bends never swap sides with another long edge's between layers: check pairs that share layers.
    const chains = [...sifted.bends.values()].filter((b) => b.length > 1);
    for (let i = 0; i < chains.length; i++)
      for (let j = i + 1; j < chains.length; j++) {
        const byY = (c) => new Map(c.map(([x, y]) => [Math.round(y), x]));
        const a = byY(chains[i]),
          b = byY(chains[j]);
        const sides = new Set();
        for (const [y, x] of a)
          if (b.has(y)) sides.add(Math.sign(x - b.get(y)));
        assert.ok(sides.size <= 1, `seed ${seed}: chains ${i} and ${j} swap`);
      }
  }
});

test("sifting on its own: finds the uncrossed order of a swapped pair", () => {
  // Layer 0: a, b. Layer 1: c, d. Edges a → d, b → c cross; sifting fixes it.
  const result = globalSifting({
    layers: [
      [0, 1],
      [2, 3],
    ],
    layer: [0, 0, 1, 1],
    upper: [[], [], [1], [0]],
    lower: [[3], [2], [], []],
    block: [0, 1, 2, 3],
    blocks: 4,
  });
  const pos = new Map(result.layers.flatMap((l) => l.map((v, i) => [v, i])));
  assert.equal(
    Math.sign(pos.get(0) - pos.get(1)),
    Math.sign(pos.get(3) - pos.get(2)),
  );
});

test("references: far cross-links into busy ingredients end at a chip one layer below their source", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const g = recipes(seed, 150, 60);
    const routing = layeredLayout(g, { references: "hubs", shareMin: 3 });
    const uses = new Int32Array(g.nodes.length);
    for (const e of g.edges) uses[e.target]++;
    const layerGap = (a, b) => b - a;
    for (const ref of routing.references) {
      const e = ref.edge;
      assert.equal(e.source, ref.source);
      assert.equal(e.target, ref.target);
      assert.ok(!e.tree, "tree edges are never referenced");
      assert.ok(uses[e.target] >= 3);
      assert.ok(
        layerGap(routing.layerOf[e.source], routing.layerOf[e.target]) >= 2,
      );
      assert.deepEqual(
        routing.bends.get(e),
        [],
        "no bends: it's a one-layer edge now",
      );
      const s = g.nodes[e.source];
      assert.ok(ref.y > s.homeY, "below its source");
      assert.ok(ref.y < g.nodes[e.target].homeY, "above its ingredient");
    }
    const off = layeredLayout(recipes(seed, 150, 60), { references: "off" });
    assert.equal(off.references.length, 0);
    assert.ok(routing.crossings <= off.crossings, `seed ${seed}`);
  }
});

test("references remove most crossings on the busy crafting fixture", () => {
  const model = GraphModel.from(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/graphs/crafting-heavy-hubs.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const lines = layeredLayout(new Graph(model), { references: "off" });
  const refs = layeredLayout(new Graph(model), { references: "hubs" });
  assert.ok(refs.references.length > 0);
  assert.ok(
    refs.crossings < lines.crossings / 4,
    `${refs.crossings} vs ${lines.crossings}`,
  );
});
