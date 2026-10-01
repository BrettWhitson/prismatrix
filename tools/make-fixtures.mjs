// Writes the fixture graphs in tests/fixtures/graphs: prismatrix-graph JSON (see next/MODEL.md) that tests, the
// layered-layout benchmark (tools/bench-layered.mjs) and bug reports share. Deterministic: the same files every
// run, so a change in a fixture is a change in a generator.
//
// Usage:  node tools/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphModel } from "../next/engine/model.js";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/graphs",
);

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/**
 * A crafting DAG: a final item, recipes branching down a few levels, raw materials at the bottom. A set of
 * common ingredients ("hubs": ingots, ectoplasm, coins) is used by many recipes at different depths, and some
 * intermediate components are shared between branches.
 */
function crafting(
  seed,
  { recipes = 120, hubs = 8, hubUse = 0.35, shareRate = 0.08 } = {},
) {
  const r = rng(seed);
  const nodes = [{ id: "item" }],
    edges = [];
  const depth = [0];
  // The recipe tree: each new recipe hangs off an earlier one, mostly 2–4 ingredients each.
  for (let i = 1; i < recipes; i++) {
    const parent = Math.floor(r() ** 1.15 * i);
    nodes.push({ id: `r${i}` });
    depth.push(depth[parent] + 1);
    edges.push({ source: nodes[parent].id, target: `r${i}` });
  }
  // Hubs: common ingredients, each with a couple of raw inputs of its own.
  for (let h = 0; h < hubs; h++) {
    nodes.push({ id: `hub${h}` });
    for (let k = 0; k < 2; k++) {
      nodes.push({ id: `raw${h}.${k}` });
      edges.push({ source: `hub${h}`, target: `raw${h}.${k}` });
    }
  }
  // Recipes use hubs.
  for (let i = 0; i < recipes; i++)
    if (r() < hubUse) {
      const uses = 1 + Math.floor(r() * 2);
      for (let k = 0; k < uses; k++)
        edges.push({
          source: nodes[i].id,
          target: `hub${Math.floor(r() * hubs)}`,
        });
    }
  // Shared intermediates: a recipe also uses a deeper recipe from another branch.
  for (let i = 0; i < recipes; i++)
    if (r() < shareRate) {
      const j = Math.floor(r() * recipes);
      if (j !== i && depth[j] > depth[i])
        edges.push({ source: nodes[i].id, target: nodes[j].id });
    }
  // Drop duplicate edges.
  const seen = new Set();
  return {
    nodes,
    edges: edges.filter((e) => {
      const key = `${e.source}>${e.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** The sandbox's old generator: a random tree plus random cross-links (forward in index, so acyclic). */
function randomDag(seed, count, links) {
  const r = rng(seed);
  const nodes = [{ id: "0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: `${i}` });
    edges.push({ source: `${Math.floor(r() ** 1.3 * i)}`, target: `${i}` });
  }
  for (let k = 0; k < links; k++) {
    const a = Math.floor(r() * count),
      b = Math.floor(r() * count);
    if (a !== b)
      edges.push({ source: `${Math.min(a, b)}`, target: `${Math.max(a, b)}` });
  }
  return { nodes, edges };
}

export const CASES = [
  ["crafting small", () => crafting(1, { recipes: 40, hubs: 4 })],
  ["crafting medium", () => crafting(2, { recipes: 150, hubs: 8 })],
  [
    "crafting heavy hubs",
    () => crafting(3, { recipes: 150, hubs: 6, hubUse: 0.6 }),
  ],
  [
    "crafting shared parts",
    () => crafting(4, { recipes: 150, hubs: 6, shareRate: 0.2 }),
  ],
  ["crafting large", () => crafting(5, { recipes: 600, hubs: 14 })],
  ["random dag 120+25", () => randomDag(6, 120, 25)],
];

/** A small, hand-written recipe with labels and data: the readable example of the format. */
function mjolnir() {
  return {
    meta: {
      description:
        "Part of a legendary recipe, hand-written: labels, data on nodes and edges, one shared ingredient.",
    },
    nodes: [
      { id: "mjolnir", label: "Mjölnir", data: { rarity: "legendary" } },
      {
        id: "gift-of-mjolnir",
        label: "Gift of Mjölnir",
        data: { rarity: "legendary" },
      },
      {
        id: "gift-of-mastery",
        label: "Gift of Mastery",
        data: { rarity: "legendary" },
      },
      {
        id: "ectoplasm",
        label: "Glob of Ectoplasm",
        data: { rarity: "exotic" },
      },
      { id: "mystic-coin", label: "Mystic Coin", data: { rarity: "rare" } },
      {
        id: "mithril-ingot",
        label: "Mithril Ingot",
        data: { rarity: "basic" },
      },
      { id: "mithril-ore", label: "Mithril Ore", data: { rarity: "basic" } },
      {
        id: "the-energizer",
        label: "The Energizer",
        data: { rarity: "exotic" },
      },
    ],
    edges: [
      { source: "mjolnir", target: "gift-of-mjolnir", data: { count: 1 } },
      { source: "mjolnir", target: "gift-of-mastery", data: { count: 1 } },
      { source: "mjolnir", target: "the-energizer", data: { count: 1 } },
      {
        source: "gift-of-mjolnir",
        target: "mithril-ingot",
        data: { count: 250 },
      },
      { source: "gift-of-mjolnir", target: "ectoplasm", data: { count: 100 } },
      { source: "gift-of-mastery", target: "ectoplasm", data: { count: 250 } },
      {
        source: "gift-of-mastery",
        target: "mystic-coin",
        data: { count: 250 },
      },
      { source: "the-energizer", target: "mithril-ingot", data: { count: 5 } },
      { source: "mithril-ingot", target: "mithril-ore", data: { count: 2 } },
    ],
  };
}

const FIXTURES = {
  "mjolnir-example": mjolnir,
  "crafting-small": () => crafting(1, { recipes: 40, hubs: 4 }),
  "crafting-medium": () => crafting(2, { recipes: 150, hubs: 8 }),
  "crafting-heavy-hubs": () =>
    crafting(3, { recipes: 150, hubs: 6, hubUse: 0.6 }),
  "crafting-shared-parts": () =>
    crafting(4, { recipes: 150, hubs: 6, shareRate: 0.2 }),
  "crafting-large": () => crafting(5, { recipes: 600, hubs: 14 }),
  "random-dag-120": () => randomDag(6, 120, 25),
};

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(FIXTURES)) {
  const data = make();
  const model = GraphModel.from({
    meta: { name, ...data.meta },
    nodes: data.nodes,
    edges: data.edges,
  });
  if (model.issues.length)
    throw new Error(`${name}: ${model.issues[0].message}`);
  writeFileSync(
    path.join(OUT, `${name}.json`),
    JSON.stringify(model.toJSON(), null, 1) + "\n",
  );
  console.log(`${name}: ${JSON.stringify(model.stats())}`);
}
