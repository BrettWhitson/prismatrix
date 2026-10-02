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
  // Several pulls on one node: the weighted median, halfway when the weight splits evenly.
  assert.deepEqual([...project([[0, 10, 30]], [], [[1, 1, 3]])], [30]);
  assert.deepEqual([...project([[0, 10]], [], [[1, 1]])], [5]);
});

test("the L1 projection is exact: it matches a brute-force optimum on small random inputs and keeps every gap", () => {
  const r = rng(11);
  for (let trial = 0; trial < 400; trial++) {
    const count = 1 + Math.floor(r() * 5);
    const desired = [],
      weights = [],
      seps = [];
    for (let i = 0; i < count; i++) {
      const pulls = 1 + Math.floor(r() * 3);
      desired.push(Array.from({ length: pulls }, () => Math.round(r() * 40)));
      weights.push(
        Array.from(
          { length: pulls },
          () => [0.01, 0.5, 1, 2, 8][(r() * 5) | 0],
        ),
      );
      if (i) seps.push(Math.round(r() * 10));
    }
    const offset = [0];
    for (let i = 1; i < count; i++) offset.push(offset[i - 1] + seps[i - 1]);
    const cost = (xs) =>
      xs.reduce(
        (sum, x, i) =>
          sum +
          desired[i].reduce(
            (s, p, k) => s + weights[i][k] * Math.abs(x - p),
            0,
          ),
        0,
      );
    // Shifted by the gaps before them, positions only have to be in order, and some optimum puts each one on a
    // shifted pull: try every ordered choice of those.
    const candidates = [
      ...new Set(desired.flatMap((d, i) => d.map((p) => p - offset[i]))),
    ].sort((a, b) => a - b);
    let best = Infinity;
    const search = (i, least, chosen) => {
      if (i === count) {
        best = Math.min(best, cost(chosen.map((y, j) => y + offset[j])));
        return;
      }
      for (const c of candidates)
        if (c >= least) search(i + 1, c, [...chosen, c]);
    };
    search(0, -Infinity, []);
    const out = [...project(desired, seps, weights)];
    for (let i = 1; i < count; i++)
      assert.ok(out[i] - out[i - 1] >= seps[i - 1] - 1e-9, `trial ${trial}`);
    assert.ok(Math.abs(cost(out) - best) < 1e-6, `trial ${trial}`);
  }
});

test("the same input gives the same layout every time: effort is counted, never timed", () => {
  const model = GraphModel.from(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/graphs/crafting-large.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const homes = (g) => g.nodes.map((n) => [n.homeX, n.homeY]);
  const now = performance.now;
  for (const make of [() => new Graph(model), () => recipes(3, 2000, 400)]) {
    const first = make();
    layeredLayout(first, {}, sizing);
    // A clock that races ahead (as on a slow or busy machine) changes nothing.
    let t = 0;
    performance.now = () => (t += 1000);
    try {
      const second = make();
      layeredLayout(second, {}, sizing);
      assert.deepEqual(homes(second), homes(first));
    } finally {
      performance.now = now;
    }
  }
});

test("a small recipe's ordering finds its uncrossed drawing (Mjölnir)", () => {
  const model = GraphModel.from(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/graphs/mjolnir-example.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  for (const references of ["hubs", "off"])
    assert.equal(
      layeredLayout(new Graph(model), { references }, sizing).crossings,
      0,
      references,
    );
});

test("every layout node keeps its gap: nodes, references and long edges' bends", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = recipes(seed, 90, 40);
    const nodeGap = 10;
    const routing = layeredLayout(g, { nodeGap }, sizing);
    // Everything on a layer, by y: [x, half width].
    const rows = new Map();
    const put = (x, y, half) => {
      const key = Math.round(y);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push([x, half]);
    };
    for (const n of g.nodes) put(n.homeX, n.homeY, 8);
    for (const ref of routing.references) put(ref.x, ref.y, 8);
    for (const bends of routing.bends.values())
      for (const [x, y] of bends) put(x, y, 2);
    for (const row of rows.values()) {
      row.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < row.length; i++) {
        const [x0, h0] = row[i - 1],
          [x1, h1] = row[i];
        const gap = h0 === 2 && h1 === 2 ? nodeGap / 2 : nodeGap;
        assert.ok(x1 - x0 >= h0 + h1 + gap - 1e-6, `seed ${seed}`);
      }
    }
  }
});

test("sifting never ends worse than the order it's given, and reads that order back exactly", () => {
  const r = rng(5);
  for (let trial = 0; trial < 60; trial++) {
    // Random proper layered graphs: single nodes, plus long edges whose dummies share one block.
    const layerCount = 3 + Math.floor(r() * 4);
    const layers = Array.from({ length: layerCount }, () => []);
    const layer = [],
      block = [];
    let blocks = 0;
    const vertex = (k, b) => {
      layers[k].push(layer.length);
      layer.push(k);
      block.push(b);
      return layer.length - 1;
    };
    for (let k = 0; k < layerCount; k++)
      for (let i = 2 + Math.floor(r() * 5); i > 0; i--) vertex(k, blocks++);
    const upper = [],
      lower = [];
    const link = (a, b) => {
      (lower[a] ??= []).push(b);
      (upper[b] ??= []).push(a);
    };
    for (let k = 0; k + 1 < layerCount; k++)
      for (const a of layers[k])
        for (const b of layers[k + 1])
          if (block[a] !== block[b] && r() < 0.3) link(a, b);
    // A long edge: a chain of dummies from layer 0 to the bottom, as one block.
    const chain = blocks++;
    let prev = layers[0][0];
    for (let k = 1; k < layerCount; k++) {
      const d = vertex(k, chain);
      link(prev, d);
      prev = d;
    }
    for (let v = 0; v < layer.length; v++) {
      upper[v] ??= [];
      lower[v] ??= [];
    }
    // Start from a shuffle: every block keeps one place, the long edge at a random place on every layer.
    const at = new Float64Array(blocks).map(() => r());
    for (const list of layers) list.sort((a, b) => at[block[a]] - at[block[b]]);
    const crossings = (list) => {
      const pos = new Float64Array(layer.length);
      list.forEach((l) => l.forEach((v, i) => (pos[v] = i)));
      return countCrossings(list, lower, pos);
    };
    const graph = { layers, layer, upper, lower, block, blocks };
    // No effort allowed: the order comes back exactly as given.
    const none = globalSifting(graph, { work: 0 });
    assert.ok(none.exact);
    assert.deepEqual(none.layers, layers);
    const sifted = globalSifting(graph, { rounds: 4 });
    assert.ok(sifted.exact);
    assert.ok(crossings(sifted.layers) <= crossings(layers), `trial ${trial}`);
  }
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
    // Two different graphs, each ordered heuristically: references come out ahead or close to it.
    assert.ok(routing.crossings <= off.crossings * 1.1, `seed ${seed}`);
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
