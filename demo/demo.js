// Prismatrix's API, all of it adjustable: every option, theme colour and Prismatrix tuning constant gets a control built from
// its schema, plugins of each kind are registered below, and the events scroll by in the log.
import {
  DEFAULT_OPTIONS,
  DEFAULT_THEME,
  DEFAULT_TUNING,
  GraphView,
  OPTIONS,
  THEME_OPTIONS,
  TUNING_OPTIONS,
  registerArrowShape,
  registerEasing,
  registerEdgeRouting,
  registerForce,
  registerLayout,
  registerNodeShape,
} from "../src/index.js";

const $ = (id) => document.getElementById(id);
const PALETTE = ["#62a4da", "#8fd07a", "#d6a74a", "#c678dd", "#e0645c"];
const SOURCES = [
  ["Crafted", "#62a4da"],
  ["Bought", "#8fd07a"],
  ["Forge", "#c678dd"],
];

// ---------------------------------------------------------------- plugins, one of each kind

// A five-pointed star, as a polygon (no GLSL needed)…
registerNodeShape("star", {
  polygon: Array.from({ length: 10 }, (_, k) => {
    const r = k % 2 ? 0.48 : 1,
      a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    return [r * Math.cos(a), r * Math.sin(a) + 0.08];
  }),
  rounding: 0.15,
});
// …and a pill, as a signed distance function in GLSL.
registerNodeShape("pill", {
  glsl: "float r = min(h.x, h.y) * 0.7; vec2 d = abs(p) - vec2(h.x, r) + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;",
});
registerArrowShape("diamond", {
  triangles: [
    [0, 0],
    [0.55, -0.4],
    [1.1, 0],
    [0, 0],
    [1.1, 0],
    [0.55, 0.4],
  ],
  inset: 1.1,
});
// Edges that leave sideways and come in from above.
registerEdgeRouting("elbow", (s, t) => {
  const dir = Math.sign(t.x - s.x) || 1;
  const start = { x: s.x + dir * s.hw, y: s.y };
  const end = { x: t.x, y: t.y - Math.sign(t.y - s.y || 1) * t.hh };
  return [start, { x: end.x, y: start.y }, end];
});
registerEasing("lazy", { speed: 3.5, damping: 1.3 });
// A layout of our own: a grid, polished by the forces (no levels or rings to keep).
registerLayout("grid", {
  label: "Grid",
  seed(graph, settings, { siblingGap }) {
    const columns = Math.ceil(Math.sqrt(graph.count));
    for (let i = 0; i < graph.count; i++) {
      graph.x[i] = (i % columns) * (60 + siblingGap);
      graph.y[i] = Math.floor(i / columns) * settings.linkDistance;
    }
    return { mode: "none" };
  },
});
// A force of our own: a sideways wind (try it with the Floating physics).
registerForce("wind", ({ strength = 0.3 }) => ({
  apply(sim, alpha) {
    for (let i = 0; i < sim.count; i++) sim.vx[i] += strength * alpha;
  },
}));

// The plugin names join the choices their options offer.
const extraChoices = {
  layout: ["grid"],
  nodeShape: ["star", "pill"],
  arrowShape: ["diamond"],
  edgeRouting: ["elbow"],
  animationEasing: ["lazy"],
};

// ---------------------------------------------------------------- the graph

/** A random tree of `count` nodes (the same one for the same seed); `shared` adds second parents. */
function makeGraph(count, shared, seed) {
  let state = seed;
  const random = () =>
    ((state = (state * 16807) % 2147483647) - 1) / 2147483646;
  const nodes = [
    {
      id: "n0",
      label: "Root",
      color: PALETTE[0],
      subtitle: "The result",
      tag: "Root",
    },
  ];
  const edges = [];
  const depth = [0];
  for (let i = 1; i < count; i++) {
    const parent = Math.floor(random() ** 1.6 * i);
    depth[i] = depth[parent] + 1;
    nodes.push({
      id: `n${i}`,
      label: `Node ${i}`,
      color: PALETTE[depth[i] % PALETTE.length],
      classes: random() < 0.1 ? ["marked"] : [],
      weight: random(),
      // Card text (nodeLook: "card"): runs with a square mark, coloured dots, and now and then a tag.
      subtitle: [
        `×${1 + Math.floor(random() * 20)} `,
        { mark: SOURCES[i % SOURCES.length][1] },
        ` ${SOURCES[i % SOURCES.length][0]}`,
      ],
      value: [
        `${Math.floor(random() * 90)}`,
        { dot: "#e2b54f" },
        ` ${Math.floor(random() * 99)}`,
        { dot: "#b9bec7" },
      ],
      tag: random() < 0.12 ? "✓ 2 owned" : "",
    });
    edges.push({
      source: `n${parent}`,
      target: `n${i}`,
      label: `${1 + Math.floor(random() * 5)}`,
    });
    if (shared && i > 3 && random() < 0.15) {
      const other = 1 + Math.floor(random() * (i - 1));
      if (other !== parent && depth[other] < depth[i])
        edges.push({ source: `n${other}`, target: `n${i}` });
    }
  }
  return { nodes, edges };
}

const view = new GraphView({
  container: $("graph"),
  classStyles: { nodes: { marked: { ring: "#ffd166", aura: "#ffd166" } } },
});

// Events: the view handles what it's told, and everything lands in the log.
view.on("nodeTap", ({ id }) => view.select(id));
view.on("backgroundTap", () => view.select(null));
view.on("nodeHoverStart", ({ id }) => view.showLineage(id));
view.on("nodeHoverEnd", () => view.clearLineage());
const log = $("log");
for (const type of [
  "nodeTap",
  "nodeDoubleTap",
  "nodeContextTap",
  "backgroundTap",
  "nodeHoverStart",
  "dragStart",
  "dragEnd",
  "physicsStart",
  "physicsSettle",
  "render",
  "select",
  "optionsChange",
  "themeChange",
])
  view.on(type, (detail) => {
    const rest = { ...detail };
    delete rest.originalEvent;
    const text = Object.keys(rest).length
      ? ` ${JSON.stringify(rest, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}`
      : "";
    log.textContent = `${type}${text}\n${log.textContent}`.slice(0, 4000);
  });

let seed = 7;
function draw({ grow = false } = {}) {
  const shared = $("shared").checked;
  const size = Number($("size").value);
  view.setOptions({ layered: shared, edgeLabels: size <= 60 });
  view.render({ ...makeGraph(size, shared, seed), fit: true, grow });
  $("status").textContent = `${view.nodeIds().length} nodes`;
}

$("shared").onchange = () => draw();
$("size").onchange = () => draw({ grow: true });
$("regenerate").onclick = () => {
  seed = (seed * 48271) % 2147483647;
  draw({ grow: true });
};
$("fit").onclick = () => view.fit();
$("shake").onclick = () => view.settle({ heat: 0.8, scatter: 60 });

// ---------------------------------------------------------------- controls, from the schemas

const panel = $("panel");
/** Options that re-run the layout when they change (Prismatrix's settings and the sizes it leaves room for). */
const RELAYOUT = new Set([
  "layout",
  "direction",
  "layered",
  "physicsMode",
  "centerForce",
  "repelForce",
  "linkForce",
  "linkDistance",
  "forces",
  "nodeSize",
  "nodeSizeScale",
  "rootSizeScale",
  "fontSize",
  "labelFontScale",
  "labelWidth",
  "labelWrapScale",
  "labelPosition",
  "showLabels",
]);

let tuning = {};
const controls = [];

/** One control per field, grouped: returns a function that sets them all from values. */
function buildControls(fields, prefix, apply) {
  const groups = new Map();
  for (const field of fields) {
    if (field.type === "function" || field.type === "array") continue;
    let group = groups.get(field.group);
    if (!group) {
      const details = document.createElement("details");
      details.innerHTML = `<summary>${prefix}${field.group}</summary>`;
      panel.append(details);
      groups.set(field.group, (group = details));
    }
    const row = document.createElement("label");
    row.className = "control";
    row.title = field.hint ?? "";
    const name = document.createElement("span");
    name.textContent = field.label ?? field.key;
    row.append(name);
    let input,
      read,
      write,
      output = null;
    if (field.type === "boolean") {
      input = Object.assign(document.createElement("input"), {
        type: "checkbox",
      });
      read = () => input.checked;
      write = (v) => (input.checked = v);
    } else if (field.type === "enum") {
      input = document.createElement("select");
      for (const value of [...field.values, ...(extraChoices[field.key] ?? [])])
        input.add(new Option(value, value));
      read = () => input.value;
      write = (v) => (input.value = v);
    } else if (field.type === "color") {
      // Colour inputs take #rrggbb; rgba() colours are edited as text.
      const hex = /^#[0-9a-f]{6}$/i.test(field.default);
      input = Object.assign(document.createElement("input"), {
        type: hex ? "color" : "text",
      });
      read = () => input.value;
      write = (v) => (input.value = v);
    } else if (field.type === "string") {
      input = Object.assign(document.createElement("input"), { type: "text" });
      read = () => input.value;
      write = (v) => (input.value = v);
    } else {
      input = Object.assign(document.createElement("input"), {
        type: "range",
        min: field.min,
        max: field.max,
        step: field.step ?? (field.type === "integer" ? 1 : "any"),
      });
      output = document.createElement("output");
      read = () => Number(input.value);
      write = (v) => {
        input.value = v;
        output.value = String(Math.round(v * 1000) / 1000);
      };
    }
    row.append(input);
    if (output) row.append(output);
    group.append(row);
    const sync = (value) => {
      write(value);
      row.classList.toggle("changed", value !== field.default);
    };
    input.addEventListener("input", () => {
      const value = read();
      sync(value);
      apply(field.key, value);
    });
    controls.push({ field, sync, prefix });
  }
}

buildControls(OPTIONS, "", (key, value) => {
  view.setOptions({ [key]: value });
  if (RELAYOUT.has(key)) draw();
});
buildControls(THEME_OPTIONS, "", (key, value) =>
  view.setTheme({ [key]: value }),
);
buildControls(TUNING_OPTIONS, "Tuning: ", (key, value) => {
  tuning = { ...tuning, [key]: value };
  view.setPhysicsTuning(tuning);
  draw();
});

function syncControls() {
  const options = view.options,
    theme = view.theme,
    current = view.physicsTuning;
  for (const { field, sync, prefix } of controls)
    sync(
      prefix
        ? current[field.key]
        : field.key in options && field.group !== "Theme"
          ? options[field.key]
          : theme[field.key],
    );
}

$("reset").onclick = () => {
  tuning = {};
  view.setPhysicsTuning({});
  view.resetOptions();
  view.setTheme(DEFAULT_THEME);
  syncControls();
  draw();
};

syncControls();
draw({ grow: true });
// For poking at from the console.
Object.assign(globalThis, { view, DEFAULT_OPTIONS, DEFAULT_TUNING });
