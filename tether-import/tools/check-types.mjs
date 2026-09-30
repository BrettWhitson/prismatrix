// The committed declarations (types/) must match the source: regenerate into a temporary folder and compare.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const out = mkdtempSync(join(tmpdir(), "tether-types-"));
try {
  const tsc = join("node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", ".", "--outDir", out], {
    stdio: "inherit",
  });
  const prettier = join("node_modules", "prettier", "bin", "prettier.cjs");
  execFileSync(
    process.execPath,
    [prettier, "--write", out, "--log-level", "warn"],
    { stdio: "inherit" },
  );
  const list = (dir) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".d.ts"))
      .sort();
  const fresh = list(out);
  const committed = (() => {
    try {
      return list("types");
    } catch {
      return [];
    }
  })();
  const stale = [
    ...fresh.filter(
      (f) =>
        !committed.includes(f) ||
        readFileSync(join(out, f), "utf8") !==
          readFileSync(join("types", f), "utf8"),
    ),
    ...committed.filter((f) => !fresh.includes(f)),
  ];
  if (stale.length) {
    console.error(
      `types/ is out of date (${stale.join(", ")}). Run \`npm run types\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `types/ is up to date (${fresh.length} files, from ${relative(".", "src")}/).`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
