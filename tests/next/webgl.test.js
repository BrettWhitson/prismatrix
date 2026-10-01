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

test("nodes pack as centre, radius, colour, visibility and shape, in index order", () => {
  const g = new Graph([{ id: "a" }, { id: "b" }], []);
  g.nodes[1].x = 10;
  g.nodes[1].y = -5;
  const scene = {
    graph: g,
    node: { shape: "hexagon" },
    looks: {
      radius: [4, 6],
      fill: ["#000000", "#ffffff"],
      shape: ["hexagon", "hexagon"],
    },
    shade: Float32Array.of(1, 0), // a lit, b fully dimmed by the hover
    dim: 0.75,
  };
  const out = packNodes(scene);
  assert.ok(out.length >= 2 * NODE_STRIDE);
  assert.deepEqual(
    [...out.subarray(NODE_STRIDE, 2 * NODE_STRIDE)],
    [10, -5, 6, 1, 1, 1, 0.25, SHAPE_IDS.hexagon],
  );
  assert.equal(out[6], 1, "the lit node is fully visible");
  assert.equal(
    packNodes({ ...scene, shade: null }, out),
    out,
    "the buffer is reused when it fits",
  );
});

import { radialLayout, treeLayout } from "../../next/engine/layouts.js";
import { cubic, edgePoints, rounded } from "../../next/engine/geometry.js";
import { edgeAlpha, labelAlpha, nodeAlpha } from "../../next/engine/render.js";
import { EASINGS, approach } from "../../next/engine/animation.js";
import {
  END_STRIDE,
  SEGMENT_STRIDE,
  edgeBrightness,
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
      shape: g.nodes.map(() => "circle"),
      // As looksOf would give them: the edge colour (or the child's), and the edge width.
      edgeColour: g.edges.map(() =>
        ({ ...EDGE, ...edge }).colorBy === "target"
          ? "#00ff00"
          : { ...EDGE, ...edge }.color,
      ),
      edgeWidth: g.edges.map(() => ({ ...EDGE, ...edge }).width),
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

test("edges carry their brightness, arrows follow their edges, and the ends sit at the tip", () => {
  const g = small();
  const routing = radialLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const a = g.byId.get("a"),
    b = g.byId.get("b");
  const shade = new Float32Array(g.nodes.length).fill(1);
  shade[b.index] = 0; // b's edge is dimmed
  const shaded = {
    ...scene(g, routing, { arrow: "arrow", colorBy: "target" }),
    shade,
    dim: 0.75,
  };
  const out = packEdges(shaded);
  const light = edgeBrightness(shaded, out);
  assert.equal(out.segmentCount, 3);
  assert.equal(out.endCount, 3);
  assert.equal(light.bright, false, "not every edge is at full brightness");
  const alphas = [...light.segmentAlpha.subarray(0, 3)].sort();
  assert.ok(Math.abs(alphas[0] - 0.15) < 1e-6, "the dimmed edge fades to 15%");
  assert.deepEqual(alphas.slice(1), [1, 1]);
  for (let i = 0; i < out.endCount; i++) {
    const o = i * END_STRIDE;
    assert.ok(
      Math.abs(Math.hypot(out.ends[o + 2], out.ends[o + 3]) - 1) < 1e-9,
      "unit direction",
    );
  }
  // The edge root → a ends with its tip just touching a's edge.
  let nearest = Infinity;
  for (let i = 0; i < out.endCount; i++) {
    const o = i * END_STRIDE;
    nearest = Math.min(
      nearest,
      Math.hypot(out.ends[o] - a.x, out.ends[o + 1] - a.y),
    );
  }
  assert.ok(Math.abs(nearest - 5) < 1e-6);
  const plain = scene(g, routing);
  assert.equal(edgeBrightness(plain, packEdges(plain)).bright, true);
});

test("visibility: hover dims nodes, labels and edges by different amounts, and fading in scales it all", () => {
  const scene = {
    shade: Float32Array.of(1, 0),
    appear: Float32Array.of(1, 0.5),
    dim: 0.75,
  };
  assert.equal(nodeAlpha(scene, 0), 1);
  assert.ok(Math.abs(nodeAlpha(scene, 1) - 0.5 * 0.25) < 1e-6);
  assert.ok(
    labelAlpha(scene, 1) < nodeAlpha(scene, 1),
    "labels fade further than nodes",
  );
  const edge = { source: 0, target: 1 };
  assert.ok(
    Math.abs(edgeAlpha(scene, edge) - 0.5 * 0.15) < 1e-6,
    "an edge is as dim as its dimmer end",
  );
  assert.equal(nodeAlpha({}, 0), 1, "nothing to fade: fully visible");
  assert.equal(nodeAlpha({ ...scene, dim: 0 }, 1), 0.5, "no dimming at all");
});

test("approach eases toward its target and lands on it; 0 ms jumps straight there", () => {
  let v = 0;
  const seen = [];
  for (let i = 0; i < 60 && v !== 1; i++)
    seen.push((v = approach(v, 1, 1 / 60, 200)));
  assert.equal(v, 1, "it arrives");
  assert.ok(seen[1] - seen[0] < seen[0], "fast at first, then slowing");
  assert.equal(approach(0.3, 0, 1 / 60, 0), 0);
});

test("every easing starts at 0 and ends at 1", () => {
  for (const [name, ease] of Object.entries(EASINGS)) {
    assert.ok(Math.abs(ease(0)) < 1e-9, name);
    assert.ok(Math.abs(ease(1) - 1) < 1e-9, name);
  }
  assert.ok(EASINGS.back(0.8) > 1, "overshoot goes past and comes back");
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

import { bucketScale, labelBox } from "../../next/engine/gl-text.js";

test("labels are rasterised at the zoom rounded up to a power of two, between ¼ and 8", () => {
  assert.equal(bucketScale(1, 1), 1);
  assert.equal(bucketScale(1.2, 1), 2, "never smaller than shown");
  assert.equal(bucketScale(0.3, 2), 1, "times the device pixel ratio");
  assert.equal(bucketScale(0.01, 1), 0.25);
  assert.equal(bucketScale(100, 1), 8);
});

test("label boxes sit where the Canvas 2D renderer puts its text", () => {
  // Below a node of radius 10 at the origin: centred, its em box's top 4 px under the node (radius + gap).
  const below = labelBox(0, 0, 10, Math.PI / 2, 12, 40);
  assert.ok(Math.abs(below.left + 20) < 1e-9);
  assert.ok(Math.abs(below.middle - (14 + 6)) < 1e-9);
  // To the right: starting just past the node, its middle on the node's centre line.
  const right = labelBox(100, 50, 10, 0, 12, 40);
  assert.ok(Math.abs(right.left - 114) < 1e-9);
  assert.ok(Math.abs(right.middle - 50) < 1e-9);
  // Pointing left (an outward label on the left of a radial): ending just before the node.
  const left = labelBox(0, 0, 10, Math.PI, 12, 40);
  assert.ok(Math.abs(left.left + 14 + 40) < 1e-9);
});

test("brightness follows each segment's own edge, and refilling it never touches the geometry", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const g = new Graph(
    ids.map((id) => ({ id })),
    ids.slice(1).map((t, i) => ({ source: ids[Math.floor(i / 3)], target: t })),
  );
  const routing = treeLayout(g, {});
  for (const n of g.nodes) [n.x, n.y] = [n.homeX, n.homeY];
  const base = scene(g, routing, { shape: "curve", arrow: "dot" });
  const packed = packEdges(base);
  const geometry = packed.segments.slice(
    0,
    packed.segmentCount * SEGMENT_STRIDE,
  );
  for (let round = 0; round < 3; round++) {
    const shade = Float32Array.from(
      g.nodes,
      (_, i) => ((i * 7 + round) % 5) / 4,
    );
    const s = { ...base, shade, dim: 0.75 };
    const light = edgeBrightness(s, packed);
    for (let i = 0; i < packed.segmentCount; i++)
      assert.equal(
        light.segmentAlpha[i],
        Math.fround(edgeAlpha(s, g.edges[packed.segmentEdge[i]])),
      );
    for (let i = 0; i < packed.endCount; i++)
      assert.equal(
        light.endAlpha[i],
        Math.fround(edgeAlpha(s, g.edges[packed.endEdge[i]])),
      );
  }
  assert.deepEqual(packed.segments.slice(0, geometry.length), geometry);
});

import { looksOf } from "../../next/engine/render.js";

test("each node's and edge's own style wins over the view's options", () => {
  const g = new Graph(
    [
      { id: "a", style: { color: "#ff0000", size: 30, shape: "diamond" } },
      { id: "b" },
    ],
    [{ source: "a", target: "b", style: { color: "#00ff00", width: 5 } }],
  );
  const node = {
    size: 10,
    sizeBy: "uniform",
    colorBy: "single",
    color: "#123456",
    shape: "circle",
  };
  const looks = looksOf(g, node, {
    colorBy: "single",
    color: "#abcdef",
    width: 1,
  });
  assert.deepEqual(
    [looks.radius[0], looks.fill[0], looks.shape[0]],
    [15, "#ff0000", "diamond"],
  );
  assert.deepEqual(
    [looks.radius[1], looks.fill[1], looks.shape[1]],
    [5, "#123456", "circle"],
  );
  assert.deepEqual([looks.edgeColour[0], looks.edgeWidth[0]], ["#00ff00", 5]);
  const packed = packNodes({ graph: g, looks });
  assert.equal(packed[7], SHAPE_IDS.diamond);
  assert.equal(packed[NODE_STRIDE + 7], SHAPE_IDS.circle);
});
