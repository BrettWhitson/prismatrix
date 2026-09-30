// The public API: the entry point, schemas and validation, the layout and force registries, and events.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as tether from "../src/index.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TUNING,
  LayoutGraph,
  LivePhysics,
  SETTINGS_SCHEMA,
  TUNING_OPTIONS,
  TUNING_SCHEMA,
  createForce,
  flowOf,
  isColor,
  isDirectionalLayout,
  listLayouts,
  registerForce,
  registerLayout,
  resolve,
  resolveSettings,
  resolveTuning,
  runLayout,
  uniqueById,
} from "../src/index.js";

const SETTINGS = {
  direction: "TB",
  centerForce: 0.2,
  repelForce: 8,
  linkForce: 0.5,
  linkDistance: 120,
};

function smallGraph() {
  const ids = ["root", "a", "b", "c", "d"];
  return new LayoutGraph(
    ids.map((id, i) => ({ id, w: 40, h: 40, root: i === 0 })),
    [
      ["root", "a"],
      ["root", "b"],
      ["a", "c"],
      ["b", "d"],
    ].map(([source, target]) => ({ source, target })),
  );
}

/** Collect warnings instead of printing them. */
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

test("the entry point exports the whole API", () => {
  for (const name of [
    "LayoutGraph",
    "runLayout",
    "LivePhysics",
    "ForceSimulation",
    "ElasticNetwork",
    "registerLayout",
    "registerForce",
    "resolveSettings",
    "resolveTuning",
    "SETTINGS_SCHEMA",
    "TUNING_SCHEMA",
    "Emitter",
  ])
    assert.ok(tether[name], `${name} is exported`);
});

test("defaults come from the schemas; every tuning constant has a control", () => {
  assert.equal(DEFAULT_SETTINGS.direction, SETTINGS_SCHEMA.direction.default);
  assert.deepEqual(
    TUNING_OPTIONS.map((o) => o.key),
    Object.keys(TUNING_SCHEMA),
  );
  for (const option of TUNING_OPTIONS) {
    assert.ok(option.label && option.group && option.hint, option.key);
    if (option.type !== "boolean") {
      assert.ok(option.min <= option.default, option.key);
      assert.ok(option.default <= option.max, option.key);
    }
  }
});

test("bad values are clamped or replaced by defaults, with one warning each", () => {
  const { result, warnings } = capture(() =>
    resolveTuning({
      theta: 99,
      ticksSmall: 12.4,
      dragHeat: "hot",
      velocityDecay: 0.5,
      repelScle: 3,
    }),
  );
  assert.equal(result.theta, TUNING_SCHEMA.theta.max);
  assert.equal(result.ticksSmall, 12);
  assert.equal(result.dragHeat, DEFAULT_TUNING.dragHeat);
  assert.equal(result.velocityDecay, 0.5);
  assert.equal(result.repelScle, undefined);
  assert.equal(warnings.length, 4);
  assert.match(warnings.join("\n"), /did you mean "repelScale"/);
});

test("strict mode throws instead of warning", () => {
  assert.throws(
    () => resolveSettings({ physicsMode: "wobbly" }, { strict: true }),
    /physicsMode/,
  );
  assert.throws(
    () =>
      runLayout(
        smallGraph(),
        { ...SETTINGS, linkDistance: -5 },
        { strict: true },
      ),
    /linkDistance/,
  );
});

test("settings keep the app's own keys; enums accept registered plugins", () => {
  const { result, warnings } = capture(() =>
    resolveSettings({ myAppFlag: 1, layout: "someday-registered" }),
  );
  assert.equal(result.myAppFlag, 1);
  assert.equal(result.layout, "someday-registered");
  assert.equal(warnings.length, 0);
});

test("resolve() reports colours and enums", () => {
  const schema = {
    tint: { type: "color", default: "#fff" },
    shape: { type: "enum", values: ["a", "b"], default: "a" },
  };
  const warnings = [];
  const out = resolve(
    schema,
    { tint: "not a colour", shape: "c" },
    { warn: (m) => warnings.push(m) },
  );
  assert.deepEqual(out, { tint: "#fff", shape: "a" });
  assert.equal(warnings.length, 2);
  assert.deepEqual(
    resolve(schema, { tint: "rgba(1, 2, 3, 0.5)" }).tint,
    "rgba(1, 2, 3, 0.5)",
  );
});

test("a registered layout is used by name, and its structure mode drives the physics", () => {
  registerLayout("test-line", {
    label: "Line",
    seed(graph) {
      for (let i = 0; i < graph.count; i++) {
        graph.x[i] = i * 100;
        graph.y[i] = 0;
      }
      return { mode: "none" };
    },
  });
  assert.ok(listLayouts().some((l) => l.name === "test-line"));
  assert.equal(isDirectionalLayout({ layout: "test-line" }), false);
  assert.equal(isDirectionalLayout({ layout: "tree" }), true);
  assert.equal(
    isDirectionalLayout({ layout: "tree", direction: "radial" }),
    false,
  );
  const graph = smallGraph();
  const simulation = runLayout(graph, { ...SETTINGS, layout: "test-line" });
  assert.equal(simulation.options.mode, "none");
  // A line stays roughly a line: the forces polish it but there's no level or ring to pull it into.
  const ys = Array.from(graph.y);
  assert.ok(
    Math.max(...ys) - Math.min(...ys) <
      Math.max(...graph.x) - Math.min(...graph.x),
  );
});

test("an unknown layout falls back to the tree, with a warning", () => {
  const { result, warnings } = capture(() =>
    runLayout(smallGraph(), { ...SETTINGS, layout: "nope" }),
  );
  assert.equal(result.options.mode, "layered");
  assert.match(warnings.join(), /unknown layout "nope"/);
});

test("registerLayout and registerForce check what they're given", () => {
  assert.throws(() => registerLayout("", { seed() {} }), TypeError);
  assert.throws(() => registerLayout("x", {}), /seed/);
  assert.throws(() => registerForce("x", 3), /factory/);
});

test("extra forces: built-in position pulls the graph over; registered ones run every tick", () => {
  const plain = smallGraph();
  runLayout(plain, { ...SETTINGS, direction: "radial" });
  const pulled = smallGraph();
  runLayout(pulled, {
    ...SETTINGS,
    direction: "radial",
    forces: [{ type: "position", x: 2000, strength: 0.5 }],
  });
  const meanX = (g) => g.x.reduce((a, b) => a + b, 0) / g.count;
  assert.ok(meanX(pulled) > meanX(plain) + 50);

  let applied = 0,
    initialized = 0;
  registerForce("test-counter", () => ({
    initialize: () => initialized++,
    apply: () => applied++,
  }));
  const simulation = runLayout(smallGraph(), {
    ...SETTINGS,
    forces: [{ type: "test-counter" }],
  });
  assert.equal(initialized, 1);
  assert.ok(applied > 10);
  assert.equal(simulation.forces[0].type, "test-counter");

  const { result, warnings } = capture(() => createForce({ type: "missing" }));
  assert.equal(result, null);
  assert.match(warnings.join(), /unknown force/);
});

test("addForce() adds a force to a running simulation, and takes it out again", () => {
  const simulation = runLayout(smallGraph(), SETTINGS);
  let calls = 0;
  const remove = simulation.addForce({ apply: () => calls++ });
  simulation.tick();
  remove();
  simulation.tick();
  assert.equal(calls, 1);
  assert.throws(() => simulation.addForce({}), /apply/);
});

test("LivePhysics events: grab, start, release, settle, in order", () => {
  for (const physicsMode of ["elastic", "floating", "none"]) {
    const settings = { ...SETTINGS, physicsMode };
    const graph = smallGraph();
    const physics = new LivePhysics(settings);
    physics.simulation = runLayout(graph, settings);
    const events = [];
    for (const type of ["grab", "start", "release", "settle"])
      physics.on(type, (detail) =>
        events.push(detail ? `${type}:${detail.mode ?? detail.reason}` : type),
      );
    const positionOf = (id) => graph.positionOf(id);
    physics.grab("a", { ids: graph.ids, links: [], positionOf });
    physics.drag("a", { x: 500, y: 500 });
    physics.release("a");
    for (let n = 0; physics.active && n < 5000; n++) physics.step();
    assert.equal(physics.active, false, physicsMode);
    assert.equal(events[0], `grab:${physicsMode}`, physicsMode);
    assert.ok(events.includes("start:drag"), physicsMode);
    assert.ok(events.includes(`release:${physicsMode}`), physicsMode);
    assert.equal(events.at(-1), "settle", physicsMode);
  }
});

test("physics mode none: only the dragged node moves", () => {
  const settings = { ...SETTINGS, physicsMode: "none" };
  const graph = smallGraph();
  const physics = new LivePhysics(settings);
  physics.simulation = runLayout(graph, settings);
  physics.grab("a", {
    ids: graph.ids,
    links: [],
    positionOf: (id) => graph.positionOf(id),
  });
  physics.drag("a", { x: 7, y: 9 });
  assert.deepEqual(physics.step().moved, [["a", 7, 9]]);
  assert.equal(physics.active, false);
});

test("emitter: on() returns an unsubscribe; once() fires once; a throwing listener doesn't stop the rest", () => {
  const emitter = new tether.Emitter();
  const seen = [];
  const off = emitter.on("x", (v) => seen.push(`a${v}`));
  emitter.once("x", (v) => seen.push(`b${v}`));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  emitter.on("x", () => {
    throw new Error("boom");
  });
  try {
    emitter.emit("x", 1);
    off();
    emitter.emit("x", 2);
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["a1", "b1"]);
  assert.equal(errors.length, 2);
});

test("colours: functional ones need the right number of parts, each in range", () => {
  for (const good of [
    "#abc",
    "#aabbccdd",
    "transparent",
    "rgb(1, 2, 3)",
    "rgba(1,2,3,0.5)",
    "rgb(1 2 3 / 50%)",
    "rgb(100%, 0%, 50%)",
    "hsl(10, 50%, 40%)",
    "hsl(210deg 40% 30% / 0.2)",
    "hsla(-30, 100%, 0%, 1)",
  ])
    assert.ok(isColor(good), good);
  for (const bad of [
    "rgb(1,2)",
    "hsl(10,50%)",
    "rgb(1,2,3,4,5)",
    "rgb(256, 0, 0)",
    "rgb(-1, 0, 0)",
    "rgba(1, 2, 3, 1.5)",
    "rgb(1 2 3 / 0.5 / 1)",
    "hsl(10, 150%, 40%)",
    "rgb(a, b, c)",
    "blue-ish",
    "",
  ])
    assert.equal(isColor(bad), false, bad);
});

test("duplicate node ids: the first is kept, with one warning", () => {
  const { result: graph, warnings } = capture(
    () =>
      new LayoutGraph(
        [
          { id: "a", w: 10, h: 10 },
          { id: "b", w: 10, h: 10 },
          { id: "a", w: 99, h: 99 },
        ],
        [{ source: "a", target: "b" }],
      ),
  );
  assert.deepEqual(graph.ids, ["a", "b"]);
  assert.equal(graph.w[graph.indexById.get("a")], 10);
  assert.equal(graph.positions().size, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate id \("a"\)/);
  const list = [{ id: "x" }];
  assert.equal(uniqueById(list), list); // unique: the same array back
});

test("a custom layout that throws falls back to the tree (strict: rethrows); a bad mode becomes none", () => {
  registerLayout("test-throws", {
    seed() {
      throw new Error("seed boom");
    },
  });
  const { result, warnings } = capture(() =>
    runLayout(smallGraph(), { ...SETTINGS, layout: "test-throws" }),
  );
  assert.equal(result.options.mode, "layered");
  assert.match(warnings.join(), /"test-throws" threw \(seed boom\)/);
  assert.throws(
    () =>
      runLayout(
        smallGraph(),
        { ...SETTINGS, layout: "test-throws" },
        { strict: true },
      ),
    /seed boom/,
  );
  registerLayout("test-bad-mode", { seed: () => ({ mode: "wobbly" }) });
  const bad = capture(() =>
    runLayout(smallGraph(), { ...SETTINGS, layout: "test-bad-mode" }),
  );
  assert.equal(bad.result.options.mode, "none");
  assert.match(bad.warnings.join(), /mode "wobbly"/);
});

test("physics mode none: one start and one settle per drag, however many frames", () => {
  const settings = { ...SETTINGS, physicsMode: "none" };
  const graph = smallGraph();
  const physics = new LivePhysics(settings);
  physics.simulation = runLayout(graph, settings);
  const events = [];
  for (const type of ["grab", "start", "release", "settle"])
    physics.on(type, () => events.push(type));
  physics.grab("a", {
    ids: graph.ids,
    links: [],
    positionOf: (id) => graph.positionOf(id),
  });
  for (let k = 0; k < 20; k++) {
    physics.drag("a", { x: k, y: k });
    physics.step();
  }
  physics.drag("a", { x: 50, y: 50 });
  physics.release("a");
  assert.deepEqual(physics.step().moved, [["a", 50, 50]]);
  assert.deepEqual(events, ["grab", "start", "release", "settle"]);
  // Let go without a final move: settles at once. stop() mid-drag settles too.
  events.length = 0;
  physics.grab("a", {
    ids: graph.ids,
    links: [],
    positionOf: (id) => graph.positionOf(id),
  });
  physics.release("a");
  physics.grab("a", {
    ids: graph.ids,
    links: [],
    positionOf: (id) => graph.positionOf(id),
  });
  physics.stop();
  assert.deepEqual(events, [
    "grab",
    "start",
    "release",
    "settle",
    "grab",
    "start",
    "settle",
  ]);
});

test("duplicate edges: an edge given twice (same id, or same ends without one) is kept once", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id, w: 10, h: 10 }));
  const { result: graph, warnings } = capture(
    () =>
      new LayoutGraph(nodes, [
        { source: "a", target: "b" },
        { source: "a", target: "b" },
        { id: "e1", source: "a", target: "c" },
        { id: "e1", source: "b", target: "c" },
        { id: "e2", source: "a", target: "b" },
      ]),
  );
  assert.deepEqual(
    graph.sources.map(
      (s, k) => `${graph.ids[s]}${graph.ids[graph.targets[k]]}`,
    ),
    ["ab", "ac", "ab"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /LayoutGraph edges: 2 duplicate ids/);
});

test("flowOf: how a layout flows, for renderers", () => {
  assert.deepEqual(flowOf({ direction: "LR" }), {
    directional: true,
    axis: "x",
    rootSide: { x: 1, y: 0 },
    growth: "RL",
  });
  assert.deepEqual(flowOf({ direction: "BT" }).rootSide, { x: 0, y: -1 });
  assert.equal(flowOf({ direction: "radial" }).directional, false);
  assert.deepEqual(flowOf({ layout: "radial", direction: "LR" }).rootSide, {
    x: 0,
    y: 0,
  });
});
