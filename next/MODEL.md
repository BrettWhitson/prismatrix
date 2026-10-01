# The graph model and snapshots

Two JSON formats the engine reads and writes. They're what tests keep as fixtures, what telemetry records, what bug
reports carry, and the shape the public API will hand around.

- **prismatrix-graph**: a graph. What it _is_: nodes, edges, labels and data. No positions.
- **prismatrix-snapshot**: a view. A graph plus the settings, camera and every node's layout state, enough to show
  exactly what was on screen again.

In code: `GraphModel` (`next/engine/model.js`) and `controller.snapshot()` / `controller.restore()`
(`next/engine/snapshot.js`, `next/engine/controller.js`).

## Model, controller, renderer

```js
const renderer = glRenderer(canvas); // the screen (Canvas 2D where there's no WebGL2)
const model = new GraphModel(json, { node, edge }); // the graph and how it looks
const controller = new GraphController(model, renderer, { layout: "tree" });

model.update({
  addNodes: [{ id: "coin" }],
  addEdges: [{ source: "gift", target: "coin" }],
});
model.update({ changeNodes: [{ id: "coin", data: { price: 12 } }] }); // a restyle: nothing moves
model.replace(json); // a whole new version: unchanged nodes are reused, not rebuilt
```

- **GraphModel** (`model.js`): what the graph _is_ and how it looks. Built once and changed in place: `update(delta)`
  (add, remove, change nodes and edges), `replace(json)` (works out the delta itself), `setOptions({ node, edge })`.
  Unchanged nodes keep their records, so a change costs what changed. It keeps what's costly and rarely changes:
  adjacency, the forest and DAG readings, and each label's measured width (each distinct label measured once). Every
  change goes to its listeners (`onChange`) as a **Change**: what was added, removed and changed, and whether the
  structure (`structure`) or a node's room (`sizes`) changed.
- **GraphController** (`controller.js`): the middle. It listens to the model and does as little as each change
  needs: a new colour or price is a restyle (no layout, nothing moves), a new label or size lays out again, new or
  removed nodes lay out again and morph. It owns everything that moves: the **matrix** (`matrix.js`: every node's
  position, velocity, home and footprint as typed-array columns), the layout, physics, animation, camera, hover and
  drags. No DOM: tests drive it headless (`tests/next/controller.test.js`).
- **Renderer** (`renderer.js`): the screen. Owns the canvas, its size, pointer and wheel input, the frame loop and
  text measurement (the model measures its labels with it), and draws each frame's `scene` with a painter
  (`WebGLPainter` or `CanvasPainter`). `glRenderer(canvas)` or `canvasRenderer(canvas)`; `controller.setRenderer`
  swaps one for another.

The working graph (`graph.js`) pairs the model's structure with the matrix. Its nodes are views: `node.x` reads and
writes `matrix.x[node.index]`, so layouts and tests can work node by node while physics, morphs and renderers run
straight down the columns. Columns are 64-bit: big graphs are hundreds of thousands of pixels wide, where 32-bit
floats can only land on sixteenths of a pixel.

## prismatrix-graph (version 1)

```json
{
  "format": "prismatrix-graph",
  "version": 1,
  "meta": { "name": "mjolnir-example" },
  "nodes": [
    { "id": "mjolnir", "label": "Mjölnir", "data": { "rarity": "legendary" } },
    { "id": "mithril-ore" }
  ],
  "edges": [
    {
      "id": "mjolnir>mithril-ore",
      "source": "mjolnir",
      "target": "mithril-ore",
      "data": { "count": 2 }
    }
  ]
}
```

| Field                       | Required | Meaning                                                                          |
| --------------------------- | -------- | -------------------------------------------------------------------------------- |
| `format`, `version`         | written  | Always written; on input, plain `{ nodes, edges }` is accepted too.              |
| `meta`                      | no       | Anything about the graph as a whole (a name, a source, a description).           |
| `nodes[].id`                | yes      | Unique. Numbers are turned into strings.                                         |
| `nodes[].label`             | no       | Shown on the node. Defaults to the id.                                           |
| `nodes[].style`             | no       | How this node looks, over the view's node options: see below.                    |
| `nodes[].data`              | no       | Anything else (icon, rarity, prices…). The engine keeps it and never reads it.   |
| `edges[].source`, `.target` | yes      | Node ids. Direction matters: for recipes, from the thing made to its ingredient. |
| `edges[].id`                | no       | Defaults to `source>target`, with `#2`, `#3`… for repeats of the same pair.      |
| `edges[].style`             | no       | How this edge looks, over the view's edge options: see below.                    |
| `edges[].data`              | no       | Anything else (quantity, recipe kind…).                                          |

**Style** is per element and wins over the view's options; anything not set comes from them.

| Element | Key     | Value                                                          |
| ------- | ------- | -------------------------------------------------------------- |
| node    | `color` | `"#rrggbb"`                                                    |
| node    | `size`  | Diameter in world px, 1–400.                                   |
| node    | `shape` | `circle`, `square`, `rounded`, `diamond`, `hexagon` or `ring`. |
| edge    | `color` | `"#rrggbb"`                                                    |
| edge    | `width` | World px, 0.1–40.                                              |

An unknown key or a bad value is left out and reported as a `bad-style` issue; the rest of the style still applies.

**Problems are reported, not hidden.** A duplicate node id keeps the first; an edge to a node that isn't there, or
from a node to itself, is left out; a delta that changes or removes something that isn't there skips it. Each
becomes an entry in `model.issues` (`kind`, `message`, `id`) for the latest load or change, and the controller logs
it as a `graphIssue` event. `new GraphModel(input, { strict: true })` throws on the first instead.

**Models change only through their own methods.** Records and the node and edge lists are frozen, and `data` is the
model's own copy (the caller's objects are never frozen or shared). Flat data (a price, a rarity) is a quick
shallow copy; nested data is cloned.

### A delta

| Field         | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `addNodes`    | New nodes, as in the JSON format. Appended in the order given.               |
| `removeNodes` | Ids. A removed node's edges go with it.                                      |
| `changeNodes` | `{ id, label?, style?, data? }`: each field given replaces the node's own.   |
| `addEdges`    | New edges, as in the JSON format (an id is made for them if they have none). |
| `removeEdges` | Ids.                                                                         |
| `changeEdges` | `{ id, style?, data? }`.                                                     |

Removals apply first, then changes, then additions. `update` returns the Change (null when nothing changed).

### What a model computes (`next/engine/model.js`)

| Member                 | What it is                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nodes`, `edges`       | The frozen nodes and edges, in input order (a node's index is its position).                                                                                                                                                                                                               |
| `node(id)`, `edge(id)` | Lookup by id.                                                                                                                                                                                                                                                                              |
| `index`, `edgeIndex`   | Maps from id to index.                                                                                                                                                                                                                                                                     |
| `outgoing`, `incoming` | Per node index, the indices of the edges out of it and into it.                                                                                                                                                                                                                            |
| `ends`                 | Per edge index, `[source index, target index]`.                                                                                                                                                                                                                                            |
| `forest()`             | The graph read as a forest: breadth-first from every node nothing points to; the first edge to reach a node is its tree edge (`tree[edge]`), any other is a cross-link. `roots`, `order`, `parent`, `children`, `depth`, `leaves`, `descendants`, `maxDepth`. For tree and radial layouts. |
| `dag()`                | The graph read as a DAG: `back[edge]` marks edges that close a cycle (to be reversed for layout); with them reversed, a topological `order`, each node's `longest` path from a source, `sources`, `sinks`. For layered layouts.                                                            |
| `stats()`              | `nodes`, `edges`, `roots`, `depth`, `layers`, `crossLinks`, `sharedNodes` (more than one parent), `maxInDegree`, `maxOutDegree`, `backEdges`, `issues`. Logged with every graph change.                                                                                                    |
| `diff(previous)`       | `nodesAdded`, `nodesRemoved`, `nodesKept`, `nodesChanged` (label, style or data), `edgesAdded`, `edgesRemoved`, by id.                                                                                                                                                                     |
| `toJSON()`             | prismatrix-graph JSON. `GraphModel.from(model.toJSON())` gives an equal model.                                                                                                                                                                                                             |
| `labelWidths()`        | Each node's label width at the current label size, measured once per distinct label and kept; `labelHeight` is one line.                                                                                                                                                                   |
| `opts`                 | `{ node, edge }`: the resolved appearance options (NODE_OPTIONS, EDGE_OPTIONS).                                                                                                                                                                                                            |
| `version`              | Bumped by every change.                                                                                                                                                                                                                                                                    |

Computed views are worked out once per structure and kept until nodes or edges come, go or move.

## prismatrix-snapshot (version 1)

```json
{
  "format": "prismatrix-snapshot",
  "version": 1,
  "time": "2026-10-01T16:20:00.000Z",
  "note": "error: something broke",
  "graph": {
    "format": "prismatrix-graph",
    "version": 1,
    "nodes": [],
    "edges": []
  },
  "stats": { "nodes": 0, "edges": 0 },
  "issues": [],
  "settings": {
    "layout": "merged",
    "layoutOptions": { "direction": "TB", "levelGap": 90, "nodeGap": 16 },
    "physics": "elastic",
    "physicsOptions": {},
    "node": {},
    "edge": {},
    "animation": {},
    "renderer": "webgl"
  },
  "camera": { "x": 0, "y": 0, "k": 1 },
  "state": {
    "mjolnir": { "x": 0, "y": 0, "homeX": 0, "homeY": 0, "vx": 0, "vy": 0 }
  }
}
```

- `graph` is a prismatrix-graph; `stats` and `issues` are what the model said about it (for reading the file
  without loading it).
- `settings` are the view's resolved options: everything that decides how it looks and moves.
- `state` is every node's layout state by id: where it is (`x`, `y`), where its layout wants it (`homeX`, `homeY`)
  and how fast it's moving (`vx`, `vy`), rounded to hundredths.
- `view.restore(snapshot)` shows it again exactly: same graph, settings, camera and positions, without a morph.
  The renderer isn't restored (it depends on the machine).

## Where they're used

- **Tests:** `tests/fixtures/graphs/*.json` are prismatrix-graph fixtures, made by `node tools/make-fixtures.mjs`
  (deterministic). `tests/next/model.test.js` checks they load cleanly and round-trip byte for byte.
- **Benchmark:** `npm run bench:merged` lays out every fixture with the merged-tree layout and reports crossings,
  long-edge span and drift, parent centring, size and time.
- **Telemetry:** the sandbox's engine log (`logs/engine-stats.log`) records each graph change with the model's
  stats and any issues. The sandbox's **Snapshot** button, `engineLog.snapshot()` in the console, and any page error
  save a snapshot to `logs/snapshots/` (the dev server keeps the newest 30). **Load…** restores one.
- **API:** a model in, changes as deltas, a snapshot out; `controller.model` is the graph shown.
