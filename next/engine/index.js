// Prismatrix, rebuilt from the ground up (work in progress: next/sandbox/ drives it). This is its public surface:
// everything an app needs. The modules behind it stay importable by path (tests and tools use them), but only this
// entry, and ./layout.js for layout without a screen, are the interface. The reference is next/API.md.
//
//   const renderer = glRenderer(canvas);
//   const model = new GraphModel(json, { node, edge });
//   const controller = new GraphController(model, renderer, { layout: "tree" });

export { GraphModel, GRAPH_FORMAT, GRAPH_VERSION } from "./model.js";
export { GraphController } from "./controller.js";
export { glRenderer, canvasRenderer } from "./renderer.js";
export { LAYOUTS } from "./layouts.js";
export { PHYSICS, physicsSchema } from "./physics.js";
export { NODE_OPTIONS, EDGE_OPTIONS } from "./style.js";
export { ANIMATION_OPTIONS, EASINGS } from "./animation.js";
export { resolve } from "./schema.js";
export { THEMES, resolveTheme } from "./theme.js";
export {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  snapshotModel,
} from "./snapshot.js";
export { WORKER_MIN } from "./layouter.js";

// Types (for TypeScript and editors; nothing at run time).
/**
 * @typedef {import("./model.js").GraphJSON} GraphJSON
 * @typedef {import("./model.js").NodeJSON} NodeJSON
 * @typedef {import("./model.js").EdgeJSON} EdgeJSON
 * @typedef {import("./model.js").NodeStyle} NodeStyle
 * @typedef {import("./model.js").EdgeStyle} EdgeStyle
 * @typedef {import("./model.js").ModelNode} ModelNode
 * @typedef {import("./model.js").ModelEdge} ModelEdge
 * @typedef {import("./model.js").ModelOptions} ModelOptions
 * @typedef {import("./model.js").Delta} Delta
 * @typedef {import("./model.js").NodeChange} NodeChange
 * @typedef {import("./model.js").EdgeChange} EdgeChange
 * @typedef {import("./model.js").Change} Change
 * @typedef {import("./model.js").Issue} Issue
 * @typedef {import("./controller.js").ControllerOptions} ControllerOptions
 * @typedef {import("./controller.js").ControllerEvents} ControllerEvents
 * @typedef {import("./controller.js").PointDetail} PointDetail
 * @typedef {import("./controller.js").GraphDetail} GraphDetail
 * @typedef {import("./controller.js").DisclosureDetail} DisclosureDetail
 * @typedef {import("./controller.js").TickResult} TickResult
 * @typedef {import("./controller.js").LayoutName} LayoutName
 * @typedef {import("./controller.js").PhysicsMode} PhysicsMode
 * @typedef {import("./renderer.js").Renderer} Renderer
 * @typedef {import("./renderer.js").RendererOptions} RendererOptions
 * @typedef {import("./renderer.js").FrameStats} FrameStats
 * @typedef {import("./style.js").NodeOptions} NodeOptions
 * @typedef {import("./style.js").EdgeOptions} EdgeOptions
 * @typedef {import("./animation.js").AnimationOptions} AnimationOptions
 * @typedef {import("./layouts.js").TreeLayoutOptions} TreeLayoutOptions
 * @typedef {import("./layouts.js").MergedLayoutOptions} MergedLayoutOptions
 * @typedef {import("./layouts.js").RadialLayoutOptions} RadialLayoutOptions
 * @typedef {import("./layouts.js").LayoutOptions} LayoutOptions
 * @typedef {import("./layouts.js").LayoutSpec} LayoutSpec
 * @typedef {import("./physics.js").StaticPhysicsOptions} StaticPhysicsOptions
 * @typedef {import("./physics.js").ElasticPhysicsOptions} ElasticPhysicsOptions
 * @typedef {import("./physics.js").FloatingPhysicsOptions} FloatingPhysicsOptions
 * @typedef {import("./physics.js").PhysicsOptions} PhysicsOptions
 * @typedef {import("./theme.js").Theme} Theme
 * @typedef {import("./theme.js").ThemeInput} ThemeInput
 * @typedef {import("./schema.js").OptionSpec} OptionSpec
 * @typedef {import("./snapshot.js").Snapshot} Snapshot
 * @typedef {import("./snapshot.js").SnapshotSettings} SnapshotSettings
 * @typedef {import("./snapshot.js").NodeState} NodeState
 */
