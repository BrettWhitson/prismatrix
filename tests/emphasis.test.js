// What the view lights up, headless: highlights, flashes and pulses (their halos), which part of a lineage a hover
// lights, the selection's lineage, and what a lit lineage does to its edges (colour by direction, flow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphController } from "../src/controller.js";
import { GraphModel } from "../src/model.js";
import { lineagePart, lineageMask } from "../src/picking.js";
import { edgeLineage, haloList, HALO_STEP } from "../src/render.js";
import {
  NODE_STRIDE,
  edgeStates,
  packHalos,
  stateAlpha,
} from "../src/gl-pack.js";

/** root → a, b; a → a1, a2; b → b1 */
const SMALL = {
  nodes: ["root", "a", "b", "a1", "a2", "b1"].map((id) => ({ id })),
  edges: [
    ["root", "a"],
    ["root", "b"],
    ["a", "a1"],
    ["a", "a2"],
    ["b", "b1"],
  ].map(([source, target]) => ({ source, target })),
};

function setup(options = {}) {
  let time = 1000;
  const events = [];
  const c = new GraphController(new GraphModel(SMALL), null, {
    clock: () => time,
    worker: false,
    onEvent: (type, detail) => events.push({ type, detail }),
    ...options,
  });
  c.setViewport(800, 600);
  const wait = (ms) => {
    let result;
    const end = time + ms;
    while (time < end) {
      time += 1000 / 60;
      result = c.tick(time);
    }
    return result;
  };
  wait(1500);
  const index = (id) => c.graph.byId.get(id).index;
  return { c, events, wait, index };
}

const lit = (c) => [...c.scene.shade].map((v) => v > 0.99);

test("a highlight lights its nodes, dims the rest, rings them in the theme's highlight colour, and says so", () => {
  const { c, events, wait, index } = setup();
  assert.equal(c.highlight(["a1", "b1", "nope"]), true);
  assert.equal(c.highlight(["b1", "a1"]), false, "the same set");
  assert.deepEqual(events.at(-1), {
    type: "highlight",
    detail: { highlighted: ["a1", "b1"] },
  });
  wait(600);
  const on = lit(c);
  assert.ok(on[index("a1")] && on[index("b1")]);
  assert.ok(!on[index("root")] && !on[index("a")]);
  const halos = haloList(c.scene);
  assert.deepEqual(
    halos.map((h) => [h.index, h.colour]),
    [
      [index("a1"), c.theme.highlight],
      [index("b1"), c.theme.highlight],
    ],
  );
  // Selected and highlighted: the highlight's ring sits outside the selection's.
  c.select("a1");
  wait(50);
  const both = haloList(c.scene).filter((h) => h.index === index("a1"));
  assert.deepEqual(
    both.map((h) => h.gap),
    [0, HALO_STEP],
  );
  c.highlight(null);
  assert.deepEqual(c.highlighted, []);
});

test("a flash comes on, holds and fades; a pulse spreads and fades; both end, and keep the view busy until then", () => {
  const { c, wait, index } = setup();
  c.flash(["a"], 600);
  c.pulse("b");
  let result = wait(120);
  assert.equal(result.busy, true);
  const flash = haloList(c.scene).find((h) => h.index === index("a"));
  assert.equal(flash.colour, c.theme.focus);
  assert.ok(flash.alpha > 0.9, "on");
  const pulse = haloList(c.scene).find((h) => h.index === index("b"));
  assert.ok(pulse.gap > 0 && pulse.alpha < 1, "spreading");
  wait(700);
  result = wait(50);
  assert.equal(haloList(c.scene).length, 0, "both over");
  assert.equal(result.busy, false);
});

test("the GPU's halos carry each one's colour, alpha and gap", () => {
  const { c, wait, index } = setup();
  c.select("a");
  c.highlight(["a"]);
  wait(50);
  const nodeData = new Float32Array(c.graph.nodes.length * NODE_STRIDE);
  for (const n of c.graph.nodes) nodeData[n.index * NODE_STRIDE + 6] = 1;
  const { data, count } = packHalos(c.scene, nodeData);
  assert.equal(count, 2);
  assert.equal(data[8], 0);
  assert.equal(data[NODE_STRIDE + 8], HALO_STEP);
  assert.ok(index("a") >= 0);
});

test("hovering lights the part of the lineage hoverLineage says; selectionLineage off leaves the selection unlit", () => {
  const { c, wait, index } = setup({
    animation: { hoverLineage: "descendants" },
  });
  c.hover = index("a");
  wait(600);
  let on = lit(c);
  assert.ok(on[index("a")] && on[index("a1")] && on[index("a2")]);
  assert.ok(!on[index("root")], "not up");
  c.setAnimation({ hoverLineage: "ancestors" });
  wait(600);
  on = lit(c);
  assert.ok(on[index("root")] && !on[index("a1")]);
  c.setAnimation({ hoverLineage: "none" });
  wait(600);
  assert.ok(lit(c).every(Boolean), "nothing dimmed");
  c.hover = -1;
  c.select("b");
  c.setAnimation({ selectionLineage: false });
  wait(600);
  assert.ok(lit(c).every(Boolean), "the selection lights nothing");
});

test("lineagePart keeps one way of a lineage, and the node itself", () => {
  const g = {
    nodes: [0, 1, 2],
    edges: [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
    ],
    incoming: [[], [0], [1]],
    outgoing: [[0], [1], []],
  };
  const all = lineageMask(g, 1);
  assert.deepEqual([...lineagePart(all, "ancestors")].map(Boolean), [
    true,
    true,
    false,
  ]);
  assert.deepEqual([...lineagePart(all, "descendants")].map(Boolean), [
    false,
    true,
    true,
  ]);
});

test("a lit lineage colours its edges by direction and flows along them; the GPU gets it packed with the brightness", () => {
  const { c, wait, index } = setup({
    animation: { lineageColor: "direction", flow: "target" },
  });
  c.hover = index("a");
  const result = wait(600);
  assert.equal(result.busy, true, "flowing keeps frames coming");
  const codes = edgeLineage(c.scene);
  const edge = (s, t) =>
    c.scene.graph.edges.findIndex(
      (e) => e.source === index(s) && e.target === index(t),
    );
  assert.equal(codes[edge("root", "a")], 1 | 4, "up, flowing");
  assert.equal(codes[edge("a", "a1")], 2 | 4, "down, flowing");
  assert.equal(codes[edge("b", "b1")], 0, "not in the lineage");
  const states = edgeStates(c.scene);
  for (let i = 0; i < states.length; i++) {
    assert.ok(Math.abs(stateAlpha(states[i]) - (states[i] % 2)) < 1e-6);
    assert.equal(Math.floor(states[i] / 2), codes[i]);
  }
  // A highlight lights nodes, not a lineage: no colours, no flow.
  c.hover = -1;
  c.highlight(["a"]);
  wait(50);
  assert.equal(edgeLineage(c.scene), null);
});
