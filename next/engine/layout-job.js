// A layout run as a job: everything a layout needs, as plain data that can cross to a worker, and its result back.
// The controller runs small graphs on the spot and big ones in a worker (layout-worker.js) with the same code here,
// so a layout comes out the same either way.
//
//   - the structure: how many nodes, and each edge's ends (the worker builds its own working graph from them);
//   - the sizing spec: every node's label width and how far its shape reaches, and the label settings that turn
//     those into footprints;
//   - the hint (optional): where each node's home was in the layout before, so a small change to the graph moves
//     only what it has to (the mental map);
//   - the result: every node's home, and the layout's routing (its kind, and for a merged tree the bends of long
//     edges and the references), with edges by index instead of by object.
//
// Pure: no DOM.

import { footprint, reach } from "./boxes.js";
import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { LAYOUTS } from "./layouts.js";

/**
 * @typedef {object} SizingSpec
 * @property {Float64Array} widths  each node's label width (0 when labels don't take room)
 * @property {Float64Array} reach   how far each node's shape reaches from its centre
 * @property {number} height        a label's height
 * @property {number} gap           extra clearance between nodes
 * @property {string} labels        the node option: "off", "below", "right" or "outward"
 * @property {boolean} collide      whether labels take room (label collision on): without it, they may overlap
 */

/**
 * @typedef {object} LayoutHint Where everything was in the layout before a change, so the new layout can keep its
 *   place: a layout keeps the old order where it can, pulls kept nodes towards their old homes and moves the whole
 *   drawing so they stay put. Per node and per edge of the graph being laid out (by index); NaN where there's no
 *   old place (a new node, an edge that had no reference). Plain typed arrays, made for each layout: they cross to a
 *   worker as cheaply as the sizing spec.
 * @property {Float64Array} x previous home, x (NaN: a new node)
 * @property {Float64Array} y previous home, y
 * @property {Float64Array} [refX] per edge, where its reference chip was, if it ended at one (merged tree)
 * @property {Float64Array} [refY]
 * @property {Int32Array} [bendStart] per edge, where its bends start in `bendXY` (edges + 1 entries: edge i's bends
 *   are points bendStart[i] to bendStart[i + 1] - 1), in the edge's own direction
 * @property {Float64Array} [bendXY] bends, x and y in turn
 */

/**
 * The hint for laying out `graph` after `previous` (both working graphs, with homes), found by id: each node's
 * home in `previous`, and with `routing` (previous's routing, edges by object) each edge's reference chip and
 * bends. Null when no node is kept (nothing to keep in place).
 * @param {import("./graph.js").Graph} previous
 * @param {import("./graph.js").Graph} graph
 * @param {import("./layouts.js").Routing | null} [routing]
 * @returns {LayoutHint | null}
 */
export function hintFrom(previous, graph, routing = null) {
  const count = graph.nodes.length;
  const x = new Float64Array(count).fill(NaN),
    y = new Float64Array(count).fill(NaN);
  const m = previous.matrix;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const was = previous.byId.get(graph.nodes[i].id);
    if (!was) continue;
    x[i] = m.homeX[was.index];
    y[i] = m.homeY[was.index];
    kept++;
  }
  if (!kept) return null;
  const hint = { x, y };
  if (!routing?.bends && !routing?.references) return hint;
  const edges = graph.edges.length;
  const index = new Map(graph.edges.map((e, i) => [e.id, i]));
  hint.refX = new Float64Array(edges).fill(NaN);
  hint.refY = new Float64Array(edges).fill(NaN);
  for (const r of routing.references ?? []) {
    const i = index.get(r.edge.id);
    if (i === undefined) continue;
    hint.refX[i] = r.x;
    hint.refY[i] = r.y;
  }
  const points = new Array(edges).fill(null);
  let total = 0;
  for (const [e, list] of routing.bends ?? []) {
    const i = index.get(/** @type {{ id: string }} */ (e).id);
    if (i === undefined || !list.length) continue;
    points[i] = list;
    total += list.length;
  }
  hint.bendStart = new Int32Array(edges + 1);
  hint.bendXY = new Float64Array(total * 2);
  let at = 0;
  for (let i = 0; i < edges; i++) {
    for (const [px, py] of points[i] ?? []) {
      hint.bendXY[at * 2] = px;
      hint.bendXY[at * 2 + 1] = py;
      at++;
    }
    hint.bendStart[i + 1] = at;
  }
  return hint;
}

/**
 * Whether `hint` fits a graph of `nodes` nodes and `edges` edges (one entry each, edge parts optional) and keeps at
 * least one node. A layout is given a hint only when it does.
 */
export function usableHint(hint, nodes, edges) {
  if (!hint || hint.x?.length !== nodes || hint.y?.length !== nodes)
    return false;
  if (hint.refX && (hint.refX.length !== edges || hint.refY?.length !== edges))
    return false;
  if (
    hint.bendStart &&
    (hint.bendStart.length !== edges + 1 ||
      hint.bendXY?.length !== 2 * hint.bendStart[edges])
  )
    return false;
  for (let i = 0; i < nodes; i++) if (!Number.isNaN(hint.x[i])) return true;
  return false;
}

/**
 * What a layout needs to know about sizes, for working graph `graph` of `model`: each node's label width (the
 * model's, measured once each) and how far its shape reaches (from `looks`, render.js's looksOf), and the label
 * settings (the model's node options) that turn those into footprints.
 * @param {Graph} graph
 * @param {GraphModel} model
 * @param {{ radius: Float64Array, shape: string[] }} looks per node of `graph`
 * @returns {SizingSpec}
 */
export function sizingSpec(graph, model, looks) {
  const { node } = model.opts;
  const labelled = node.labels !== "off";
  return {
    widths: labelled
      ? graph.pick(model.labelWidths())
      : new Float64Array(graph.nodes.length),
    reach: Float64Array.from(
      graph.nodes,
      (n) => looks.radius[n.index] * reach(looks.shape[n.index]),
    ),
    height: model.labelHeight,
    gap: node.collisionRadius,
    labels: node.labels,
    collide: labelled && node.labelCollide,
  };
}

/** A layout's sizing (see layouts.js) from a spec: label widths, and each node's footprint for a label direction. */
export function sizingFrom({ widths, reach, height, gap, labels, collide }) {
  const fixed = labels === "right" ? 0 : Math.PI / 2;
  return {
    widths,
    height,
    gap,
    box: (i, angle) =>
      footprint(
        reach[i],
        labels === "outward" ? angle : fixed,
        collide ? widths[i] : 0,
        height,
      ),
  };
}

/**
 * The structure of a working graph, for a worker: node count and edge ends, as typed arrays. The arrays are new
 * each time and nothing else holds them, so they can be moved (transferred) to the worker rather than copied.
 */
export function structureOf(graph) {
  return {
    count: graph.nodes.length,
    from: Int32Array.from(graph.edges, (e) => e.source),
    to: Int32Array.from(graph.edges, (e) => e.target),
  };
}

/** A working graph with just a structure: nodes by index, edges in the same order (so indices line up). */
export function graphFromStructure({ count, from, to }) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: String(i) }));
  const edges = Array.from(from, (s, i) => ({
    id: String(i),
    source: String(s),
    target: String(to[i]),
  }));
  return new Graph(GraphModel.from({ nodes, edges }));
}

/**
 * Lay `graph` out with layout `name`: every node's home, and the routing, packed for the trip back from a worker
 * (bends and references refer to edges by index). With a `hint` (the previous layout's homes), the layout keeps
 * kept nodes near where they were.
 * @param {import("./graph.js").Graph} graph
 * @param {string} name
 * @param {object} options
 * @param {SizingSpec} spec
 * @param {LayoutHint | null} [hint]
 */
export function runLayout(graph, name, options, spec, hint = null) {
  const routing = LAYOUTS[name].run(
    graph,
    options,
    sizingFrom(spec),
    usableHint(hint, graph.nodes.length, graph.edges.length) ? hint : null,
  );
  const m = graph.matrix;
  return {
    homeX: m.homeX.slice(),
    homeY: m.homeY.slice(),
    routing: packRouting(routing, graph),
  };
}

/** A routing with its edge-keyed parts (bends, references) by edge index. */
export function packRouting(routing, graph) {
  const { bends, references, ...rest } = routing;
  const out = { ...rest };
  if (bends) {
    const index = new Map(graph.edges.map((e, i) => [e, i]));
    const edges = [],
      start = [0],
      xy = [];
    for (const [e, points] of bends) {
      if (!points.length) continue;
      edges.push(index.get(e));
      for (const [x, y] of points) xy.push(x, y);
      start.push(xy.length / 2);
    }
    out.bends = {
      edges: Int32Array.from(edges),
      start: Int32Array.from(start),
      xy: Float64Array.from(xy),
    };
  }
  if (references) {
    const index = new Map(graph.edges.map((e, i) => [e, i]));
    out.references = references.map(({ edge, ...r }) => ({
      ...r,
      edge: index.get(edge),
    }));
  }
  return out;
}

/** The routing again, its bends and references keyed by `graph`'s own edge objects. */
export function unpackRouting(packed, graph) {
  const { bends, references, ...rest } = packed;
  const routing = { ...rest };
  if (bends) {
    routing.bends = new Map();
    for (let k = 0; k < bends.edges.length; k++) {
      const points = [];
      for (let p = bends.start[k]; p < bends.start[k + 1]; p++)
        points.push([bends.xy[p * 2], bends.xy[p * 2 + 1]]);
      routing.bends.set(graph.edges[bends.edges[k]], points);
    }
  }
  if (references)
    routing.references = references.map(({ edge, ...r }) => ({
      ...r,
      edge: graph.edges[edge],
    }));
  return routing;
}
