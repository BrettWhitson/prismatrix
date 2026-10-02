// Quality benchmark for the merged-tree (layered) layout. Lays out a fixed set of crafting-like DAGs and reports
// what makes a layered drawing clean or not, so a change to the algorithm is judged by numbers, not by eye.
//
// The graphs are the fixtures in tests/fixtures/graphs (prismatrix-graph JSON; regenerate them with
// `node tools/make-fixtures.mjs`).
//
// Usage:  node tools/bench-layered.mjs [--json] [--stability=0.5]
//
// Metrics (lower is better unless noted):
//   crossings   edge crossings between neighbouring layers (as the layout counts them)
//   span        total layers crossed by edges beyond the first (dummy nodes): long edges cost this much
//   drift       long edges' sideways travel beyond the straight line between their ends, per long edge (px)
//   ink         total length of every edge as drawn (straight segments through its bends), px
//   centring    mean distance of a parent from the middle of its children (px)
//   width       drawing width (px); height (px)
//   ms          layout time
//   moved       stability: after a one-leaf change (a new ingredient under an item, or a leaf removed), laid out with
//               the layout before as its hint, the share of the kept nodes whose home moves more than 2 px (%), over
//               six such changes
//   shift       stability: how far they move on average (px)
//   +x fresh    crossings after those changes, against laying each changed graph out afresh (%): the price of
//               keeping the old order (it also inherits the old order's luck, good or bad)
//   +x before   crossings after those changes, against the layout before them (%)
//   hint ms     layout time with a hint
//
// A second table compares moved/shift without a hint and with one, for the merged tree, the tree and the radial
// tree (the tree and radial layouts' shapes are fixed by the tree: a hint only moves or turns them into place).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Graph } from "../src/graph.js";
import { GraphModel } from "../src/model.js";
import { layeredLayout } from "../src/layered.js";
import { radialLayout, treeLayout } from "../src/layouts.js";
import { hintFrom } from "../src/layout-job.js";

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
  const { homeX, homeY } = g.matrix;
  return {
    nodes: g.nodes.length,
    edges: g.edges.length,
    refs: routing.references?.length ?? 0,
    crossings: routing.crossings,
    span,
    ink: Math.round(ink),
    drift: Math.round(longEdges ? drift / longEdges : 0),
    centring: Math.round(parents ? centring / parents : 0),
    width: Math.round(Math.max(...homeX) - Math.min(...homeX)),
    height: Math.round(Math.max(...homeY) - Math.min(...homeY)),
    ms: Math.round(ms * 10) / 10,
  };
}

/**
 * How much a layout keeps its place under a small change (the mental map). Six one-leaf changes: a new ingredient
 * under an item a quarter, half and three quarters of the way through the node list, and the removal of the leaf
 * nearest each of those places. Each is laid out again with the layout before as its hint (layout-job.js), and
 * every kept node's home compared with where it was. Returns the share of kept nodes that moved more than 2 px (%),
 * their mean move (px), and how many more crossings the hinted layout has than a fresh one of the same graph (%,
 * over all six). `hint: false` lays out again without the hint (how it was before hints).
 */
export function stability(
  model,
  layout = layeredLayout,
  options = {},
  { hint = true } = {},
) {
  const json = GraphModel.from(model).toJSON();
  const lay = (data, previous) => {
    const g = new Graph(GraphModel.from(data));
    const start = performance.now();
    const routing = layout(
      g,
      options,
      sizing,
      previous && hint ? hintFrom(previous.g, g, previous.routing) : null,
    );
    return { g, routing, ms: performance.now() - start };
  };
  const before = lay(json);
  const changes = [];
  const outgoing = new Map(json.nodes.map((n) => [n.id, 0]));
  for (const e of json.edges)
    outgoing.set(e.source, outgoing.get(e.source) + 1);
  for (const at of [0.25, 0.5, 0.75]) {
    const parent = json.nodes[Math.floor(json.nodes.length * at)].id;
    changes.push({
      nodes: [...json.nodes, { id: "bench-new" }],
      edges: [...json.edges, { source: parent, target: "bench-new" }],
    });
    // The leaf nearest that place (a node nothing comes out of), removed with its edges.
    const from = Math.floor(json.nodes.length * at);
    let leaf = null;
    for (let d = 0; d < json.nodes.length && !leaf; d++)
      for (const i of [from + d, from - d])
        if (!leaf && json.nodes[i] && !outgoing.get(json.nodes[i].id))
          leaf = json.nodes[i].id;
    if (leaf && json.nodes.length > 2)
      changes.push({
        nodes: json.nodes.filter((n) => n.id !== leaf),
        edges: json.edges.filter((e) => e.source !== leaf && e.target !== leaf),
      });
  }
  let moved = 0,
    shift = 0,
    kept = 0,
    crossings = 0,
    fresh = 0,
    old = 0,
    ms = 0;
  for (const data of changes) {
    const after = lay(data, before);
    ms += after.ms;
    crossings += after.routing.crossings ?? 0;
    old += before.routing.crossings ?? 0;
    fresh += hint
      ? (lay(data).routing.crossings ?? 0)
      : (after.routing.crossings ?? 0);
    for (const n of after.g.nodes) {
      const was = before.g.byId.get(n.id);
      if (!was) continue;
      const d = Math.hypot(n.homeX - was.homeX, n.homeY - was.homeY);
      if (d > 2) moved++;
      shift += d;
      kept++;
    }
  }
  const percent = (a, b) =>
    b ? Math.round(((a - b) / b) * 1000) / 10 : a ? Infinity : 0;
  return {
    moved: Math.round((moved / kept) * 100),
    shift: Math.round(shift / kept),
    "+x fresh": percent(crossings, fresh),
    "+x before": percent(crossings, old),
    "hint ms": Math.round((ms / changes.length) * 10) / 10,
  };
}

// Run directly (not imported by another script): print the tables.
if (process.argv[1]?.endsWith("bench-layered.mjs")) {
  const given = process.argv.find((a) => a.startsWith("--stability="));
  const options = given ? { stability: Number(given.split("=")[1]) } : {};
  const all = fixtures();
  const rows = all.map(([name, model]) => ({
    case: name,
    ...measure(model, layeredLayout, options),
    ...stability(model, layeredLayout, options),
  }));
  // Moved % / mean shift px, without a hint → with one.
  const pair = (model, layout, opts) => {
    const a = stability(model, layout, opts, { hint: false }),
      b = stability(model, layout, opts);
    return `${a.moved}%/${a.shift} → ${b.moved}%/${b.shift}`;
  };
  const kept = all.map(([name, model]) => ({
    case: name,
    merged: pair(model, layeredLayout, options),
    tree: pair(model, treeLayout, {}),
    radial: pair(model, radialLayout, {}),
  }));
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({ rows, kept }, null, 2));
  else {
    console.table(rows);
    console.log("Kept in place (moved / shift px), without a hint → with one:");
    console.table(kept);
  }
}
