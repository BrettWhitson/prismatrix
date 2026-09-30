// API.md's settings and tuning tables come from the schemas. `node tools/docs.mjs` rewrites them;
// `--check` fails when they're out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_OPTIONS, TUNING_OPTIONS } from "../src/index.js";

const cell = (text) => String(text).replace(/\|/g, "\\|");
const range = (o) =>
  o.values
    ? o.values.map((v) => `\`${v}\``).join(", ") +
      (o.open ? ", or registered" : "")
    : o.type === "boolean"
      ? "true / false"
      : o.type === "array"
        ? "array"
        : `${o.min} – ${o.max}`;
const value = (o) => `\`${JSON.stringify(o.default)}\``;

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

const sections = { settings: settingsTable(), tuning: tuningTables() };
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
