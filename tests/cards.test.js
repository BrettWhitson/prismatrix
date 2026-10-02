// Cards (the `look` node option): their size in layouts, their text, their marks on the GPU, hitting them, and edges
// meeting them at their rim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphController } from "../src/controller.js";
import { GraphModel, cardTextWidth } from "../src/model.js";
import { cardBox, cardRuns, cardTextArea } from "../src/cards.js";
import { planText } from "../src/labels.js";
import { NODE_STRIDE, packNodes } from "../src/gl-pack.js";
import { endTrims, startTrims } from "../src/geometry.js";

const CARD = { look: "card", cardWidth: 200, cardHeight: 60, labelSize: 11 };

/** root → a, b; a → a1 (styled with card text) */
const GRAPH = {
  nodes: [
    { id: "root" },
    {
      id: "a",
      style: {
        subtitle: ["×2 ", { mark: "#d6a74a" }, " Crafted"],
        value: [{ text: "12", color: "#e5b83b" }, { dot: "#e5b83b" }],
        tag: "owned",
      },
    },
    { id: "b" },
    { id: "a1" },
  ],
  edges: [
    { source: "root", target: "a" },
    { source: "root", target: "b" },
    { source: "a", target: "a1" },
  ],
};

function cards(direction = "TB") {
  const c = new GraphController(new GraphModel(GRAPH, { node: CARD }), null, {
    layout: "tree",
    layoutOptions: { direction },
    worker: false,
    clock: () => 0,
  });
  c.setViewport(1200, 800);
  c.run(1500, { start: 0 });
  return c;
}

test("the model checks card text: lines of text or runs, and a short tag", () => {
  const model = new GraphModel({
    nodes: [
      { id: "ok", style: { subtitle: "plain", value: [{ dot: "#ffffff" }] } },
      {
        id: "bad",
        style: { subtitle: [{ mark: "red" }], tag: "x".repeat(30) },
      },
    ],
  });
  assert.equal(model.issues.filter((i) => i.kind === "bad-style").length, 2);
  assert.deepEqual(
    cardRuns(["a", { text: "b", color: "#ff0000" }, { mark: "#00ff00" }]),
    [
      { text: "a", colour: null },
      { text: "b", colour: "#ff0000" },
      { text: "■", colour: "#00ff00" },
    ],
  );
});

test("every card is the same size: its text has the card's room, and layouts space whole cards", () => {
  const c = cards();
  assert.equal(c.model.labelHeight, CARD.cardHeight);
  assert.ok(c.model.labelWidths().every((w) => w === cardTextWidth(CARD)));
  const box = cardBox(CARD);
  const m = c.graph.matrix;
  for (let i = 0; i < m.count; i++) {
    // The footprint is the card: its half height round the icon, and its width to the right.
    assert.ok(Math.abs(m.boxX0[i] - box.x) < 1e-6);
    assert.ok(Math.abs(m.boxX1[i] - (box.x + box.width)) < 1e-6);
    assert.ok(Math.abs(m.boxY0[i] - box.y) < 1e-6);
  }
  // Siblings' cards don't overlap.
  const a = c.graph.byId.get("a"),
    b = c.graph.byId.get("b");
  assert.ok(Math.abs(a.x - b.x) >= box.width - 1e-6);
  assert.equal(c.scene.looks.radius[a.index], box.icon, "the icon is the node");
});

test("a card's text: its label in bold, then its subtitle and value run by run, and its tag in a pill", () => {
  const c = cards();
  const scene = { ...c.scene, camera: { x: 0, y: 0, k: 2 } };
  const measure = (text, size) => text.length * size * 0.5;
  const items = planText(scene, { fit: (t) => t, measure });
  const a = c.graph.byId.get("a");
  const mine = items.filter(
    (it) =>
      Math.abs(it.x - a.x) < CARD.cardWidth &&
      Math.abs(it.y - a.y) < CARD.cardHeight,
  );
  const title = mine.find((it) => it.bold);
  assert.equal(title.text, "a");
  assert.equal(title.x, a.x + cardTextArea(CARD).x);
  assert.deepEqual(
    mine.filter((it) => !it.bold && !it.pill).map((it) => it.text),
    ["×2 ", "■", " Crafted", "12", "●"],
  );
  const mark = mine.find((it) => it.text === "■");
  assert.equal(mark.colour, "#d6a74a");
  assert.ok(mark.x > title.x, "runs follow one another");
  assert.equal(mine.find((it) => it.pill).text, "owned");
  // Zoomed out, only titles.
  const far = planText(
    { ...c.scene, camera: { x: 0, y: 0, k: 0.35 } },
    { fit: (t) => t, measure },
  );
  assert.ok(far.length && far.every((it) => it.bold));
});

test("the GPU knows which nodes are cards; picking finds a card anywhere on it", () => {
  const c = cards();
  const out = packNodes(c.scene);
  for (let i = 0; i < c.graph.nodes.length; i++)
    assert.equal(out[i * NODE_STRIDE + 35], 1);
  const a = c.graph.byId.get("a");
  // Far out on the card's text, well past its icon.
  const p = c.toScreen(a.x + CARD.cardWidth - CARD.cardHeight, a.y + 10);
  assert.equal(c.hit(c.toWorld(p.x, p.y)), a.index);
});

test("edges meet a card at its rim, and leave past its text when they leave through it", () => {
  const c = cards("TB");
  const starts = startTrims(c.scene),
    ends = endTrims(c.scene);
  // Top to bottom: out of the bottom, in at the top, half a card from its centre.
  for (let i = 0; i < c.graph.edges.length; i++) {
    assert.equal(starts[i], CARD.cardHeight / 2);
    assert.equal(ends[i], CARD.cardHeight / 2);
  }
  // Left to right: out of the right end, past the text.
  const lr = cards("LR");
  const out = startTrims(lr.scene);
  const into = endTrims(lr.scene);
  for (let i = 0; i < lr.graph.edges.length; i++) {
    assert.ok(out[i] > CARD.cardWidth - CARD.cardHeight, "past the text");
    assert.equal(into[i], CARD.cardHeight / 2, "in at the icon's end");
  }
});
