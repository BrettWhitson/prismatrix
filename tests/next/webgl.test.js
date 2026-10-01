// The WebGL renderer's pure parts: what it sends the GPU for each node. (The shaders themselves are checked in the
// browser, against the Canvas 2D renderer.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../../next/engine/graph.js";
import { NODE_OPTIONS } from "../../next/engine/style.js";
import {
  NODE_STRIDE,
  SHAPE_IDS,
  packNodes,
  parseColour,
} from "../../next/engine/webgl.js";

test("every node shape the options offer has a shader id", () => {
  const shapes = NODE_OPTIONS.find((o) => o.key === "shape").choices;
  for (const { value } of shapes) assert.ok(value in SHAPE_IDS, value);
});

test("colours are parsed to 0–1 channels", () => {
  assert.deepEqual(parseColour("#ff8000"), [1, 128 / 255, 0]);
});

test("nodes pack as centre, radius, colour, dimming and shape, in index order", () => {
  const g = new Graph([{ id: "a" }, { id: "b" }], []);
  g.nodes[1].x = 10;
  g.nodes[1].y = -5;
  const scene = {
    graph: g,
    node: { shape: "hexagon" },
    looks: { radius: [4, 6], fill: ["#000000", "#ffffff"] },
    focus: new Set([0]),
  };
  const out = packNodes(scene);
  assert.ok(out.length >= 2 * NODE_STRIDE);
  assert.deepEqual(
    [...out.subarray(NODE_STRIDE, 2 * NODE_STRIDE)],
    [10, -5, 6, 1, 1, 1, 0.25, SHAPE_IDS.hexagon],
  );
  assert.equal(out[6], 1, "the focused node isn't dimmed");
  assert.equal(
    packNodes({ ...scene, focus: null }, out),
    out,
    "the buffer is reused when it fits",
  );
});
