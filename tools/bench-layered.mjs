// Quality benchmark for the merged-tree (layered) layout. Lays out a fixed set of crafting-like DAGs and reports
// what makes a layered drawing clean or not, so a change to the algorithm is judged by numbers, not by eye.
//
// The graphs are the fixtures in tests/fixtures/graphs (prismatrix-graph JSON; regenerate them with
// `node tools/make-fixtures.mjs`).
//
// Usage:  node tools/bench-layered.mjs [--json]
//
// Metrics (lower is better unless noted):
//   crossings   edge crossings between neighbouring layers (as the layout counts them)
//   span        total layers crossed by edges beyond the first (dummy nodes): long edges cost this much
//   drift       long edges' sideways travel beyond the straight line between their ends, per long edge (px)
//   ink         total length of every edge as drawn (straight segments through its bends), px
//   centring    mean distance of a parent from the middle of its children (px)
//   width       drawing width (px); height (px)
//   ms          layout time
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Graph } from "../next/engine/graph.js";
import { GraphModel } from "../next/engine/model.js";
import { layeredLayout } from "../next/engine/layered.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/graphs",
);

/** Every fixture graph (prismatrix-graph JSON, made by tools/make-fixtures.mjs), as [name, model]. */
export function fixtures() {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [
      f.replace(/\.json$/, ""),
      GraphModel.from(JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"))),
    ]);
}

const sizing = { gap: 0, box: () => ({ x0: -20, y0: -8, x1: 20, y1: 8 }) };

/** Lay a case out and measure it. `layout` defaults to the engine's layeredLayout. */
export function measure(model, layout = layeredLayout, options = {}) {
  const g = new Graph(GraphModel.from(model));
  const start = performance.now();
  const routing = layout(g, options, sizing);
  const ms = performance.now() - start;
  let span = 0,
    ink = 0,
    drift = 0,
    longEdges = 0;
  for (const e of g.edges) {
    const s = g.nodes[e.source],
      t = g.nodes[e.target];
    const bends = routing.bends.get(e) ?? [];
    span += bends.length;
    const points = [[s.homeX, s.homeY], ...bends, [t.homeX, t.homeY]];
    for (let i = 1; i < points.length; i++)
      ink += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
      );
    if (!bends.length) continue;
    longEdges++;
    // Sideways travel along the edge beyond what going straight from end to end needs.
    let travel = 0;
    for (let i = 1; i < points.length; i++)
      travel += Math.abs(points[i][0] - points[i - 1][0]);
    drift += travel - Math.abs(t.homeX - s.homeX);
  }
  let centring = 0,
    parents = 0;
  for (const n of g.nodes) {
    const kids = g.outgoing[n.index].map((ei) => g.nodes[g.edges[ei].target]);
    if (!kids.length) continue;
    const xs = kids.map((k) => k.homeX);
    centring += Math.abs(n.homeX - (Math.min(...xs) + Math.max(...xs)) / 2);
    parents++;
  }
  const b = g.bounds(true);
  return {
    nodes: g.nodes.length,
    edges: g.edges.length,
    crossings: routing.crossings,
    span,
    ink: Math.round(ink),
    drift: Math.round(longEdges ? drift / longEdges : 0),
    centring: Math.round(parents ? centring / parents : 0),
    width: Math.round(b.maxX - b.minX),
    height: Math.round(b.maxY - b.minY),
    ms: Math.round(ms * 10) / 10,
  };
}

// Run directly (not imported by another script): print the table.
if (process.argv[1]?.endsWith("bench-layered.mjs")) {
  const rows = fixtures().map(([name, model]) => ({
    case: name,
    ...measure(model),
  }));
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);
}
