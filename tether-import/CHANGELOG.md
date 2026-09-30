# Changelog

Tether: graph layout and physics. Versions follow `0.MINOR.PATCH` until the first stable release.

## 0.3.1 (2026-09-30)

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

## 0.3.0 (2026-09-30)

- **Faster layouts, the same results.** Repulsion walks a flattened quadtree: its cells laid out in the order
  they're visited, with a pointer past each subtree, instead of a stack over scattered cells. The quadtree is also
  built with less overhead. Layouts are bit-identical to before and 1.6–2.7× faster.

  | Nodes | Tree layout, before | After |
  | --- | --- | --- |
  | 3,000 | 0.8 s | 0.48 s |
  | 10,000 | 4.6 s | 1.8 s |

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

  | Nodes | Floating layout, before | After |
  | --- | --- | --- |
  | 1,000 | 1.9 s | 0.24 s |
  | 3,000 | 6.4 s | 0.57 s |

- **`flowOf(settings)`**: how the laid-out graph flows, for whoever draws it. It returns `{ directional, axis,
  rootSide, growth }`: whether levels run along an axis, which axis, a unit vector toward the root, and the tree's
  growth direction. Renderers no longer interpret the layout settings themselves.

## 0.2.0 (2026-09-30)

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

## 0.1.0 (2026-09-30)

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
