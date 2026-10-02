// The committed declarations in types/ must match the source in src/: regenerate them into a temporary folder and
// compare.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECTS = [{ config: "tsconfig.json", out: "types", source: "src" }];

const tsc = join("node_modules", "typescript", "bin", "tsc");
const prettier = join("node_modules", "prettier", "bin", "prettier.cjs");

/** The .d.ts files under `dir`, relative to it. */
const list = (dir) => {
  try {
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".d.ts"))
      .sort();
  } catch {
    return [];
  }
};

let failed = false;
for (const { config, out: committedDir, source } of PROJECTS) {
  const out = mkdtempSync(join(tmpdir(), "prism-types-"));
  try {
    execFileSync(process.execPath, [tsc, "-p", config, "--outDir", out], {
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      [prettier, "--write", out, "--log-level", "warn"],
      { stdio: "inherit" },
    );
    const fresh = list(out);
    const committed = list(committedDir);
    const stale = [
      ...fresh.filter(
        (f) =>
          !committed.includes(f) ||
          readFileSync(join(out, f), "utf8") !==
            readFileSync(join(committedDir, f), "utf8"),
      ),
      ...committed.filter((f) => !fresh.includes(f)),
    ];
    if (stale.length) {
      console.error(
        `${committedDir}/ is out of date (${stale.join(", ")}). Run \`npm run types\` and commit the result.`,
      );
      failed = true;
    } else
      console.log(
        `${committedDir}/ is up to date (${fresh.length} files, from ${source}/).`,
      );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
if (failed) process.exit(1);
