# Tether

Graph layout and physics on plain arrays: no DOM, no dependencies. It positions a graph's nodes and keeps them
moving believably afterwards. [Prism](https://github.com/BrettWhitson/prism) draws what it positions.

- **Layouts:** a tidy tree, a layered (Sugiyama-style) layout for DAGs and graphs with cycles, and a radial tree,
  each leaving room for node labels. Directional layouts flow any way: TB, BT, LR or RL. Add your own with
  `registerLayout`.
- **Physics:** a force simulation with Barnes–Hut repulsion, link springs, centering, a pull that keeps a layout's
  levels or rings, and box collisions. It polishes every layout, and in "floating" mode keeps the whole graph live.
  Add forces of your own with `registerForce`, or to a running simulation with `addForce`.
- **Dragging:** an elastic network. The held node pulls its neighbours, they pull theirs, and the pull fades with
  every link, so the rest of the graph stays put.
- **Live physics:** everything after the layout in one place, with events. Tell it what the pointer does (grab,
  drag, release), or shake it, and call `step()` each frame while it's `active`. It returns what moved in any
  physics mode: elastic, floating or none.
- **Fully tunable:** every setting and constant is described by a schema (type, range, default, label, hint).
  Values are checked: bad ones are clamped or replaced by the default with a warning, or throw in strict mode. The
  same schemas can build a settings UI.

No build step: plain ES modules, with TypeScript declarations in `types/`.

```js
import { LayoutGraph, runLayout } from "tether";

// Nodes: { id, w, h, fullW?, fullH?, root? } (fullW × fullH: the node with its label).
// Edges run parent → child: { source, target }.
const graph = new LayoutGraph(nodes, edges);
const simulation = runLayout(graph, {
  layout: "tree", // or "radial", or one you registered
  direction: "TB", // or "BT", "LR", "RL"
  physicsMode: "elastic", // or "floating", "none"
  linkDistance: 140, // anything left out keeps its default
});
graph.positionOf("a"); // { x, y }
```

`runLayout` returns the force simulation. Hand it to `LivePhysics` to drag and animate the graph afterwards:

```js
import { LivePhysics } from "tether";

const physics = new LivePhysics(settings);
physics.simulation = simulation;
physics.on("settle", () => save(graph.positions()));

physics.grab("a", { ids, links: edges, positionOf }); // positionOf(id): where it's drawn now
physics.drag("a", { x: 300, y: 120 }); // as the pointer moves; physics.release("a") when it lets go

function frame() {
  draw(physics.step().moved); // [[id, x, y], …]
  if (physics.active) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The full reference is in [API.md](API.md).

In a browser without a bundler, map the import:

```html
<script type="importmap">
  { "imports": { "tether": "./node_modules/tether/src/index.js", "tether/": "./node_modules/tether/src/" } }
</script>
```

## Layout of the code

| Where | What |
| --- | --- |
| `src/index.js` | the public API: import everything from here |
| `src/run-layout.js` | `runLayout`: settings → seed layout → physics |
| `src/layouts.js` | the layout registry, with the built-in "tree" and "radial" |
| `src/layered.js`, `src/trees.js` | the layered, tidy tree and radial tree seeds |
| `src/physics.js` | `ForceSimulation`: the forces, collisions, and bringing a graph to rest |
| `src/forces.js` | the extra-force registry, with "position" and "radial" |
| `src/elastic.js` | `ElasticNetwork`: the elastic drag |
| `src/live-physics.js` | `LivePhysics`: dragging, shaking and floating in, with events |
| `src/settings.js`, `src/tuning.js` | the schemas of the settings and the constants |
| `src/schema.js`, `src/emitter.js` | validation and events (shared with Prism) |

## Development

```sh
npm install
npm run verify   # lint, prettier, type check, declarations up to date, tests
npm run types    # regenerate types/ after changing a JSDoc type
```
