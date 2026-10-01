# Changelog

Prismatrix: a lightning fast and lightweight graph rendering and physics engine. Versions follow `0.MINOR.PATCH`
until the first stable release, continuing Prism's numbering.

## Unreleased (branch `ground-up`)

A ground-up rebuild of the engine, in `next/`, beside the current one (`src/`, untouched). Work in progress: it
draws with WebGL2 (Canvas 2D as the fallback), and isn't exported from the package yet.

- **Layouts**, each placing nodes by their real footprint (node plus label), and each with its own physics modes:
  - tree: contour-packed (Reingold–Tilford style) in any of four directions; static or elastic.
  - radial: leaf-weighted wedges, rings that grow until their nodes fit; static, elastic or floating.
  - merged tree: a layered (Sugiyama) drawing for shared ingredients. Global sifting orders nodes and whole long
    edges together; a weighted placement keeps long edges straight; busy shared ingredients get a reference chip
    under each far-away recipe instead of a long edge (pointing at one lights up the ingredient). On the 642-node
    crafting fixture: 15,601 crossings down to 1,190. Network simplex layering is an option.
- **Physics:** friction in every mode, so anything moving eases to a full stop; throws; elastic springs to home with
  optional level or ring locks; floating with local repulsion, shape memory, drift and a settle time; node and
  label collision; a per-frame time budget so big graphs slow down rather than lock up.
- **Edges:** straight, step (right angles in a tree, ring arcs in a radial) and fan; corner radius, taper, colour,
  opacity and ends, drawn as one layer so overlaps don't brighten.
- **Nodes:** six shapes, sizing by subtree or depth, colouring by depth or branch, labels below, right or outward.
- **Model, controller, renderer:** `new GraphController(new GraphModel(json, { node, edge }), glRenderer(canvas))`.
  The model is the graph and how it looks, built once and changed in place by deltas (`update`) or whole versions
  (`replace`), which reuse every unchanged node; it stores label widths (each label measured once) and reports
  exactly what changed. The controller listens and does only what a change needs (a restyle, a layout, a morph);
  node positions and velocities live in its matrix of typed-array columns. The renderer owns the screen (canvas,
  input, frames, text measurement). `GraphView` is gone. A 30k → 40k node update freezes for 0.46 s instead of 0.91.
- **Sandbox** (`npm run sandbox`, http://localhost:8651): drives every option, built from the engine's schemas, and
  writes a rolling 30-second engine log to `logs/engine-stats.log`.

## 0.4.0 (2026-09-30)

Prism and Tether are one engine now: **Prismatrix**.

- One package, two layers:
  - `import … from "prismatrix"` gives everything: the view and renderer (formerly Prism), and the layout and physics
    layer (formerly Tether).
  - `"prismatrix/layout"` is the layout and physics layer on its own, with no DOM or WebGL, for workers, tools and
    tests.
  - Module paths stay importable: `prismatrix/<module>.js`, `prismatrix/layout/<module>.js`,
    `prismatrix/render/<module>.js`.
- The public names are unchanged: `GraphView`, `runLayout`, `LivePhysics`, `TUNING_OPTIONS`, the schemas, the
  registries. Moving an app over means changing its import paths:
  - `prism` and `prism/<module>.js` become `prismatrix` and `prismatrix/<module>.js`;
  - `tether` and `tether/<module>.js` become `prismatrix/layout` and `prismatrix/layout/<module>.js`.
- No peer dependency any more: the layers import each other by relative path. One package.json, one lockfile, one
  verify, one API.md and one changelog.
- A new test keeps the layers apart: the layout layer imports nothing outside itself and uses no DOM or WebGL, and the
  renderer imports nothing outside itself.
- Messages and warnings say "Prismatrix" (for example "Prismatrix options: …").
- No behaviour change: layouts are bit-identical to Tether 0.3.1, and all 100 tests from the two repositories pass
  unchanged.
- Both histories are kept in this repository (`git log`, `git blame`). Prism's tags keep their names (`v0.2.0` to
  `v0.3.2`); Tether's are prefixed (`tether-v0.2.0` to `tether-v0.3.1`).

## Prism (the view and renderer) before 0.4.0

### 0.3.2 (2026-09-30)

- **Tether is a peer dependency** (`>=0.3.1 <0.4.0`): Prism uses the app's own Tether instead of a copy nested
  inside it, so a Tether fix reaches Prism as soon as the app pins it. Install both:
  `npm install github:BrettWhitson/prism#v0.3.2 github:BrettWhitson/tether#v0.3.1`. Don't install Prism alone: npm
  would look for "tether" on the npm registry, where that name belongs to an unrelated package. When upgrading, install
  Tether first, then Prism: in one command, npm checks the peer range against the old Tether and fails (ERESOLVE).
- With Tether 0.3.1, floating graphs respond to small drags again and radial graphs don't spin (see Tether's
  changelog).

### 0.3.1 (2026-09-30)

Needs Tether 0.3.0 (for `flowOf`); the dependency is `tether#v0.3.0`.

- **Faster restyles with class rules or hooks.** An edge reads its end nodes' resolved styles instead of resolving
  them again. Before, every restyle resolved each node three times.
- **Smooth panning over cards.** New card-text bitmaps are made within 4 ms per frame; past that, a card's text is
  drawn straight onto the layer for that frame. Panning into a crowd of new cards dropped from 31 ms for the first
  frame to about 5 ms. Off-screen cards no longer get bitmaps.
- **Separation of concerns.** Tether says how the graph flows (`flowOf`: where the root lies, the axis levels run
  along, and which way the tree grows). Prism no longer interprets the layout settings for port sides, label
  placement, edge routing or the smart fit.
- **Faster layouts, from Tether.** On the demo, rendering 3,000 nodes went from 1.1 s to 0.69 s, and 10,000 from
  4.1 s to 2.5 s. Floating graphs lay out 8–11× faster and no longer drift after a touch.

### 0.3.0 (2026-09-30)

Card nodes.

- **`nodeLook: "card"`**: wide cards with their text inside, as an alternative to square icons with a label beside
  them (`"icon"`, still the default, drawn exactly as before).
  - Switching looks morphs every node to its new size, since node sizes now animate on springs.
  - The graph lays itself out again. `relayout()` is also public.
  - A class rule or hook can set `look` per node.
- **Card parts:**
  - a title (the node's `label`);
  - a subtitle and a value: a string, or runs of text, `{ text, color }`, `{ mark }` (a small square) and `{ dot }`
    (a small circle);
  - a `tag` pill on the top edge;
  - a colour stripe down the left edge;
  - the icon on the left;
  - port dots where the flow's edges meet the card, drawn only where an edge actually connects, and never in radial
    layouts.
- **Card options:** size, icon size and inset, padding, font sizes, stripe width and inset, port size, and
  `cardDetailZoom`. Below `cardDetailZoom` only titles are drawn, and below `labelFadeZoom` no card text at all.
- **Card text** is one bitmap per card, cached by content and zoom level, capped at 24 million pixels (least
  recently used dropped first). PNG export draws it too.
- **`cardConnectors`:** where edges meet a card:
  - `"dots"` (the default): port dots only;
  - `"arrows"`: arrowheads, at the end `arrowEnd` picks;
  - `"both"`: the edge stops at the dot's rim, so the arrowhead sits beside the dot.
- **`edgeLineStyle: "arrows"`:** a dotted line of small chevrons, pointing the way `flowToward` says.
- **`lineageColor: "edge"`:** lit lineage edges keep their own colour, and are only widened and flowing. `"theme"`
  (the default) uses the theme's ancestor and descendant colours, as before.
- **New style fields:** `width`, `height`, `stripe`, `portIn`, `portOut`, `subtitle`, `value`, `tag`, `tagColor`,
  `valueColor`.
- **New theme colours:** `cardBorder`, `cardText`, `cardMuted`, `portFill`.
- Tether stays at v0.2.0.

### 0.2.0 (2026-09-30)

A public API, and full customization.

- **One entry point:** `import { … } from "prism"` gets Prism's API and all of Tether's (layouts, forces, tuning), so
  an app needs one import.
- **TypeScript declarations** in `types/`, generated from the JSDoc. `verify` type-checks the source and checks that
  `types/` and API.md's tables are up to date.
- **Options and theme as schemas:** `OPTIONS_SCHEMA` and `THEME_SCHEMA`, where each value has a range, default, label
  and hint. `OPTIONS` and `THEME_OPTIONS` can build a settings UI; the demo's panel is built that way.
- **Validation:**
  - a value out of range is clamped;
  - a wrong type falls back to the default;
  - each problem is warned about once, and `strict: true` throws instead.
- **No hardcoded constants.** These are all options now:
  - node, font and label sizes;
  - the root's emphasis and the tint strength;
  - the hover delay, and the animation and stagger limits;
  - fit and focus padding, and the smart-fit thresholds;
  - input timings: double tap, long press, drag thresholds, pan glide;
  - the background cell size.
- **All colours in the theme:** the renderer's label and interaction colours are theme colours too, and `setTheme`
  applies them live.
- **Events:** `view.on(type, listener)` returns an unsubscribe. There are 18 events: taps, hovers, drags,
  `physicsStart`/`physicsSettle`, `render`, `select`, `optionsChange`, `themeChange` and `destroy`. The `handlers`
  object still works.
- **Styling in steps**, each able to set any style field:
  1. options and theme;
  2. built-in classes;
  3. class rules;
  4. the node's own `style`;
  5. the new `nodeStyle` / `edgeStyle` hooks.
  - Every step's values are checked (`NODE_STYLE_SCHEMA`, `EDGE_STYLE_SCHEMA`), and a size is at least 1.
- **Plugins:**
  - `registerNodeShape`: a polygon, or a GLSL distance function compiled into the shader. A shape that fails to
    compile is reported once and drawn as the default.
  - `registerArrowShape`, `registerEdgeRouting` and `registerEasing`.
  - A name that isn't registered draws the default, with one warning.
- **New methods:** `getViewport`/`setViewport`, `toScreen`/`toGraph`, `positionOf`/`positions`, `selectedId`,
  `resetOptions`, and the constructor's `tuning` and `classStyles`.
- **Input checks:**
  - duplicate node or edge ids keep the first, with a warning;
  - `minZoom` above `maxZoom` is swapped;
  - a custom layout that throws no longer makes `render()` throw.
- **The demo is an API playground:** a control for every option, colour and tuning constant; a plugin of each kind;
  an event log.
- API.md documents it all, including using a view from a Svelte component.

### 0.1.0 (2026-09-30)

The first release, split out of GW2 Visualizer.

- **A WebGL2 renderer:**
  - instanced nodes, edges and arrowheads;
  - signed-distance shapes that stay crisp at any zoom;
  - labels on a 2D layer;
  - springs that animate every change, so one change can interrupt another without a jump;
  - 60 fps at 10,000 nodes.
- **`GraphView`:**
  - morphing from one graph to the next: survivors glide, new nodes grow out of their ancestors, and removed ones fold
    into theirs;
  - hover lineage with travelling light pulses, selection, highlights and flashes;
  - fit, focus and PNG export.
- **Dragging runs through Tether:** elastic or floating.
- **Fixes from an audit:**
  - WebGL context loss and restore;
  - multi-touch during a drag;
  - size options apply at once;
  - transitions fold along the graph's own links;
  - any CSS colour, with alpha;
  - label wrapping;
  - a complete `destroy()`;
  - device-pixel-ratio changes;
  - export limits;
  - non-finite positions can't hang the renderer.
- A drag held through a render rests on the new layout.

## Tether (the layout and physics layer) before 0.4.0

### 0.3.1 (2026-09-30)

Floating graphs respond to small drags again, and radial ones don't spin.

- The dead zone (0.3.0) only holds nodes the drag hasn't reached. A node that has moved more than `wakeDistance` (2)
  wakes its linked neighbours, so a pull travels along the links in full. In 0.3.0, a short drag of a leaf didn't
  move the item it feeds at all.
- Radial graphs no longer spin about their pinned centre when one leaf is pulled: the graph's net turn is taken out
  of the free nodes' velocities, like the net push elsewhere.
- `liveAnchor` (0.02): while live, each node is pulled very gently toward where it rested, so nothing slowly turns or
  slides as a whole.
- After a release the graph stops once nothing moves more than the dead zone per tick. Before, it could hover in a
  slow back-and-forth until `releaseTicks`.
- In the reported case (a 3 × 6 tree, 90 ticks), pulling a leaf 8, 20, 40 and 80 units moves its product 4, 9, 16
  and 27 units top-down (it was 0, 9, 25 and 13), and 0.2, 2, 7 and 16 units radially (it was 0, 0, 0.6 and 1).
  Large graphs settle within 20 to 50 frames of a release, and a touch still moves nothing.

### 0.3.0 (2026-09-30)

- **Faster layouts, the same results.** Repulsion walks a flattened quadtree: its cells laid out in the order
  they're visited, with a pointer past each subtree, instead of a stack over scattered cells. The quadtree is also
  built with less overhead. Layouts are bit-identical to before and 1.6–2.7× faster.

  | Nodes  | Tree layout, before | After  |
  | ------ | ------------------- | ------ |
  | 3,000  | 0.8 s               | 0.48 s |
  | 10,000 | 4.6 s               | 1.8 s  |

- **Floating graphs stay put.**
  - Grabbing a node and letting go without moving it no longer makes the graph drift. On big graphs, far-off parts
    used to wander hundreds of units after a mere touch.
  - After a drag the graph settles at the drag heat and stops once it's still, instead of cooling. The forces at rest
    are recorded at that heat and cancel only there.
  - A new `deadZone` (0.2): while live, a node pushed less than this per tick stays put, so a drag's ripple dies out
    instead of feeding on leftovers.
  - A new `releaseTicks` (300): the most ticks the graph spends settling after a drag.
- **Floating layouts are 8–11× faster.** The rest correction now does the job of the long settle before showing a
  floating graph, so `settleWork` drops from 1,350,000 to 100,000.

  | Nodes | Floating layout, before | After  |
  | ----- | ----------------------- | ------ |
  | 1,000 | 1.9 s                   | 0.24 s |
  | 3,000 | 6.4 s                   | 0.57 s |

- **`flowOf(settings)`**: how the laid-out graph flows, for whoever draws it. It returns `{ directional, axis,
rootSide, growth }`: whether levels run along an axis, which axis, a unit vector toward the root, and the tree's
  growth direction. Renderers no longer interpret the layout settings themselves.

### 0.2.0 (2026-09-30)

A public API.

- **One entry point:** `import { … } from "tether"` gets everything. Each module stays importable as
  `tether/<module>.js`, with types.
- **TypeScript declarations** in `types/`, generated from the JSDoc. `verify` type-checks the source and checks that
  `types/` and API.md's tables are up to date.
- **Schemas for settings and tuning.** Every value has a type, range, default, label and hint:
  - settings: `SETTINGS_SCHEMA`, `DEFAULT_SETTINGS`, `resolveSettings`;
  - tuning: `TUNING_SCHEMA`, `DEFAULT_TUNING`, `resolveTuning`;
  - the helpers work on any schema: `resolve`, `validate`, `checkField`, `isColor`.
- **Validation:**
  - a number out of range is clamped;
  - a wrong type or an unknown value falls back to the default;
  - an unknown key is ignored, with a "did you mean" for typos;
  - each problem is warned about once, and `strict: true` throws instead.
- **No hardcoded constants.** These are all tuning now, with defaults unchanged:
  - the seed node size, label room and sibling gap;
  - the structure pull;
  - the quadtree depth;
  - the layered layout's passes and weights.
- **Custom layouts:** `registerLayout(name, { seed, directional })`, with "tree" and "radial" built in, chosen by the
  new `layout` setting. `direction: "radial"` still works. A seed can ask for no structure force (`mode: "none"`).
- **Custom forces:** `registerForce(type, factory)`, the `forces` setting and `ForceSimulation.addForce()`, with
  "position" and "radial" built in.
- **Events:** `LivePhysics` emits `grab`, `release`, `start` and `settle`. `on()` returns an unsubscribe.
- **A third physics mode, "none":** the dragged node moves alone. It announces one start and one settle per drag.
- **Tighter input checks:**
  - rgb()/hsl() colours need the right number of parts, each in range;
  - duplicate node ids keep the first, with a warning (`uniqueById`);
  - a repeated edge (same id, or same ends) pulls once;
  - a custom layout that throws falls back to the tree, and one returning an unknown mode gets "none".
- API.md documents it all.

### 0.1.0 (2026-09-30)

The first release, split out of GW2 Visualizer.

- **Layouts:**
  - a tidy tree, directional (TB, BT, LR or RL);
  - a layered, Sugiyama-style layout for DAGs and graphs with cycles: cycle removal, network-simplex-like ranking,
    long-edge dummies, barycentre sweeps with transposition, and isotonic placement;
  - a radial tree.
  - Each leaves room for node labels.
- **Physics:**
  - a force simulation with Barnes–Hut repulsion, link springs, centering, a pull toward each node's level or ring,
    and box collisions on a hashed grid;
  - net push cancellation, so the graph never slides;
  - deterministic: the same input always gives the same layout.
- **Physics modes:**
  - Elastic: a dragged node pulls its neighbours, less with every link, and the rest of the graph stays still.
  - Floating: the whole graph is live. It uses soft collisions, and the forces on the graph at rest are subtracted,
    so a grab moves only what it touches.
- **`LivePhysics`:** dragging, shaking and floating into place in one API. The caller calls `step()` each frame and
  draws what moved.
- **Fixes from an audit:**
  - floating graphs settle by a work budget, not the clock, so a graph lands the same on any machine;
  - floating in always ends;
  - a drag stays in the mode it started in;
  - nodes stacked on one point push apart.
