# The graph model and snapshots

Two JSON formats the engine reads and writes. They're what tests keep as fixtures, what telemetry records, what bug
reports carry, and the shape the public API will hand around.

- **prismatrix-graph**: a graph. What it _is_: nodes, edges, labels and data. No positions.
- **prismatrix-snapshot**: a view. A graph plus the settings, camera and every node's layout state, enough to show
  exactly what was on screen again.

In code: `GraphModel` (`next/engine/model.js`) and `controller.snapshot()` / `controller.restore()`
(`next/engine/snapshot.js`, `next/engine/controller.js`). The full API reference is [API.md](API.md).

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
      "label": "×2",
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
| `edges[].label`             | no       | Drawn small beside the edge ("×2"), where the `labels` edge option says.         |
| `edges[].style`             | no       | How this edge looks, over the view's edge options: see below.                    |
| `edges[].data`              | no       | Anything else (quantity, recipe kind…).                                          |

**Style** is per element and wins over the view's options; anything not set comes from them.

| Element | Key           | Value                                                                                            |
| ------- | ------------- | ------------------------------------------------------------------------------------------------ |
| node    | `color`       | `"#rrggbb"`                                                                                      |
| node    | `size`        | Diameter in world px, 1–400.                                                                     |
| node    | `shape`       | `circle`, `square`, `rounded`, `diamond`, `hexagon`, `ring` or `tile` (a node that is its icon). |
| node    | `stroke`      | A border's colour, `"#rrggbb"`.                                                                  |
| node    | `strokeWidth` | The border's width in world px, 0–100 (default: the `strokeWidth` node option).                  |
| node    | `icon`        | An image drawn in the node: a URL, or an image already in hand (only a URL survives `toJSON`).   |
| node    | `badge`       | Up to 12 characters in a pill at the node's top right ("!", "new").                              |
| edge    | `color`       | `"#rrggbb"`                                                                                      |
| edge    | `width`       | World px, 0.1–40.                                                                                |

An unknown key or a bad value is left out and reported as a `bad-style` issue; the rest of the style still applies.

**Problems are reported, not hidden.** A duplicate node id keeps the first; an edge to a node that isn't there, or
from a node to itself, is left out; a delta that changes or removes something that isn't there skips it. Each
becomes an entry in `model.issues` (`kind`, `message`, `id`) for the latest load or change, and the controller logs
it as a `graphIssue` event. `new GraphModel(input, { strict: true })` throws on the first instead.

| Kind                            | What happened                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `missing-id`                    | A node with no id, or one that isn't a non-empty string or a number (left out).                    |
| `duplicate-node`                | A node id already used (the first is kept).                                                        |
| `missing-endpoint`, `self-loop` | An edge to a node that isn't there, or from a node to itself (left out).                           |
| `bad-id`, `duplicate-edge-id`   | An edge id that isn't a non-empty string or a number (one is made), or one already used (renamed). |
| `missing-node`, `missing-edge`  | A delta changes or removes something that isn't there (skipped).                                   |
| `bad-style`                     | An unknown style key or a bad value (left out).                                                    |
| `bad-option`                    | An unknown node or edge option, a bad value (the default is used) or one out of range (clamped).   |
| `bad-input`                     | A graph or delta that isn't an object, nodes or edges that aren't arrays, an unknown delta field.  |

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
| `changeEdges` | `{ id, label?, style?, data? }`.                                             |

Each field takes a list (any iterable) or a single item. Removals apply first, then changes, then additions.
`update` returns the Change (null when nothing changed).

### A change

What `update`, `replace` and `setOptions` return, and what `onChange` listeners hear:

| Field                                        | What it says                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `version`                                    | The model's version after the change.                                                |
| `structure`                                  | Nodes or edges came, went or were reordered: lay out again.                          |
| `sizes`                                      | Something changed how much room a node takes (a shown label, a size, a shape).       |
| `looks`                                      | Anything drawn changed.                                                              |
| `dataOnly`                                   | Only `data` (or `meta`) changed: nothing is drawn differently and nothing moves.     |
| `nodesAdded`, `nodesRemoved`                 | Ids.                                                                                 |
| `nodesChanged`                               | Every kept node with a new record (label, style or data).                            |
| `nodesRestyled`                              | The part of `nodesChanged` whose label or style changed (what's drawn).              |
| `edgesAdded`, `edgesRemoved`, `edgesChanged` | The same for edges.                                                                  |
| `edgesRestyled`                              | The part of `edgesChanged` whose label or style changed.                             |
| `options`                                    | For `setOptions`: `{ node, edge }`, the options that changed, with their new values. |
| `issues`                                     | The problems in this change.                                                         |

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
| `labelWidths()`        | Each node's label width at the current label size, measured once per distinct label and kept, and cut to the `labelMaxWidth` node option (as the painters cut labels, with an ellipsis); `labelHeight` is one line.                                                                        |
| `opts`                 | `{ node, edge }`: the resolved appearance options (NODE_OPTIONS, EDGE_OPTIONS).                                                                                                                                                                                                            |
| `explicit`             | `{ node, edge }`: the option keys set on purpose (given to the constructor or `setOptions`). The rest are defaults, and a view may show its own in their place (a layout's `edgeDefaults`).                                                                                                |
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
    "explicit": { "node": ["labelSize"], "edge": [] },
    "animation": {},
    "renderer": "webgl"
  },
  "camera": { "x": 0, "y": 0, "k": 1 },
  "selection": ["mjolnir"],
  "collapsed": ["gift-of-mastery"],
  "state": {
    "mjolnir": { "x": 0, "y": 0, "homeX": 0, "homeY": 0, "vx": 0, "vy": 0 }
  }
}
```

- `graph` is a prismatrix-graph; `stats` and `issues` are what the model said about it (for reading the file
  without loading it).
- `settings` are the view's resolved options: everything that decides how it looks and moves. `explicit` lists the
  node and edge options set on purpose; `restore` sets only those again (over the defaults), so a layout's own
  defaults still apply to the rest. A snapshot without it sets every option it has.
- `selection` is the selected node ids, in the order they were selected; `collapsed` the collapsed node ids (their
  hidden descendants have no `state`).
- `state` is every node's layout state by id: where it is (`x`, `y`), where its layout wants it (`homeX`, `homeY`)
  and how fast it's moving (`vx`, `vy`), rounded to hundredths.
- `view.restore(snapshot)` shows it again exactly: same graph, settings, camera, selection, collapsed nodes and
  positions, without a morph. The renderer isn't restored (it depends on the machine).

## Layouts, hints and routing

A layout (`LAYOUTS[name].run(graph, options, sizing, hint)`, `next/engine/layouts.js`) sets every node's home and
returns its **routing**: how edges bend. `kind` is `"tree"` (with its `direction`), `"radial"` (with its centre
`cx`, `cy`) or `"layered"` for the merged tree, which adds `bends` (the points each long edge passes through),
`references` (edges drawn to a chip under their source: `{ edge, source, target, x, y, radius }`), `crossings`,
`initialCrossings` and `layerOf`, and with ranking `"simplex"`, `simplex`: `{ pivots, optimal }`, how many exchanges
network simplex made and whether it reached the fewest long edges or stopped at its work budget (very big graphs).

When nodes or edges come or go, the layout is given a **hint**: the layout before the change, by index into the new
graph (`next/engine/layout-job.js`, `LayoutHint`). `x`, `y` are each node's previous home (NaN for a new node);
for the merged tree, `refX`, `refY` are where each edge's reference chip was, and `bendStart`, `bendXY` its bends.
Layouts use it to keep the mental map: a tree and a radial tree move as a whole so kept nodes stay put; the merged
tree also keeps its old order (only what's new is sifted in) and pulls kept nodes, chips and bends back towards where
they were, as firmly as its `stability` option says (0: laid out afresh, then only moved into place). Hints are
plain typed arrays, so they cross to the layout worker as cheaply as the sizing spec.

## Where they're used

- **Tests:** `tests/fixtures/graphs/*.json` are prismatrix-graph fixtures, made by `node tools/make-fixtures.mjs`
  (deterministic). `tests/next/model.test.js` checks they load cleanly and round-trip byte for byte.
- **Benchmark:** `npm run bench:merged` lays out every fixture with the merged-tree layout and reports crossings,
  long-edge span and drift, parent centring, size and time.
- **Telemetry:** the sandbox's engine log (`logs/engine-stats.log`) records each graph change with the model's
  stats and any issues. The sandbox's **Snapshot** button, `engineLog.snapshot()` in the console, and any page error
  save a snapshot to `logs/snapshots/` (the dev server keeps the newest 30). **Load…** restores one.
- **API:** a model in, changes as deltas, a snapshot out; `controller.model` is the graph shown.
