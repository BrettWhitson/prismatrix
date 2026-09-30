# Tether API

Everything below is exported from the entry point, `import { … } from "tether"`. The modules behind it
(`tether/<module>.js`) stay importable, but only the entry point is the stable interface. Types for all of it are in
`types/` (`LayoutSettings`, `Tuning`, `LayoutDefinition`, `Force`, …).

- [Laying out a graph](#laying-out-a-graph)
- [Settings](#settings)
- [Tuning](#tuning)
- [Validation](#validation)
- [Live physics and events](#live-physics-and-events)
- [Custom layouts](#custom-layouts)
- [Custom forces](#custom-forces)
- [Lower-level pieces](#lower-level-pieces)

## Laying out a graph

### `new LayoutGraph(nodes, edges)`

The graph as the layouts see it: flat typed arrays.

- `nodes`: `{ id, w, h, fullW?, fullH?, x?, y?, root?, ghost? }[]`. `w × h` is the node's box, and `fullW × fullH`
  is the box it makes with its label (layouts leave room for it). `root: true` marks the root; otherwise tree
  layouts have none. Ghosts (nodes on their way out) are laid out but not simulated.
- `edges`: `{ id?, source, target }[]`, parent → child. Edges to unknown nodes and self-loops are dropped, and so are
  repeats (an edge's id is its `id`, or `"source->target"`): an edge given twice pulls once.

It has `ids`, `indexById`, `count`, `x`, `y` (centres, written by the layouts), `w`, `h`, `fullW`, `fullH`,
`sources`, `targets` (edges as index pairs), `rootId`, `positionOf(id)` and `positions()` (a `Map`: id → `{ x, y }`). Ids must be unique: of nodes sharing an id, the first is kept
and the rest dropped, with a warning (`uniqueById` does the same for your own lists).

### `runLayout(graph, settings, { tuning?, settle?, strict? })`

Positions every node, synchronously, and returns the `ForceSimulation` that did it, or null when the layout can't
place this graph (the radial layout needs a root). Every layout runs in two stages: its seed (the layout itself),
then the physics, which polishes it with the forces and removes overlaps.

- `settings`: any subset of [the settings](#settings).
- `tuning`: any subset of [the tuning](#tuning).
- `settle: false`: return the seed and an unrun simulation, to animate it live (`LivePhysics.floatIn`).
- `strict: true`: invalid settings throw instead of warning.

In "floating" mode the result is brought truly to rest, so waking it later (a drag) only moves what's disturbed.
Layouts are deterministic: the same graph and settings always give the same positions.

## Settings

What an app lets its users choose. `DEFAULT_SETTINGS` holds the defaults, `SETTINGS_SCHEMA` describes each one, and
`SETTINGS_OPTIONS` lists them in order for building a settings UI (`{ key, type, default, min, max, step, values,
label, group, hint }`). `resolveSettings(partial)` fills in the defaults and checks what's given; keys it doesn't
know are kept, so an app's own options can travel in the same object.

<!-- generated:settings -->

| Setting | Default | Values | What it does |
| --- | --- | --- | --- |
| `layout` | `"tree"` | `tree`, `radial`, or registered | A registered layout: "tree" (directional), "radial", or your own (registerLayout). |
| `direction` | `"BT"` | `TB`, `BT`, `LR`, `RL`, `radial` | Directional layouts: which way the graph flows, leaves → root ("BT": leaves at the bottom). "radial" is shorthand for layout: "radial". |
| `layered` | `false` | true / false | Always use the layered layout (graphs with shared nodes or cycles), not a tidy tree. |
| `physicsMode` | `"elastic"` | `elastic`, `floating`, `none` | elastic: a dragged node pulls its neighbours, less with every link. floating: the whole graph is live. none: a dragged node moves alone. |
| `centerForce` | `0.2` | 0 – 1 | Pull toward the middle; also how firmly levels, rings and (elastic) rest positions hold. |
| `repelForce` | `8` | 0 – 40 | Push between nodes; also the room left between siblings and for labels. |
| `linkForce` | `0.5` | 0 – 2 | How hard links pull toward their length; (elastic) how far a pull reaches. |
| `linkDistance` | `120` | 10 – 600 | The length links settle at: the spacing between levels and rings. |
| `forces` | `[]` | array | Forces added to the simulation: instances, or { type, ...options } for forces added with registerForce(). |

<!-- /generated:settings -->

## Tuning

Every constant behind the layouts and the physics. `DEFAULT_TUNING` (also `PHYSICS_TUNING`) holds the defaults,
`TUNING_SCHEMA` describes each one, and `TUNING_OPTIONS` lists them for developer tools. `resolveTuning(partial)`
fills in the defaults and checks what's given. Pass a partial tuning to `runLayout`, or set
`livePhysics.tuning = partial` (it applies to the running simulation too).

<!-- generated:tuning -->

**Simulation**

| Constant | Default | Range | What it does |
| --- | --- | --- | --- |
| `repelScale` | `70` | 0 – 300 | Repel setting → force. Many-body push between every pair (Barnes-Hut). |
| `centerScale` | `0.03` | 0 – 0.2 | Center setting → pull toward the graph's own middle. |
| `linkScale` | `0.9` | 0 – 3 | Link setting → spring toward the link distance. |
| `structureScale` | `1.1` | 0 – 5 | Pull toward each node's level (tree) or ring (radial). |
| `structureBase` | `0.15` | 0 – 2 | Structure pull at Center 0 (how loosely levels and rings hold). |
| `structurePerCenter` | `4.25` | 0 – 10 | Structure pull added per unit of the Center setting. |
| `velocityDecay` | `0.4` | 0.05 – 0.95 | Friction: share of speed lost per tick. |
| `theta` | `0.9` | 0.2 – 2 | Accuracy vs speed of the repulsion: lower is exact and slower. |
| `maxTreeDepth` | `24` | 4 – 40 | Deepest quadtree level: points closer than this resolves merge into one mass. |
| `alphaMin` | `0.001` | 0.0001 – 0.05 | The simulation stops when its temperature falls below this. |
| `levelGap` | `24` | 0 – 120 | Minimum clear space between neighbouring levels (px). |
| `ticksSmall` | `300` | 10 – 1000 | Ticks to settle a new layout under 300 nodes. |
| `ticksMedium` | `200` | 10 – 1000 | … under 1,000 nodes. |
| `ticksLarge` | `120` | 10 – 1000 | … 1,000 nodes and over. |

**Layout**

| Constant | Default | Range | What it does |
| --- | --- | --- | --- |
| `seedNodeSize` | `48` | 0 – 400 | The node size seed layouts measure level gaps against: the gap between levels is link distance minus this. |
| `referenceRepel` | `8` | 0.1 – 100 | The Repel setting at which layouts leave full room for labels; lower Repel packs labels tighter. |
| `siblingGapPerRepel` | `3` | 0 – 20 | Space between siblings in the seed layouts, per unit of Repel. |
| `edgeGap` | `6` | 0 – 60 | Layered: space between long edges passing through a level. |
| `crossingSweeps` | `12` | 0 – 60 | Layered: up-and-down passes that reorder each level to cut edge crossings. |
| `transposePasses` | `6` | 0 – 30 | Layered: passes swapping neighbours on a level while that cuts crossings. |
| `alignRounds` | `6` | 0 – 30 | Layered: passes lining nodes up with their neighbours on the next level. |
| `rankPasses` | `24` | 0 – 100 | Layered: passes shortening edges by moving nodes between levels. |
| `longEdgeWeight` | `8` | 1 – 50 | Layered: how much straighter long edges are kept than short ones. |

**Floating**

| Constant | Default | Range | What it does |
| --- | --- | --- | --- |
| `dragHeat` | `0.3` | 0 – 1 | Temperature held while a node is dragged: how much the rest of the graph sways. |
| `cooling` | `0.0228` | 0.001 – 0.2 | How fast it cools after you let go (per tick). |
| `floatIn` | `true` | true / false | New graphs settle live from their seed layout instead of appearing settled. |
| `floatInTicks` | `240` | 0 – 3600 | The most ticks a new floating graph spends floating into place before it's brought to rest. |
| `stillness` | `0.02` | 0 – 2 | A floating graph counts as settled once no node moves more than this per tick (at the drag heat). |
| `settleTicks` | `4000` | 0 – 5000 | The most ticks spent bringing a floating graph to rest. |
| `settleWork` | `100000` | 0 – 10000000 | The most work (nodes × ticks) spent bringing a floating graph to rest before showing it (very big graphs may still drift a little when grabbed). |
| `releaseTicks` | `300` | 0 – 3600 | After a drag, the most ticks the graph spends settling (at the drag heat) before it stops. |
| `deadZone` | `0.2` | 0 – 2 | While live, a node pushed less than this per tick stays put, so a grab or release disturbs only what it reaches. |
| `liveAnchor` | `0.02` | 0 – 1 | While live, how firmly each node is pulled back toward where it rested (per unit of heat): keeps the graph from turning or sliding as a whole. |
| `wakeDistance` | `2` | 0 – 50 | While live, a node that has moved this far wakes its linked neighbours: the dead zone stops holding them. |
| `softCollision` | `0.3` | 0 – 1 | How hard overlapping nodes push apart while floating (as a push on their speed, so the graph can rest). |

**Elastic**

| Constant | Default | Range | What it does |
| --- | --- | --- | --- |
| `elasticStiffnessBase` | `0.3` | 0 – 2 | How firmly links keep their shape, before Link strength. |
| `elasticStiffnessPerLink` | `1` | 0 – 3 | Added per unit of the link force setting. |
| `elasticAnchorBase` | `0.05` | 0 – 1 | How firmly nodes hold their place, before Center. |
| `elasticAnchorPerCenter` | `0.5` | 0 – 2 | Added per unit of the center force setting. |
| `elasticDamping` | `0.35` | 0.02 – 0.95 | Share of speed lost per step: low wobbles, high is sluggish. |
| `elasticAlongHold` | `2` | 1 – 10 | Trees: how much more firmly nodes keep their level than their place along it. |
| `elasticWake` | `0.05` | 0.001 – 5 | How far a node must be displaced before it disturbs its neighbours. |
| `elasticRest` | `0.01` | 0.0005 – 1 | Below this speed and force a node is settled (and sleeps). |

<!-- /generated:tuning -->

## Validation

Settings, tuning, and Prism's options and theme are all checked against their schemas. A wrong value never stops the
engine:

- a number out of range is clamped into it;
- a whole-number constant given a fraction is rounded;
- a wrong type, an unknown enum value or a malformed colour is replaced by the default (a functional colour needs
  the right number of parts, each in range: `rgb(1,2)` or `rgb(300,0,0)` isn't one);
- an unknown key is ignored (with a "did you mean" hint for typos), except in settings, which keep them.

Each problem is reported once with `console.warn`. With `strict: true` (runLayout, resolveSettings, resolveTuning,
or the `resolve` / `validate` helpers) they throw a `TypeError` instead, which suits tests.

The helpers work on any schema, so apps can describe their own options the same way:

```js
import { resolve } from "tether";

const schema = {
  zoom: { type: "number", default: 1, min: 0.1, max: 8 },
  accent: { type: "color", default: "#62a4da" },
};
resolve(schema, { zoom: 20 }); // { zoom: 8, accent: "#62a4da" }, and a warning
```

Field types: `number`, `integer`, `boolean`, `string`, `enum` (with `values`; `open: true` accepts other strings
too), `color`, `function`, `array`, `object`, `any`. `nullable: true` allows null.

## Live physics and events

### `new LivePhysics(settings)`

Everything after the layout: dragging, shaking and floating into place. It reads `physicsMode`, `linkForce`,
`centerForce`, `layout` and `direction` from `settings` on every grab, so the caller can change them in place.

| Member | What it does |
| --- | --- |
| `simulation` | the layout's simulation (set it after each `runLayout`); setting it stops whatever was moving |
| `tuning` | get a copy, or set a partial tuning (checked; everything else returns to its default) |
| `grab(id, { ids, links, positionOf })` | a node is grabbed; `positionOf(id)` says where each node is drawn now |
| `drag(id, point)` | the held node moved to `point` (`{ x, y }`) |
| `release(id)` | the held node was let go |
| `shake(positionOf, { heat?, scatter? })` | heat the simulation (0–1) and let it settle; scatter every node first |
| `floatIn()` | a new layout (from `settle: false`) floats into place |
| `stop()` | stop whatever is moving, and let go of a held node |
| `step()` | advance one frame: `{ moving, moved: [id, x, y][] }` |
| `active` | does `step()` have anything to move? |
| `heldId` | the node being dragged, or null |
| `elasticNet` | the elastic net during an elastic drag (for developer tools) |

Physics modes:

- **elastic:** the graph holds its layout. The held node pulls its neighbours, theirs less, fading with every
  link. Letting go keeps the pulled shape.
- **floating:** the whole graph is live. The held node drags its neighbours, the rest sways and makes room, and it
  all settles again after you let go.
- **none:** the held node moves alone. `start` is announced on the grab and `settle` once it's let go.

### Events

`LivePhysics` is an `Emitter`. `on(type, listener)` returns a function that unsubscribes; `once` and `off` work as
you'd expect. A listener that throws is reported and doesn't stop the others.

| Event | Payload | When |
| --- | --- | --- |
| `grab` | `{ id, mode }` | a node was grabbed |
| `release` | `{ id, mode }` | the held node was let go |
| `start` | `{ reason }` | `step()` has something to move again: `"drag"`, `"shake"` or `"float-in"` |
| `settle` | none | everything is still again |

```js
const off = physics.on("settle", () => save(graph.positions()));
// later, or in a component's onDestroy:
off();
```

## Custom layouts

### `registerLayout(name, definition)`

Adds a layout, or replaces one (built-ins included). Select it with the `layout` setting.

```js
import { registerLayout, runLayout } from "tether";

registerLayout("grid", {
  label: "Grid",
  directional: false,
  seed(graph, settings, { siblingGap }) {
    const columns = Math.ceil(Math.sqrt(graph.count));
    for (let i = 0; i < graph.count; i++) {
      graph.x[i] = (i % columns) * (48 + siblingGap);
      graph.y[i] = Math.floor(i / columns) * settings.linkDistance;
    }
    return { mode: "none" };
  },
});

runLayout(graph, { layout: "grid" });
```

- `seed(graph, settings, context)` writes `graph.x` / `graph.y` and returns how the physics should hold the shape:
  - `{ mode: "layered", axis: "x" | "y" }`: nodes keep their level (their coordinate along `axis`);
  - `{ mode: "radial", depthById, rootId }`: nodes keep their ring around the root (pinned);
  - `{ mode: "none" }`: no structure; the forces just polish it;
  - `null`: this graph can't be laid out this way (`runLayout` returns null).

  A seed that throws, or returns another mode, is warned about and falls back (to the tree, or to `"none"`); with
  `strict: true` it throws.
- `context`: `{ tuning, labelShare, siblingGap, levelGap, sizeOf(i) }`, the spacing the built-in layouts use.
- `directional`: true when levels run along an axis set by `direction` (Prism then puts labels beside nodes in
  horizontal flows and routes edges with right angles).

`getLayout(name)`, `listLayouts()` (`[{ name, label, directional }]`), `layoutNameOf(settings)` and
`isDirectionalLayout(settings)` answer questions about them. `flowOf(settings)` tells a renderer how the graph flows:
`{ directional, axis, rootSide, growth }` (the axis levels run along, a unit vector toward the root, and the tree's
growth direction), so it never has to interpret the settings itself. `direction: "radial"` is shorthand for
`layout: "radial"`.

## Custom forces

A force is an object with `apply(simulation, alpha)`, and optionally `initialize(simulation)` (called once, when it
joins). `apply` adds to the velocities in proportion to `alpha`, the simulation's temperature: it cools toward 0 as
the graph settles, and a drag warms it.

The simulation's public arrays, all indexed by simulation index (`simulation.indexById.get(id)`):

| Array | What |
| --- | --- |
| `x`, `y` | positions |
| `vx`, `vy` | velocities: add to these |
| `fx`, `fy` | held positions, NaN when free |
| `halfW`, `halfH` | collision half-sizes (with the label's share) |
| `linkSources`, `linkTargets`, `degree` | links as index pairs, and each node's link count |
| `ids`, `count` | node ids, node count |

Pass forces in the `forces` setting, as instances or as `{ type, ...options }` for a registered type:

```js
import { registerForce, runLayout } from "tether";

registerForce("wind", ({ strength = 0.5 }) => ({
  apply(sim, alpha) {
    for (let i = 0; i < sim.count; i++) sim.vx[i] += strength * alpha;
  },
}));

runLayout(graph, { ...settings, forces: [{ type: "wind", strength: 0.2 }] });
```

Built in:

- `{ type: "position", x?, y?, strength? }`: pull toward a point, or a line when only `x` or `y` is given.
- `{ type: "radial", radius, x?, y?, strength? }`: pull toward a circle.

Values can be functions of the node id (`x: (id) => …`). `simulation.addForce(force)` adds one to a running
simulation and returns a function that takes it out. `createForce(spec)`, `createForces(specs)` and `forceTypes()`
round it out; unknown types are warned about and skipped.

## Lower-level pieces

For tools that want one stage on its own:

| Export | What |
| --- | --- |
| `ForceSimulation(graph, options)` | the physics: `run`, `tick`, `reheat`, `fix`, `release`, `equilibrate`, `holdRest`, `setPositions`, `addForce`, `resolveOverlaps`, `writeTo` |
| `simulateForces(graph, options)` | build, settle and write back in one go |
| `ElasticNetwork(graph, options)` | the elastic drag on its own: `grab`, `move`, `release`, `step` |
| `layeredLayout`, `tidyTreeLayout`, `radialTreeLayout`, `spanningTree` | the seed layouts |
| `countCrossings` | edge crossings between ordered ranks |
| `Quadtree`, `CollisionGrid` | the spatial structures behind repulsion and collision |
| `treeDirection`, `isHorizontalDirection` | direction helpers |
| `ticksFor(count, tuning)` | how many ticks a fresh layout gets |
| `Emitter` | the event emitter `LivePhysics` (and Prism's views) are built on |
| `resolve`, `validate`, `checkField`, `defaultsOf`, `describeSchema`, `isColor` | the schema helpers |
