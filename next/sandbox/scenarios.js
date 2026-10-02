// Scenarios: scripted tours of the engine. Each is a list of steps that build graphs (prismatrix-graph JSON),
// change layouts, physics and styles, and move a pretend pointer through the controller (drags, throws, hover),
// with a caption saying what's being shown. Every step is logged as a `scenario` event in the engine log, so
// logs/engine-stats.log shows what the engine was doing at each point.
//
// A step is `async (ctx) => {}`; see `context` for what ctx offers.

import { EASINGS } from "../engine/index.js";

// ---- a recipe to play with ----------------------------------------------------------------------------------

/** A made-up legendary recipe: what each item is made from. Shared ingredients appear under several recipes. */
const RECIPE = {
  Aurora: ["Gift of Aurora", "Gift of Mastery", "Gift of Fortune", "Coeus"],
  "Gift of Aurora": [
    "Gift of Insight",
    "Gift of the Mists",
    "Ley-Line Spark",
    "Mystic Coin",
  ],
  "Gift of Insight": ["Gift of Glory", "Mystic Clover", "Amalgamated Gemstone"],
  "Gift of the Mists": [
    "Gift of Battle",
    "Gift of Glory",
    "Glob of Ectoplasm",
    "Obsidian Shard",
  ],
  "Gift of Mastery": [
    "Gift of Exploration",
    "Bloodstone Shard",
    "Obsidian Shard",
    "Mystic Coin",
  ],
  "Gift of Fortune": [
    "Mystic Clover",
    "Glob of Ectoplasm",
    "Gift of Magic",
    "Gift of Might",
  ],
  "Gift of Magic": [
    "Vial of Powerful Blood",
    "Powerful Venom Sac",
    "Elaborate Totem",
    "Crystalline Dust",
  ],
  "Gift of Might": [
    "Armored Scale",
    "Ancient Bone",
    "Vicious Claw",
    "Vicious Fang",
  ],
  "Mystic Clover": [
    "Obsidian Shard",
    "Mystic Coin",
    "Glob of Ectoplasm",
    "Spirit Shard",
  ],
  Coeus: [
    "Gift of Coeus",
    "Mystic Coin",
    "Glob of Ectoplasm",
    "Amalgamated Gemstone",
  ],
  "Gift of Coeus": ["Ley-Line Spark", "Crystalline Dust", "Bloodstone Shard"],
  "Amalgamated Gemstone": ["Crystalline Ore", "Orichalcum Ingot"],
  "Orichalcum Ingot": ["Orichalcum Ore"],
  "Gift of Glory": ["Shard of Glory"],
  "Gift of Battle": ["Badge of Honor"],
  "Ley-Line Spark": ["Mystic Coin", "Glob of Ectoplasm"],
  "Gift of Exploration": ["World Completion"],
};

const id = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** How many of `part` a recipe for `name` takes: made up, but the same every time (an edge's label shows it). */
function quantity(name, part) {
  let h = 7;
  for (const ch of name + part) h = (h * 31 + ch.charCodeAt(0)) % 1009;
  return [1, 1, 2, 5, 10, 25, 77, 250][h % 8];
}

/** Each item's crafting step: breadth-first from the top, the step where it's first needed. */
function steps(root) {
  const step = new Map([[root, 0]]);
  const queue = [root];
  for (let h = 0; h < queue.length; h++)
    for (const part of RECIPE[queue[h]] ?? [])
      if (!step.has(part)) {
        step.set(part, step.get(queue[h]) + 1);
        queue.push(part);
      }
  return step;
}

/**
 * The recipe as prismatrix-graph JSON: items needed within `depth` steps, minus anything in `without` (and what
 * only it needed), with `style` per item from `styleOf(name)`.
 */
function recipeGraph({ depth = Infinity, without = [], styleOf } = {}) {
  const step = steps("Aurora");
  const keep = new Set();
  const visit = (name) => {
    if (keep.has(name) || without.includes(name) || step.get(name) > depth)
      return;
    keep.add(name);
    for (const part of RECIPE[name] ?? []) visit(part);
  };
  visit("Aurora");
  const nodes = [...keep].map((name) => ({
    id: id(name),
    label: name,
    ...(styleOf?.(name) && { style: styleOf(name) }),
  }));
  const edges = [];
  for (const name of keep)
    for (const part of RECIPE[name] ?? [])
      if (keep.has(part))
        edges.push({
          source: id(name),
          target: id(part),
          label: `×${quantity(name, part)}`,
        });
  return { format: "prismatrix-graph", version: 1, nodes, edges };
}

const DEEPEST = Math.max(...steps("Aurora").values());
const uses = (name) =>
  Object.values(RECIPE).filter((parts) => parts.includes(name)).length;

// ---- what a step can do --------------------------------------------------------------------------------------

/** Thrown to end a scenario early (Stop). */
class Stopped extends Error {}

function context(controller, { caption, log, signal }) {
  const c = controller;
  const frame = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const check = () => {
    if (signal.aborted) throw new Stopped();
  };
  const node = (nodeId) => {
    const n = c.graph.byId.get(nodeId);
    if (!n) throw new Error(`scenario: no node "${nodeId}"`);
    return n;
  };
  const screenOf = (n) => c.toScreen(n.x, n.y);
  const POINTER = 77;

  const ctx = {
    controller,
    c,
    recipeGraph,
    id,
    /** Wait `ms`, a frame at a time (Stop ends it). */
    async wait(ms) {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        check();
        await frame();
      }
    },
    /** Show a caption and log the step. */
    say(text) {
      check();
      caption(text);
      log("scenario", { step: text });
    },
    /**
     * Drag a node by (dx, dy) screen px over `ms`. `hold` pauses before letting go (no throw); without it, the
     * node is thrown at the speed it was moving.
     */
    async drag(nodeId, dx, dy, ms = 700, { hold = 250 } = {}) {
      const start = screenOf(node(nodeId));
      c.pointerDown({ id: POINTER, ...start, time: performance.now() });
      const began = performance.now();
      for (;;) {
        check();
        const t = Math.min((performance.now() - began) / ms, 1);
        const f = EASINGS.smooth(t);
        c.pointerMove({
          id: POINTER,
          x: start.x + dx * (hold ? f : t),
          y: start.y + dy * (hold ? f : t),
          time: performance.now(),
        });
        if (t >= 1) break;
        await frame();
      }
      if (hold) await ctx.wait(hold);
      c.pointerUp({ id: POINTER, time: performance.now() });
    },
    /** Point at a node (hover), or at nothing. */
    hover(nodeId) {
      if (!nodeId) return c.pointerLeave();
      c.pointerMove({ id: POINTER, ...screenOf(node(nodeId)) });
    },
    /** Point at the first reference to an ingredient. */
    hoverReference(nodeId) {
      const target = node(nodeId).index;
      const ref = c.routing.references?.find((r) => r.target === target);
      if (!ref) return false;
      const s = c.graph.nodes[ref.source];
      c.pointerMove({
        id: POINTER,
        ...c.toScreen(ref.x + s.x - s.homeX, ref.y + s.y - s.homeY),
      });
      return true;
    },
    /** Zoom the camera in on a node (eased, like a fit). */
    focus(nodeId, k = 1.4) {
      const n = node(nodeId);
      c.cameraTween = {
        from: { ...c.camera },
        to: { x: n.x, y: n.y, k },
        start: performance.now(),
      };
      c.framed = false;
      c.renderer?.invalidate();
    },
  };
  return ctx;
}

// ---- the scenarios -------------------------------------------------------------------------------------------

const PURPLE = "#b48cff",
  ORANGE = "#ff9f43",
  GOLD = "#ffd166";

export const SCENARIOS = {
  showcase: {
    label: "Showcase",
    description:
      "A legendary recipe grows, gets dragged, thrown, hovered, pruned and restyled, through every layout.",
    steps: [
      async (s) => {
        s.controller.setAnimation({});
        s.controller.setLayout("tree", { direction: "TB" });
        s.controller.setPhysics("static");
        s.say("A legendary recipe, grown one crafting step at a time");
        for (let depth = 0; depth <= DEEPEST; depth++) {
          s.controller.setGraph(s.recipeGraph({ depth }));
          await s.wait(depth === 0 ? 900 : 1100);
        }
        await s.wait(800);
      },
      async (s) => {
        s.say("Hover: an ingredient lights up everything it's part of");
        for (const name of [
          "Mystic Coin",
          "Gift of Fortune",
          "Orichalcum Ore",
        ]) {
          s.hover(s.id(name));
          await s.wait(1500);
        }
        s.hover(null);
        await s.wait(600);
      },
      async (s) => {
        s.say("Static physics: drag a branch and it stays where it's put");
        await s.drag(s.id("Gift of Magic"), 160, 60, 900);
        await s.wait(900);
        s.say("Reset sends everything home");
        s.controller.reset();
        await s.wait(1200);
      },
      async (s) => {
        s.say(
          "Elastic: pull a node and its neighbours follow, then spring back",
        );
        s.controller.setPhysics("elastic");
        await s.drag(s.id("Gift of Coeus"), -180, 120, 800, { hold: 0 });
        await s.wait(2500);
      },
      async (s) => {
        s.say("Same tree, left to right");
        s.controller.setLayout("tree", { direction: "LR" });
        await s.wait(2200);
        s.controller.setLayout("tree", { direction: "TB" });
        await s.wait(1600);
      },
      async (s) => {
        s.say("Radial: the recipe in rings, one ring per crafting step");
        s.controller.setLayout("radial", {});
        s.controller.setPhysics("static");
        await s.wait(2200);
        s.say("Floating: throw a node and the graph rearranges around it");
        s.controller.setPhysics("floating");
        await s.wait(1200);
        await s.drag(s.id("Gift of Might"), 220, -140, 350, { hold: 0 });
        await s.wait(3500);
        s.controller.setPhysics("static");
        await s.wait(1200);
      },
      async (s) => {
        s.say("Removing a recipe folds its ingredients back into it");
        s.controller.setGraph(s.recipeGraph({ without: ["Gift of Fortune"] }));
        await s.wait(2000);
        s.say("…and adding it back grows them out again");
        s.controller.setGraph(s.recipeGraph());
        await s.wait(2000);
      },
      async (s) => {
        s.say(
          "Merged tree: layered, so a shared ingredient sits below every recipe that uses it",
        );
        s.controller.setLayout("merged", { references: "off" });
        await s.wait(3000);
        s.say(
          "Busy shared ingredients get a reference under each far-away recipe instead",
        );
        s.controller.setLayout("merged", { references: "hubs", shareMin: 3 });
        await s.wait(2500);
        s.say(
          "Pointing at a reference lights up the real ingredient and every recipe that uses it",
        );
        if (s.hoverReference(s.id("Glob of Ectoplasm"))) await s.wait(2500);
        s.hover(null);
        await s.wait(600);
      },
      async (s) => {
        s.say("Each node and edge can carry its own style in the graph data");
        s.controller.setGraph(
          s.recipeGraph({
            styleOf: (name) =>
              name === "Aurora"
                ? { color: ORANGE, size: 34, shape: "diamond" }
                : name.startsWith("Gift")
                  ? { color: PURPLE }
                  : uses(name) >= 3
                    ? { color: GOLD, shape: "hexagon" }
                    : null,
          }),
        );
        await s.wait(3000);
      },
      async (s) => {
        s.say("Bigger: a 642-item crafting graph, laid out with references");
        const big = await (
          await fetch("/tests/fixtures/graphs/crafting-large.json")
        ).json();
        s.controller.setGraph(big);
        await s.wait(3000);
        s.say("Zooming in");
        s.focus(s.c.graph.nodes[0].id, 1.2);
        await s.wait(2500);
        s.controller.fit();
        await s.wait(2000);
      },
    ],
  },
};

/**
 * Play a scenario on a controller. `caption(text)` shows a caption (empty to hide); `log(type, detail)` records events.
 * Resolves when it ends or is stopped through `signal`.
 * @returns {Promise<"done" | "stopped" | Error>}
 */
export async function playScenario(
  controller,
  scenario,
  { caption, log, signal },
) {
  const ctx = context(controller, { caption, log, signal });
  const started = performance.now();
  log("scenarioStart", { scenario: scenario.label });
  try {
    for (const step of scenario.steps) await step(ctx);
    log("scenarioEnd", {
      scenario: scenario.label,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    });
    return "done";
  } catch (error) {
    if (error instanceof Stopped) {
      log("scenarioStopped", { scenario: scenario.label });
      return "stopped";
    }
    log("error", { message: `scenario: ${error.message}` });
    return error;
  } finally {
    controller.pointerUp({ id: 77, time: performance.now() });
    controller.pointerLeave();
    caption("");
  }
}
