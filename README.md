# Prismatrix

**Force Graph Layout and Rendering Engine.**

Give it nodes and edges. It lays them out, draws them on the GPU (WebGL2, with Canvas 2D as the fallback), moves them
believably when you drag them, and morphs from one version of the graph to the next. It was built for crafting trees,
where one ingredient feeds many recipes, and stays smooth at tens of thousands of nodes. No runtime dependencies and no
build step: plain ES modules, with TypeScript declarations.

An app works with three parts:

- **`GraphModel`**: what the graph is (nodes, edges, labels, data) and how it looks. Built once, then changed in place
  by deltas, so a change costs what it changes.
- **`GraphController`**: the view. It listens to the model and does only what each change needs: nothing for new data,
  a restyle for new colours, a layout and a morph for new nodes. It owns the layout, physics, animation, camera,
  hover, selection, drags and what's collapsed.
- **A renderer** (`glRenderer` or `canvasRenderer`): the screen. It owns the canvas, input and the frame loop.

```js
import { GraphModel, GraphController, glRenderer } from "prismatrix";

const model = new GraphModel({
  nodes: [
    { id: "mjolnir", label: "Mjölnir", style: { icon: "/icons/mjolnir.png" } },
    { id: "gift", label: "Gift of Mjölnir" },
    { id: "ecto", label: "Glob of Ectoplasm" },
  ],
  edges: [
    { source: "mjolnir", target: "gift" },
    { source: "gift", target: "ecto", label: "×250" },
  ],
});
const view = new GraphController(model, glRenderer(document.querySelector("canvas")), {
  layout: "merged",
  theme: "dark",
});

view.on("tap", ({ node }) => node && view.toggle(node));
model.update({ addNodes: [{ id: "coin" }], addEdges: [{ source: "gift", target: "coin" }] }); // lays out, morphs
```

## What it does

- **Layouts**, each spacing nodes by their real footprint (node and label), deterministic, and stable under change
  (a new node moves only what it has to):
  - `tree`: a tidy tree in any of four directions;
  - `merged`: a layered (Sugiyama) drawing where each shared ingredient appears once, with global sifting, an exact
    placement that keeps long edges straight, and reference chips in place of long edges into busy ingredients;
  - `radial`: rings by depth, packed like a tidy tree.
- **Physics:** `static`, `elastic` (springs back home) and `floating` (pushes apart, holds edges), with throws,
  collision and a per-frame budget.
- **Big graphs:** layouts of 2,000 nodes or more run in a worker while the page keeps drawing; edges are traced on the
  GPU; one-node updates cost under a millisecond at 100k nodes.
- **Exploring:** expand and collapse with progressive disclosure, selection, focus, lineage on hover, pinch and
  trackpad zoom, tap, double tap and long press events.
- **Looks:** node shapes, icons and tiles, badges, borders, edge shapes (straight, step, fan, curve), edge labels,
  dark and light themes or your own.
- **Everything checked:** every option is described by a schema (default, range, label, hint), so a settings UI can be
  built from it; bad input is reported, never silently fixed.
- **Headless:** with no renderer, a controller runs in tests or on a server; `prismatrix/layout` lays graphs out
  with no DOM at all. Views save and restore as JSON snapshots.

The full reference is [API.md](API.md); the graph and snapshot formats are in [MODEL.md](MODEL.md).

## Install

```sh
npm install github:BrettWhitson/prismatrix#vX.Y.Z
```

Pin a release tag (`v0.5.0` and later: this engine). Releases up to `v0.4.0` carry the earlier engine and its API
(see [CHANGELOG.md](CHANGELOG.md)).

In a browser without a bundler, map the imports:

```html
<script type="importmap">
  {
    "imports": {
      "prismatrix": "./node_modules/prismatrix/src/index.js",
      "prismatrix/layout": "./node_modules/prismatrix/src/layout.js"
    }
  }
</script>
```

## Layout of the code

| Where | What |
| --- | --- |
| `src/index.js` | the public surface; `layout.js` is layout without a screen |
| `src/model.js` | `GraphModel`: the graph, its options, deltas and change events |
| `src/controller.js` | `GraphController`: layouts, physics, animation, camera, input, disclosure, snapshots |
| `src/renderer.js` | the renderers; `webgl.js` and `gl-*.js` draw with WebGL2, `render.js` with Canvas 2D |
| `src/layouts.js` | the layouts; `tidy.js`, `layered.js`, `sifting.js`, `simplex.js` and `references.js` do the work |
| `src/physics.js` | the physics modes |
| `src/layouter.js` | where layouts run: on the page or in the worker (`layout-worker.js`) |
| `sandbox/` | the sandbox: every option, live |

## Development

```sh
npm install
npm run sandbox  # http://localhost:8651: every option, built from the schemas, with an engine log in logs/
npm run verify   # lint, prettier, type check, declarations and docs up to date, all tests
npm run types    # regenerate types/ after changing a JSDoc type
npm run docs     # regenerate API.md's tables after changing a schema or typedef
npm run bench:merged  # merged-tree layout timings on the fixture graphs
```

## History

Prismatrix joins two engines, **Prism** (the renderer) and **Tether** (layout and physics), and then rebuilds them from
the ground up. Both earlier histories are in this repository. Prism's tags are `v0.2.0` to `v0.3.2`, Tether's are
`tether-v0.2.0` to `tether-v0.3.1`, and `v0.4.0` is the two combined. See [CHANGELOG.md](CHANGELOG.md).
