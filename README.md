# Prismatrix

**Lightning fast and lightweight Graph Rendering and Physics Engine.**

Give it nodes and edges. It lays them out, draws them on the GPU (WebGL2), moves them believably when you drag them,
and morphs smoothly from one graph to the next. It holds 60 fps at 10,000 nodes, and has no runtime dependencies and
no build step: plain ES modules, with TypeScript declarations.

Two layers, one package:

- **The view and renderer** (`"prismatrix"`) knows what's in the graph and how to draw it:
  - styles, from options, a theme, class rules and hooks;
  - icons or cards;
  - labels, edges and arrowheads;
  - hover lineage, selection and highlights;
  - panning, zooming and fitting;
  - PNG export.
- **The layout and physics layer** (`"prismatrix/layout"`) knows where every node is and how nodes move and push on
  each other:
  - tidy tree, layered (Sugiyama-style) and radial layouts;
  - a Barnes–Hut force simulation;
  - elastic and floating drag physics.

  It has no DOM or WebGL, so it runs in workers, tools and tests on its own.

Everything is described by a schema (type, range, default, label and hint) and checked: 93 options, 17 theme colours
and 43 physics constants. There are plugins for node shapes (a polygon, or GLSL), arrowheads, edge
routings, easings, layouts and forces. `view.on(…)` gives events and returns its own unsubscribe.

```js
import { GraphView } from "prismatrix";

const view = new GraphView({
  container: document.getElementById("graph"),
  options: { direction: "LR", physicsMode: "floating", nodeLook: "card" },
});
view.on("nodeTap", ({ id }) => view.select(id));
view.render({
  nodes: [
    { id: "a", label: "Start", color: "#62a4da", subtitle: "the root" },
    { id: "b", label: "Next", value: "42" },
  ],
  edges: [{ source: "a", target: "b" }],
  fit: true,
});
```

Laying a graph out without drawing it:

```js
import { LayoutGraph, runLayout } from "prismatrix/layout";

const graph = new LayoutGraph(nodes, edges); // nodes: { id, w, h }; edges: { source, target }
runLayout(graph, { layout: "tree", direction: "TB" });
graph.positionOf("a"); // { x, y }
```

The full reference, covering the view, cards, events, plugins, the layout layer, settings and tuning, is in
[API.md](API.md).

## Install

```sh
npm install github:BrettWhitson/prismatrix#v0.4.0
```

In a browser without a bundler, map the imports:

```html
<script type="importmap">
  {
    "imports": {
      "prismatrix": "./node_modules/prismatrix/src/index.js",
      "prismatrix/layout": "./node_modules/prismatrix/src/layout/index.js"
    }
  }
</script>
```

## Layout of the code

| Where | What |
| --- | --- |
| `src/index.js` | the public API: everything |
| `src/graph-view.js` | `GraphView`: styles the graph, asks the layout layer for positions and motion, has the renderer draw them, emits the events |
| `src/options.js`, `src/style.js` | the options and theme schemas, and options + theme + classes + hooks → what each node and edge looks like |
| `src/render/` | the WebGL2 renderer (`WebGLGraph`) and its plugin registries. It imports nothing outside itself (a test checks). |
| `src/layout/` | the layout and physics layer: `runLayout`, the layouts, `ForceSimulation`, `ElasticNetwork`, `LivePhysics`, the settings and tuning schemas. It imports nothing outside itself and uses no DOM (a test checks). |

## History

Prismatrix joins two engines: **Prism**, the renderer, and **Tether**, the layout and physics layer. Their full
histories are in this repository (`git log`, `git blame`). The old tags keep their names: Prism's are `v0.2.0` to
`v0.3.2`, and Tether's are prefixed `tether-v0.2.0` to `tether-v0.3.1`. See [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm install
npm run demo     # http://localhost:8650/demo/: every option, colour and constant, live
npm run verify   # lint, prettier, type check, declarations and docs up to date, all tests
npm run types    # regenerate types/ after changing a JSDoc type
npm run docs     # regenerate API.md's tables after changing a schema
```
