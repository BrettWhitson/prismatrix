// Text over the graph and edges clear of it: labels cut short, edges that start past their own node's label (the
// same on the CPU and the GPU), edge labels, "×N" on shared ingredients, badges, pinned labels, link glyphs, and
// what the WebGL painter's text layer sends the GPU. (The pixels themselves are compared in the browser.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_CLEAR,
  ELLIPSIS,
  LABEL_GAP,
  LINE,
  fitLabel,
  footprint,
  labelRect,
  startTrim,
} from "../../next/engine/boxes.js";
import { edgeRoute, startTrims, trim } from "../../next/engine/geometry.js";
import { GraphModel, roughMeasure } from "../../next/engine/model.js";
import { GraphController } from "../../next/engine/controller.js";
import {
  EDGE_LABEL_BACK,
  EDGE_LABEL_SCALE,
  PILL,
  PINNED_PX,
  Room,
  textColours,
  badgesOf,
  edgeLabelAt,
  pinnedNodes,
  planText,
  textBox,
  textFitter,
  textVisibility,
} from "../../next/engine/labels.js";
import {
  PIECE_STRIDE,
  packPieces,
  piecePoints,
  AXIS,
} from "../../next/engine/gl-edges.js";
import {
  GLYPH_STRIDE,
  packEdges,
  packGlyphs,
} from "../../next/engine/gl-pack.js";
import {
  GLYPH_MIN_PX,
  glyphRadius,
  linkGlyphs,
} from "../../next/engine/references.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** A small crafting recipe with names, quantities on its edges and shared ingredients. */
function recipe() {
  const R = {
    Aurora: ["Gift of Aurora", "Gift of Mastery", "Coeus"],
    "Gift of Aurora": ["Mystic Coin", "Glob of Ectoplasm", "Ley-Line Spark"],
    "Gift of Mastery": ["Mystic Coin", "Obsidian Shard", "Bloodstone Shard"],
    Coeus: ["Mystic Coin", "Glob of Ectoplasm"],
    "Ley-Line Spark": ["Mystic Coin", "Glob of Ectoplasm"],
  };
  const id = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const names = new Set();
  for (const [k, v] of Object.entries(R)) {
    names.add(k);
    for (const x of v) names.add(x);
  }
  let q = 0;
  return {
    nodes: [...names].map((n) => ({ id: id(n), label: n })),
    edges: Object.entries(R).flatMap(([k, v]) =>
      v.map((x) => ({
        source: id(k),
        target: id(x),
        label: `×${[1, 5, 250][q++ % 3]}`,
      })),
    ),
  };
}

/** A controller laid out and settled, headless (rough text measurement). */
function view(json, { layout = "tree", node = {}, edge = {}, ...rest } = {}) {
  let t = 1000;
  const model = new GraphModel(json, { node, edge });
  const c = new GraphController(model, null, {
    layout,
    worker: false,
    physics: "static",
    clock: () => t,
    ...rest,
  });
  c.setViewport(800, 600, 1);
  c.run(600, { start: t });
  t += 700;
  return {
    c,
    /** Tick on a little (after setting hover, the camera, a fold). */
    settle() {
      c.run(400, { start: t });
      t += 500;
      return c.scene;
    },
  };
}

const fit = textFitter(roughMeasure);

// ---- labels cut short --------------------------------------------------------------------------------------------

test("a label wider than the limit is cut at a character with an ellipsis, as wide as fits", () => {
  const width = (t) => t.length * 10;
  assert.deepEqual(fitLabel("Mystic Coin", 0, width), {
    text: "Mystic Coin",
    width: 110,
  });
  assert.deepEqual(fitLabel("Mystic Coin", 110, width).text, "Mystic Coin");
  const cut = fitLabel("Mystic Coin", 75, width);
  assert.equal(cut.text, `Mystic${ELLIPSIS}`, "the space before it goes too");
  assert.ok(cut.width <= 75);
  // The most that fits: one more character wouldn't.
  const long = fitLabel("Amalgamated Gemstone", 100, width);
  assert.equal(long.text, `Amalgamat${ELLIPSIS}`);
  assert.ok(width(`Amalgamate${ELLIPSIS}`) > 100);
  // Characters, not UTF-16 halves.
  assert.equal(
    fitLabel("\u{1F4A0}\u{1F4A0}\u{1F4A0}", 45, width).text,
    `\u{1F4A0}${ELLIPSIS}`,
  );
  assert.equal(fitLabel("abc", 1, width).text, ELLIPSIS);
});

test("the model keeps room for the cut label, and a new limit measures again and lays out again", () => {
  const m = new GraphModel(
    { nodes: [{ id: "a", label: "A rather long name for an item" }] },
    { node: { labelSize: 10, labelMaxWidth: 100 } },
  );
  const width = m.labelWidths()[0];
  assert.ok(width <= 100);
  assert.equal(
    width,
    roughMeasure(
      fitLabel(m.nodes[0].label, 100, (t) => roughMeasure(t, 10)).text,
      10,
    ),
  );
  const change = m.setOptions({ node: { labelMaxWidth: 0 } });
  assert.ok(change.sizes, "a new limit changes the room labels take");
  assert.equal(m.labelWidths()[0], roughMeasure(m.nodes[0].label, 10));
});

test("the hovered label is drawn whole; the others as cut", () => {
  const long = "Gift of Magic, the Very Long Named One";
  const { c, settle } = view(
    {
      nodes: [
        { id: "r", label: "Root" },
        { id: "a", label: long },
      ],
      edges: [{ source: "r", target: "a" }],
    },
    { node: { labelMaxWidth: 120 } },
  );
  let scene = c.scene;
  const shown = (s) =>
    planText(s, { fit }).find((i) => i.text.startsWith("Gift")).text;
  assert.ok(shown(scene).endsWith(ELLIPSIS));
  c.hover = c.graph.byId.get("a").index;
  scene = settle();
  assert.equal(shown(scene), long);
});

// ---- edges clear of their own labels -----------------------------------------------------------------------------

test("an edge leaving through its node's label starts past it; one that doesn't, at the node", () => {
  const r = 8,
    w = 60,
    h = 11 * LINE;
  const below = labelRect(r, Math.PI / 2, w, h);
  assert.deepEqual(below, {
    x0: -30,
    y0: r + LABEL_GAP,
    x1: 30,
    y1: r + LABEL_GAP + h,
  });
  // The footprint holds the node and the label.
  const box = footprint(r, Math.PI / 2, w, h);
  assert.equal(box.y1, below.y1);
  assert.equal(box.x0, -30);
  // Straight down: past the label's bottom.
  assert.ok(
    close(startTrim(r, r, Math.PI / 2, w, h, 0, 1), below.y1 + EDGE_CLEAR),
  );
  // Down and to the side: out through the label's side.
  const d = [Math.SQRT1_2, Math.SQRT1_2];
  assert.ok(
    close(
      startTrim(r, r, Math.PI / 2, w, h, ...d),
      below.y1 / d[1] + EDGE_CLEAR,
    ),
  );
  // Up, or sideways under a label below: never through it.
  assert.equal(startTrim(r, r, Math.PI / 2, w, h, 0, -1), r);
  assert.equal(startTrim(r, r, Math.PI / 2, w, h, 1, 0), r);
  // A label to the right, an edge going right (left to right): past its end.
  assert.ok(
    close(startTrim(r, r, 0, w, h, 1, 0), r + LABEL_GAP + w + EDGE_CLEAR),
  );
  // Never more than the cap, never less than the node.
  assert.equal(startTrim(r, r, Math.PI / 2, w, h, 0, 1, 12), 12);
  assert.equal(startTrim(r, r, Math.PI / 2, w, h, 0, 1, 2), r);
  assert.equal(startTrim(r, r, Math.PI / 2, 0, h, 0, 1), r, "no label");
});

test("tree edges start below their parent's label, on the CPU and the GPU alike; bundles at the node", () => {
  const { c } = view(recipe(), { edge: { shape: "step" } });
  const scene = c.scene;
  const { graph, looks } = scene;
  const trims = startTrims(scene);
  const h = scene.node.labelSize * LINE;
  let below = 0;
  graph.edges.forEach((e, ei) => {
    const r = looks.radius[e.source];
    if (!e.tree) {
      assert.equal(trims[ei], r, "a bundled cross-link starts at its node");
      return;
    }
    const s = graph.nodes[e.source];
    assert.ok(close(trims[ei], r + LABEL_GAP + h + EDGE_CLEAR), `${s.id}`);
    below++;
    // The CPU's route, trimmed, starts under the label...
    const pts = trim(edgeRoute(graph, scene.routing, "step", e), trims[ei], r);
    assert.ok(close(pts[0], s.x) && close(pts[1], s.y + trims[ei], 1e-6));
  });
  assert.ok(below > 5);
  // ...and so does the GPU's piece (its first trim), traced by the shader's twin.
  const packed = packPieces(scene, { x: 0, y: 0 });
  for (let p = 0; p < packed.pieceCount; p++) {
    const o = p * PIECE_STRIDE;
    const ei = packed.pieceEdge[p];
    assert.equal(packed.pieces[o + 10], Math.fround(trims[ei]));
    const e = graph.edges[ei],
      s = graph.nodes[e.source],
      t = graph.nodes[e.target];
    const pts = piecePoints(
      1,
      AXIS.TB,
      [s.x, s.y],
      [t.x, t.y],
      trims[ei],
      looks.radius[e.target],
      scene.edge.corner,
    );
    assert.ok(close(pts[0][1], s.y + trims[ei], 1e-4));
  }
  // The CPU's segments (fans, tapers) start there too.
  const segs = packEdges({ ...scene, edge: { ...scene.edge, taper: true } });
  const first = graph.edges.findIndex((e) => e.tree);
  const at = segs.segmentEdge.indexOf(first);
  const s = graph.nodes[graph.edges[first].source];
  assert.ok(close(segs.segments[at * 9 + 1], s.y + trims[first], 1e-3));
});

test("without label widths (or with labels off) edges start at their nodes, as before", () => {
  const { c } = view(recipe(), { edge: { shape: "curve" } });
  const scene = c.scene;
  const radii = scene.graph.edges.map((e) => scene.looks.radius[e.source]);
  assert.deepEqual([...startTrims({ ...scene, labelWidths: null })], radii);
  assert.deepEqual(
    [...startTrims({ ...scene, node: { ...scene.node, labels: "off" } })],
    radii,
  );
});

test("in a merged tree, every edge leaves below its source's label, and never past halfway to its first stop", () => {
  const { c } = view(recipe(), { layout: "merged" });
  const scene = c.scene;
  const trims = startTrims(scene);
  scene.graph.edges.forEach((e, ei) => {
    const s = scene.graph.nodes[e.source];
    const bend = scene.routing.bends.get(e)?.[0];
    const t = scene.graph.nodes[e.target];
    const reachOut = Math.abs((bend ? bend[1] : t.homeY) - s.homeY);
    assert.ok(trims[ei] > scene.looks.radius[e.source]);
    assert.ok(
      trims[ei] <= reachOut * 0.45 + 1e-9 ||
        trims[ei] === scene.looks.radius[e.source],
    );
  });
});

// ---- edge labels -------------------------------------------------------------------------------------------------

test("an edge label sits beside its edge: right of one going down, above one going across", () => {
  const down = edgeLabelAt([0, 0, 0, 100], "target", 10, 3);
  assert.deepEqual(down, { x: 3, y: 90, align: "left", baseline: "middle" });
  const middle = edgeLabelAt([0, 0, 0, 100], "middle", 10, 3);
  assert.equal(middle.y, 50);
  const across = edgeLabelAt([0, 0, 100, 0], "target", 10, 3);
  assert.deepEqual(across, {
    x: 90,
    y: -3,
    align: "center",
    baseline: "bottom",
  });
  // Up an edge going left: still on the right, or above.
  const left = edgeLabelAt([100, 0, 0, 0], "target", 10, 3);
  assert.equal(left.baseline, "bottom");
  // A step: along the last run, never further back than halfway.
  const step = edgeLabelAt([0, 0, 0, 50, 80, 50, 80, 100], "target", 20, 3);
  assert.deepEqual([step.x, step.y], [83, 80]);
  assert.equal(edgeLabelAt([5, 5, 5, 5], "target", 1, 1), null);
});

test("edge labels come from the model, show once zoomed in, sit near the target, and follow restyles", () => {
  const { c, settle } = view(recipe(), { edge: { shape: "step" } });
  assert.equal(c.model.edges[0].label, "×1");
  assert.equal(c.graph.edges[0].label, "×1");
  assert.equal(c.model.toJSON().edges[0].label, "×1");
  c.camera = { ...c.camera, k: 0.3 };
  let scene = settle();
  const edgeItems = (s) =>
    planText(s, { fit }).filter((i) => i.colour === textColours().quiet);
  assert.equal(edgeItems(scene).length, 0, "too small to read: hidden");
  assert.ok(!textVisibility(scene).edges);
  const coeus = c.graph.byId.get("coeus");
  c.camera = { x: coeus.x, y: coeus.y, k: 2 };
  scene = settle();
  const items = edgeItems(scene);
  assert.ok(items.length > 0);
  const size = scene.node.labelSize * EDGE_LABEL_SCALE;
  // Aurora → Coeus: Coeus has one way in, so its label is near its top, right of the edge.
  const e = c.graph.edges.find(
    (f) =>
      c.graph.nodes[f.source].id === "aurora" &&
      c.graph.nodes[f.target].id === "coeus",
  );
  const item = items.find(
    (i) =>
      i.text === e.label &&
      close(i.x, coeus.x + 3 + scene.looks.edgeWidth[0] / 2, 1e-6),
  );
  assert.ok(item, "beside the edge coming down into Coeus");
  assert.ok(
    close(
      item.y,
      coeus.y - scene.looks.radius[coeus.index] - size * EDGE_LABEL_BACK,
      1e-6,
    ),
  );
  assert.equal(item.align, "left");
  // A new label is a restyle: drawn, nothing laid out again.
  const change = c.model.update({ changeEdges: [{ id: e.id, label: "×42" }] });
  assert.deepEqual(change.edgesRestyled, [e.id]);
  assert.ok(!change.dataOnly && !change.structure && !change.sizes);
  scene = settle();
  assert.ok(edgeItems(scene).some((i) => i.text === "×42"));
  assert.ok(!c.model.update({ changeEdges: [{ id: e.id, label: "×42" }] }));
  c.model.update({ changeEdges: [{ id: e.id, label: null }] });
  assert.equal(c.model.edge(e.id).label, "");
  assert.ok(!("label" in c.model.toJSON().edges.find((f) => f.id === e.id)));
});

test("edge labels that would land on each other: only the first is drawn", () => {
  const room = new Room(40);
  assert.ok(room.take({ x0: 0, y0: 0, x1: 10, y1: 10 }));
  assert.ok(!room.take({ x0: 5, y0: 5, x1: 15, y1: 15 }));
  assert.ok(room.take({ x0: 10, y0: 0, x1: 20, y1: 10 }), "touching is fine");
  assert.ok(room.take({ x0: 1000, y0: 1000, x1: 1001, y1: 1001 }));
});

// ---- boxes and badges --------------------------------------------------------------------------------------------

test("text boxes: aligned like Canvas 2D; a badge's pill pads its text", () => {
  const text = { size: 10, align: "center", baseline: "top", pill: false };
  assert.deepEqual(textBox(text, 40), {
    left: -20,
    middle: 5,
    width: 40,
    height: 10,
    text: -20,
  });
  const pill = { size: 10, align: "left", baseline: "bottom", pill: true };
  const box = textBox(pill, 20);
  assert.equal(box.width, 20 + 2 * PILL.pad * 10);
  assert.equal(box.height, PILL.height * 10);
  assert.equal(box.middle, -box.height / 2, "its bottom on the anchor");
  assert.equal(box.text, PILL.pad * 10);
  assert.equal(textBox({ ...pill, align: "right" }, 20).left, -box.width);
});

test("badges: a collapsed node's +N (a dim + when nothing's hidden) and the node's own badge beside it", () => {
  const nodes = [
    { style: {} },
    { style: { badge: "!" } },
    { style: { badge: "new" } },
  ];
  const scene = {
    graph: { nodes },
    collapsed: Uint8Array.from([1, 1, 0]),
    hidden: Int32Array.from([12, 0, 0]),
  };
  assert.deepEqual(badgesOf(scene, 0), [
    { text: "+12", side: "right", fold: true },
  ]);
  assert.deepEqual(badgesOf(scene, 1), [
    { text: "+", side: "right", fold: true },
    { text: "!", side: "left" },
  ]);
  assert.deepEqual(badgesOf(scene, 2), [{ text: "new", side: "right" }]);
  assert.deepEqual(badgesOf({ graph: { nodes }, collapsed: null }, 0), []);
});

test("a collapsed node's badge and a styled node's badge are planned as pills at the node's top corners", () => {
  const json = recipe();
  json.nodes.find((n) => n.id === "coeus").style = { badge: "!" };
  const { c, settle } = view(json, { edge: { shape: "step" } });
  c.collapse("gift-of-aurora");
  const aurora = () => c.graph.byId.get("gift-of-aurora");
  c.camera = { x: aurora().x, y: aurora().y, k: 2 };
  const scene = settle();
  assert.ok(scene.collapsed, "the controller marks collapsed nodes");
  const pills = planText(scene, { fit }).filter((i) => i.pill);
  const fold = pills.find((p) => p.text.startsWith("+"));
  assert.ok(fold, "the fold mark");
  const n = aurora();
  const r = scene.looks.radius[n.index];
  assert.ok(close(fold.x, n.x + r * 0.55) && close(fold.y, n.y - r * 0.55));
  assert.equal(
    fold.under,
    scene.looks.fill[n.index],
    "a pill in the node's colour",
  );
  assert.equal(fold.colour, scene.background, "its text in the background's");
  assert.equal(fold.text, `+${scene.hidden[n.index]}`);
  assert.ok(
    pills.some((p) => p.text === "!"),
    "the app's own badge",
  );
});

// ---- references, pinned labels, glyphs ---------------------------------------------------------------------------

test("a shared ingredient with references carries ×N, N its in-degree", () => {
  const { c } = view(recipe(), {
    layout: "merged",
    layoutOptions: { references: "hubs", shareMin: 2 },
  });
  const scene = c.scene;
  const refs = c.routing.references;
  assert.ok(refs.length > 0, "the layout drew references");
  const coin = c.graph.byId.get("mystic-coin").index;
  assert.equal(scene.graph.uses.get(coin), c.graph.incoming[coin].length);
  c.camera = { ...c.camera, k: 2 };
  c.run(50);
  const counts = planText(c.scene, { fit }).filter(
    (i) => i.colour === textColours().quiet,
  );
  assert.ok(counts.some((i) => i.text === `×${c.graph.incoming[coin].length}`));
});

test("zoomed out, only pinned labels show, at a size you can read; hovering an ingredient names its chips", () => {
  const { c, settle } = view(recipe(), {
    layout: "merged",
    layoutOptions: { references: "hubs", shareMin: 2 },
  });
  c.camera = { ...c.camera, k: 0.1 };
  let scene = settle();
  assert.ok(!textVisibility(scene).labels);
  let items = planText(scene, { fit });
  assert.deepEqual(
    items.map((i) => i.text),
    ["Aurora"],
    "the root alone",
  );
  assert.ok(items[0].screen && items[0].size === PINNED_PX);
  const coin = c.graph.byId.get("mystic-coin").index;
  c.hover = coin;
  scene = settle();
  assert.deepEqual([...pinnedNodes(scene).entries()].at(-1), [coin, true]);
  items = planText(scene, { fit });
  const chips = scene.graph.nodes.filter((n) => n.reference === coin);
  assert.ok(chips.length > 0);
  assert.equal(
    items.filter((i) => i.text === "Mystic Coin").length,
    chips.length + 1,
    "on each chip and on the ingredient",
  );
  // Zoomed in, pinned labels are labels like the others (in world px), drawn last.
  c.camera = { ...c.camera, k: 2 };
  scene = settle();
  items = planText(scene, { fit });
  assert.equal(items.at(-1).text, "Mystic Coin");
  assert.ok(!items.at(-1).screen);
});

test("chips get a link glyph once it's big enough to see; the GPU gets every one, the shader leaves out the small", () => {
  const { c } = view(recipe(), {
    layout: "merged",
    layoutOptions: { references: "hubs", shareMin: 2 },
  });
  const scene = c.scene;
  const chips = scene.graph.nodes.filter((n) => n.reference !== undefined);
  const r = glyphRadius(scene.looks.radius[chips[0].index]);
  assert.ok(r > 0 && r < scene.looks.radius[chips[0].index]);
  const big = {
    ...scene,
    camera: { ...scene.camera, k: (GLYPH_MIN_PX + 1) / r },
  };
  const tiny = {
    ...scene,
    camera: { ...scene.camera, k: (GLYPH_MIN_PX - 1) / r },
  };
  assert.equal(linkGlyphs(big).length, chips.length);
  assert.equal(linkGlyphs(tiny).length, 0);
  const packed = packGlyphs(tiny, null, { x: 10, y: 0 });
  assert.equal(packed.count, chips.length);
  assert.ok(close(packed.data[0], chips[0].x - 10, 1e-3));
  assert.ok(close(packed.data[2], r, 1e-5));
  assert.equal(packed.data.length >= chips.length * GLYPH_STRIDE, true);
});

// ---- the WebGL text layer ----------------------------------------------------------------------------------------

import {
  LABEL_STRIDE,
  LabelLayer,
  labelBox,
} from "../../next/engine/gl-text.js";

/** Just enough DOM and GL for the text layer: text 6 px a character, every upload counted. */
function withDom(body) {
  const saved = globalThis.document;
  const sent = { cells: 0 };
  const ctx = new Proxy(
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
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
  const gl = new Proxy(
    {},
    {
      get: (_, name) =>
        /^[A-Z0-9_]+$/.test(name)
          ? name
          : name === "texSubImage2D"
            ? () => sent.cells++
            : () => ({}),
    },
  );
  try {
    body(gl, sent);
  } finally {
    globalThis.document = saved;
  }
}

test("the text layer: a quad per piece of text, in drawing order, anchored where planned, in its colours", () => {
  withDom((gl, sent) => {
    const { c, settle } = view(recipe(), {
      layout: "merged",
      layoutOptions: { references: "hubs", shareMin: 2 },
    });
    const coin = c.graph.byId.get("mystic-coin");
    c.camera = { x: coin.x, y: coin.y, k: 2 };
    c.hover = coin.index;
    const scene = settle();
    const layer = new LabelLayer(gl);
    const origin = { x: 100, y: -50 };
    let built = layer.build(scene, origin);
    for (let i = 0; built.pending && i < 50; i++)
      built = layer.build(scene, origin);
    const items = planText(scene, { fit: layer.fit, near: null }).filter(
      (i) =>
        Math.abs(i.x - scene.camera.x) < 400 &&
        Math.abs(i.y - scene.camera.y) < 300,
    );
    assert.ok(built.count >= items.length && items.length > 3);
    assert.equal(sent.cells > 0, true, "text drawn into the atlas");
    assert.equal(
      built.groups.reduce((n, g) => n + g.count, 0),
      built.count,
    );
    const d = built.data;
    const rows = Array.from({ length: built.count }, (_, k) =>
      d.subarray(k * LABEL_STRIDE, (k + 1) * LABEL_STRIDE),
    );
    // The hovered ingredient's label is last, whole, anchored under it, in the label colour over the background.
    const last = rows.at(-1);
    assert.equal(last[2], 0, "zoomed in: world units");
    const n = scene.graph.nodes[coin.index];
    assert.ok(close(last[0] + origin.x, n.x, 1e-3));
    const [r, g, b] = [0xd5 / 255, 0xd9 / 255, 0xe4 / 255];
    assert.ok(
      close(last[12], r, 1e-6) &&
        close(last[13], g, 1e-6) &&
        close(last[14], b, 1e-6),
    );
    // Its box: centred, as wide as the text (6 texels a character here, drawn at 2 texels a world px at zoom 2)
    // plus the cell's padding.
    const width = ("Mystic Coin".length * 6) / 2;
    assert.ok(close(last[3] + last[5] / 2, 0, 1e-4), "centred on the anchor");
    assert.ok(last[5] > width);
    // A pan within the cell reuses everything; nothing new is drawn into the atlas.
    const before = sent.cells;
    layer.build(
      { ...scene, camera: { ...scene.camera, x: scene.camera.x + 3 } },
      origin,
    );
    assert.equal(sent.cells, before);
  });
});

test("zoomed out, pinned labels are anchored in the world but sized on screen", () => {
  withDom((gl) => {
    const { c, settle } = view(recipe(), { layout: "merged" });
    c.camera = { ...c.camera, k: 0.1 };
    const scene = settle();
    const layer = new LabelLayer(gl);
    let built = layer.build(scene);
    for (let i = 0; built.pending && i < 50; i++) built = layer.build(scene);
    assert.equal(built.count, 1);
    const row = built.data.subarray(0, LABEL_STRIDE);
    assert.equal(row[2], 1, "screen units");
    // "Aurora" at PINNED_PX on screen, 6 px a character at size 1: about PINNED_PX / labelSize × 36 px wide, plus
    // padding, in screen px whatever the zoom.
    const text = "Aurora".length * 6;
    assert.ok(row[5] > text * 0.5 && row[5] < text * 2);
  });
});

test("label boxes sit where the Canvas 2D renderer puts its text", () => {
  const below = labelBox(0, 0, 10, Math.PI / 2, 12, 40);
  assert.ok(close(below.left, -20) && close(below.middle, 20));
});
