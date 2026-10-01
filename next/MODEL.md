# The graph model and snapshots

Two JSON formats the engine reads and writes. They're what tests keep as fixtures, what telemetry records, what bug
reports carry, and the shape the public API will hand around.

- **prismatrix-graph**: a graph. What it _is_: nodes, edges, labels and data. No positions.
- **prismatrix-snapshot**: a view. A graph plus the settings, camera and every node's layout state, enough to show
  exactly what was on screen again.

In code: `GraphModel` (`next/engine/model.js`) and `takeSnapshot` / `controller.snapshot()` / `controller.restore()`
(`next/engine/snapshot.js`, `next/engine/controller.js`; a view passes them through).

## Model, controller, view

- **GraphModel** (`model.js`): what the graph _is_. Immutable data, nothing about the screen.
- **GraphController** (`controller.js`): everything that happens to it, with no DOM. It builds the working graph
  from the model, owns the settings and all changing state (positions, camera, hover, fades, morphs, ghosts), runs
  layouts and physics, takes input as canvas-local points (`pointerDown/Move/Up`, `wheel`, `doubleClick`), and each
  `tick(now)` produces the `scene` a renderer draws. Tests drive one directly (`tests/next/controller.test.js`).
- **Updates are cheap when the shape stays the same.** `setGraph` with the same nodes and edges (same ids, order
  and ends) and nothing that changes a node's room (its label while labels show, its size or shape) takes the new
  data, labels and styles in place: no layout, no morph, positions and hover kept, logged as `graphRestyle`. On
  the 642-node fixture in the merged tree that's about 3 ms instead of 64. Anything else lays out and morphs.
- **GraphView** (`view.js`): a controller on a canvas. Measures text, forwards pointer events, runs the frame loop
  and picks a renderer (WebGL2 or Canvas 2D).

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
from a node to itself, is left out. Each becomes an entry in `model.issues` (`kind`, `message`, `id`), and the view
logs it as a `graphIssue` event. `GraphModel.from(input, { strict: true })` throws on the first instead.

**Models never change.** Everything is frozen, and `data` is the model's own copy (the caller's objects are never
frozen or shared). Changing a graph means building a new model; `next.diff(previous)` says what changed.

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

Computed views are worked out once per model and kept.

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
- **API (later):** a model in, a snapshot out; `view.model` is the graph shown.

## What isn't in the model (yet)

The engine's working graph (`next/engine/graph.js`) is built from a model and adds the layout state (positions,
velocities, label angles, footprints) on per-node objects. Moving that state into typed arrays is planned as a
performance step; it won't change either format.
