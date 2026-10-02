# Prismatrix API

The reference for the Prismatrix engine (`src/`), imported from `prismatrix`. The sandbox
(`npm run sandbox`, http://localhost:8651) drives every option described here. The 0.4 engine this replaces is documented in API.md
at the `v0.4.0` tag.

An app works with three parts:

- **`GraphModel`**: what the graph _is_ (nodes, edges, labels, data) and how it looks (node and edge options, each
  element's own style). Built once, then changed in place by deltas or whole new versions.
- **`GraphController`**: the view. It listens to the model and does only what each change needs (nothing for new
  data, a restyle for new colours, a layout and a morph for new nodes), and owns everything that moves: layout,
  physics, animation, the camera, hover, selection, drags and what's collapsed.
- **A renderer** (`glRenderer`, `canvasRenderer`): the screen. It owns the canvas, its size, pointer and wheel input,
  the frame loop and text measurement, and draws what the controller hands it.

The option, style, field and event tables are written from the code (the schemas and the JSDoc) by `npm run docs`
(`tools/docs.mjs`); `npm run verify` fails when they're out of date, when a typedef and its schema disagree, or
when an event, issue kind or public member isn't documented here. The file formats are also described in
[MODEL.md](MODEL.md).

**Contents:** [Quick start](#quick-start) · [Entry points](#entry-points) · [GraphModel](#graphmodel) ·
[GraphController](#graphcontroller) · [Events](#events) · [Renderers](#renderers) · [Layouts](#layouts) ·
[Physics](#physics) · [Animation](#animation) · [Node and edge options](#node-and-edge-options) ·
[Themes](#themes) · [Option schemas](#option-schemas) ·
[Layout without a screen](#layout-without-a-screen) · [Performance](#performance) · [Types](#types)

## Quick start

```js
import { GraphModel, GraphController, glRenderer } from "prismatrix";

const canvas = document.querySelector("canvas"); // sized by CSS: the renderer follows its size
const model = new GraphModel({
  nodes: [
    { id: "mjolnir", label: "Mjölnir", style: { icon: "/icons/mjolnir.png", badge: "new" } },
    { id: "gift", label: "Gift of Mjölnir" },
    { id: "ecto", label: "Glob of Ectoplasm", data: { price: 21 } },
  ],
  edges: [
    { source: "mjolnir", target: "gift" },
    { source: "gift", target: "ecto", label: "×250" },
  ],
});
const view = new GraphController(model, glRenderer(canvas), {
  layout: "merged",
  theme: "dark",
  depth: 2, // start with two levels below the roots; the rest collapsed
});

view.on("tap", ({ node, reference }) => {
  if (reference) view.focus(node); // a tap on a reference chip flies to its ingredient
});
view.on("select", ({ selected }) => showDetails(selected));

model.update({ changeNodes: [{ id: "ecto", data: { price: 23 } }] }); // data only: costs nothing on screen
model.update({ addNodes: [{ id: "coin" }], addEdges: [{ source: "gift", target: "coin" }] }); // lays out, morphs
await view.settled(); // the new layout is in and everything has come to rest
```

Without a screen (tests, a server), a controller runs headless: give it no renderer, set a viewport, and tick it
yourself.

```js
const view = new GraphController(json, null, { layout: "tree" });
view.setViewport(800, 600);
view.run(1000); // tick 1 s forward, 60 times a second
view.snapshot(); // everything on screen, as JSON
```

## Entry points

| Import                       | What it is                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `prismatrix`            | The public surface (`src/index.js`): everything below.                                                             |
| `prismatrix/layout`     | Layout without a screen (`src/layout.js`): `layoutGraph`, `GraphModel`, `LAYOUTS` and the schemas. No DOM needed. |
| `prismatrix/<module>.js` | Any module by path (`src/<module>.js`), for tools and tests. Not a stable interface.                             |

What `prismatrix` exports:

| Export                                          | What it is                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `GraphModel`, `GRAPH_FORMAT`, `GRAPH_VERSION`   | The graph model, and the JSON format's name (`"prismatrix-graph"`) and version.  |
| `GraphController`                               | The view.                                                                        |
| `glRenderer`, `canvasRenderer`                  | Renderers on a canvas.                                                           |
| `LAYOUTS`                                       | The layouts, their options, physics modes and edge defaults.                     |
| `PHYSICS`, `physicsSchema`                      | The physics modes and their options; a mode's full schema within a layout.       |
| `NODE_OPTIONS`, `EDGE_OPTIONS`                  | How nodes and edges look: the option schemas.                                    |
| `ANIMATION_OPTIONS`, `EASINGS`                  | How the view moves between states, and the easing curves.                        |
| `resolve`                                       | Checking options against a schema (with no values: its defaults).                |
| `THEMES`, `resolveTheme`                        | The theme presets, and a theme from a name or tokens.                            |
| `SNAPSHOT_FORMAT`, `SNAPSHOT_VERSION`, `snapshotModel` | The snapshot format's name and version, and a snapshot's graph as a model. |
| `WORKER_MIN`                                    | Graphs with at least this many nodes lay out in a worker (2,000).                |

Types are in `types/` (generated from the JSDoc; `npm run types`). The index re-exports the ones an app uses:
see [Types](#types).

## GraphModel

### The JSON format

A graph is prismatrix-graph JSON (`model.toJSON()` writes it), or plain `{ nodes, edges }`:

```json
{
  "format": "prismatrix-graph",
  "version": 1,
  "meta": { "name": "mjolnir-example" },
  "nodes": [
    { "id": "mjolnir", "label": "Mjölnir", "style": { "shape": "tile", "icon": "/icons/mjolnir.png" }, "data": { "rarity": "legendary" } },
    { "id": "mithril-ore" }
  ],
  "edges": [{ "source": "mjolnir", "target": "mithril-ore", "label": "×2", "data": { "count": 2 } }]
}
```

| Field                       | Required | Meaning                                                                                                   |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `format`, `version`         | no       | Written by `toJSON`; plain `{ nodes, edges }` is read too.                                                |
| `meta`                      | no       | Anything about the graph as a whole. Kept, frozen, and never read by the engine.                          |
| `nodes[].id`                | yes      | Unique: a non-empty string or a number (numbers become strings).                                          |
| `nodes[].label`             | no       | Shown by the node. Defaults to the id.                                                                    |
| `nodes[].style`             | no       | How this node looks, over the node options (below).                                                       |
| `nodes[].data`              | no       | Anything else (prices, rarity…). The model keeps its own frozen copy and never reads it.                  |
| `edges[].source`, `.target` | yes      | Node ids. Direction matters: for recipes, from the thing made to its ingredient.                          |
| `edges[].id`                | no       | Defaults to `source>target`, with `#2`, `#3`… for repeats of the same pair.                              |
| `edges[].label`             | no       | Drawn small beside the edge, near its target (a quantity: "×3"); `""` for none. See the `labels` edge option. |
| `edges[].style`             | no       | How this edge looks, over the edge options.                                                               |
| `edges[].data`              | no       | Anything else.                                                                                            |

**Node style** (`nodes[].style`): each key wins over the matching node option; anything not set comes from the
options (and the theme). An unknown key or a bad value is left out and reported as a `bad-style` issue; the rest of
the style still applies.

<!-- generated:node-style -->

| Key | Value | Meaning |
| --- | --- | --- |
| `color` | `string` | "#rrggbb" |
| `size` | `number` | Diameter, world px (1–400) |
| `shape` | `"circle" \| "square" \| "rounded" \| "diamond" \| "hexagon" \| "ring" \| "tile"` |  |
| `stroke` | `string` | A border's colour, "#rrggbb" |
| `strokeWidth` | `number` | The border's width, world px (0–100; default: the node option `strokeWidth`) |
| `icon` | `string \| { width: number, height: number }` | An image drawn in the node: a URL, or an image already in hand (an HTMLImageElement, ImageBitmap, canvas…; only a URL survives toJSON) |
| `badge` | `string` | Up to 12 characters in a pill at the node's top right ("!", "new"); top left when the node is collapsed (its "+N" takes the right) |

<!-- /generated:node-style -->

- **Icons** are loaded once per URL (with CORS) and shared by every view on the page. Until one is in, the node
  shows its fill. They're clipped to the node's shape (`iconFit`: cover or contain), and appear once the node is 8 CSS
  px across on screen (fully by 12). A `tile` node is a rounded square that _is_ its icon, like an
  item in a game's inventory.
- **Badges** sit in a pill at the node's top right. A collapsed node's fold mark ("+N", N nodes hidden below it)
  takes the right, and the badge moves to the left.

**Edge style** (`edges[].style`):

<!-- generated:edge-style -->

| Key | Value | Meaning |
| --- | --- | --- |
| `color` | `string` | "#rrggbb" |
| `width` | `number` | World px (0.1–40) |

<!-- /generated:edge-style -->

**Records are frozen.** `model.nodes`, `model.edges` and every record, style and data in them are frozen, and `data`
is the model's own copy (the caller's objects are never frozen or shared). A model changes only through its own
methods.

### Creating one

`new GraphModel(input?, options?)` reads JSON (or another model's graph). `GraphModel.from(input, options?)` does the
same, but returns `input` itself when it's already a model.

<!-- generated:model-options -->

| Option | Type | Meaning |
| --- | --- | --- |
| `node` | `Partial<NodeOptions>` | Node appearance: NODE_OPTIONS (size, shape, colours, labels and their size…) |
| `edge` | `Partial<EdgeOptions>` | Edge appearance: EDGE_OPTIONS |
| `measure` | `(text: string, size: number) => number` | A label's width at a font size; a renderer supplies a real one when a controller connects them (until then, an estimate) |
| `strict` | `boolean` | Throw on the first problem instead of listing it in `issues` |
| `onError` | `(error: unknown, change: Change \| null) => void` | Hears an error thrown by a listener (or by a queued change); without it, errors go to console.error. Never rethrown: the model stays committed. |

<!-- /generated:model-options -->

**Explicit options.** `model.explicit` (`{ node, edge }`, sets of keys) lists the options set on purpose: given to the
constructor or to `setOptions`. Everything else is a default, and a view may show its own default in its place: the
merged tree draws curves unless the edge `shape` was set on purpose (see `edgeDefaults` under [Layouts](#layouts)).
Setting an option to its default value still makes it explicit.

### Reading it

| Member                                | What it is                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `nodes`, `edges`                      | The records, in order (a node's index is its position), frozen. A list read once stays as it was.                |
| `size`                                | How many nodes.                                                                                                  |
| `node(id)`, `edge(id)`                | A record by id (a number id is read as a string), or undefined.                                                  |
| `index`, `edgeIndex`                  | Maps from id to index, kept up to date in place.                                                                 |
| `meta`                                | The graph's `meta`, frozen.                                                                                      |
| `opts`                                | `{ node, edge }`: the resolved node and edge options.                                                            |
| `explicit`                            | `{ node, edge }`: the option keys set on purpose (above).                                                        |
| `issues`                              | The problems found by the latest load or change (below).                                                         |
| `version`                             | Bumped by every change.                                                                                          |
| `structureVersion`                    | Bumped when nodes or edges come, go or move.                                                                     |
| `adjacency()`                         | The structure as flat typed arrays (compressed sparse rows): `source`, `target` per edge; `outStart`/`outEdges` and `inStart`/`inEdges` per node. Read, don't write. |
| `outgoing`, `incoming`, `ends`        | The same as arrays of arrays: per node its edges out and in, per edge `[source index, target index]`.           |
| `forest()`                            | The graph read as a forest, breadth first from every node nothing points to: `roots`, `order`, `parent`, `children`, `depth`, `leaves`, `descendants`, `tree` (per edge, 1 for a tree edge), `maxDepth`. |
| `dag()`                               | The graph read as a DAG: `back` (per edge, 1 where it closes a cycle), a topological `order`, each node's `longest` path from a source, `sources`, `sinks`. |
| `stats()`                             | `nodes`, `edges`, `roots`, `depth`, `layers`, `crossLinks`, `sharedNodes`, `maxInDegree`, `maxOutDegree`, `backEdges`, `issues`. |
| `toJSON()`                            | prismatrix-graph JSON. `GraphModel.from(model.toJSON())` gives an equal model.                                   |
| `labelWidths()`, `labelHeight`        | Each node's label width (each distinct label measured once, cut to `labelMaxWidth`), and one line's height.      |
| `measure`, `measured`, `setMeasure(fn)` | How labels are measured; whether that's real text measurement; measure with `fn` from now on (labels are measured again). |

Everything worked out from the structure (adjacency, forest, DAG, stats) is worked out when first asked for and kept
until the structure changes.

### Changing it

- **`update(delta)`** applies a delta: removals first (a removed node takes its edges), then changes, then additions
  (appended in the order given). It costs what it changes: a change of data or style touches only those records.
- **`replace(input)`** makes the model hold a whole new version (JSON or a model), in its order. Nodes and edges that
  are the same as before keep their records: nothing is copied, checked or measured again. It works out the delta
  itself.
- **`setOptions({ node, edge }, { reset }?)`** changes the node and edge options, all or some: given keys are merged
  over what's set. Numbers out of range are clamped; unknown keys and bad values are reported (`bad-option`). With
  `reset: true` the options become exactly what's given over the defaults, and only those keys are explicit.

Each returns the [Change](#change), or null when nothing changed (or when it was called from inside a listener: see
below). Anything in a delta that doesn't fit (a change to a node that isn't there, an edge to a missing node) is
skipped and listed in the change's issues.

<!-- generated:delta -->

| Field | Type | Meaning |
| --- | --- | --- |
| `addNodes` | `NodeJSON \| Iterable<NodeJSON>` | New nodes, as in the JSON format |
| `removeNodes` | `string \| number \| Iterable<string \| number>` | Ids (their edges go too) |
| `changeNodes` | `NodeChange \| Iterable<NodeChange>` | `{ id, label?, style?, data? }`: the fields given replace the node's own |
| `addEdges` | `EdgeJSON \| Iterable<EdgeJSON>` | New edges, as in the JSON format |
| `removeEdges` | `string \| number \| Iterable<string \| number>` | Ids |
| `changeEdges` | `EdgeChange \| Iterable<EdgeChange>` | `{ id, label?, style?, data? }` |

<!-- /generated:delta -->

### Change

What a listener hears, and what `update`, `replace` and `setOptions` return.

<!-- generated:change -->

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `number` | The model's version after the change |
| `structure` | `boolean` | Nodes or edges came, went or were reordered: lay out again |
| `sizes` | `boolean` | Something changed how much room a node takes (a shown label, a size, a shape) |
| `looks` | `boolean` | Anything that's drawn changed (false for a change of data only) |
| `dataOnly` | `boolean` | Only `data` (or the graph's `meta`) changed: nothing is drawn differently and nothing moves, so a view only needs the new records (no layout, no restyle) |
| `nodesAdded` | `string[]` |  |
| `nodesRemoved` | `string[]` |  |
| `nodesChanged` | `string[]` | Every kept node with a new record (label, style or data), in node order |
| `nodesRestyled` | `string[]` | The part of nodesChanged whose label or style changed (what's drawn) |
| `edgesAdded` | `string[]` |  |
| `edgesRemoved` | `string[]` |  |
| `edgesChanged` | `string[]` | Every kept edge with a new record (label, style or data), in edge order |
| `edgesRestyled` | `string[]` | The part of edgesChanged whose label or style changed |
| `options` | `{ node: Partial<NodeOptions>, edge: Partial<EdgeOptions> }` | For setOptions: the options that changed, with their new values |
| `issues` | `Issue[]` | Problems in this change (left out, never fixed silently) |

<!-- /generated:change -->

How a controller takes each change: `dataOnly` costs nothing (no layout, no frame; a `graphData` event); a change of
looks restyles just the nodes and edges named (`graphRestyle`); `sizes` or `structure` lays out again, and new or
removed nodes morph (`graph`, then `laidOut`).

### Listening

**`onChange(listener)`** calls `listener(change, model)` on every change and returns a function that stops it. Every
listener hears every change, in order, each with the model as that change left it. A listener that throws doesn't
stop the others: the error goes to `onError` (or the console), and the model stays committed. A change asked for
from inside a listener (an `update` in reply to another) waits until every listener has heard the current one, then is
applied and told in its turn; the call itself returns null.

### Issues

Problems are reported, never hidden or fixed silently. Each is `{ kind, message, id? }`, in `model.issues` (for the
latest load or change) and in the change; a controller sends each as a `graphIssue` event. `new GraphModel(input,
{ strict: true })` throws on the first problem instead, and leaves the model as it was.

| Kind                | What happened                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `missing-id`        | A node with no id, or one that isn't a non-empty string or a number. It's left out.                         |
| `duplicate-node`    | A second node with an id already used (the first is kept), or an added node that's already there.          |
| `missing-endpoint`  | An edge naming a node that isn't there. It's left out.                                                     |
| `self-loop`         | An edge from a node to itself. It's left out.                                                              |
| `bad-id`            | An edge's own id that isn't a non-empty string or a number: one is made for it.                            |
| `duplicate-edge-id` | Two edges with the same id: the second is renamed (`id#n`).                                                |
| `missing-node`      | A delta removes or changes a node that isn't there. That part is skipped.                                  |
| `missing-edge`      | A delta removes or changes an edge that isn't there. That part is skipped.                                 |
| `bad-style`         | An unknown style key or an invalid value (with the closest known key, if it looks like a typo). Left out; the rest of the style applies. |
| `bad-option`        | A node or edge option that's unknown (with a suggestion), invalid (its default is used) or out of range (clamped). Each message once per model. |
| `bad-input`         | A graph that isn't an object, nodes or edges that aren't arrays, a delta that isn't an object, an unknown delta field, or a field of the wrong kind. Ignored. |

Options given to a controller (layout, physics, animation) are checked the same way, but reported once per message on
the console (`console.warn`) rather than as issues.

## GraphController

### Creating one

`new GraphController(model, renderer?, options?)`. `model` is a `GraphModel` (or JSON, made into one); `renderer` is
the screen (`null` runs headless). The renderer comes first: it brings the viewport's size and real text measurement
(which becomes the model's, unless the model was given its own `measure`), so the first layout uses both.

<!-- generated:controller-options -->

| Option | Type | Meaning |
| --- | --- | --- |
| `layout` | `LayoutName` | "tree" (the default), "merged" or "radial" (see LAYOUTS) |
| `layoutOptions` | `LayoutOptions` | The layout's options, all or some |
| `physics` | `PhysicsMode` | "static" (the default), "elastic" or "floating": what the layout offers (LAYOUTS[layout].physics; a mode it doesn't offer is "static") |
| `physicsOptions` | `PhysicsOptions` | The mode's options, all or some |
| `animation` | `Partial<AnimationOptions>` | ANIMATION_OPTIONS, all or some |
| `onEvent` | `(type: keyof ControllerEvents, detail?: any) => void` | Every event (see `on` for one type at a time) |
| `onFrame` | `(stats: FrameStats) => void` | After every drawn frame (the renderer calls it) |
| `onChange` | `() => void` | Something changed that needs a tick (renderers wake their frame loop) |
| `clock` | `() => number` | The time now, ms (for changes made between ticks) |
| `worker` | `boolean \| "auto"` | Where layouts run: "auto" (the default) in a worker for big graphs, true always in a worker, false always on the page's thread (see layouter.js) |
| `workerUrl` | `string \| URL` | Where the layout worker's script is, for bundlers that don't follow `new URL("./layout-worker.js", import.meta.url)` (a module worker running layout-worker.js) |
| `wheel` | `"auto" \| "zoom" \| "pan"` | What a plain wheel or two-finger scroll does: "auto" (the default) zooms with a mouse wheel and pans with a trackpad; a pinch (ctrl+wheel) always zooms |
| `tapSelects` | `boolean` | A tap selects the node under it (shift, ctrl or cmd: adds or removes it) and a tap on empty space clears the selection (default true) |
| `depth` | `number \| null` | Progressive disclosure: show this many levels below the roots and collapse the rest (0: just the roots; null, the default: everything). Applies to the first graph, to `setModel`, and to a graph that shares no nodes with the one before (`setGraph` with a different graph) |
| `doubleTapToggles` | `boolean` | A double tap on a node expands or collapses it (default false: a double tap is only reported, so an app can give it its own meaning) |
| `theme` | `ThemeInput` | The colours the engine picks itself (see theme.js; default "dark") |

<!-- /generated:controller-options -->

An unknown layout name throws. Out-of-range and misspelt layout, physics and animation options are clamped or
replaced by their defaults, with a console warning.

### Settings

Every setter merges: the options given change, the rest stay as they are. Options belong to one layout or physics
mode, so switching to a different layout or mode starts from its own defaults.

| Method                         | What it does                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `setLayout(name, options?)`    | Lay out with layout `name` and its options. A new layout is framed (the camera glides to fit it); the physics mode carries over if the new layout offers it (else `static`), with its options back at that layout's defaults. Same layout: options merge. An unknown name throws. Sends `layout`. |
| `setPhysics(mode?, options?)`  | Move with physics `mode` (`null` or omitted: the current one, to change options only). A mode the layout doesn't offer throws and changes nothing. Changing to any mode but floating sends nodes gliding home; coming into floating, the graph floats off from where it is. Sends `physics`. |
| `setAnimation(options)`        | How the view moves between states. Sends `animation`.                                                          |
| `setNodeStyle(options)`        | The model's node options (`model.setOptions({ node })`): every view of the model changes. Sends `nodeStyle`.    |
| `setEdgeStyle(options)`        | The model's edge options. Sends `edgeStyle`.                                                                   |
| `setTheme(theme)`              | The colours the engine picks itself (see [Themes](#themes)). Returns the resolved theme. Sends `theme`.        |
| `reset()`                      | Send every node back to its home (a node being dragged is let go first). Sends `reset`.                        |

What's in effect: `layout`, `layoutOpts`, `mode` (the physics mode), `modeOpts`, `anim`, `theme`, and the getters
`node` (the model's node options) and `edge` (the model's edge options with the layout's `edgeDefaults` for any key
that wasn't set on purpose). An edge's own style wins, then an edge option set on purpose, then the layout's
default, then `EDGE_OPTIONS`' default.

### The graph shown

| Member                 | What it does                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `model`                | The `GraphModel` shown.                                                                                   |
| `update(delta)`        | `model.update(delta)`.                                                                                    |
| `setGraph(input)`      | `model.replace(input)`: unchanged nodes are reused, kept nodes glide to their new places.                |
| `setModel(model)`      | Show a different model (or JSON): its nodes glide from where the same ids were. The `depth` option applies again. |
| `setRenderer(renderer)`| Draw on another renderer from now on (`null`: none). Its text measurement becomes the model's, unless the model has its own. Sends `renderer`. |
| `destroy()`            | Stop listening to the model, let go of the renderer and stop the layout worker.                           |

The controller also keeps a working graph (`graph`: the shown part of the model with every node's position,
velocity and home) and builds what to draw each frame (`scene`). Both are internal and may change.

### Camera

The camera is `{ x, y, k }` (`camera`): the world point at the middle of the view, and the scale (CSS px per world
px). Canvas points are CSS px from the canvas's top-left corner.

| Method                          | What it does                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fit(animate = true)`           | Frame the graph where it's heading (40 px clear round it, zoomed in at most 2.5×). While a layout is on its way, the graph it brings is framed when it lands. Sends `fit`. |
| `focus(id, { zoom?, animate? })`| Bring node `id` to the middle, following it if it moves. `zoom` defaults to the current scale but at least 1. A hidden node is revealed first; one still being laid out is focused once it's in. Returns false for an id the model doesn't have. Sends `focus`. |
| `zoomBy(factor, x?, y?)`        | Zoom about a canvas point (default: the middle), keeping the world point under it in place: for zoom buttons. |
| `zoomLimits()`                  | `{ min, max }`: in to 8×, out to 0.05× or further if that's what it takes to see the whole graph (half its fit). |
| `toWorld(x, y)`, `toScreen(x, y)` | Between canvas and world coordinates.                                                                 |
| `setViewport(width, height, dpr?)` | The drawing area's size in CSS px (a renderer calls this; headless, call it yourself). A view showing a framing it chose itself frames again. |

The camera frames the first graph, and frames each new layout while it's showing a framing it chose (a `fit`, a new
layout); once the user pans or zooms, it holds still instead, on the node that's dragged, hovered, selected or
focused, or else the one nearest the middle, so that node stays put on screen while everything else moves.

### Selection

`select(ids, { add?, toggle? })` selects node `ids` (one id, a list, or null for none) in place of the selection; with
`add`, as well as it; with `toggle`, flipping each in or out. Ids the model doesn't have are skipped. It returns
whether the selection changed and sends `select`. `selected` is the selected ids, in the order they were selected.
With `tapSelects` (the default), taps select: shift, ctrl or cmd adds or removes a node, and a tap on empty space
clears the selection. Selected nodes get a halo and keep their lineage lit; a node that leaves the model leaves the
selection (one only folded away stays selected).

### Expand and collapse

Collapsing is view state: the model keeps every node. A node is hidden when every path to it from a root passes
through a collapsed node, so a shared ingredient stays while any recipe showing it is open. Expanding grows the new
nodes out of the node opened; collapsing folds them back into it; the camera holds still on that node. Every call
returns whether anything changed and sends `expand` or `collapse`.

| Method                          | What it does                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `collapse(id)`                  | Fold what's below node `id` (and not shown through another path) into it. A leaf can't be collapsed.  |
| `expand(id, { depth = 1 })`     | Show `depth` levels below node `id` (Infinity: everything below it). Nodes those levels bring in that lead on to more start collapsed, so one expand never spills a whole subtree. |
| `toggle(id)`                    | Expand if collapsed, else collapse.                                                                     |
| `expandAll()`                   | Show everything.                                                                                        |
| `collapseTo(depth)`             | Show `depth` levels below the roots (0: just the roots) and collapse everything deeper.                 |
| `reveal(id)`                    | Open the collapsed nodes on node `id`'s path from a root (only the path opens). False when it's shown already or not in the model. |
| `isCollapsed(id)`, `isHidden(id)` | Whether a node is collapsed; whether it's in the model but folded away.                               |
| `hiddenCount(id)`               | How many nodes are hidden below a shown, collapsed node: what its "+N" badge shows.                     |
| `collapsed`                     | The collapsed ids.                                                                                       |

Set `doubleTapToggles` to expand and collapse on a double tap, and `depth` to start with only the top levels.

### Waiting for layouts

Small graphs lay out on the spot. Graphs of `WORKER_MIN` (2,000) nodes or more lay out in a worker while the graph
on screen carries on (`layoutPending` is true meanwhile), and the new layout morphs in when it lands; only the newest
layout asked for is used.

- **`laidOut()`** resolves once the newest layout is in place: `graph`, `fit()` and `snapshot()` then see the graph
  as the model has it. At once when nothing is being laid out; it rejects if that layout fails.
- **`settled()`** resolves once the view has come to rest: the layout in place, the morph, camera moves, fade-ins
  and folding ghosts done, nothing held, physics asleep (a graph that drifts forever counts once everything else is
  done). It's ticks that move things on: with a renderer, the frame loop; headless, whoever calls `tick`. A
  `settled` event is sent at the same moment.

### Snapshots

`snapshot(note?)` returns everything needed to show the view again exactly: the graph, settings, camera, selection,
collapsed nodes and every shown node's layout state (prismatrix-snapshot JSON). `restore(snapshot)` shows one again,
as it was, without a morph (the renderer isn't restored: it depends on the machine), and sends `restore`; it throws
on anything that isn't a snapshot this engine can read. `snapshotModel(snapshot)` checks one and returns its graph as
a model. Only the node and edge options set on purpose (`settings.explicit`) are set again, so a layout's own defaults
still apply to the rest; an older snapshot without that list sets them all.

<!-- generated:snapshot -->

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | `"prismatrix-snapshot"` |  |
| `version` | `number` |  |
| `time` | `string` | When it was taken (ISO 8601) |
| `note` | `string` | Why it was taken |
| `graph` | `GraphJSON` |  |
| `stats` | `Record<string, number>` | What the model said about the graph (GraphModel.stats) |
| `issues` | `Issue[]` |  |
| `settings` | `SnapshotSettings` |  |
| `camera` | `Camera` |  |
| `selection` | `string[]` | The selected node ids, in the order they were selected |
| `collapsed` | `string[]` | The collapsed node ids |
| `state` | `Record<string, NodeState>` | Every shown node's layout state, by id |

<!-- /generated:snapshot -->

`settings`:

<!-- generated:snapshot-settings -->

| Field | Type | Meaning |
| --- | --- | --- |
| `layout` | `LayoutName` |  |
| `layoutOptions` | `Record<string, any>` |  |
| `physics` | `PhysicsMode` |  |
| `physicsOptions` | `Record<string, any>` |  |
| `node` | `NodeOptions` |  |
| `edge` | `EdgeOptions` | The edge options shown (with the layout's own defaults) |
| `explicit` | `{ node: string[], edge: string[] }` | The node and edge options set on purpose (the rest are defaults: restore sets only these again, so a layout's own defaults still apply to the rest) |
| `animation` | `AnimationOptions` |  |
| `renderer` | `string` | "webgl" or "canvas" (not restored: it depends on the machine) |

<!-- /generated:snapshot-settings -->

### Input and time

A renderer turns DOM events into these calls and runs the frame loop; headless code (tests) and custom renderers call
them directly. Every pointer is tracked by its id: the first one down drags the node under it or pans; a second turns
the two into a pinch; more are ignored until those lift. A press that doesn't wander (10 CSS px for touch, 6 for a
pen, 5 for a mouse) is a tap, two within 300 ms and 24 px a double tap, and one held still for 500 ms a long press
(its release isn't a tap). The secondary mouse button is left to the page.

| Member                                   | What it does                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pointerDown(input)`                     | A press at a canvas point: grabs the node there or starts a pan; a second pointer pinches.     |
| `pointerMove(input)`                     | A pressed pointer drags, pans or pinches; one that isn't pressed hovers.                       |
| `pointerUp(input?)`                      | The press ended: a dragged node is let go (thrown, if it was moving), a pan glides on; a tap or double tap is reported. |
| `pointerCancel(input?)`                  | The press was taken away: like a release, but nothing is thrown and it's never a tap.          |
| `pointerLeave(input?)`                   | The pointer left the canvas: no more hover.                                                    |
| `wheel(input)`                           | A wheel or trackpad: zooms or pans (the `wheel` option); lines and pages are turned into pixels first. |
| `doubleClick({ x, y })`                  | On empty space, frame the graph (for input that has its own double clicks).                    |
| `hit(point, { references? })`            | The topmost node under a world point (an index into `graph`), or -1; with `references`, a reference chip counts as its ingredient. |
| `cursor`                                 | What the pointer should look like: `"grab"`, `"grabbing"`, `"default"` or `""`.                |
| `pointers`, `pointer`, `pinch`           | Pressed pointers by id; the one dragging or panning (or null); the pinch (or null).            |
| `tick(now)`                              | Advance everything to `now` (ms) and build `scene`. Returns a TickResult (below).              |
| `run(ms, { start?, step? })`             | Tick from `start` to `start + ms`, `step` ms at a time (default 60 a second). Returns the last TickResult. |
| `rest()`                                 | Nothing more to do for now: the next tick starts timing afresh.                                |

`PointerInput`:

<!-- generated:pointer-input -->

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `number` | The pointer's id (each finger has its own) |
| `x` | `number` | CSS px from the canvas's left |
| `y` | `number` |  |
| `time` | `number` | Ms, on the controller's clock |
| `pointerType` | `string` | "mouse", "touch" or "pen" |
| `button` | `number` | Which button pressed (2, the secondary, is left to the page) |
| `shiftKey` | `boolean` |  |
| `ctrlKey` | `boolean` |  |
| `metaKey` | `boolean` |  |

<!-- /generated:pointer-input -->

`WheelInput`:

<!-- generated:wheel-input -->

| Field | Type | Meaning |
| --- | --- | --- |
| `x` | `number` |  |
| `y` | `number` |  |
| `deltaX` | `number` |  |
| `deltaY` | `number` |  |
| `deltaMode` | `number` | 0 px, 1 lines, 2 pages |
| `ctrlKey` | `boolean` | A trackpad pinch (or ctrl held) |
| `wheelDeltaY` | `number` | The legacy delta (Chrome, Safari), which tells a wheel from a trackpad |
| `time` | `number` |  |

<!-- /generated:wheel-input -->

`TickResult`:

<!-- generated:tick-result -->

| Field | Type | Meaning |
| --- | --- | --- |
| `busy` | `boolean` | Something is still moving or fading: keep ticking |
| `gap` | `number` | Seconds since the last tick, unclamped (0 for the first after a rest) |
| `simMs` | `number` | Wall time spent moving nodes this tick (morph and physics), ms |
| `energy` | `number` | Mean squared node speed |
| `state` | `string` | "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest" |

<!-- /generated:tick-result -->

## Events

`on(type, listener)` calls `listener(detail)` on every event of `type` and returns a function that stops it; the
`onEvent(type, detail)` option hears every event. A listener that throws is reported on the console and never stops
the controller mid-change.

<!-- generated:events -->

| Event | Detail | When |
| --- | --- | --- |
| `graph` | `GraphDetail` | A graph was shown, or nodes or edges came or went |
| `graphIssue` | `Issue` | A problem in the graph or a change to it (one per problem) |
| `graphData` | `{ nodes: number, edges: number }` | Only data changed: nothing is drawn differently |
| `graphRestyle` | `{ nodes: number, edges: number }` | Nodes' or edges' labels or styles changed |
| `nodeStyle` | `Partial<NodeOptions>` | Node options changed: the new values |
| `edgeStyle` | `Partial<EdgeOptions>` | Edge options changed: the new values |
| `layout` | `{ layout: LayoutName } & Record<string, any>` | The layout changed (setLayout): it, and all its options |
| `physics` | `{ mode: PhysicsMode } & Record<string, any>` | The physics changed (setPhysics): the mode, and all its options |
| `animation` | `AnimationOptions` | The animation options changed (setAnimation): all of them |
| `theme` | `{ name: string }` | The theme changed (setTheme): "dark", "light" or "custom" |
| `renderer` | `{ renderer: string }` | The renderer changed (setRenderer): "webgl" or "canvas" |
| `reset` | `undefined` | Everything is going back to its home (reset) |
| `restore` | `{ nodes: number, time: string }` | A snapshot is shown (restore): its node count and time |
| `laidOut` | `{ layout: LayoutName, nodes: number, edges: number }` | A layout is in place |
| `settled` | `{ nodes: number }` | The view has come to rest (see `settled()`) |
| `fit` | `{ k: number, pending?: boolean }` | The camera frames the graph (pending: a layout is on its way, and another "fit" follows when it lands) |
| `focus` | `{ node: string, k: number }` | The camera is on its way to a node |
| `select` | `{ selected: string[] }` | The selection changed |
| `expand` | `DisclosureDetail` | Nodes were expanded (expand, expandAll, reveal) |
| `collapse` | `DisclosureDetail` | Nodes were collapsed (collapse, collapseTo) |
| `hoverEnter` | `{ node: string, reference: boolean }` | The pointer is over a node (or one of its chips) |
| `hoverLeave` | `{ node: string }` | The pointer left it |
| `tap` | `PointDetail` | A press that didn't wander (with `tapSelects`, it also selects) |
| `doubleTap` | `PointDetail` | The second of two quick taps in about the same place |
| `longPress` | `PointDetail` | A press held still for half a second (its release isn't a tap) |
| `dragStart` | `{ node: string, carried: number }` | A node is being dragged (`carried`: it and its subtree) |
| `dragEnd` | `{ node: string, thrown: boolean, screenSpeed: number, cancelled?: boolean }` | The drag ended: whether the node was thrown (and how fast, screen px/s), or the drag was cancelled (a pinch began, the node left) |
| `panStart` | `{ x: number, y: number }` | A pan began: where it started, CSS px |
| `panEnd` | `{ node?: undefined, thrown: boolean, screenSpeed: number, cancelled?: boolean }` | The pan ended (thrown: the camera glides on) |
| `pinchStart` | `{ k: number }` | Two pointers are zooming: the scale they started at |
| `pinchEnd` | `{ k: number }` | The pinch ended: the scale it left |
| `error` | `{ message: string }` | A layout failed, or the layout worker was given up on |

<!-- /generated:events -->

A tap, double tap or long press (`PointDetail`):

<!-- generated:point-detail -->

| Field | Type | Meaning |
| --- | --- | --- |
| `node` | `string \| null` | The node's id, or null for empty space |
| `reference` | `boolean` | The node was found through one of its reference chips |
| `x` | `number` | CSS px from the canvas's left |
| `y` | `number` |  |
| `world` | `{ x: number, y: number }` | The same point in world coordinates |
| `pointerType` | `string` | "mouse", "touch" or "pen" |

<!-- /generated:point-detail -->

A `graph` event (`GraphDetail`; `stats` walks the whole graph, so it's worked out only if read):

<!-- generated:graph-detail -->

| Field | Type | Meaning |
| --- | --- | --- |
| `nodes` | `number` | In the model |
| `edges` | `number` |  |
| `added` | `number` | Nodes added (after a change; absent for a first graph) |
| `removed` | `number` | Nodes removed |
| `issues` | `number` | Problems found (see `graphIssue`) |
| `stats` | `ReturnType<GraphModel["stats"]>` | The model's shape (roots, depth, layers, cross-links…), worked out when first read |

<!-- /generated:graph-detail -->

An `expand` or `collapse` event (`DisclosureDetail`):

<!-- generated:disclosure-detail -->

| Field | Type | Meaning |
| --- | --- | --- |
| `node` | `string \| null` | The node expanded or collapsed (null: expandAll or collapseTo) |
| `depth` | `number` | Levels shown (expand, expandAll, collapseTo) |
| `reveal` | `boolean` | The expand opened the way to a node (reveal, focus) |
| `visible` | `number` | Nodes shown now |
| `hidden` | `number` | Nodes folded away now |

<!-- /generated:disclosure-detail -->

A double tap on empty space also frames the graph. A tap on a reference chip is a tap on its ingredient, with
`reference: true`: `view.on("tap", ({ node, reference }) => reference && view.focus(node))` flies to the real node.

## Renderers

`glRenderer(canvas, options?)` draws with WebGL2, or Canvas 2D where WebGL2 isn't available or fails to start (with a
console warning). `canvasRenderer(canvas, options?)` always draws with Canvas 2D: slower, but it works everywhere,
and it's the reference the WebGL painter is checked against. Both return a `Renderer`; hand it to a controller (the
constructor, or `setRenderer`).

<!-- generated:renderer-options -->

| Option | Type | Meaning |
| --- | --- | --- |
| `frameRate` | `"display" \| "uncapped"` | "display" (the default) draws once per screen refresh |

<!-- /generated:renderer-options -->

| Member                | What it does                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `name`                | `"webgl"` or `"canvas"`.                                                                                    |
| `setFrameRate(mode)`  | `"display"` (once per screen refresh) or `"uncapped"` (as fast as frames finish, for benchmarking; a hidden page still waits for the display). |
| `invalidate()`        | Draw a frame soon (the controller asks whenever something changes; frames stop once everything is at rest). |
| `measureText(text, size)` | A label's width at a font size, in the font labels are drawn in (`system-ui, sans-serif`).              |
| `dispose()`           | Let go of the controller and free what the painter holds (GPU buffers). The renderer can't be used again.   |

While attached to a controller, a renderer:

- follows the canvas's CSS size (a ResizeObserver) and the device pixel ratio;
- sets the canvas's `touch-action` to `none` (restored when it lets go), so the page doesn't scroll or zoom under a
  drag or pinch, captures each pointer, and keeps a touch's long press from opening the context menu;
- turns Safari's trackpad gesture events into zooms (other browsers send ctrl+wheel);
- sets the canvas's cursor from `controller.cursor` every frame;
- after each frame, calls the controller's `onFrame` with its `FrameStats`:

<!-- generated:frame-stats -->

| Field | Type | Meaning |
| --- | --- | --- |
| `fps` | `number` | Smoothed |
| `dt` | `number` | Seconds since the previous frame, unclamped (0 for the first after a rest) |
| `simMs` | `number` | Wall time spent moving nodes this frame (morph and physics), ms |
| `drawMs` | `number` | Time spent drawing this frame |
| `energy` | `number` | Mean squared node speed |
| `state` | `string` | "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest" |

<!-- /generated:frame-stats -->

**What's drawn.** Both painters draw the same scene: edges as one layer (so overlaps don't brighten), nodes with their
icons and borders, a halo round each selected node, and text. Every piece of text has a halo in the background
colour, so edges crossing it don't cut the letters. Node labels show while they're at least 2 CSS px tall on screen
(6 px with `labelCollide` off); edge labels while they're at least 6 px; badges and "×N" usage counts while they're at
least 5 px. The roots (when there are at most 12), the selection and the hovered node keep their labels at any zoom
(drawn at 10 px when they'd be smaller); the hovered node's label is shown whole, never cut short. Hovering a node
lights its lineage (everything it leads to and everything that leads to it) and dims the rest (`hoverDim`).

## Layouts

`LAYOUTS` lists them: for each, its `label`, `run(graph, options, sizing, hint)`, its `options` (a schema), the physics
modes it offers (`physics`: each with its own extra options and defaults) and, where it has them, `edgeDefaults`: edge
options it shows in place of `EDGE_OPTIONS`' defaults, for any key that wasn't set on purpose.

<!-- generated:layouts -->

| Layout | Name | Physics modes | Edge defaults |
| --- | --- | --- | --- |
| `tree` | Tree | `static`, `elastic` | none |
| `merged` | Merged tree | `static`, `elastic` | `shape`: `"curve"` |
| `radial` | Radial | `static`, `elastic`, `floating` | none |

<!-- /generated:layouts -->

Every layout places nodes by their real footprint (the node and, with `labelCollide`, its label) and keeps the node
option `collisionRadius` clear round each. Layouts are deterministic: the same graph and options always give the same
drawing, on the page or in the worker (they count work, never time).

**The layout hint.** When nodes come or go, the layout is given the layout before the change as a hint (each kept
node's old home, and for the merged tree its reference chips and the bends of its long edges), so a change moves only
what it has to: a tree moves as a whole so kept nodes stay put; a full-circle radial turns to match (it stays centred);
the merged tree also keeps its order and pulls kept nodes back to where they were (`stability`).

### tree

A tidy tree (Walker's algorithm in linear time) in any of four directions: subtrees pack as tightly as their outlines
allow, small ones between big ones are spread evenly, and every parent sits centred over its children. The forest is
the model's: breadth first from every node nothing points to, the first edge to reach a node being its tree edge; any
other edge into it is drawn as a cross-link.

<!-- generated:layout-tree -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `direction` | `"TB"` | `TB` (top → bottom), `BT` (bottom → top), `LR` (left → right), `RL` (right → left) | Which way the tree grows from its roots |
| `levelGap` | `90` | 20 – 300 | At least this far apart; more when labels need it. |
| `siblingGap` | `16` | 0 – 120 | Space between neighbours with the same parent. |
| `subtreeGap` | `28` | 0 – 200 | Space between neighbours with different parents, so separate branches read as separate. Separate trees get twice this. |
| `parentAlign` | `"centres"` | `centres` (its children's centres), `edges` (its children's whole span) | Centre a parent between its first and last child's centres (the classic tidy tree), or between their outer edges, which counts their labels too. |

<!-- /generated:layout-tree -->

### merged

A layered (Sugiyama) drawing for graphs with shared nodes: every shared ingredient appears once. Cycles are broken by
reversing back edges; nodes are put on layers (`ranking`), ordered along each layer to cut crossings (`ordering`), and
placed so long edges run straight (`placement`). An ingredient used by many recipes (`shareMin` or more) keeps one
edge, from a recipe a layer above it, and every other recipe that uses it gets a small reference chip under it
instead (`references`): the chip shows a link glyph, pointing at it lights up the ingredient, and the ingredient
shows "×N". With a hint, `stability` decides how firmly a change keeps everything else in place (0: laid out afresh,
then only moved into place). Edges are curves unless the edge `shape` was set on purpose.

<!-- generated:layout-merged -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `direction` | `"TB"` | `TB` (top → bottom), `BT` (bottom → top), `LR` (left → right), `RL` (right → left) | Which way the layers run from the sources |
| `levelGap` | `90` | 20 – 300 | At least this far apart; more when labels need it. |
| `nodeGap` | `16` | 0 – 120 | Space between neighbours on a layer. |
| `ranking` | `"longest"` | `longest` (by depth from the top), `simplex` (fewest long edges) | Fewest long edges lets a node sit lower, next to what it's made from. |
| `ordering` | `"sifting"` | `sifting` (global sifting), `barycenter` (faster) | How nodes are ordered along each layer to cut crossings. |
| `placement` | `"balanced"` | `balanced` (straight long edges), `median` | Where nodes sit along their layer: balanced keeps long edges straight (an exact L1 placement), median sits each node at the median of its neighbours |
| `references` | `"hubs"` | `hubs` (references under each user), `off` (long edges) | An ingredient used by many recipes keeps one edge, from a recipe just above it; every other recipe that uses it gets a small chip under it instead of an edge. |
| `shareMin` | `3` | 2 – 20 | How many recipes must use an ingredient before all but one get references. |
| `stability` | `0.5` | 0 – 1 | When the graph changes (a recipe expanded or collapsed), how firmly everything else keeps its place: the old order is kept and nodes are pulled back to where they were. At 0, every change is laid out afresh. |

<!-- /generated:layout-merged -->

The routing it returns (`routing`, see [Layout without a screen](#layout-without-a-screen)) has `kind: "layered"`,
the `direction`, `bends` (the points long edges pass through), `references`, `crossings`, `initialCrossings`,
`layerOf`, and with ranking "simplex", `simplex`: `{ pivots, optimal }` (how many exchanges the layering made, and
whether it reached the fewest long edges or stopped at its work budget, on very big graphs).

### radial

Depth is the ring: one root in the middle (several share the first ring round an empty centre). Rings are at least
`ringGap` apart and clear of each other's footprints.

<!-- generated:layout-radial -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `ringGap` | `80` | 20 – 300 | At least this far apart; more when nodes need the room. |
| `sweep` | `360` | 60 – 360 | How much of the circle the tree fans over. |
| `rotation` | `0` | -180 – 180 | Degrees the drawing is turned |
| `spacing` | `"tidy"` | `tidy` (compact), `leaves` (wedges by leaf count) | Tidy packs the tree in angle like a tidy tree: subtrees take only the angle they use, so the middle fills in. Wedges by leaf count is the classic rule. |

<!-- /generated:layout-radial -->

## Physics

Each layout offers some physics modes. Every mode has friction, which brings any motion to a full stop. `static` has
no forces: a dragged node goes where it's put (with its subtree, by default) and stays. `elastic` springs every node
to its home and holds every edge at its laid-out length: pull a node and its neighbours follow, let go and everything
springs back. `floating` pushes nodes apart and holds edges together, with only a faint memory of the layout, and
fades its forces out over its settle time. Physics gets at most 10 ms a frame: a big graph slows down rather than
lock up. Edges drawn as reference chips have no spring.

`PHYSICS` lists the modes and their options; `physicsSchema(layout, mode)` is a mode's full schema within a layout (its
own options, the layout's extras, and the layout's defaults), and throws for a mode the layout doesn't offer.

<!-- generated:physics -->

**static**

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `dragSubtree` | `true` | true / false | Dragging a node carries everything below it. |
| `fling` | `true` | true / false | A released node keeps the speed you threw it with. |
| `friction` | `5` | 0.5 – 30 | How quickly anything moving eases to a stop. |

**elastic**

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `anchor` | `50` | 0 – 200 | How hard each node is pulled back to its home. |
| `links` | `35` | 0 – 200 | How hard edges hold their laid-out length. |
| `friction` | `8` | 0.5 – 30 | How quickly anything moving eases to a stop. |
| `collide` | `true` | true / false | Nodes (and, with label collision on, their labels) push each other out of the way. |
| `fling` | `true` | true / false | A released node keeps the speed you threw it with. |

**floating**

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `repulsion` | `80` | 0 – 400 | How hard nodes push each other apart. |
| `links` | `25` | 0 – 200 | How hard edges hold their length |
| `linkLength` | `1` | 0.3 – 2.5 | Edge length relative to the layout's. |
| `memory` | `1` | 0 – 30 | A faint pull back to the layout; 0 forgets it. |
| `friction` | `3` | 0.5 – 30 | How quickly anything moving eases to a stop. |
| `settle` | `4` | 0.5 – 30 | Seconds the graph keeps rearranging after it's disturbed, before its forces fade and it eases to a stop. |
| `drift` | `0` | 0 – 60 | Gentle wandering. Above zero the graph never quite stops. |
| `collide` | `true` | true / false | Nodes (and, with label collision on, their labels) push each other out of the way. |
| `fling` | `true` | true / false | A released node keeps the speed you threw it with. |

**What each layout offers**

| Layout | Mode | Its own defaults | Its own options |
| --- | --- | --- | --- |
| `tree` | `static` | none | none |
| `tree` | `elastic` | `anchor` 60, `links` 40, `friction` 9 | `levelLock` (true / false, default false): Nodes only slide sideways along their level. |
| `merged` | `static` | none | none |
| `merged` | `elastic` | `anchor` 60, `links` 40, `friction` 9 | `levelLock` (true / false, default false): Nodes only slide sideways along their layer. |
| `radial` | `static` | none | none |
| `radial` | `elastic` | `anchor` 40, `links` 30, `friction` 7 | `ringLock` (true / false, default false): Nodes only slide around their ring. |
| `radial` | `floating` | none | none |

<!-- /generated:physics -->

## Animation

<!-- generated:animation-options -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `transition` | `650` | 0 – 2000 | How long nodes take to glide to a new layout: a new graph, a layout change, Reset. |
| `easing` | `"smooth"` | `smooth` (slow in and out), `out` (ease out (quick start, soft landing)), `back` (overshoot (a little past, then back)), `linear` | The curve morphs and camera moves follow (EASINGS) |
| `camera` | `650` | 0 – 2000 | How long the camera takes to frame the graph. |
| `enter` | `"grow"` | `grow` (out of their parent), `fade` (in where they land), `none` (appear at once) | How new nodes arrive: growing out of their parent, fading in where they land, or at once |
| `hoverFade` | `180` | 0 – 1000 | How long nodes and edges take to brighten or dim when the hover moves. |
| `hoverDim` | `0.75` | 0 – 1 | How far everything outside the hovered node's lineage fades: 0 not at all, 1 to nothing. |

<!-- /generated:animation-options -->

`EASINGS` maps each easing name to its curve (progress 0–1 in, eased progress out).

## Node and edge options

The model's options (`new GraphModel(json, { node, edge })`, `model.setOptions`, `view.setNodeStyle`,
`view.setEdgeStyle`). Each node's or edge's own `style` wins over them. A change to an option that decides how much
room a node takes (`shape`, `size`, `sizeBy`, `labels`, `labelSize`, `collisionRadius`, `labelCollide`,
`labelMaxWidth`) lays the graph out again; any other is a restyle.

**Node options** (`NODE_OPTIONS`):

<!-- generated:node-options -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `shape` | `"circle"` | `circle`, `square`, `rounded` (square), `diamond`, `hexagon`, `ring`, `tile` | Tile: a rounded square that is its icon (like an item in a game's inventory); its fill shows only until the icon is in, or when it has none. |
| `size` | `16` | 4 – 60 | Diameter, world px |
| `sizeBy` | `"uniform"` | `uniform`, `descendants` (subtree size), `depth` (shrink with depth) | Every node the same size, bigger with a bigger subtree, or smaller the deeper it is |
| `colorBy` | `"depth"` | `depth`, `branch`, `single` (one colour) | What picks a node's colour from the palette: its depth, or its branch (which of its root's children it's under); or one colour for all |
| `color` | `"#7aa2f7"` | "#rrggbb" | Used when colouring by one colour. |
| `outline` | `0` | 0 – 6 | A ring in the background colour round each node, px (0: none) |
| `strokeWidth` | `2` | 0 – 12 | How wide a node's border is drawn (inside its shape) when its style gives it a stroke colour. |
| `iconFit` | `"cover"` | `cover` (fill the shape), `contain` (fit inside) | How a node's icon sits in its shape: filling it (cropped to the shape) or whole inside it, the fill around it. |
| `labels` | `"below"` | `off`, `below`, `right`, `outward` | Outward points labels away from the layout's centre or root. |
| `labelSize` | `11` | 6 – 24 | Label text size, world px |
| `labelMaxWidth` | `160` | 0 – 400 | Longer labels are cut short with an ellipsis (shown whole on hover). 0: no limit. |
| `collisionRadius` | `4` | 0 – 60 | Clearance kept around every node: layouts leave it, and colliding nodes keep it. |
| `labelCollide` | `true` | true / false | Labels take up room too: layouts make space for them and collisions push them apart, so they never overlap and never need hiding. |

<!-- /generated:node-options -->

**Edge options** (`EDGE_OPTIONS`):

<!-- generated:edge-options -->

| Option | Default | Values | What it does |
| --- | --- | --- | --- |
| `shape` | `"step"` | `straight`, `step`, `fan`, `curve` | Step bends around the layout: right angles in a tree, ring arcs in a radial. Fan leaves the parent along the layout's axis, then goes straight to the child. Curve flows from the parent to the child along the layout's axis or spokes. |
| `corner` | `8` | 0 – 40 | Rounds a step edge's bends. |
| `width` | `1.5` | 0.25 – 8 | World px |
| `taper` | `false` | true / false | Thick at the parent, thin at the child. |
| `colorBy` | `"single"` | `single` (one colour), `target` (child's colour) | Every edge in one colour, or each in its child's colour |
| `color` | `"#5b6478"` | "#rrggbb" | "#rrggbb", when edges are one colour |
| `opacity` | `0.8` | 0.05 – 1 | Edges are drawn as one layer at this opacity, so overlaps don't brighten |
| `arrow` | `"none"` | `none`, `arrow`, `dot` | What an edge ends in at its target |
| `arrowSize` | `6` | 2 – 16 | The end's size, world px |
| `labels` | `"target"` | `off`, `target` (near the target), `middle` | Where an edge's own label (a quantity, say) is drawn. Shown once zoomed in far enough to read. |

<!-- /generated:edge-options -->

## Themes

A theme is the colours the engine picks itself: the background, label text and its halo, the default node and edge
colours, a root's colour when colouring by branch, and the palette (colours by depth or branch). A graph's own colours
(node and edge `color`, `stroke`) are the app's and never change with the theme; node and edge `color` options left
at their defaults follow it.

`theme` (the controller option) and `setTheme(theme)` take `"dark"` (the default), `"light"`, or an object of tokens
over a preset: `{ base: "light", background: "#ffffff", palette: [...] }` (`base` defaults to dark). Unknown names,
unknown tokens and colours that aren't `"#rrggbb"` are left out with a console warning. `resolveTheme(input)` gives
the complete theme; `THEMES` holds the presets (every preset palette colour has at least 4:1 WCAG 2 contrast against
its background).

<!-- generated:themes -->

| Token | `dark` | `light` | What it colours |
| --- | --- | --- | --- |
| `name` | `dark` | `light` | "dark", "light" or "custom" |
| `background` | `#0e1016` | `#f6f7f9` | Behind everything; also inside rings and in node outlines |
| `text` | `#d5d9e4` | `#1f2430` | Label text |
| `textHalo` | `#0e1016` | `#f6f7f9` | A halo behind label text, for painters that draw one (usually the background) |
| `edge` | `#5b6478` | `#808899` | Edges, when the edge `color` option is left at its default |
| `node` | `#7aa2f7` | `#2f5fd0` | Nodes coloured by one colour, when the node `color` option is left at its default |
| `root` | `#e6e9f2` | `#1f2430` | A root's colour when colouring by branch |
| `palette` | `#f6c177` `#7aa2f7` `#9ece6a` `#e27e8d` `#bb9af7` `#5ccfe6` `#ff9e64` `#c0caf5` | `#b5650d` `#2f5fd0` `#3f7d20` `#c2364f` `#7a4fd6` `#0b7a91` `#c4520f` `#5a6378` | Colours by depth or branch, then wrapping |

<!-- /generated:themes -->

## Option schemas

Every option list (`NODE_OPTIONS`, `EDGE_OPTIONS`, `ANIMATION_OPTIONS`, each layout's `options`, each physics mode's)
is a schema: a list of `OptionSpec`s, `{ key, label, type, default, min?, max?, step?, choices?, hint? }`, where
`type` is `"range"`, `"select"`, `"bool"` or `"color"`. A UI can build its controls from them (the sandbox does).

- **`resolve(schema, values?, warn?)`** returns every key of the schema: from `values` where usable, else the
  default. A number outside its range is clamped; anything else unusable (a wrong type, a choice that isn't one)
  takes the default; unknown keys are dropped. Each of those is reported to `warn(message)` (by default once per
  message on the console), with the closest known key or choice when one is close (a typo). `resolve(schema)` alone
  is the defaults.

## Layout without a screen

`prismatrix/layout` lays graphs out with no renderer, no controller and nothing that needs a DOM: for a worker,
a build step or a tool. It runs the same code a controller runs, sized the same way, so the homes are the ones a view
would show.

```js
import { layoutGraph } from "prismatrix/layout";

const { positions, routing, model } = layoutGraph(json, {
  layout: "merged",
  layoutOptions: { direction: "LR" },
  node: { labelSize: 12 }, // sizes, shapes and labels decide how much room each node takes
  measure: (text, size) => myFont.width(text) * size, // default: an estimate for a sans-serif face
});
positions.get("mjolnir"); // { x, y }, world px
```

`layoutGraph(input, options?)` takes JSON or a model (a model brings its own node options and measurement) and
returns `positions` (every node's home, by id), `routing` (how edges bend: its `kind`, the tree's `direction` or the
radial's centre `cx`, `cy`, and for the merged tree `bends` as `{ edges, start, xy }` and `references`, edges by their
index in `model.edges` and nodes by theirs in `model.nodes`) and the `model`. The entry also exports `GraphModel`, `GRAPH_FORMAT`, `GRAPH_VERSION`,
`LAYOUTS`, `NODE_OPTIONS`, `EDGE_OPTIONS` and `resolve`.

## Performance

- **Layouts in a worker.** Graphs of `WORKER_MIN` (2,000) nodes or more lay out in a module worker
  (`src/layout-worker.js`); the page keeps drawing and taking input meanwhile. Quick updates coalesce: the
  worker works on one layout at a time, and only the newest request waits. If the worker can't start (a content
  security policy, a bundler that didn't bundle it) or doesn't answer, layouts run on the page from then on and an
  `error` event says so once. `worker: false` always lays out on the page (layouts are then synchronous at every
  size); `worker: true` always uses the worker. Bundlers that don't follow `new URL("./layout-worker.js",
  import.meta.url)` need `workerUrl`.
- **Changes cost what they change.** A one-node update costs 0.01–0.6 ms at 100k nodes; a change of data alone costs
  nothing on screen; a restyle of a few nodes or edges re-uploads only their bytes; every distinct label is measured
  once. Only a structural change lays out again.
- **Drawing.** Edges are traced on the GPU from a positions texture (straight, step, curve and bundled, in every
  layout), so a morph doesn't rebuild them on the CPU; at 40k nodes a tree morph frame is a few ms. Pans and zooms
  rebuild nothing; at rest, frames stop.
- **Physics** is a typed-array simulation with a collision grid, at most 10 ms a frame, and costs nothing once
  asleep.
- **Positions** are 64-bit (big graphs are hundreds of thousands of px wide); the GPU gets them relative to an origin
  in the middle of the drawing.
- **Merged tree.** Layering, ordering and placement are budgeted by work, not time, so they're deterministic; on very
  big graphs network-simplex layering stops at its budget (`routing.simplex.optimal` is then false).

Figures are from the benchmarks in the changelog and `npm run bench:merged` (fixtures in `tests/fixtures/graphs/`),
measured headless; a real page adds drawing time.

## Types

The declarations are generated from the JSDoc into `types/` (`npm run types`; `npm run verify` checks they're
current and that `src/` type-checks). `prismatrix` exports these types:

- the graph: `GraphJSON`, `NodeJSON`, `EdgeJSON`, `NodeStyle`, `EdgeStyle`, `ModelNode`, `ModelEdge`,
  `ModelOptions`, `Delta`, `NodeChange`, `EdgeChange`, `Change`, `Issue`;
- the view: `ControllerOptions`, `ControllerEvents` (event type → detail; `on` is typed by it), `PointDetail`,
  `GraphDetail`, `DisclosureDetail`, `TickResult`, `LayoutName`, `PhysicsMode`;
- the screen: `Renderer`, `RendererOptions`, `FrameStats`;
- options: `NodeOptions`, `EdgeOptions`, `AnimationOptions`, `TreeLayoutOptions`, `MergedLayoutOptions`,
  `RadialLayoutOptions`, `LayoutOptions`, `LayoutSpec`, `StaticPhysicsOptions`, `ElasticPhysicsOptions`,
  `FloatingPhysicsOptions`, `PhysicsOptions`, `OptionSpec`;
- themes and snapshots: `Theme`, `ThemeInput`, `Snapshot`, `SnapshotSettings`, `NodeState`.
