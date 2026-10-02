// A layout run as a job: everything a layout needs, as plain data that can cross to a worker, and its result back.
// The controller runs small graphs on the spot and big ones in a worker (layout-worker.js) with the same code here,
// so a layout comes out the same either way.
//
//   - the structure: how many nodes, and each edge's ends (the worker builds its own working graph from them);
//   - the sizing spec: every node's label width and how far its shape reaches, and the label settings that turn
//     those into footprints;
//   - the result: every node's home, and the layout's routing (its kind, and for a merged tree the bends of long
//     edges and the references), with edges by index instead of by object.
//
// Pure: no DOM.

import { footprint } from "./boxes.js";
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
 * (bends and references refer to edges by index).
 */
export function runLayout(graph, name, options, spec) {
  const routing = LAYOUTS[name].run(graph, options, sizingFrom(spec));
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
