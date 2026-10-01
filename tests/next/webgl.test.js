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

import { radialLayout, treeLayout } from "../../next/engine/layouts.js";
import { cubic, edgePoints, rounded } from "../../next/engine/geometry.js";
import {
  END_STRIDE,
  SEGMENT_STRIDE,
  packEdges,
} from "../../next/engine/gl-pack.js";

/** root → a, b; a → a1 */
function small() {
  const g = new Graph(
    ["root", "a", "b", "a1"].map((id) => ({ id })),
    [
      ["root", "a"],
      ["root", "b"],
      ["a", "a1"],
    ].map(([source, target]) => ({ source, target })),
  );
  return g;
}

const EDGE = {
  shape: "straight",
  corner: 0,
  width: 2,
  taper: false,
  colorBy: "single",
  color: "#ff0000",
  opacity: 1,
  arrow: "none",
  arrowSize: 6,
};

function scene(g, routing, edge = {}, focus = null) {
  return {
    graph: g,
    routing,
    edge: { ...EDGE, ...edge },
    looks: {
      radius: g.nodes.map(() => 5),
      fill: g.nodes.map(() => "#00ff00"),
    },
    focus,
  };
}

test("a cubic curve starts and ends on its end points, with more points the longer it is", () => {
  const short = cubic([0, 0], [0, 5], [10, 5], [10, 10]);
  const long = cubic([0, 0], [0, 500], [1000, 500], [1000, 1000]);
  assert.deepEqual(short.slice(0, 2), [0, 0]);
  assert.deepEqual(short.slice(-2), [10, 10]);
  assert.ok(long.length > short.length);
  assert.ok(long.length / 2 <= 49);
});

test("curve edges leave a tree parent along the tree's axis", () => {
  const pts = edgePoints(
    { kind: "tree", direction: "TB" },
    "curve",
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  );
  // The first step is straight down: x hardly moves while y does.
  assert.ok(Math.abs(pts[2]) < pts[3]);
  assert.deepEqual(pts.slice(-2), [100, 100]);
});

test("rounded corners replace a right angle with an arc of the asked radius", () => {
  const pts = rounded([0, 0, 0, 100, 100, 100], 20);
  assert.deepEqual(pts.slice(0, 2), [0, 0]);
  assert.deepEqual(pts.slice(-2), [100, 100]);
  // Every arc point is 20 from the arc's centre at (20, 80).
  for (let i = 2; i < pts.length - 2; i += 2)
    assert.ok(Math.abs(Math.hypot(pts[i] - 20, pts[i + 1] - 80) - 20) < 1e-9);
  // Short segments shrink the arc rather than overshooting them.
  const tight = rounded([0, 0, 0, 10, 10, 10], 40);
  for (let i = 0; i < tight.length; i += 2) {
    assert.ok(tight[i] >= -1e-9 && tight[i] <= 10 + 1e-9);
    assert.ok(tight[i + 1] >= -1e-9 && tight[i + 1] <= 10 + 1e-9);
  }
  assert.deepEqual(
    rounded([0, 0, 0, 10, 0, 20], 5),
    [0, 0, 0, 10, 0, 20],
    "straight runs are left alone",
  );
});

test("edges pack as segments trimmed to the nodes, in the edge's colour", () => {
  const g = small();
  const routing = treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const out = packEdges(scene(g, routing));
  assert.equal(out.segmentCount, 3, "one straight segment per edge");
  assert.equal(out.endCount, 0);
  const [x0, y0, x1, y1, h0, h1, r, gr, b] = out.segments.subarray(
    0,
    SEGMENT_STRIDE,
  );
  const root = g.byId.get("root"),
    a = g.byId.get("a");
  assert.ok(
    Math.abs(Math.hypot(x0 - root.x, y0 - root.y) - 5) < 1e-6,
    "starts at the parent's edge",
  );
  assert.ok(
    Math.abs(Math.hypot(x1 - a.x, y1 - a.y) - 5) < 1e-6,
    "ends at the child's edge",
  );
  assert.deepEqual([h0, h1], [1, 1], "half the width");
  assert.deepEqual([r, gr, b], [1, 0, 0]);
});

test("a taper narrows continuously from parent to child", () => {
  const g = small();
  const routing = treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const out = packEdges(scene(g, routing, { shape: "step", taper: true }));
  // The first edge's segments: each starts as wide as the last one ended, and they narrow.
  let previous = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = i * SEGMENT_STRIDE;
    assert.ok(out.segments[o + 4] <= previous + 1e-9);
    assert.ok(out.segments[o + 5] < out.segments[o + 4]);
    previous = out.segments[o + 5];
  }
  assert.ok(
    Math.abs(out.segments[4] - 2) < 1e-9,
    "twice the width at the parent (half-width 2)",
  );
});

test("dimmed edges come first, arrows follow their edges, and the ends sit at the tip", () => {
  const g = small();
  const routing = radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const a = g.byId.get("a"),
    a1 = g.byId.get("a1"),
    root = g.byId.get("root");
  const focus = new Set([root.index, a.index, a1.index]); // b's edge is dimmed
  const out = packEdges(
    scene(g, routing, { arrow: "arrow", colorBy: "target" }, focus),
  );
  assert.equal(out.dimSegments, 1);
  assert.equal(out.dimEnds, 1);
  assert.equal(out.endCount, 3);
  for (let i = 0; i < out.endCount; i++) {
    const o = i * END_STRIDE;
    assert.ok(
      Math.abs(Math.hypot(out.ends[o + 2], out.ends[o + 3]) - 1) < 1e-9,
      "unit direction",
    );
  }
  // The lit edge root → a ends with its tip just touching a's edge.
  let nearest = Infinity;
  for (let i = out.dimEnds; i < out.endCount; i++) {
    const o = i * END_STRIDE;
    nearest = Math.min(
      nearest,
      Math.hypot(out.ends[o] - a.x, out.ends[o + 1] - a.y),
    );
  }
  assert.ok(Math.abs(nearest - 5) < 1e-6);
});

test("packing grows its buffers mid-frame without losing what's already in them", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `n${i}`);
  const g = new Graph(
    ids.map((id) => ({ id })),
    ids.slice(1).map((t, i) => ({ source: ids[Math.floor(i / 3)], target: t })),
  );
  const routing = radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const out = packEdges(scene(g, routing, { shape: "curve" }), {
    segments: new Float32Array(9),
  });
  for (let i = 0; i < out.segmentCount * SEGMENT_STRIDE; i++)
    assert.ok(Number.isFinite(out.segments[i]));
  assert.notEqual(out.segments[0], 0, "the first segment survived the growth");
});
