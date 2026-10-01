// The sandbox: a sample graph, the engine's view, and a panel built straight from the engine's option schemas.

import {
  ANIMATION_OPTIONS,
  EDGE_OPTIONS,
  GraphView,
  LAYOUTS,
  NODE_OPTIONS,
  PHYSICS,
  physicsSchema,
  resolve,
} from "../engine/index.js";
import { bool, range, select } from "../engine/schema.js";
import { startTelemetry } from "./telemetry.js";

// Bumped when option meanings change, so old settings don't carry over.
const STORAGE_KEY = "prismatrix-sandbox-2";

// No real limit with WebGL: this only stops a typo (or a deep balanced tree) from freezing the tab.
const MAX_NODES = 1_000_000;
// Graphs bigger than this rebuild when a slider is let go, not on every step of the drag.
const LIVE_NODES = 3000;

const GRAPH_OPTIONS = [
  select(
    "kind",
    "Shape",
    [
      { value: "balanced", label: "Balanced tree" },
      { value: "random", label: "Random tree" },
    ],
    "random",
  ),
  range(
    "depth",
    "Depth",
    1,
    14,
    1,
    4,
    `Balanced tree only. Stops at ${MAX_NODES.toLocaleString()} nodes.`,
  ),
  range("branching", "Branching", 1, 10, 1, 3, "Balanced tree only."),
  {
    ...range(
      "count",
      "Nodes",
      2,
      100_000,
      1,
      80,
      `Random tree only. Type a number for more (up to ${MAX_NODES.toLocaleString()}).`,
    ),
    log: true,
    open: true,
  },
  range(
    "bushiness",
    "Bushiness",
    0.3,
    3,
    0.1,
    1.4,
    "Random tree: high piles children near the root, low makes long chains.",
  ),
  {
    ...range(
      "crossLinks",
      "Cross-links",
      0,
      20_000,
      1,
      0,
      "Extra edges that aren't part of the tree, like shared ingredients.",
    ),
    log: true,
    open: true,
  },
  range("seed", "Seed", 1, 999, 1, 7),
  bool(
    "labels",
    "Short labels",
    true,
    "Path labels (1.2.1) instead of numbers.",
  ),
];

// ---- settings, remembered between visits -------------------------------------------------------------------

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private windows and blocked storage just don't remember.
  }
}

const stored = load();
const settings = {
  graph: resolve(GRAPH_OPTIONS, stored.graph),
  renderer: stored.renderer === "canvas" ? "canvas" : "webgl",
  frameRate: stored.frameRate === "uncapped" ? "uncapped" : "display",
  layout: LAYOUTS[stored.layout] ? stored.layout : "radial",
  layouts: stored.layouts ?? {}, // per layout: { options, mode, physics: { [mode]: options } }
  node: resolve(NODE_OPTIONS, stored.node),
  edge: resolve(EDGE_OPTIONS, stored.edge),
  animation: resolve(ANIMATION_OPTIONS, stored.animation),
};

/**
 * One layout's remembered settings, checked against its schemas. The option objects are filled in place, never
 * replaced: the panel's controls write into them, so a fresh object would quietly cut those controls off.
 */
function layoutState(name = settings.layout) {
  const s = (settings.layouts[name] ??= {});
  s.options = fill(s.options, LAYOUTS[name].options);
  if (!LAYOUTS[name].physics[s.mode])
    s.mode = name === "radial" ? "elastic" : "static";
  s.physics ??= {};
  s.physics[s.mode] = fill(s.physics[s.mode], physicsSchema(name, s.mode));
  return s;
}

/** `target` (made if missing) holding exactly the checked values of `schema`. */
function fill(target = {}, schema) {
  const checked = resolve(schema, target);
  for (const k of Object.keys(target)) if (!(k in checked)) delete target[k];
  return Object.assign(target, checked);
}

// ---- sample graphs -----------------------------------------------------------------------------------------

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGraph(g) {
  const rand = random(g.seed);
  const nodes = [{ id: "0", label: g.labels ? "root" : "0" }];
  const edges = [];
  const path = ["root"];
  const kids = [0];
  const add = (parent) => {
    const id = nodes.length;
    kids[parent] += 1;
    kids.push(0);
    path.push(
      parent === 0 ? `${kids[parent]}` : `${path[parent]}.${kids[parent]}`,
    );
    nodes.push({ id: String(id), label: g.labels ? path[id] : String(id) });
    edges.push({ source: String(parent), target: String(id) });
    return id;
  };
  if (g.kind === "balanced") {
    let level = [0];
    for (let d = 0; d < g.depth; d++) {
      const next = [];
      for (const p of level)
        for (let b = 0; b < g.branching; b++)
          if (nodes.length < MAX_NODES) next.push(add(p));
      level = next;
    }
  } else {
    for (let i = 1; i < Math.min(g.count, MAX_NODES); i++)
      add(Math.floor(rand() ** g.bushiness * i));
  }
  for (let i = 0; i < g.crossLinks && nodes.length > 2; i++) {
    const a = Math.floor(rand() * nodes.length);
    const b = Math.floor(rand() * nodes.length);
    if (a !== b)
      edges.push({
        source: String(Math.min(a, b)),
        target: String(Math.max(a, b)),
      });
  }
  return { nodes, edges };
}

// ---- the view ----------------------------------------------------------------------------------------------

const stats = document.getElementById("stats");
const log = startTelemetry(() => view);
const view = new GraphView(
  document.getElementById("graph"),
  {
    onEvent: log.event,
    onFrame: (frame) => {
      log.frame(frame);
      const { fps, energy, state } = frame;
      stats.textContent =
        `${view.renderer.name === "webgl" ? "WebGL" : "Canvas 2D"} · ` +
        `${view.graph.nodes.length} nodes · ${view.graph.edges.length} edges · ` +
        `${Math.round(fps)} fps · ${state}` +
        (state === "moving" ? ` · energy ${energy.toFixed(1)}` : "");
    },
  },
  { renderer: settings.renderer, frameRate: settings.frameRate },
);

function applyAll() {
  const s = layoutState();
  view.setAnimation(settings.animation);
  view.setNodeStyle(settings.node);
  view.setEdgeStyle(settings.edge);
  view.setLayout(settings.layout, s.options);
  view.setPhysics(s.mode, s.physics[s.mode]);
  view.setGraph(makeGraph(settings.graph));
}

// ---- the panel ---------------------------------------------------------------------------------------------

const sections = document.getElementById("sections");
const openSections = new Set(
  stored.open ?? ["View", "Graph", "Layout", "Physics"],
);

function section(title, build) {
  const details = document.createElement("details");
  details.open = openSections.has(title);
  details.addEventListener("toggle", () => {
    if (details.open) openSections.add(title);
    else openSections.delete(title);
    settings.open = [...openSections];
    save();
  });
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.className = "body";
  details.append(summary, body);
  build(body);
  return details;
}

function subhead(body, text) {
  const h = document.createElement("div");
  h.className = "subhead";
  h.textContent = text;
  body.append(h);
}

/** One control for a schema entry; `onChange(value)` fires as it moves. */
function control(spec, value, onChange) {
  const row = document.createElement("div");
  row.className = spec.type === "bool" ? "row check" : "row";
  const id = `c${Math.random().toString(36).slice(2)}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = spec.label;
  let input;
  if (spec.type === "select") {
    input = document.createElement("select");
    for (const c of spec.choices)
      input.add(new Option(c.label, c.value, false, c.value === value));
    input.addEventListener("change", () => onChange(input.value));
    row.append(label, input);
  } else if (spec.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => onChange(input.checked));
    row.append(input, label);
  } else if (spec.type === "color") {
    input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    row.append(label, input);
  } else {
    // A log slider spreads small values out (2 to 100 gets as much travel as 1,000 to 100,000). An open range
    // takes typed values past the slider's end.
    const SPAN = 1000;
    const toSlider = (v) =>
      spec.log
        ? (Math.log1p(Math.min(Math.max(v, spec.min), spec.max) - spec.min) /
            Math.log1p(spec.max - spec.min)) *
          SPAN
        : v;
    const fromSlider = (t) => {
      if (!spec.log) return t;
      const v =
        spec.min + Math.expm1((t / SPAN) * Math.log1p(spec.max - spec.min));
      return Math.round(v / spec.step) * spec.step;
    };
    input = document.createElement("input");
    input.type = "range";
    Object.assign(input, {
      min: spec.log ? 0 : spec.min,
      max: spec.log ? SPAN : spec.max,
      step: spec.log ? 1 : spec.step,
      value: toSlider(value),
    });
    const out = document.createElement("input");
    out.type = "number";
    out.className = "value";
    Object.assign(out, { min: spec.min, step: spec.step });
    if (!spec.open) out.max = spec.max;
    const show = (v) => (out.value = String(Math.round(v * 100) / 100));
    show(value);
    let sent = value;
    const send = (v) => {
      if (v === sent) return;
      sent = v;
      onChange(v);
    };
    input.addEventListener("input", () => {
      const v = fromSlider(Number(input.value));
      show(v);
      if (!spec.heavy?.(v)) send(v);
    });
    input.addEventListener("change", () =>
      send(fromSlider(Number(input.value))),
    );
    out.addEventListener("change", () => {
      let v = Number(out.value);
      if (!Number.isFinite(v)) return show(sent);
      v = Math.max(v, spec.min);
      if (!spec.open) v = Math.min(v, spec.max);
      show(v);
      input.value = toSlider(v);
      send(v);
    });
    row.append(label, out, input);
  }
  input.id = id;
  if (spec.hint) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = spec.hint;
    row.append(hint);
  }
  return row;
}

function controls(body, schema, values, after) {
  for (const spec of schema) {
    body.append(
      control(spec, values[spec.key], (v) => {
        values[spec.key] = v;
        save();
        after(spec.key);
      }),
    );
  }
}

function render() {
  sections.replaceChildren(
    section("View", (body) => {
      body.append(
        control(
          select(
            "renderer",
            "Renderer",
            [
              { value: "webgl", label: "WebGL" },
              { value: "canvas", label: "Canvas 2D" },
            ],
            "webgl",
            "WebGL draws everything on the GPU. Canvas 2D is the fallback, and the reference the GPU is checked against.",
          ),
          view.renderer.name,
          (v) => {
            settings.renderer = view.setRenderer(v);
            save();
          },
        ),
        control(
          select(
            "frameRate",
            "Frame rate",
            [
              { value: "display", label: "Match display" },
              { value: "uncapped", label: "Uncapped (benchmark)" },
            ],
            "display",
            "Uncapped draws as fast as it can to show the engine's headroom. The screen still shows one frame per refresh, so it only costs power.",
          ),
          view.frameRate,
          (v) => {
            settings.frameRate = view.setFrameRate(v);
            save();
          },
        ),
      );
    }),
    section("Graph", (body) => {
      const relevant = GRAPH_OPTIONS.filter(
        (o) =>
          !(
            settings.graph.kind === "balanced" &&
            ["count", "bushiness"].includes(o.key)
          ) &&
          !(
            settings.graph.kind === "random" &&
            ["depth", "branching"].includes(o.key)
          ),
      );
      // A big graph (now, or after this change) rebuilds on release rather than on every slider step.
      const heavy = (spec) => ({
        ...spec,
        heavy: (v) =>
          Math.max(view.graph.nodes.length, spec.key === "count" ? v : 0) >
          LIVE_NODES,
      });
      controls(body, relevant.map(heavy), settings.graph, (key) => {
        view.setGraph(makeGraph(settings.graph));
        if (key === "kind") render();
      });
    }),
    section("Layout", (body) => {
      body.append(
        control(
          select(
            "layout",
            "Layout",
            Object.entries(LAYOUTS).map(([value, l]) => ({
              value,
              label: l.label,
            })),
            "radial",
          ),
          settings.layout,
          (v) => {
            settings.layout = v;
            save();
            const s = layoutState();
            view.setLayout(v, s.options);
            view.setPhysics(s.mode, s.physics[s.mode]);
            render();
          },
        ),
      );
      const s = layoutState();
      controls(body, LAYOUTS[settings.layout].options, s.options, () =>
        view.setLayout(settings.layout, s.options),
      );
    }),
    section("Physics", (body) => {
      const s = layoutState();
      const modes = Object.keys(LAYOUTS[settings.layout].physics);
      body.append(
        control(
          select(
            "mode",
            `${LAYOUTS[settings.layout].label} physics`,
            modes.map((m) => ({ value: m, label: PHYSICS[m].label })),
            modes[0],
          ),
          s.mode,
          (v) => {
            s.mode = v;
            save();
            const next = layoutState();
            view.setPhysics(v, next.physics[v]);
            render();
          },
        ),
      );
      subhead(
        body,
        `${PHYSICS[s.mode].label} in ${LAYOUTS[settings.layout].label.toLowerCase()}`,
      );
      const opts = s.physics[s.mode];
      controls(body, physicsSchema(settings.layout, s.mode), opts, () =>
        view.setPhysics(s.mode, opts),
      );
    }),
    section("Nodes", (body) =>
      controls(body, NODE_OPTIONS, settings.node, () =>
        view.setNodeStyle(settings.node),
      ),
    ),
    section("Edges", (body) =>
      controls(body, EDGE_OPTIONS, settings.edge, () =>
        view.setEdgeStyle(settings.edge),
      ),
    ),
    section("Animation", (body) =>
      controls(body, ANIMATION_OPTIONS, settings.animation, () =>
        view.setAnimation(settings.animation),
      ),
    ),
  );
}

document.getElementById("reset").addEventListener("click", () => view.reset());
document.getElementById("snapshot").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const saved = await log.snapshot("button");
  button.textContent = saved ? "Saved ✓" : "No server";
  button.title = saved ?? "Snapshots need the dev server (npm run sandbox)";
  setTimeout(() => (button.textContent = "Snapshot"), 1500);
});
document
  .getElementById("load")
  .addEventListener("click", () =>
    document.getElementById("load-file").click(),
  );
document.getElementById("load-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    view.restore(JSON.parse(await file.text()));
  } catch (error) {
    log.event("error", { message: `load: ${error.message}` });
    alert(`Couldn't load that snapshot: ${error.message}`);
  }
});
document.getElementById("fit").addEventListener("click", () => view.fit());
document.getElementById("defaults").addEventListener("click", () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
  location.reload();
});

// Handy from the console.
window.view = view;

render();
applyAll();
