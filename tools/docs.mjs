// API.md's option, theme, settings and tuning tables come from the schemas. `node tools/docs.mjs` rewrites them;
// `--check` fails when they're out of date.
import { readFileSync, writeFileSync } from "node:fs";
import {
  OPTIONS,
  SETTINGS_OPTIONS,
  THEME_OPTIONS,
  TUNING_OPTIONS,
} from "../src/index.js";

const cell = (text) => String(text).replace(/\|/g, "\\|");
const range = (o) =>
  o.values
    ? o.values.map((v) => `\`${v}\``).join(", ") +
      (o.open ? ", or registered" : "")
    : o.type === "boolean"
      ? "true / false"
      : o.type === "number" || o.type === "integer"
        ? `${o.min} – ${o.max}`
        : o.type;
const value = (o) =>
  typeof o.default === "function" ? "" : `\`${JSON.stringify(o.default)}\``;

/** Prismatrix's own options (Prismatrix's settings are documented in Prismatrix's API.md), grouped. */
function optionTables() {
  const tether = new Set(SETTINGS_OPTIONS.map((o) => o.key));
  const out = [];
  let group;
  for (const o of OPTIONS) {
    if (tether.has(o.key)) continue;
    if (o.group !== group) {
      group = o.group;
      out.push(
        "",
        `**${group}**`,
        "",
        "| Option | Default | Values | What it does |",
        "| --- | --- | --- | --- |",
      );
    }
    out.push(`| \`${o.key}\` | ${value(o)} | ${range(o)} | ${cell(o.hint)} |`);
  }
  return out.join("\n").trim();
}

function themeTable() {
  return [
    "| Colour | Default | What it colours |",
    "| --- | --- | --- |",
    ...THEME_OPTIONS.map(
      (o) => `| \`${o.key}\` | \`${o.default}\` | ${cell(o.hint)} |`,
    ),
  ].join("\n");
}

function settingsTable() {
  const rows = SETTINGS_OPTIONS.map(
    (o) => `| \`${o.key}\` | ${value(o)} | ${range(o)} | ${cell(o.hint)} |`,
  );
  return [
    "| Setting | Default | Values | What it does |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function tuningTables() {
  const out = [];
  let group;
  for (const o of TUNING_OPTIONS) {
    if (o.group !== group) {
      group = o.group;
      out.push(
        "",
        `**${group}**`,
        "",
        "| Constant | Default | Range | What it does |",
        "| --- | --- | --- | --- |",
      );
    }
    out.push(`| \`${o.key}\` | ${value(o)} | ${range(o)} | ${cell(o.hint)} |`);
  }
  return out.join("\n").trim();
}

const sections = {
  options: optionTables(),
  theme: themeTable(),
  settings: settingsTable(),
  tuning: tuningTables(),
};
const path = new URL("../API.md", import.meta.url);
const before = readFileSync(path, "utf8");
let after = before;
for (const [name, body] of Object.entries(sections))
  after = after.replace(
    new RegExp(
      `(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`,
    ),
    `$1\n\n${body}\n\n$2`,
  );
if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error("API.md's tables are out of date. Run `npm run docs`.");
    process.exit(1);
  }
  console.log("API.md's tables are up to date.");
} else if (after !== before) {
  writeFileSync(path, after);
  console.log("API.md updated.");
}
