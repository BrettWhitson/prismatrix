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
//   moved       stability: after a one-node change (a new ingredient under one item), the share of the other nodes
//               whose home moves more than 2 px (%), averaged over three such changes
//   shift       stability: how far they move on average (px)
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
  // A referenced edge is drawn to its reference, not all the way to the ingredient.
  const referenced = new Map(
    (routing.references ?? []).map((r) => [r.edge, { homeX: r.x, homeY: r.y }]),
  );
  for (const e of g.edges) {
    const s = g.nodes[e.source],
      t = referenced.get(e) ?? g.nodes[e.target];
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
    refs: routing.references?.length ?? 0,
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

/**
 * How much a layout keeps its place under a small change (the mental map): add one new ingredient under an item a
 * quarter, half and three quarters of the way through the node list, lay out again, and compare every other
 * node's home with where it was. Returns the share of them that moved more than 2 px (%) and the mean distance (px).
 */
export function stability(model, layout = layeredLayout, options = {}) {
  const json = GraphModel.from(model).toJSON();
  const homes = (data) => {
    const g = new Graph(GraphModel.from(data));
    layout(g, options, sizing);
    return new Map(g.nodes.map((n) => [n.id, [n.homeX, n.homeY]]));
  };
  const before = homes(json);
  let moved = 0,
    shift = 0,
    kept = 0;
  for (const at of [0.25, 0.5, 0.75]) {
    const parent = json.nodes[Math.floor(json.nodes.length * at)].id;
    const after = homes({
      nodes: [...json.nodes, { id: "bench-new" }],
      edges: [...json.edges, { source: parent, target: "bench-new" }],
    });
    for (const [id, [x, y]] of before) {
      const [x2, y2] = after.get(id);
      const d = Math.hypot(x2 - x, y2 - y);
      if (d > 2) moved++;
      shift += d;
      kept++;
    }
  }
  return {
    moved: Math.round((moved / kept) * 100),
    shift: Math.round(shift / kept),
  };
}

// Run directly (not imported by another script): print the table.
if (process.argv[1]?.endsWith("bench-layered.mjs")) {
  const rows = fixtures().map(([name, model]) => ({
    case: name,
    ...measure(model),
    ...stability(model),
  }));
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);
}
