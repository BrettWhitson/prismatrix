// API.md (the reference) keeps its tables in step with the code. `node tools/docs.mjs`
// rewrites every generated table (between <!-- generated:NAME --> markers) from the option schemas and the JSDoc
// typedefs; `--check` fails when they're out of date. Either way it also checks that the code agrees with itself and
// with the hand-written parts:
//
//   - each options typedef (NodeOptions, TreeLayoutOptions…) lists exactly its schema's keys, and NodeStyle and
//     EdgeStyle exactly what a style may set (NODE_STYLE, EDGE_STYLE);
//   - ControllerEvents lists exactly the events the controller and its gestures send;
//   - every issue kind the model reports is listed (Issue) and explained in API.md;
//   - every public member of GraphModel, GraphController and Renderer is mentioned in API.md.
import { readFileSync, writeFileSync } from "node:fs";
import { LAYOUTS } from "../src/layouts.js";
import { PHYSICS, physicsSchema } from "../src/physics.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "../src/style.js";
import { ANIMATION_OPTIONS } from "../src/animation.js";
import { THEMES } from "../src/theme.js";
import { EDGE_STYLE, GraphModel, NODE_STYLE } from "../src/model.js";
import { GraphController } from "../src/controller.js";
import { Renderer } from "../src/renderer.js";

const engine = (file) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const problems = [];

// ---- JSDoc typedefs --------------------------------------------------------------------------------------------

/**
 * The properties of `@typedef {…} name` in `file`: { name, type, optional, text } each, in order. A property's text
 * runs on over the lines indented under it.
 */
function typedef(file, name) {
  const source = engine(file);
  const at = source.search(new RegExp(`@typedef \\{[^\\n]*\\} ${name}\\b`));
  if (at < 0) throw new Error(`no typedef ${name} in ${file}`);
  const lines = source
    .slice(at, source.indexOf("*/", at))
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""));
  // Each property with the lines indented under it, as one line.
  const entries = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("@typedef")) break;
    if (line.startsWith("@property ")) entries.push(line.slice(10));
    else if (entries.length && /^\s+\S/.test(line))
      entries[entries.length - 1] += ` ${line.trim()}`;
  }
  const props = [];
  for (let rest of entries) {
    let type = "";
    if (rest.startsWith("{")) {
      let depth = 0,
        i = 0;
      for (; i < rest.length; i++) {
        if (rest[i] === "{") depth++;
        else if (rest[i] === "}" && --depth === 0) break;
      }
      type = rest.slice(1, i).trim();
      rest = rest.slice(i + 1).trim();
    }
    const [, key, text = ""] = rest.match(/^(\[[^\]]+\]|\S+)\s*(.*)$/);
    const optional = key.startsWith("[");
    props.push({
      name: optional ? key.slice(1, -1) : key,
      type,
      optional,
      text: text.trim(),
    });
  }
  return props;
}

// ---- table helpers ---------------------------------------------------------------------------------------------

const cell = (text) => String(text).replace(/\|/g, "\\|");
const code = (text) => `\`${cell(text)}\``;
/** A type as written in JSDoc, shorter: imports dropped (import("./x.js").Name is Name). */
const typeText = (type) =>
  type.replace(/import\("\.\/[a-z-]+\.js"\)\./g, "").replace(/\s+/g, " ");
const sentence = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

function table(head, rows) {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/** A choice's label, when it says more than its value ("Barycenter (faster)" for barycenter: "faster"). */
function choiceNote({ value, label }) {
  let note = (label ?? "").toLowerCase();
  if (note === value.toLowerCase()) return "";
  if (note.startsWith(`${value.toLowerCase()} `))
    note = note.slice(value.length + 1).replace(/^\((.*)\)$/, "$1");
  return note;
}

const values = (o) =>
  o.type === "select"
    ? o.choices
        .map((c) => {
          const note = choiceNote(c);
          return note ? `${code(c.value)} (${cell(note)})` : code(c.value);
        })
        .join(", ")
    : o.type === "bool"
      ? "true / false"
      : o.type === "range"
        ? `${o.min} – ${o.max}`
        : o.type === "color"
          ? '"#rrggbb"'
          : o.type;
const fallback = (o, described) =>
  o.hint || sentence(described.get(o.key)) || o.label;

/** A schema as a table, each row explained by its hint, else by the typedef's words for it, else its label. */
function optionTable(schema, typedefFile, typedefName, defaults = {}) {
  const described = new Map(
    typedef(typedefFile, typedefName).map((p) => [p.name, p.text]),
  );
  return table(
    ["Option", "Default", "Values", "What it does"],
    schema.map((o) => [
      code(o.key),
      code(JSON.stringify(defaults[o.key] ?? o.default)),
      values(o),
      cell(fallback(o, described) || o.label),
    ]),
  );
}

/** A typedef as a table of its properties. */
function typedefTable(file, name, head = ["Field", "Type", "Meaning"]) {
  return table(
    head,
    typedef(file, name).map((p) => [
      code(p.name),
      code(typeText(p.type)),
      cell(sentence(p.text)),
    ]),
  );
}

// ---- checks ------------------------------------------------------------------------------------------------------

function sameKeys(what, documented, actual) {
  const a = [...documented].sort(),
    b = [...actual].sort();
  const missing = b.filter((k) => !a.includes(k)),
    extra = a.filter((k) => !b.includes(k));
  if (missing.length || extra.length)
    problems.push(
      `${what}: ${[
        missing.length && `not documented: ${missing.join(", ")}`,
        extra.length && `documented but not there: ${extra.join(", ")}`,
      ]
        .filter(Boolean)
        .join("; ")}`,
    );
}

const keys = (file, name) => typedef(file, name).map((p) => p.name);
const schemaKeys = (schema) => schema.map((o) => o.key);

sameKeys(
  "NodeOptions (style.js)",
  keys("style.js", "NodeOptions"),
  schemaKeys(NODE_OPTIONS),
);
sameKeys(
  "EdgeOptions (style.js)",
  keys("style.js", "EdgeOptions"),
  schemaKeys(EDGE_OPTIONS),
);
sameKeys(
  "AnimationOptions (animation.js)",
  keys("animation.js", "AnimationOptions"),
  schemaKeys(ANIMATION_OPTIONS),
);
for (const [layout, name] of [
  ["tree", "TreeLayoutOptions"],
  ["merged", "MergedLayoutOptions"],
  ["radial", "RadialLayoutOptions"],
])
  sameKeys(
    `${name} (layouts.js)`,
    keys("layouts.js", name),
    schemaKeys(LAYOUTS[layout].options),
  );
for (const [mode, name] of [
  ["static", "StaticPhysicsOptions"],
  ["elastic", "ElasticPhysicsOptions"],
  ["floating", "FloatingPhysicsOptions"],
]) {
  const all = new Set();
  for (const layout of Object.keys(LAYOUTS))
    if (LAYOUTS[layout].physics[mode])
      for (const o of physicsSchema(layout, mode)) all.add(o.key);
  sameKeys(`${name} (physics.js)`, keys("physics.js", name), all);
}
sameKeys(
  "NodeStyle (model.js)",
  keys("model.js", "NodeStyle"),
  Object.keys(NODE_STYLE),
);
sameKeys(
  "EdgeStyle (model.js)",
  keys("model.js", "EdgeStyle"),
  Object.keys(EDGE_STYLE),
);

// emit("type", …), emit(flag ? "one" : "other", …), and #setFolds(…, "type", …) (which sends its type).
const emitted = new Set();
for (const file of ["controller.js", "gestures.js"]) {
  const source = engine(file);
  for (const [, a, b] of source.matchAll(
    /emit\(\s*(?:[\w.]+\s*\?\s*"(\w+)"\s*:\s*)?"(\w+)"/g,
  ))
    for (const type of [a, b]) if (type) emitted.add(type);
  for (const [, type] of source.matchAll(/#setFolds\([^;]*?,\s*"(\w+)"/g))
    emitted.add(type);
}
sameKeys(
  "ControllerEvents (controller.js)",
  keys("controller.js", "ControllerEvents"),
  emitted,
);

const issueKinds = new Set(
  [...engine("model.js").matchAll(/problem\(\s*"([a-z-]+)"/g)].map((m) => m[1]),
);
const issueDoc = typedef("model.js", "Issue").find((p) => p.name === "kind");
sameKeys(
  "Issue kinds (model.js, Issue.kind)",
  [...issueDoc.text.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]),
  issueKinds,
);

// ---- the tables ------------------------------------------------------------------------------------------------

function physicsTables() {
  const out = [];
  for (const [mode, { label, options }] of Object.entries(PHYSICS)) {
    out.push(
      label.toLowerCase() === mode
        ? `**${mode}**`
        : `**${mode}** (${label.toLowerCase()})`,
      "",
      optionTable(
        options,
        "physics.js",
        `${mode[0].toUpperCase()}${mode.slice(1)}PhysicsOptions`,
      ),
      "",
    );
  }
  out.push(
    "**What each layout offers**",
    "",
    table(
      ["Layout", "Mode", "Its own defaults", "Its own options"],
      Object.entries(LAYOUTS).flatMap(([layout, spec]) =>
        Object.entries(spec.physics).map(([mode, m]) => [
          code(layout),
          code(mode),
          Object.entries(m.defaults ?? {})
            .map(([k, v]) => `${code(k)} ${v}`)
            .join(", ") || "none",
          (m.options ?? [])
            .map(
              (o) =>
                `${code(o.key)} (${values(o)}, default ${o.default}): ${cell(o.hint ?? o.label)}`,
            )
            .join("; ") || "none",
        ]),
      ),
    ),
  );
  return out.join("\n");
}

function layoutsTable() {
  return table(
    ["Layout", "Name", "Physics modes", "Edge defaults"],
    Object.entries(LAYOUTS).map(([name, spec]) => [
      code(name),
      cell(spec.label),
      Object.keys(spec.physics).map(code).join(", "),
      Object.entries(spec.edgeDefaults ?? {})
        .map(([k, v]) => `${code(k)}: ${code(JSON.stringify(v))}`)
        .join(", ") || "none",
    ]),
  );
}

function themesTable() {
  const described = typedef("theme.js", "Theme");
  return table(
    ["Token", "`dark`", "`light`", "What it colours"],
    described.map((p) => [
      code(p.name),
      ...["dark", "light"].map((t) => {
        const v = THEMES[t][p.name];
        return Array.isArray(v) ? v.map(code).join(" ") : code(v);
      }),
      cell(sentence(p.text)),
    ]),
  );
}

const sections = {
  "node-options": optionTable(NODE_OPTIONS, "style.js", "NodeOptions"),
  "edge-options": optionTable(EDGE_OPTIONS, "style.js", "EdgeOptions"),
  "animation-options": optionTable(
    ANIMATION_OPTIONS,
    "animation.js",
    "AnimationOptions",
  ),
  layouts: layoutsTable(),
  "layout-tree": optionTable(
    LAYOUTS.tree.options,
    "layouts.js",
    "TreeLayoutOptions",
  ),
  "layout-merged": optionTable(
    LAYOUTS.merged.options,
    "layouts.js",
    "MergedLayoutOptions",
  ),
  "layout-radial": optionTable(
    LAYOUTS.radial.options,
    "layouts.js",
    "RadialLayoutOptions",
  ),
  physics: physicsTables(),
  themes: themesTable(),
  "node-style": typedefTable("model.js", "NodeStyle", [
    "Key",
    "Value",
    "Meaning",
  ]),
  "edge-style": typedefTable("model.js", "EdgeStyle", [
    "Key",
    "Value",
    "Meaning",
  ]),
  "model-options": typedefTable("model.js", "ModelOptions", [
    "Option",
    "Type",
    "Meaning",
  ]),
  delta: typedefTable("model.js", "Delta"),
  change: typedefTable("model.js", "Change"),
  "controller-options": typedefTable("controller.js", "ControllerOptions", [
    "Option",
    "Type",
    "Meaning",
  ]),
  events: typedefTable("controller.js", "ControllerEvents", [
    "Event",
    "Detail",
    "When",
  ]),
  "point-detail": typedefTable("controller.js", "PointDetail"),
  "graph-detail": typedefTable("controller.js", "GraphDetail"),
  "tick-result": typedefTable("controller.js", "TickResult"),
  "pointer-input": typedefTable("gestures.js", "PointerInput"),
  "wheel-input": typedefTable("gestures.js", "WheelInput"),
  "disclosure-detail": typedefTable("controller.js", "DisclosureDetail"),
  snapshot: typedefTable("snapshot.js", "Snapshot"),
  "snapshot-settings": typedefTable("snapshot.js", "SnapshotSettings"),
  "renderer-options": typedefTable("renderer.js", "RendererOptions", [
    "Option",
    "Type",
    "Meaning",
  ]),
  "frame-stats": typedefTable("renderer.js", "FrameStats"),
};

const path = new URL("../API.md", import.meta.url);
const before = readFileSync(path, "utf8");
let after = before;
for (const [name, body] of Object.entries(sections)) {
  const marker = new RegExp(
    `(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`,
  );
  if (!marker.test(after))
    problems.push(`API.md has no generated:${name} section`);
  after = after.replace(marker, `$1\n\n${body}\n\n$2`);
}

// The hand-written parts: every issue kind explained, every public member mentioned.
for (const kind of issueKinds)
  if (!after.includes(`\`${kind}\``))
    problems.push(`API.md doesn't explain the issue kind "${kind}"`);
/** Members that are plumbing (between a controller and its renderer, or for tests), not an app's API. */
const INTERNAL = new Set(["constructor", "attach", "detach"]);
for (const [what, cls] of [
  ["GraphModel", GraphModel],
  ["GraphController", GraphController],
  ["Renderer", Renderer],
]) {
  const members = [
    ...Object.getOwnPropertyNames(cls.prototype),
    ...Object.getOwnPropertyNames(cls).filter(
      (k) => typeof cls[k] === "function",
    ),
  ].filter((k) => !INTERNAL.has(k) && !k.startsWith("#"));
  for (const k of members)
    if (!new RegExp(`\`[^\`\\n]*\\b${k}\\b`).test(after))
      problems.push(`API.md doesn't mention ${what}'s \`${k}\``);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(
      "API.md's tables are out of date. Run `npm run docs` and commit the result.",
    );
    process.exit(1);
  }
  console.log("API.md's tables are up to date, and agree with the code.");
} else if (after !== before) {
  writeFileSync(path, after);
  console.log("API.md updated.");
}
