// The public API without a browser: the entry point, option and theme schemas, the style pipeline and hooks, and the
// plugin registries (shapes, arrowheads, routings, easings). GraphView itself needs WebGL2: see the demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as prism from "../src/index.js";
import {
  DEFAULT_OPTIONS,
  DEFAULT_THEME,
  OPTIONS,
  OPTIONS_SCHEMA,
  THEME_SCHEMA,
  nodeShapeNames,
  registerArrowShape,
  registerEasing,
  registerEdgeRouting,
  registerNodeShape,
  resolveEdgeStyle,
  resolveNodeStyle,
  resolveOptions,
  resolveTheme,
} from "../src/index.js";
import {
  customShapeGlsl,
  disableShape,
  glslShapeNames,
  pluginVersion,
  shapeId,
} from "../src/render/plugins.js";
import { nodeFragmentSource } from "../src/render/shaders.js";
import { arrowTemplate, edgeRoute } from "../src/render/edge-geometry.js";
import { springFor } from "../src/render/spring.js";

function capture(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("the entry point exports the view's API and the layout layer's", () => {
  for (const name of [
    "GraphView",
    "OPTIONS_SCHEMA",
    "THEME_SCHEMA",
    "registerNodeShape",
    "registerArrowShape",
    "registerEdgeRouting",
    "registerEasing",
    "WebGLGraph",
    // the layout layer
    "runLayout",
    "registerLayout",
    "registerForce",
    "TUNING_SCHEMA",
    "LivePhysics",
  ])
    assert.ok(prism[name], `${name} is exported`);
});

test("options: every one is described, and the layout settings are among them", () => {
  for (const key of ["layout", "direction", "physicsMode", "linkDistance"])
    assert.ok(key in OPTIONS_SCHEMA, key);
  for (const option of OPTIONS) {
    assert.ok(option.label && option.group && option.hint, option.key);
    assert.deepEqual(DEFAULT_OPTIONS[option.key], option.default, option.key);
    if (option.type === "number" || option.type === "integer")
      assert.ok(
        option.min <= option.default && option.default <= option.max,
        option.key,
      );
  }
});

test("options are checked: clamped, defaulted, warned about; strict throws", () => {
  const { result, warnings } = capture(() =>
    resolveOptions({
      edgeWidth: 500,
      hoverMode: "sometimes",
      nodeShape: "my-shape", // open: registered shapes are fine
      nodeStyle: 3,
      edgeWidht: 2,
    }),
  );
  assert.equal(result.edgeWidth, OPTIONS_SCHEMA.edgeWidth.max);
  assert.equal(result.hoverMode, "both");
  assert.equal(result.nodeShape, "my-shape");
  assert.equal(result.nodeStyle, null);
  assert.equal(warnings.length, 4);
  assert.match(warnings.join("\n"), /did you mean "edgeWidth"/);
  assert.throws(
    () => resolveOptions({ animationDuration: -1 }, { strict: true }),
    /animationDuration/,
  );
});

test("theme: every colour is described and checked", () => {
  assert.deepEqual(Object.keys(DEFAULT_THEME), Object.keys(THEME_SCHEMA));
  const { result, warnings } = capture(() =>
    resolveTheme({ edge: "#123456", node: "blue-ish", hover: "rgb(1,2,3)" }),
  );
  assert.equal(result.edge, "#123456");
  assert.equal(result.node, DEFAULT_THEME.node);
  assert.equal(result.hover, "rgb(1,2,3)");
  assert.equal(warnings.length, 1);
});

test("style order: options → root → class rules → the node's own style → the hook", () => {
  const seen = [];
  const o = resolveOptions({
    nodeSize: 40,
    rootBorderBoost: 2,
    nodeStyle: (node, style) => {
      seen.push([node.id, style.border]);
      return node.big ? { size: style.size * 2, unknownField: 1 } : null;
    },
  });
  const rules = {
    nodes: { warm: { border: "#ff0000", shape: "hexagon", ring: "#00ff00" } },
  };
  const root = resolveNodeStyle(
    new Set(["root", "warm"]),
    { id: "r", style: { border: "#0000ff" } },
    o,
    DEFAULT_THEME,
    rules,
  );
  assert.equal(root.size, 40 * o.rootSizeScale);
  assert.equal(root.borderWidth, o.nodeBorderWidth + 2);
  assert.equal(root.shape, "hexagon");
  assert.equal(root.ring, "#00ff00");
  assert.equal(root.border, "#0000ff"); // the node's own style beats the class
  const big = resolveNodeStyle(
    new Set(),
    { id: "b", big: true },
    o,
    DEFAULT_THEME,
  );
  assert.equal(big.size, 80);
  assert.equal("unknownField" in big, false);
  assert.deepEqual(seen, [
    ["r", "#0000ff"],
    ["b", DEFAULT_THEME.node],
  ]);
  // null only clears the fields that can be "none".
  const cleared = resolveNodeStyle(
    new Set(["warm"]),
    { style: { ring: null, border: null } },
    o,
    DEFAULT_THEME,
    rules,
  );
  assert.equal(cleared.ring, null);
  assert.equal(cleared.border, "#ff0000");
});

test("edge style: the edge's own style and the hook", () => {
  const o = resolveOptions({
    edgeStyle: (edge) => (edge.heavy ? { width: 6 } : undefined),
  });
  const heavy = resolveEdgeStyle(
    new Set(),
    { heavy: true, style: { glow: true, pattern: "dotted" } },
    o,
    DEFAULT_THEME,
  );
  assert.equal(heavy.width, 6);
  assert.equal(heavy.glow, true);
  assert.equal(heavy.pattern, "dotted");
});

test("custom node shapes: polygons and GLSL compile into the node shader under their own ids", () => {
  const before = pluginVersion();
  registerNodeShape("test-star", {
    polygon: Array.from({ length: 10 }, (_, k) => {
      const r = k % 2 ? 0.45 : 1,
        a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      return [r * Math.cos(a), r * Math.sin(a)];
    }),
    rounding: 0.2,
  });
  registerNodeShape("test-pill", {
    glsl: "vec2 d = abs(p) - h + min(h.x, h.y); return length(max(d, 0.0)) - min(h.x, h.y);",
  });
  assert.ok(pluginVersion() > before);
  assert.ok(nodeShapeNames().includes("test-star"));
  const star = shapeId("test-star"),
    pill = shapeId("test-pill");
  assert.ok(star >= 6 && pill === star + 1);
  assert.equal(shapeId("ellipse"), 2);
  assert.equal(shapeId("nothing-registered"), 1);
  const source = nodeFragmentSource(customShapeGlsl());
  assert.match(
    source,
    new RegExp(`float customShape${star}\\(vec2 p, vec2 h\\)`),
  );
  assert.match(source, /vec2 v\[10\] = vec2\[10\]\(/);
  assert.match(source, new RegExp(`abs\\(id - ${pill}\\.0\\) < 0\\.5`));
  assert.doesNotMatch(source, /\/\*CUSTOM/);
  // Leaving a broken one out.
  assert.doesNotMatch(
    nodeFragmentSource(customShapeGlsl(new Set(["test-pill"]))),
    new RegExp(`customShape${pill}`),
  );
  // Re-registering keeps the id.
  registerNodeShape("test-pill", { glsl: "return length(p) - h.x;" });
  assert.equal(shapeId("test-pill"), pill);
});

test("registerNodeShape rejects what it can't draw", () => {
  assert.throws(
    () => registerNodeShape("ellipse", { glsl: "return 0.0;" }),
    /built-in/,
  );
  assert.throws(
    () =>
      registerNodeShape("x", {
        polygon: [
          [0, 0],
          [1, 1],
        ],
      }),
    /3 to/,
  );
  assert.throws(
    () =>
      registerNodeShape("x", {
        polygon: [
          [0, 0],
          [2, 0],
          [0, 1],
        ],
      }),
    /-1\.\.1/,
  );
  assert.throws(() => registerNodeShape("x", {}), /polygon|glsl/);
});

test("custom arrowheads replace the template; routings and easings are used by name", () => {
  registerArrowShape("test-diamond", {
    triangles: [
      [0, 0],
      [0.5, -0.4],
      [1, 0],
      [0, 0],
      [1, 0],
      [0.5, 0.4],
    ],
    inset: 1,
  });
  assert.equal(arrowTemplate("test-diamond").inset, 1);
  assert.throws(
    () => registerArrowShape("bad", { triangles: [[0, 0]] }),
    /three per triangle/,
  );

  registerEdgeRouting("test-elbow", (s, t) => [
    { x: s.x, y: s.y },
    { x: t.x, y: s.y },
    { x: t.x, y: t.y },
  ]);
  const a = { x: 0, y: 0, hw: 5, hh: 5 },
    b = { x: 100, y: 50, hw: 5, hh: 5 };
  assert.deepEqual(edgeRoute(a, b, { routing: "test-elbow" })[1], {
    x: 100,
    y: 0,
  });
  registerEdgeRouting("test-broken", () => null);
  assert.equal(edgeRoute(a, b, { routing: "test-broken" }).length, 2); // falls back to straight

  registerEasing("test-lazy", { speed: 3, damping: 1.2 });
  assert.deepEqual(springFor(1000, "test-lazy"), { omega: 3, zeta: 1.2 });
  assert.deepEqual(springFor(1000, "unknown"), springFor(1000, "smooth"));
  assert.throws(
    () => registerEasing("x", { speed: 0, damping: 1 }),
    /positive/,
  );
});

test("style values are checked: clamped, or left out with one warning per source and problem", () => {
  const o = resolveOptions({});
  const { result, warnings } = capture(() => {
    const out = [];
    for (let k = 0; k < 3; k++)
      out.push(
        resolveNodeStyle(
          new Set(["bad"]),
          { style: { size: -5, border: "nope", pattern: "zigzag", sizee: 3 } },
          o,
          DEFAULT_THEME,
          { nodes: { bad: { fillAlpha: 7, aura: "rgb(1,2)" } } },
        ),
      );
    return out;
  });
  const style = result[0];
  assert.equal(style.size, 1); // clamped to the smallest size, never invisible
  assert.equal(style.border, DEFAULT_THEME.node); // left as it was
  assert.equal(style.pattern, "solid");
  assert.equal(style.fillAlpha, 1);
  assert.equal(style.aura, null);
  assert.equal(warnings.length, 6); // once each, not per node
  assert.match(
    warnings.join("\n"),
    /a node's style: "border" expected a CSS colour/,
  );
  assert.match(
    warnings.join("\n"),
    /node class "bad": "fillAlpha" out of range/,
  );
  assert.match(warnings.join("\n"), /unknown style field "sizee"/);
  const hooked = capture(() =>
    resolveEdgeStyle(
      new Set(),
      {},
      resolveOptions({ edgeStyle: () => ({ width: "wide", pattern: null }) }),
      DEFAULT_THEME,
    ),
  );
  assert.equal(hooked.result.width, resolveOptions({}).edgeWidth);
  assert.equal(hooked.result.pattern, null);
  assert.match(
    hooked.warnings.join(),
    /the edgeStyle hook: "width" expected a number/,
  );
});

test("zoom limits out of order are swapped, with a warning (strict: thrown)", () => {
  const { result, warnings } = capture(() =>
    resolveOptions({ minZoom: 0.9, maxZoom: 0.2 }),
  );
  assert.equal(result.minZoom, 0.2);
  assert.equal(result.maxZoom, 0.9);
  assert.match(warnings.join(), /minZoom \(0\.9\) is above maxZoom \(0\.2\)/);
  assert.throws(
    () => resolveOptions({ minZoom: 0.9, maxZoom: 0.2 }, { strict: true }),
    /swapping/,
  );
});

test("names nothing is registered under draw the fallback, with one warning each", () => {
  const { warnings } = capture(() => {
    for (let k = 0; k < 3; k++) {
      assert.equal(shapeId("test-blob"), 1);
      arrowTemplate("test-arrowless");
      edgeRoute(
        { x: 0, y: 0, hw: 5, hh: 5 },
        { x: 50, y: 50, hw: 5, hh: 5 },
        { routing: "test-wiggle" },
      );
      springFor(300, "test-wobbly");
    }
    shapeId(undefined);
    arrowTemplate("vee");
    edgeRoute(
      { x: 0, y: 0, hw: 5, hh: 5 },
      { x: 50, y: 50, hw: 5, hh: 5 },
      { routing: "arc" },
    );
  });
  assert.equal(warnings.length, 4);
  assert.match(
    warnings.join("\n"),
    /unknown node shape "test-blob" \(not registered\); drawing round-rectangle/,
  );
  assert.match(warnings.join("\n"), /unknown arrowhead "test-arrowless"/);
  assert.match(warnings.join("\n"), /unknown edge routing "test-wiggle"/);
  assert.match(warnings.join("\n"), /unknown easing "test-wobbly"/);
  // Registered later: no longer unknown.
  registerNodeShape("test-blob", { glsl: "return length(p) - h.x;" });
  assert.notEqual(shapeId("test-blob"), 1);
});

test("a shape that didn't compile is left out of later shaders and the shape list, until registered again", () => {
  registerNodeShape("test-broken", { glsl: "return nonsense(p);" });
  const id = shapeId("test-broken");
  assert.ok(
    nodeFragmentSource(customShapeGlsl()).includes(`customShape${id}(`),
  );
  disableShape("test-broken");
  assert.ok(
    !nodeFragmentSource(customShapeGlsl()).includes(`customShape${id}(`),
  );
  assert.ok(!nodeShapeNames().includes("test-broken"));
  assert.ok(!glslShapeNames().includes("test-broken"));
  assert.equal(shapeId("test-broken"), id); // drawn as the default by the shader, without a second warning
  registerNodeShape("test-broken", { glsl: "return length(p) - h.x;" });
  assert.ok(nodeShapeNames().includes("test-broken"));
});

test("lineageColor defaults to the theme's colours (unchanged behaviour)", () => {
  assert.equal(resolveOptions({}).lineageColor, "theme");
  assert.equal(resolveOptions({ lineageColor: "edge" }).lineageColor, "edge");
});
