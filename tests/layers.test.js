// The package's two layers stay apart: the layout and physics layer (src/layout/) knows positions and motion, and
// nothing about drawing; the renderer (src/render/) draws, and imports nothing from the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

async function sources(folder) {
  const dir = new URL(`../src/${folder}/`, import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".js"));
  return Promise.all(
    files.map(async (file) => [
      file,
      await readFile(new URL(file, dir), "utf8"),
    ]),
  );
}

test("the layout layer imports nothing outside itself, and uses no DOM or WebGL", async () => {
  for (const [file, source] of await sources("layout")) {
    for (const [, path] of source.matchAll(/\bfrom\s+"([^"]+)"/g))
      assert.ok(
        path.startsWith("./") && !path.includes("/", 2),
        `layout/${file} imports ${path}`,
      );
    // Code, not comments: strip block and line comments first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const name of [
      "document",
      "window",
      "WebGL",
      "canvas",
      "requestAnimationFrame",
      "HTMLElement",
    ])
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(code),
        `layout/${file} uses ${name}`,
      );
  }
});

test("prismatrix/layout loads without a DOM, and gives the same objects as prismatrix", async () => {
  const layout = await import("../src/layout/index.js");
  const all = await import("../src/index.js");
  for (const name of [
    "LayoutGraph",
    "runLayout",
    "LivePhysics",
    "TUNING_OPTIONS",
    "PHYSICS_TUNING",
    "flowOf",
  ]) {
    assert.ok(layout[name], `layout exports ${name}`);
    assert.equal(
      all[name],
      layout[name],
      `prismatrix re-exports the same ${name}`,
    );
  }
});
