// The graph model: what a graph *is*, separate from where anything is drawn.
//
// A GraphModel is immutable and serialisable. It's the format the engine takes in, what tests keep as fixtures,
// what telemetry snapshots record, and what a public API will hand around. It holds nodes and directed edges by id,
// with free-form `data` on both (an item's icon, rarity, a recipe's quantities…), and computes views of the graph
// on demand: adjacency, a spanning forest (for tree-shaped layouts), a DAG reading (for layered layouts), stats,
// and the difference between two versions of a graph.
//
// Layout state (positions, velocities, footprints) is not here: the engine keeps that in its working graph
// (graph.js), keyed by node index, and a snapshot (snapshot.js) records it by id.
//
// The JSON format is documented in next/MODEL.md.

export const GRAPH_FORMAT = "prismatrix-graph";
export const GRAPH_VERSION = 1;

/**
 * @typedef {object} ModelNode
 * @property {string} id
 * @property {string} label    shown on the node; defaults to the id
 * @property {object} data     anything else, untouched by the engine
 *
 * @typedef {object} ModelEdge
 * @property {string} id       given, or "source>target" (with "#2", "#3"… for repeats)
 * @property {string} source   node id
 * @property {string} target   node id
 * @property {object} data
 *
 * @typedef {object} Issue
 * @property {"duplicate-node" | "missing-endpoint" | "self-loop" | "duplicate-edge-id" | "bad-input"} kind
 * @property {string} message
 * @property {string} [id]
 */

/** Deep-freeze plain objects and arrays (data is the caller's, but the model never lets it change under it). */
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

/** The model's own copy of a node's or edge's data (so freezing it never touches the caller's objects). */
function copyData(value) {
  const data = plain(value);
  try {
    return structuredClone(data);
  } catch {
    return { ...data }; // something that can't be cloned (a function, say): a shallow copy
  }
}

export class GraphModel {
  /**
   * Build a model from JSON (the prismatrix-graph format) or plain `{ nodes, edges }`. Problems are collected in
   * `issues` (a duplicate node keeps its first, an edge to an unknown node or a self-loop is left out); with
   * `strict`, the first problem throws instead.
   * @param {{ nodes?: object[], edges?: object[], meta?: object }} input
   * @param {{ strict?: boolean }} [options]
   */
  static from(input, { strict = false } = {}) {
    if (input instanceof GraphModel) return input;
    return new GraphModel(input ?? {}, strict);
  }

  /** @private use GraphModel.from */
  constructor(input, strict) {
    /** @type {Issue[]} */
    this.issues = [];
    const problem = (kind, message, id) => {
      if (strict) throw new Error(`Prismatrix graph: ${message}`);
      this.issues.push({ kind, message, ...(id !== undefined && { id }) });
    };
    if (!Array.isArray(input.nodes ?? []) || !Array.isArray(input.edges ?? []))
      problem("bad-input", "nodes and edges must be arrays");
    this.meta = freeze({ ...plain(input.meta) });

    /** @type {ReadonlyArray<ModelNode>} */
    const nodes = [];
    /** @type {Map<string, number>} id to node index */
    this.index = new Map();
    for (const raw of Array.isArray(input.nodes) ? input.nodes : []) {
      const id = String(raw?.id ?? "");
      if (this.index.has(id)) {
        problem(
          "duplicate-node",
          `duplicate node id "${id}" (the first is kept)`,
          id,
        );
        continue;
      }
      this.index.set(id, nodes.length);
      nodes.push(
        freeze({
          id,
          label: raw.label === undefined ? id : String(raw.label),
          data: copyData(raw.data),
        }),
      );
    }
    this.nodes = Object.freeze(nodes);

    /** @type {ReadonlyArray<ModelEdge>} */
    const edges = [];
    this.edgeIndex = new Map();
    const pairs = new Map();
    for (const raw of Array.isArray(input.edges) ? input.edges : []) {
      const source = String(raw?.source ?? ""),
        target = String(raw?.target ?? "");
      if (!this.index.has(source) || !this.index.has(target)) {
        problem(
          "missing-endpoint",
          `edge ${source} → ${target} names a node that isn't there (left out)`,
          raw?.id,
        );
        continue;
      }
      if (source === target) {
        problem(
          "self-loop",
          `edge ${source} → ${target} loops to itself (left out)`,
          raw?.id,
        );
        continue;
      }
      const pair = `${source}>${target}`;
      const repeat = (pairs.get(pair) ?? 0) + 1;
      pairs.set(pair, repeat);
      let id =
        raw.id === undefined
          ? repeat > 1
            ? `${pair}#${repeat}`
            : pair
          : String(raw.id);
      if (this.edgeIndex.has(id)) {
        problem("duplicate-edge-id", `duplicate edge id "${id}" (renamed)`, id);
        id = `${id}#${edges.length}`;
      }
      this.edgeIndex.set(id, edges.length);
      edges.push(freeze({ id, source, target, data: copyData(raw.data) }));
    }
    this.edges = Object.freeze(edges);

    // Adjacency by index: the edge indices out of and into each node, in edge order.
    const out = nodes.map(() => []),
      into = nodes.map(() => []);
    edges.forEach((e, i) => {
      out[this.index.get(e.source)].push(i);
      into[this.index.get(e.target)].push(i);
    });
    this.outgoing = Object.freeze(out.map(Object.freeze));
    this.incoming = Object.freeze(into.map(Object.freeze));
    /** Each edge's ends as node indices. */
    this.ends = Object.freeze(
      edges.map((e) =>
        Object.freeze([this.index.get(e.source), this.index.get(e.target)]),
      ),
    );
    this.cache = new Map();
    Object.freeze(this.issues);
  }

  get size() {
    return this.nodes.length;
  }

  node(id) {
    const i = this.index.get(String(id));
    return i === undefined ? undefined : this.nodes[i];
  }

  edge(id) {
    const i = this.edgeIndex.get(String(id));
    return i === undefined ? undefined : this.edges[i];
  }

  /** Computed once per model and kept: models never change. */
  #cached(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }

  /**
   * The graph read as a forest: breadth-first from every node nothing points to (in node order), then from any
   * node still unreached (cycles); the first edge to reach a node is its tree edge, any other edge into it is a
   * cross-link.
   * @returns {{ roots: number[], order: number[], parent: Int32Array, depth: Int32Array, children: number[][],
   *   leaves: Int32Array, descendants: Int32Array, tree: Uint8Array, maxDepth: number }}
   */
  forest() {
    return this.#cached("forest", () => {
      const count = this.nodes.length;
      const parent = new Int32Array(count).fill(-1),
        depth = new Int32Array(count),
        leaves = new Int32Array(count).fill(1),
        descendants = new Int32Array(count),
        tree = new Uint8Array(this.edges.length);
      const children = Array.from({ length: count }, () => []);
      const roots = [],
        order = [];
      const seen = new Uint8Array(count);
      const grow = (root) => {
        seen[root] = 1;
        roots.push(root);
        const queue = [root];
        for (let head = 0; head < queue.length; head++) {
          const at = queue[head];
          order.push(at);
          for (const ei of this.outgoing[at]) {
            const target = this.ends[ei][1];
            if (seen[target]) continue;
            seen[target] = 1;
            tree[ei] = 1;
            parent[target] = at;
            depth[target] = depth[at] + 1;
            children[at].push(target);
            queue.push(target);
          }
        }
      };
      for (let i = 0; i < count; i++) if (!this.incoming[i].length) grow(i);
      for (let i = 0; i < count; i++) if (!seen[i]) grow(i);
      let maxDepth = 0;
      for (let k = order.length - 1; k >= 0; k--) {
        const v = order[k];
        if (children[v].length) {
          leaves[v] = 0;
          for (const c of children[v]) {
            leaves[v] += leaves[c];
            descendants[v] += descendants[c] + 1;
          }
        }
        maxDepth = Math.max(maxDepth, depth[v]);
      }
      return {
        roots,
        order,
        parent,
        depth,
        children,
        leaves,
        descendants,
        tree,
        maxDepth,
      };
    });
  }

  /**
   * The graph read as a DAG: edges that close a cycle (found depth-first from the forest's roots) are marked as
   * back edges, to be reversed for layout; with them reversed, a topological order and each node's longest path
   * from a source.
   * @returns {{ back: Uint8Array, order: number[], longest: Int32Array, sources: number[], sinks: number[] }}
   */
  dag() {
    return this.#cached("dag", () => {
      const count = this.nodes.length;
      const back = new Uint8Array(this.edges.length);
      const state = new Uint8Array(count); // 0 new, 1 on the stack, 2 done
      const visit = (start) => {
        const stack = [[start, 0]];
        state[start] = 1;
        while (stack.length) {
          const top = stack[stack.length - 1];
          const v = top[0];
          if (top[1] < this.outgoing[v].length) {
            const ei = this.outgoing[v][top[1]++];
            const w = this.ends[ei][1];
            if (state[w] === 1) back[ei] = 1;
            else if (!state[w]) {
              state[w] = 1;
              stack.push([w, 0]);
            }
          } else {
            state[v] = 2;
            stack.pop();
          }
        }
      };
      for (const r of this.forest().roots) if (!state[r]) visit(r);
      for (let v = 0; v < count; v++) if (!state[v]) visit(v);

      const from = (ei) => this.ends[ei][back[ei] ? 1 : 0],
        to = (ei) => this.ends[ei][back[ei] ? 0 : 1];
      const indegree = new Int32Array(count),
        down = Array.from({ length: count }, () => []);
      this.edges.forEach((_, ei) => {
        indegree[to(ei)]++;
        down[from(ei)].push(to(ei));
      });
      const sources = [];
      for (let v = 0; v < count; v++) if (!indegree[v]) sources.push(v);
      const order = sources.slice(),
        longest = new Int32Array(count);
      for (let head = 0; head < order.length; head++) {
        const v = order[head];
        for (const w of down[v]) {
          longest[w] = Math.max(longest[w], longest[v] + 1);
          if (--indegree[w] === 0) order.push(w);
        }
      }
      const sinks = [];
      for (let v = 0; v < count; v++) if (!down[v].length) sinks.push(v);
      return { back, order, longest, sources, sinks };
    });
  }

  /** Counts that describe the graph's shape, for telemetry and tests. */
  stats() {
    return this.#cached("stats", () => {
      const f = this.forest(),
        d = this.dag();
      let crossLinks = 0;
      for (let i = 0; i < this.edges.length; i++) if (!f.tree[i]) crossLinks++;
      let maxIn = 0,
        maxOut = 0,
        shared = 0;
      for (let v = 0; v < this.nodes.length; v++) {
        maxIn = Math.max(maxIn, this.incoming[v].length);
        maxOut = Math.max(maxOut, this.outgoing[v].length);
        if (this.incoming[v].length > 1) shared++;
      }
      return Object.freeze({
        nodes: this.nodes.length,
        edges: this.edges.length,
        roots: f.roots.length,
        depth: f.maxDepth,
        layers: this.nodes.length ? Math.max(...d.longest) + 1 : 0,
        crossLinks,
        sharedNodes: shared,
        maxInDegree: maxIn,
        maxOutDegree: maxOut,
        backEdges: d.back.reduce((a, b) => a + b, 0),
        issues: this.issues.length,
      });
    });
  }

  /**
   * What changed from `previous` to this model, by id: nodes and edges added, removed, kept, and kept nodes whose
   * label or data changed.
   */
  diff(previous) {
    const before = GraphModel.from(previous);
    const nodesAdded = [],
      nodesKept = [],
      nodesChanged = [];
    for (const n of this.nodes) {
      const old = before.node(n.id);
      if (!old) nodesAdded.push(n.id);
      else {
        nodesKept.push(n.id);
        if (
          old.label !== n.label ||
          JSON.stringify(old.data) !== JSON.stringify(n.data)
        )
          nodesChanged.push(n.id);
      }
    }
    const nodesRemoved = before.nodes
      .filter((n) => !this.index.has(n.id))
      .map((n) => n.id);
    const edgesAdded = this.edges
      .filter((e) => !before.edgeIndex.has(e.id))
      .map((e) => e.id);
    const edgesRemoved = before.edges
      .filter((e) => !this.edgeIndex.has(e.id))
      .map((e) => e.id);
    return {
      nodesAdded,
      nodesRemoved,
      nodesKept,
      nodesChanged,
      edgesAdded,
      edgesRemoved,
    };
  }

  /** The model as prismatrix-graph JSON: GraphModel.from(model.toJSON()) gives an equal model. */
  toJSON() {
    return {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      ...(Object.keys(this.meta).length && { meta: this.meta }),
      nodes: this.nodes.map((n) => ({
        id: n.id,
        ...(n.label !== n.id && { label: n.label }),
        ...(Object.keys(n.data).length && { data: n.data }),
      })),
      edges: this.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(Object.keys(e.data).length && { data: e.data }),
      })),
    };
  }
}
