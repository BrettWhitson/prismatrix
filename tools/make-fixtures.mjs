// Writes the fixture graphs in tests/fixtures/graphs: prismatrix-graph JSON (see MODEL.md) that tests, the
// layered-layout benchmark (tools/bench-layered.mjs) and bug reports share. Deterministic: the same files every
// run, so a change in a fixture is a change in a generator.
//
// Usage:  node tools/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphModel } from "../src/model.js";

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

/**
 * A statistical twin of real crafting data (a whole game's recipes, merged), with generic names. Real recipe data
 * is nothing like a tree with a few shared parts: almost every recipe takes a few ingredients (four here: one of its
 * own and three common ones), but a handful of common ingredients are used by hundreds of recipes, and whole
 * families of recipes share the same three (a biclique: in the real data, 516 recipes all use the same three).
 * Most items are made and never used again; some are upgraded step by step in long series.
 *
 * At scale 1 it has the real data's shape (real figures in brackets): 3,196 items [3,294] and 7,298 edges [7,088];
 * 40% of items used by nothing [39%] and 43% using nothing [45%]; in-degrees 0 / 1 / 2 / 3–9 / 10–99 / 100+ for
 * 1,292 / 1,433 / 231 / 149 / 84 / 7 items [1,296 / 1,519 / 202 / 203 / 66 / 8]; the busiest ingredients used
 * 574 / 565 / 563 / 338 / 171 times [629 / 599 / 566 / 240 / 139]; 74% of edges into ingredients used three times or
 * more [73%]; a 528-recipe biclique [516]; 13 layers [14]. Ids: i… made items, m… materials only a few recipes use,
 * c… common ingredients (lower numbers more common).
 */
function recipeTwin(seed, scale = 1) {
  const r = rng(seed);
  const recipes = Math.round(1800 * scale),
    commons = Math.round(320 * scale),
    families = Math.round(300 * scale);
  /** A pick from 0 … count - 1, each k about 1 / (k + 1)^s as likely (Zipf). */
  const zipf = (count, s) => {
    const cdf = [];
    let total = 0;
    for (let k = 1; k <= count; k++) cdf.push((total += 1 / k ** s));
    return () => {
      const x = r() * total;
      let lo = 0,
        hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
  };
  const nodes = [],
    edges = [];
  for (let c = 0; c < commons; c++) nodes.push({ id: `c${c}` });
  // c0–c2 are the big family's; any other common ingredient, flatter than a strict 1/k so plenty are used 3–99
  // times.
  const pick = zipf(commons - 3, 0.7);
  const anyCommon = () => (r() < 0.1 ? Math.floor(r() * 3) : 3 + pick());
  // Families: recipes made the same way share their three common ingredients. The first takes 28% of all recipes.
  const triples = [[0, 1, 2]];
  for (let f = 1; f < families; f++) {
    const t = new Set();
    while (t.size < 3) t.add(3 + pick());
    triples.push([...t]);
  }
  const otherFamily = zipf(families - 1, 0.9);
  const made = [];
  let materials = 0,
    series = 0;
  for (let i = 0; i < recipes; i++) {
    const id = `i${i}`;
    nodes.push({ id });
    const uses = new Set();
    // Its own ingredient: the item before it in a series of upgrades (1% of recipes start one, 3–10 long), an
    // earlier item (30%, mostly recent ones), a material another recipe nearby also uses (12% of the rest), or a new
    // material of its own.
    if (made.length && (series > 0 || r() < 0.01)) {
      series = series > 0 ? series - 1 : 2 + Math.floor(r() * 8);
      uses.add(made[made.length - 1]);
    } else if (made.length && r() < 0.3) {
      uses.add(made[made.length - 1 - Math.floor(r() ** 6 * made.length)]);
    } else if (materials && r() < 0.12) {
      uses.add(`m${materials - 1 - Math.floor(r() * Math.min(materials, 20))}`);
    } else {
      nodes.push({ id: `m${materials}` });
      uses.add(`m${materials++}`);
    }
    // Three common ingredients from its family; outside the big family a quarter of them are swapped for another.
    const family = r() < 0.28 ? 0 : 1 + otherFamily();
    for (const c of triples[family])
      uses.add(`c${family && r() < 0.25 ? anyCommon() : c}`);
    for (const t of uses) edges.push({ source: id, target: t });
    made.push(id);
  }
  // Some common ingredients are made too: from more common ones (lower numbers) and a material of their own.
  const crafted = new Set();
  while (crafted.size < Math.round(30 * scale))
    crafted.add(8 + Math.floor(r() * (commons - 8)));
  for (const c of crafted) {
    const uses = new Set([`m${materials}`]);
    nodes.push({ id: `m${materials++}` });
    while (uses.size < 4) uses.add(`c${Math.floor(r() ** 2 * c)}`);
    for (const t of uses) edges.push({ source: `c${c}`, target: t });
  }
  return { nodes, edges };
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
  // Half the real data's size (a smaller file), with its shape: 1,589 items, the busiest ingredients used 277 /
  // 275 / 274 times, a 255-recipe biclique.
  "recipes-twin": () => ({
    meta: {
      description:
        "A statistical twin of real crafting data at half size (tools/make-fixtures.mjs, recipeTwin): few ingredients per recipe, a few used by hundreds, big families of recipes sharing the same three.",
    },
    ...recipeTwin(8, 0.5),
  }),
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
