// How nodes look: themes, borders, icons (loading, the atlas, fitting, level of detail), and restyles patched into
// the WebGL painter's buffers instead of rebuilding them. Shaders are checked in a browser against Canvas 2D; here,
// a stand-in GL records what's sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GraphModel, equal } from "../../next/engine/model.js";
import { GraphController } from "../../next/engine/controller.js";
import { Graph } from "../../next/engine/graph.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "../../next/engine/style.js";
import { defaultsOf } from "../../next/engine/schema.js";
import { THEMES, contrast, resolveTheme } from "../../next/engine/theme.js";
import {
  drawNodes,
  drawScene,
  looksOf,
  patchLooks,
} from "../../next/engine/render.js";
import {
  AtlasPacker,
  ICON_FADE_PX,
  ICON_GUTTER,
  ICON_MIN_PX,
  ICON_SLOT,
  IconStore,
  cellFit,
  iconBox,
  iconShown,
  zOrder,
} from "../../next/engine/icons.js";
import { IconAtlas } from "../../next/engine/gl-icons.js";
import {
  NODE_STRIDE,
  packNodes,
  parseColour,
  runsOf,
} from "../../next/engine/gl-pack.js";
import { PIECE_STRIDE, packPieces } from "../../next/engine/gl-edges.js";
import { WebGLPainter, restylesSince } from "../../next/engine/webgl.js";
import { LABEL_STRIDE } from "../../next/engine/gl-text.js";

const NODE = defaultsOf(NODE_OPTIONS);
const EDGE = defaultsOf(EDGE_OPTIONS);

/** root → a, b; a → a1 */
const SMALL = {
  nodes: ["root", "a", "b", "a1"].map((id) => ({ id })),
  edges: [
    ["root", "a"],
    ["root", "b"],
    ["a", "a1"],
  ].map(([source, target]) => ({ source, target })),
};

// ---- themes -------------------------------------------------------------------------------------------------------

test("theme presets, and tokens over a preset; bad tokens are reported and left out", () => {
  assert.equal(resolveTheme(), THEMES.dark);
  assert.equal(resolveTheme("light"), THEMES.light);
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const custom = resolveTheme(
    { base: "light", background: "#ffffff", text: "red", glow: "#000000" },
    warn,
  );
  assert.equal(custom.background, "#ffffff");
  assert.equal(custom.text, THEMES.light.text, "a bad colour is left out");
  assert.equal(custom.palette, THEMES.light.palette);
  assert.equal(warnings.length, 2);
  assert.equal(resolveTheme("sepia", warn), THEMES.dark);
  assert.equal(warnings.length, 3);
});

test("every theme's colours read on its background", () => {
  for (const theme of Object.values(THEMES)) {
    const bg = theme.background;
    for (const c of [...theme.palette, theme.node, theme.root])
      assert.ok(contrast(c, bg) >= 4, `${theme.name} ${c}: ${contrast(c, bg)}`);
    assert.ok(contrast(theme.text, bg) >= 7, `${theme.name} text`);
    assert.ok(contrast(theme.edge, bg) >= 3, `${theme.name} edges`);
    assert.ok(contrast(theme.textHalo, theme.text) >= 7, `${theme.name} halo`);
  }
  assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
});

test("looks follow the theme: palette, root, default node and edge colours; set colours stay", () => {
  const g = new Graph(new GraphModel(SMALL));
  const light = looksOf(g, NODE, EDGE, THEMES.light);
  assert.equal(light.fill[0], THEMES.light.palette[0]);
  assert.equal(light.edgeColour[0], THEMES.light.edge);
  const single = looksOf(g, { ...NODE, colorBy: "single" }, EDGE, THEMES.light);
  assert.equal(single.fill[1], THEMES.light.node);
  const branch = looksOf(g, { ...NODE, colorBy: "branch" }, EDGE, THEMES.light);
  assert.equal(branch.fill[0], THEMES.light.root);
  const own = looksOf(
    g,
    { ...NODE, colorBy: "single", color: "#123456" },
    { ...EDGE, color: "#ff0000" },
    THEMES.light,
  );
  assert.equal(own.fill[1], "#123456");
  assert.equal(own.edgeColour[0], "#ff0000");
});

/** A 2D context that records what's drawn: calls as [name, ...args], property sets as ["=name", value]. */
function recorder() {
  const calls = [];
  const ctx = new Proxy(
    { canvas: { width: 800, height: 600 } },
    {
      get: (target, name) =>
        name in target
          ? target[name]
          : name === "measureText"
            ? (text) => ({ width: text.length * 6 })
            : (...args) => {
                calls.push([name, ...args]);
              },
      set: (_, name, value) => (calls.push([`=${name}`, value]), true),
    },
  );
  return { ctx, calls };
}

function frame(theme) {
  let time = 1000;
  const c = new GraphController(new GraphModel(SMALL), null, {
    clock: () => time,
    worker: false,
    theme,
  });
  c.setViewport(800, 600);
  for (let i = 0; i < 120; i++) c.tick((time += 16.7));
  return { c, tick: () => c.tick((time += 16.7)) };
}

test("the controller's theme reaches the scene, and setTheme restyles everything", () => {
  const { c, tick } = frame("light");
  assert.equal(c.scene.theme, THEMES.light);
  assert.equal(c.scene.background, THEMES.light.background);
  assert.equal(c.scene.looks.fill[0], THEMES.light.palette[0]);
  const events = [];
  c.on("theme", (d) => events.push(d));
  const geometry = c.geometryVersion;
  c.setTheme("dark");
  tick();
  assert.equal(c.scene.background, THEMES.dark.background);
  assert.equal(c.scene.looks.fill[0], THEMES.dark.palette[0]);
  assert.equal(c.scene.looks.edgeColour[0], THEMES.dark.edge);
  assert.ok(c.geometryVersion > geometry, "a whole restyle");
  assert.deepEqual(events, [{ name: "dark" }]);
});

test("Canvas 2D: the theme's background and text colour", () => {
  const { c } = frame("light");
  const { ctx, calls } = recorder();
  // Opaque edges: no edge layer (no DOM here).
  drawScene(ctx, { ...c.scene, edge: { ...c.scene.edge, opacity: 1 } });
  const fills = calls.filter(([n]) => n === "=fillStyle").map(([, v]) => v);
  assert.equal(fills[0], THEMES.light.background);
  assert.ok(fills.includes(THEMES.light.text));
  assert.ok(!fills.includes(THEMES.dark.text));
});

// ---- a stand-in WebGL2 that records what's sent ------------------------------------------------------------------

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
        if (name === "getExtension" || name === "getParameter")
          return () => null;
        return (...args) => {
          sent.calls.push([name, ...args]);
          if (name === "bufferSubData") {
            const [, , data, , length] = args;
            sent.bytes += (length ?? data.length) * data.BYTES_PER_ELEMENT;
          }
          return {};
        };
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
    gl,
  };
}

function withDom(body) {
  const saved = [globalThis.document, globalThis.getComputedStyle];
  const sent = { bytes: 0, calls: [] };
  globalThis.document = { createElement: () => fakeCanvas(sent) };
  globalThis.getComputedStyle = () => ({ position: "relative" });
  try {
    return body(sent);
  } finally {
    [globalThis.document, globalThis.getComputedStyle] = saved;
  }
}

const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test("WebGL: the theme's background clears the canvas and its text colour tints labels", () => {
  withDom((sent) => {
    const { c } = frame("light");
    const painter = new WebGLPainter(
      globalThis.document.createElement("canvas"),
    );
    for (let i = 0; i < 50; i++) {
      painter.draw(c.scene);
      if (!painter.pending) break;
    }
    const bg = parseColour(THEMES.light.background);
    const clear = sent.calls.find(([n]) => n === "clearColor");
    assert.ok(close(clear.slice(1, 4), bg));
    // Each piece of text carries its colours (gl-text.js, LABEL_STRIDE): text, then halo.
    const text = parseColour(THEMES.light.text);
    const halo = parseColour(THEMES.light.textHalo);
    const { data } = painter.labelLayer;
    const count = painter.labelGroups.reduce((n, g) => n + g.count, 0);
    assert.ok(count > 0);
    for (let k = 0; k < count; k++) {
      const row = data.subarray(k * LABEL_STRIDE, (k + 1) * LABEL_STRIDE);
      assert.ok(close([...row.subarray(12, 15)], text), "the theme's text");
      assert.ok(close([...row.subarray(15, 18)], halo), "on its halo");
    }
  });
});

// ---- borders --------------------------------------------------------------------------------------------------------

test("a node's style can give it a border; the model checks it", () => {
  const model = new GraphModel({
    nodes: [
      { id: "a", style: { color: "#ff0000", stroke: "#00ff00" } },
      { id: "b", style: { stroke: "#0000ff", strokeWidth: 5 } },
      { id: "c", style: { stroke: "green", strokeWidth: -1 } },
    ],
  });
  assert.equal(model.issues.filter((i) => i.kind === "bad-style").length, 2);
  const g = new Graph(model);
  const looks = looksOf(g, { ...NODE, strokeWidth: 3 }, EDGE);
  assert.deepEqual(
    [...looks.stroke],
    ["#00ff00", "#0000ff", null],
    "no colour, no border",
  );
  assert.deepEqual([...looks.strokeWidth], [3, 5, 0]);
  const out = packNodes({ graph: g, looks });
  assert.deepEqual([...out.subarray(8, 12)], [0, 1, 0, 3]);
  assert.deepEqual(
    [...out.subarray(NODE_STRIDE + 8, NODE_STRIDE + 12)],
    [0, 0, 1, 5],
  );
  assert.equal(out[2 * NODE_STRIDE + 11], 0);
});

test("Canvas 2D draws a border inside the shape: clipped to it, twice as wide", () => {
  const model = new GraphModel({
    nodes: [{ id: "a", style: { stroke: "#00ff00", strokeWidth: 4 } }],
  });
  const g = new Graph(model);
  const { ctx, calls } = recorder();
  drawNodes(ctx, {
    graph: g,
    node: NODE,
    looks: looksOf(g, NODE, EDGE),
    camera: { x: 0, y: 0, k: 1 },
    width: 800,
    height: 600,
    dpr: 1,
    background: "#000000",
  });
  const names = calls.map(([n]) => n);
  const clip = names.indexOf("clip");
  assert.ok(clip > names.indexOf("fill"), "after the fill");
  assert.ok(names.indexOf("stroke", clip) > clip, "stroked inside the clip");
  assert.ok(calls.some(([n, v]) => n === "=lineWidth" && v === 8));
  assert.ok(calls.some(([n, v]) => n === "=strokeStyle" && v === "#00ff00"));
});

// ---- icons ---------------------------------------------------------------------------------------------------------

/** A loader that resolves when told: `loads` lists each URL asked for, `finish(url)` hands its image over. */
function stubLoader() {
  const waiting = new Map();
  const loads = [];
  return {
    loads,
    load: (url) => {
      loads.push(url);
      return new Promise((resolve, reject) =>
        waiting.set(url, { resolve, reject }),
      );
    },
    finish: (url, image = { width: 64, height: 64 }) =>
      waiting.get(url).resolve(image),
    fail: (url) => waiting.get(url).reject(new Error("404")),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("icons load once per URL, a few at a time, and listeners hear each arrive", async () => {
  const loader = stubLoader();
  const store = new IconStore({ load: loader.load, concurrency: 2 });
  const heard = [];
  store.onReady((e) => heard.push([e.source, e.state]));
  const a = store.get("a.png");
  assert.equal(store.get("a.png"), a, "cached by URL");
  store.get("b.png");
  store.get("c.png");
  assert.deepEqual(loader.loads, ["a.png", "b.png"], "two at a time");
  assert.equal(a.state, "loading");
  assert.equal(store.pending, 3);
  loader.finish("a.png", { width: 32, height: 16 });
  await tick();
  assert.equal(a.state, "ready");
  assert.deepEqual([a.width, a.height], [32, 16]);
  assert.deepEqual(loader.loads, ["a.png", "b.png", "c.png"]);
  loader.fail("b.png");
  await tick();
  assert.equal(store.get("b.png").state, "failed");
  assert.deepEqual(heard, [
    ["a.png", "ready"],
    ["b.png", "failed"],
  ]);
  assert.equal(store.get(null), null);
  assert.equal(store.get(""), null);
  // An image in hand (a bitmap, a canvas) is ready at once, kept by identity.
  const bitmap = { width: 8, height: 8 };
  assert.equal(store.get(bitmap).state, "ready");
  assert.equal(store.get(bitmap), store.get(bitmap));
  assert.notEqual(store.get({ width: 8, height: 8 }), store.get(bitmap));
});

test("images in a style are the same only when they're the same object", () => {
  class ImageBitmap {
    constructor() {
      this.width = 4;
      this.height = 4;
    }
    get [Symbol.toStringTag]() {
      return "ImageBitmap";
    }
  }
  const one = new ImageBitmap(),
    two = new ImageBitmap();
  assert.ok(equal({ icon: one }, { icon: one }));
  assert.ok(!equal({ icon: one }, { icon: two }));
  const model = new GraphModel({ nodes: [{ id: "a", style: { icon: one } }] });
  assert.equal(model.node("a").style.icon, one);
  const change = model.update({
    changeNodes: [{ id: "a", style: { icon: two } }],
  });
  assert.deepEqual(change.nodesRestyled, ["a"]);
  assert.equal(change.sizes, false, "a new icon moves nothing");
});

test("icon boxes: cover fills the shape's square, contain fits inside the shape and its border", () => {
  const r = 10;
  assert.deepEqual(iconBox("circle", "cover", 1, r), [10, 10]);
  assert.deepEqual(iconBox("circle", "cover", 2, r), [20, 10]);
  assert.deepEqual(iconBox("diamond", "cover", 1, r), [12.5, 12.5]);
  const [cx, cy] = iconBox("circle", "contain", 1, r);
  assert.ok(Math.abs(cx - r / Math.SQRT2) < 1e-9 && cx === cy);
  assert.deepEqual(iconBox("square", "contain", 2, r), [10, 5]);
  assert.deepEqual(iconBox("square", "contain", 1, r, 2), [8, 8]);
  assert.deepEqual(iconBox("diamond", "contain", 1, r), [6.25, 6.25]);
  // Inside a tile (a rounded square), the box's corner just touches the rounded corner.
  const [tx] = iconBox("tile", "contain", 1, r);
  assert.ok(tx > r / Math.SQRT2 && tx < r);
  assert.ok(Math.abs(tx - r * (0.8 + 0.2 / Math.SQRT2)) < 1e-6);
  // A hexagon's box stays inside it.
  const [hx, hy] = iconBox("hexagon", "contain", 1, r);
  assert.ok(hx / Math.sqrt(3) + hy <= 11 + 1e-9);
});

test("icons fade in as nodes grow on screen, and are gone below a few px", () => {
  const r = ICON_MIN_PX / 2;
  assert.equal(iconShown(r, 1), 0);
  assert.equal(iconShown(r, 0.5), 0);
  assert.equal(iconShown(r + ICON_FADE_PX / 4, 1), 0.5);
  assert.equal(iconShown(r * 4, 1), 1);
});

test("atlas cells fill a page in Z order, keep their places as the page doubles, then go on new pages", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(zOrder), [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 0],
    [3, 0],
  ]);
  const packer = new AtlasPacker({ side: 2, maxSide: 4, maxLayers: 2 });
  const spots = Array.from({ length: 33 }, () => packer.place());
  assert.equal(spots[3].grew, null);
  assert.equal(spots[4].grew, "page", "the fifth doubles the page");
  assert.equal(spots[16].grew, "layer");
  assert.deepEqual([spots[16].layer, spots[16].x, spots[16].y], [1, 0, 0]);
  assert.equal(spots[32], null, "full");
  // No two icons share a cell.
  const cells = new Set(
    spots.slice(0, 32).map((s) => `${s.layer},${s.x},${s.y}`),
  );
  assert.equal(cells.size, 32);
  assert.deepEqual(cellFit(64, 32), { x: 0, y: 16, w: 64, h: 32 });
});

/** A stand-in GL for the icon atlas alone. */
function atlasGL() {
  const calls = [];
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) return name;
        if (name === "getParameter") return () => null;
        return (...args) => {
          calls.push([name, ...args]);
          return {};
        };
      },
    },
  );
  return { gl, calls };
}

test("the icon atlas copies each icon in once, as it's first asked for after loading, and grows", async () => {
  const saved = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => new Proxy({}, { get: () => () => {} }),
    }),
  };
  try {
    const loader = stubLoader();
    const store = new IconStore({ load: loader.load, concurrency: 64 });
    const { gl, calls } = atlasGL();
    const atlas = new IconAtlas(gl, store);
    assert.equal(
      atlas.lookup("a.png"),
      null,
      "loading: the node shows its fill",
    );
    loader.finish("a.png", { width: 64, height: 32 });
    await tick();
    const a = atlas.lookup("a.png");
    assert.equal(a.layer, 0);
    assert.equal(a.aspect, 2);
    // Inside its cell, past the gutter, the icon fitted whole (letterboxed).
    const page = 4 * ICON_SLOT;
    assert.ok(Math.abs(a.u0 - ICON_GUTTER / page) < 1e-9);
    assert.ok(Math.abs(a.v0 - (ICON_GUTTER + 16) / page) < 1e-9);
    assert.ok(Math.abs(a.u1 - a.u0 - 64 / page) < 1e-9);
    atlas.lookup("a.png");
    const uploads = () => calls.filter(([n]) => n === "texSubImage3D").length;
    assert.equal(uploads(), 1, "copied in once");
    // Seventeen icons: the 4 × 4 page doubles; every icon's rectangle halves.
    const moved = atlas.moved;
    for (let i = 0; i < 16; i++) {
      store.get(`${i}.png`);
      loader.finish(`${i}.png`);
    }
    await tick();
    for (let i = 0; i < 16; i++) assert.ok(atlas.lookup(`${i}.png`));
    assert.equal(uploads(), 17);
    assert.equal(atlas.side, 8);
    assert.ok(atlas.moved > moved, "nodes must be packed again");
    const after = atlas.lookup("a.png");
    assert.ok(Math.abs(after.u1 - after.u0 - (a.u1 - a.u0) / 2) < 1e-9);
    assert.ok(
      calls.some(([n]) => n === "copyTexSubImage3D"),
      "the old page copied across on the GPU",
    );
    // Mipmaps are made again before the atlas is next drawn with.
    atlas.bind(2);
    assert.ok(calls.some(([n]) => n === "generateMipmap"));
  } finally {
    globalThis.document = saved;
  }
});

test("nodes pack their icon's atlas rectangle, page and box; rings and missing icons show none", () => {
  const model = new GraphModel({
    nodes: [
      { id: "a", style: { icon: "a.png", size: 20 } },
      { id: "b", style: { icon: "b.png", shape: "ring" } },
      { id: "c", style: { icon: "missing.png" } },
    ],
  });
  const g = new Graph(model);
  const looks = looksOf(g, { ...NODE, iconFit: "contain" }, EDGE);
  const at = { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4, layer: 2, aspect: 1 };
  const out = packNodes({ graph: g, looks }, null, undefined, (source) =>
    source === "missing.png" ? null : at,
  );
  const a = [...out.subarray(12, 19)];
  assert.deepEqual(
    a.map((v) => +v.toFixed(4)),
    [0.1, 0.2, 0.3, 0.4, 2, 7.0711, 7.0711],
  );
  assert.equal(out[NODE_STRIDE + 16], -1, "a ring has no icon");
  assert.equal(out[2 * NODE_STRIDE + 16], -1, "not loaded yet");
});

test("Canvas 2D draws a loaded icon clipped to its node, and a tile's fill gives way to it", () => {
  const store = new IconStore({ load: () => new Promise(() => {}) });
  const image = { width: 64, height: 64 };
  const model = new GraphModel({
    nodes: [{ id: "a", style: { icon: image, shape: "tile", size: 40 } }],
  });
  const g = new Graph(model);
  const scene = {
    graph: g,
    node: NODE,
    looks: looksOf(g, NODE, EDGE),
    camera: { x: 0, y: 0, k: 1 },
    width: 800,
    height: 600,
    dpr: 1,
    background: "#000000",
  };
  const { ctx, calls } = recorder();
  drawNodes(ctx, scene, store);
  const names = calls.map(([n]) => n);
  assert.ok(!names.includes("fill"), "the tile is its icon");
  const draw = calls.find(([n]) => n === "drawImage");
  assert.deepEqual(draw.slice(1), [image, -20, -20, 40, 40]);
  assert.ok(names.indexOf("clip") < names.indexOf("drawImage"));
  // Too small on screen: no icon, the tile's fill instead.
  const small = recorder();
  drawNodes(small.ctx, { ...scene, camera: { x: 0, y: 0, k: 0.1 } }, store);
  assert.ok(small.calls.some(([n]) => n === "fill"));
  assert.ok(!small.calls.some(([n]) => n === "drawImage"));
});

// ---- restyles patched in place -------------------------------------------------------------------------------------

test("patchLooks redoes just the restyled nodes and edges, and edges coloured by a restyled child", () => {
  const model = new GraphModel(SMALL);
  const g = new Graph(model);
  const edge = { ...EDGE, colorBy: "target" };
  const looks = looksOf(g, NODE, edge);
  model.update({ changeNodes: [{ id: "a1", style: { color: "#ff0000" } }] });
  g.refresh();
  const done = patchLooks(looks, g, NODE, edge, [3]);
  assert.deepEqual([...done.nodes], [3]);
  assert.deepEqual([...done.edges], [2], "a → a1 follows its child");
  assert.equal(looks.fill[3], "#ff0000");
  assert.equal(looks.edgeColour[2], "#ff0000");
  assert.deepEqual(
    looks,
    { ...looksOf(g, NODE, edge) },
    "same as from scratch",
  );
});

test("restylesSince: the restyles in between, or null when one restyled everything or is missing", () => {
  const log = [
    { version: 3, nodes: Int32Array.of(1), edges: Int32Array.of() },
    { version: 4, nodes: Int32Array.of(5, 1), edges: Int32Array.of(2) },
    { version: 5, nodes: null, edges: null },
    { version: 6, nodes: Int32Array.of(7), edges: Int32Array.of() },
  ];
  const r = restylesSince(log, 2, 4);
  assert.deepEqual([...r.nodes], [1, 5]);
  assert.deepEqual([...r.edges], [2]);
  assert.equal(restylesSince(log, 3, 5), null, "everything");
  assert.equal(restylesSince(log, 1, 4), null, "2 is missing");
  assert.deepEqual([...restylesSince(log, 5, 6).nodes], [7]);
  assert.deepEqual(runsOf([1, 2, 3, 40, 41, 90], 4), [
    [1, 4],
    [40, 42],
    [90, 91],
  ]);
});

test("a restyle in place finds nodes in the graph on screen when some are folded away", () => {
  let time = 1000;
  const c = new GraphController(new GraphModel(SMALL), null, {
    clock: () => time,
    worker: false,
    depth: 1, // root, a, b shown; a1 folded away
  });
  c.setViewport(800, 600);
  c.run(1000, { start: time });
  time += 1000;
  assert.equal(c.graph.nodes.length, 3);
  const geometry = c.geometryVersion;
  c.update({
    changeNodes: [
      { id: "b", style: { color: "#ff0000" } },
      { id: "a1", style: { color: "#00ff00" } },
    ],
  });
  assert.equal(c.geometryVersion, geometry, "patched, not rebuilt");
  const b = c.graph.byId.get("b").index;
  assert.equal(c.looks.fill[b], "#ff0000");
  assert.deepEqual([...c.restyles.at(-1).nodes], [b], "a1 isn't on screen");
});

function craftingSmall() {
  const url = new URL(
    "../fixtures/graphs/crafting-small.json",
    import.meta.url,
  );
  return new GraphModel(JSON.parse(readFileSync(url, "utf8")));
}

/** A controller laid out at rest, a WebGL painter that has drawn it, and a frame step. */
function painted(layout, sent) {
  let time = 1000;
  const c = new GraphController(craftingSmall(), null, {
    layout,
    worker: false,
    clock: () => time,
  });
  c.setViewport(800, 600, 1);
  c.run(1500, { start: time });
  time += 1500;
  const painter = new WebGLPainter(globalThis.document.createElement("canvas"));
  for (let i = 0; i < 100; i++) {
    painter.draw(c.scene);
    if (!painter.pending) break;
  }
  const step = () => {
    time += 16.7;
    c.tick(time);
    sent.bytes = 0;
    painter.draw(c.scene);
    return sent.bytes;
  };
  return { c, painter, step };
}

test("a node restyle uploads that node alone; the edges' pieces aren't touched", () => {
  withDom((sent) => {
    const { c, painter, step } = painted("tree", sent);
    assert.equal(step(), 0, "a frame at rest sends nothing");
    const pieces = painter.gpu;
    const n = c.graph.nodes[5];
    c.update({
      changeNodes: [
        { id: n.id, style: { color: "#ff0000", stroke: "#00ff00" } },
      ],
    });
    const bytes = step();
    assert.equal(bytes, NODE_STRIDE * 4, "one node's instance");
    assert.equal(painter.gpu, pieces, "the same edge pieces");
    // What was patched is what a full pack gives.
    const full = packNodes(c.scene, null, painter.origin);
    const count = c.graph.nodes.length * NODE_STRIDE;
    assert.deepEqual(
      [...painter.nodeData.subarray(0, count)],
      [...full.subarray(0, count)],
    );
    const o = n.index * NODE_STRIDE;
    assert.deepEqual([...painter.nodeData.subarray(o + 3, o + 6)], [1, 0, 0]);
    // An option change restyles everything: the whole graph goes up again.
    c.setNodeStyle({ colorBy: "branch" });
    assert.ok(step() > 20 * bytes);
  });
});

test("an edge restyle uploads that edge's pieces alone, the same as packing them all again", () => {
  withDom((sent) => {
    const { c, painter, step } = painted("tree", sent);
    step();
    const e = c.graph.edges.find((x) => x.tree);
    const index = c.graph.edges.indexOf(e);
    c.update({
      changeEdges: [{ id: e.id, style: { color: "#00ff00", width: 5 } }],
    });
    const pieces = painter.gpu;
    const bytes = step();
    assert.equal(painter.gpu, pieces);
    const g = pieces;
    const mine = [...g.pieceEdge.subarray(0, g.pieceCount)].filter(
      (i) => i === index,
    ).length;
    assert.ok(mine >= 1);
    assert.equal(bytes, mine * PIECE_STRIDE * 4);
    const fresh = packPieces(c.scene, painter.origin);
    assert.deepEqual(
      [...g.pieces.subarray(0, g.pieceCount * PIECE_STRIDE)],
      [...fresh.pieces.subarray(0, fresh.pieceCount * PIECE_STRIDE)],
    );
  });
});

test("restyles with references and CPU-traced edges patch the same as a full rebuild", () => {
  withDom((sent) => {
    // Fans are traced on the CPU; the merged tree draws references (display-only nodes past the real ones).
    for (const [layout, edge] of [
      ["tree", { shape: "fan", colorBy: "target" }],
      ["merged", { colorBy: "target" }],
    ]) {
      const { c, painter, step } = painted(layout, sent);
      c.setEdgeStyle(edge);
      step();
      const busy = c.graph.nodes.reduce((best, n) =>
        c.graph.incoming[n.index].length > c.graph.incoming[best.index].length
          ? n
          : best,
      );
      c.update({ changeNodes: [{ id: busy.id, style: { color: "#ff00ff" } }] });
      const bytes = step();
      const layer = painter;
      const full = packNodes(c.scene, null, layer.origin);
      const count = c.scene.graph.nodes.length * NODE_STRIDE;
      assert.deepEqual(
        [...layer.nodeData.subarray(0, count)],
        [...full.subarray(0, count)],
        `${layout}: nodes, references included`,
      );
      const { segments, segmentCount } = layer.edgeData;
      const again = new WebGLPainter(
        globalThis.document.createElement("canvas"),
      );
      sent.bytes = 0;
      again.draw(c.scene);
      assert.ok(
        bytes > 0 && bytes < sent.bytes / 4,
        `${layout}: ${bytes} bytes for the restyle, ${sent.bytes} for everything`,
      );
      const fresh = again.edgeData;
      assert.equal(fresh.segmentCount, segmentCount);
      assert.deepEqual(
        [...segments.subarray(0, segmentCount * 9)],
        [...fresh.segments.subarray(0, segmentCount * 9)],
        `${layout}: CPU segments`,
      );
    }
  });
});
