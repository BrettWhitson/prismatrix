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

test("nodes and CPU-traced edges pack relative to an origin, so far-out graphs keep their precision", () => {
  const g = small();
  const routing = treeLayout(g, {});
  const far = 3e6; // 32-bit floats only land on quarter-pixels out here
  for (const n of g.nodes) [n.x, n.y] = [n.homeX + far + 0.3, n.homeY - far];
  const s = scene(g, routing, { shape: "fan", arrow: "arrow" });
  const origin = { x: far, y: -far };
  const nodes = packNodes(s, null, origin);
  const root = g.byId.get("root");
  // Relative to the origin, the 0.3 survives the 32-bit buffer; at 3,000,000 px it would round to a quarter.
  assert.ok(Math.abs(nodes[root.index * NODE_STRIDE] - (root.x - far)) < 1e-4);
  assert.ok(Math.abs(Math.fround(root.x) - root.x) > 0.04);
  const absolute = packEdges(s);
  const relative = packEdges(s, {}, null, origin);
  assert.equal(relative.segmentCount, absolute.segmentCount);
  for (
    let i = 0;
    i < relative.segmentCount * SEGMENT_STRIDE;
    i += SEGMENT_STRIDE
  )
    for (const k of [0, 2])
      assert.ok(
        Math.abs(
          relative.segments[i + k] + origin.x - absolute.segments[i + k],
        ) < 0.5,
      );
});

// ---- the WebGL painter's rebuild logic, with a stand-in GL that only counts what's sent to the GPU -------------

import { GraphModel } from "../../next/engine/model.js";
import { GraphController } from "../../next/engine/controller.js";
import { WebGLPainter } from "../../next/engine/webgl.js";
import { withReferences } from "../../next/engine/references.js";
import { readFileSync } from "node:fs";

/** A canvas whose WebGL2 context does nothing but count the bytes uploaded; its 2D context does nothing. */
function fakeCanvas(sent) {
  const listeners = {};
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) return name; // constants
        if (name === "getShaderParameter") return () => true;
        if (name === "getProgramParameter")
          return (_p, k) => (k === "LINK_STATUS" ? true : 0);
        if (name === "getExtension") return () => null;
        if (name === "bufferSubData")
          return (_t, _o, data, _s, length) => {
            sent.bytes += (length ?? data.length) * data.BYTES_PER_ELEMENT;
          };
        if (name === "texSubImage2D" || name === "texImage2D")
          return (...args) => {
            const data = args.find((a) => a?.BYTES_PER_ELEMENT);
            if (data) sent.bytes += data.byteLength;
          };
        return () => ({});
      },
    },
  );
  const ctx2d = new Proxy(
    {},
    {
      get: (_, name) =>
        name === "measureText"
          ? (t) => ({ width: t.length * 6 })
          : name === "getImageData"
            ? (x, y, w, h) => ({ width: w, height: h })
            : () => {},
      set: () => true,
    },
  );
  return {
    width: 800,
    height: 600,
    style: {},
    parentElement: { insertBefore() {} },
    addEventListener: (type, f) => (listeners[type] = f),
    remove() {},
    getContext: (kind) => (kind === "webgl2" ? gl : ctx2d),
    fire: (type) => listeners[type]?.({ preventDefault() {} }),
  };
}

/** Run `body` with just enough of a DOM for the WebGL painter. */
function withDom(body) {
  const saved = [globalThis.document, globalThis.getComputedStyle];
  const sent = { bytes: 0 };
  globalThis.document = { createElement: () => fakeCanvas(sent) };
  globalThis.getComputedStyle = () => ({ position: "relative" });
  try {
    body(sent);
  } finally {
    [globalThis.document, globalThis.getComputedStyle] = saved;
  }
}

/** A small crafting fixture: shared ingredients, so the merged tree draws references to them. */
function craftingSmall() {
  const url = new URL(
    "../fixtures/graphs/crafting-small.json",
    import.meta.url,
  );
  return new GraphModel(JSON.parse(readFileSync(url, "utf8")));
}

test("the WebGL painter sends nothing new for a frame where only the display graph object is new", () => {
  withDom((sent) => {
    const c = new GraphController(craftingSmall(), null, {
      layout: "merged",
      worker: false,
      clock: () => 1000,
    });
    c.setViewport(800, 600, 1);
    c.run(500, { start: 1000 });
    assert.ok(c.routing.references?.length, "the layout drew references");
    const painter = new WebGLPainter(
      globalThis.document.createElement("canvas"),
    );
    const scene = c.scene;
    // Until every label is in the atlas (a few milliseconds a frame; slower when the machine is busy).
    for (let i = 0; i < 100; i++) {
      painter.draw(scene);
      if (!painter.pending) break;
    }
    // The view builds the display graph again every frame (withReferences): same content, new objects.
    const again = withReferences(c.graph, c.routing.references, {
      looks: c.looks,
      shade: c.shade,
      appear: c.appear,
    });
    assert.notEqual(again.graph, scene.graph);
    sent.bytes = 0;
    const camera = { ...scene.camera, x: scene.camera.x + 5 };
    painter.draw({ ...scene, ...again, camera });
    assert.equal(
      sent.bytes,
      0,
      "a pan with a rebuilt display graph uploads nothing",
    );
    painter.draw({ ...scene, version: scene.version + 1 });
    assert.ok(sent.bytes > 0, "moved nodes do go up");
  });
});

test("when a lost WebGL context comes back, the painter draws the last frame again by itself", () => {
  withDom((sent) => {
    const c = new GraphController(craftingSmall(), null, {
      layout: "tree",
      worker: false,
      clock: () => 1000,
    });
    c.setViewport(800, 600, 1);
    c.run(300, { start: 1000 });
    const painter = new WebGLPainter(
      globalThis.document.createElement("canvas"),
    );
    painter.draw(c.scene);
    painter.glCanvas.fire("webglcontextlost");
    sent.bytes = 0;
    painter.draw(c.scene);
    assert.equal(sent.bytes, 0, "nothing is drawn while the context is lost");
    painter.glCanvas.fire("webglcontextrestored");
    assert.ok(sent.bytes > 0, "restored: everything sent again and drawn");
  });
});

import { packHalos } from "../../next/engine/gl-pack.js";
import { drawHalos, HALO_GAP, HALO_WIDTH } from "../../next/engine/render.js";

test("selection halos: only selected real nodes, packed as nodes are; references and ghosts never", () => {
  const g = small();
  for (const n of g.nodes) [n.x, n.y] = [n.index * 10, 5];
  const looks = {
    radius: [4, 6, 8, 10, 12],
    fill: ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000"],
    shape: ["circle", "square", "diamond", "hexagon", "ring"],
  };
  // A fifth, display-only node past the real ones: the mask doesn't reach it.
  const graph = { nodes: [...g.nodes, { index: 4, x: 0, y: 0 }] };
  const scene = { graph, looks, selected: Uint8Array.of(0, 1, 0, 1) };
  const { data, count } = packHalos(scene, null, { x: 1, y: 0 });
  assert.equal(count, 2);
  assert.deepEqual(
    [...data.subarray(0, NODE_STRIDE)],
    [9, 5, 6, 0, 1, 0, 1, SHAPE_IDS.square],
  );
  assert.equal(data[NODE_STRIDE + 7], SHAPE_IDS.hexagon);
  assert.equal(packHalos({ ...scene, selected: null }).count, 0);
});

test("Canvas 2D halos sit the gap outside each shape, its corners rounded, in the node's colour", () => {
  const g = small();
  for (const n of g.nodes) [n.x, n.y] = [0, 0];
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
      set: (_, name, value) => (calls.push([`=${name}`, value]), true),
    },
  );
  const k = 2;
  const scene = {
    graph: g,
    camera: { x: 0, y: 0, k },
    width: 100,
    height: 100,
    dpr: 1,
    looks: {
      radius: [10, 10, 10, 10],
      fill: ["#123456", "#abcdef", "#000000", "#000000"],
      shape: ["circle", "square", "circle", "circle"],
    },
    selected: Uint8Array.of(1, 1, 0, 0),
  };
  drawHalos(ctx, scene);
  const o = (HALO_GAP + HALO_WIDTH / 2) / k;
  const arcs = calls.filter(([name]) => name === "arc");
  assert.deepEqual(arcs[0].slice(1, 4), [0, 0, 10 + o], "a circle's ring");
  // A square: four corner arcs of radius o round its corners, each a quarter turn.
  const corners = arcs.slice(1);
  assert.equal(corners.length, 4);
  for (const [, x, y, r, a0, a1] of corners) {
    assert.deepEqual([Math.abs(x), Math.abs(y), r], [10, 10, o]);
    const sweep = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-9);
  }
  assert.deepEqual(
    calls.filter(([name]) => name === "=strokeStyle").map(([, v]) => v),
    ["#123456", "#abcdef"],
  );
  assert.ok(
    calls.some(([name, v]) => name === "=lineWidth" && v === HALO_WIDTH / k),
  );
});

test("a selection change redraws halos without rebuilding the edge pieces", () => {
  withDom(() => {
    const c = new GraphController(craftingSmall(), null, {
      layout: "tree",
      worker: false,
      clock: () => 1000,
    });
    c.setViewport(800, 600, 1);
    c.run(300, { start: 1000 });
    const painter = new WebGLPainter(
      globalThis.document.createElement("canvas"),
    );
    painter.draw(c.scene);
    const pieces = painter.layer.gpu;
    assert.ok(pieces, "the GPU draws this graph's edges");
    assert.ok(c.select(c.graph.nodes[3].id));
    c.run(50, { start: 1400 });
    painter.draw(c.scene);
    assert.equal(painter.layer.gpu, pieces, "the same pieces");
    assert.equal(painter.layer.haloData.count, 1);
    c.select(null);
    c.run(50, { start: 1500 });
    painter.draw(c.scene);
    assert.equal(painter.layer.haloData.count, 0);
    assert.equal(painter.layer.gpu, pieces);
  });
});
