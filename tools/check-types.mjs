// The committed declarations must match the source: regenerate each project's into a temporary folder and compare.
//   types/       from src/         (tsconfig.json)
//   types/next/  from next/engine/ (tsconfig.next.json)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECTS = [
  { config: "tsconfig.json", out: "types", source: "src", skip: "next" },
  {
    config: "tsconfig.next.json",
    out: "types/next",
    source: "next/engine",
  },
];

const tsc = join("node_modules", "typescript", "bin", "tsc");
const prettier = join("node_modules", "prettier", "bin", "prettier.cjs");

/** The .d.ts files under `dir`, relative to it, leaving out the folder `skip` (another project's). */
const list = (dir, skip) => {
  try {
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter(
        (f) => f.endsWith(".d.ts") && !(skip && f.split(/[\\/]/)[0] === skip),
      )
      .sort();
  } catch {
    return [];
  }
};

let failed = false;
for (const { config, out: committedDir, source, skip } of PROJECTS) {
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
    const committed = list(committedDir, skip);
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
