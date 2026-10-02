import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { Simulation } from "./physics.js";
import { Layouter } from "./layouter.js";
import { LineageCache } from "./picking.js";
import { Gestures } from "./gestures.js";
import * as cam from "./camera.js";
export { alongRings } from "./transitions.js";
export { looksLikeTrackpad } from "./gestures.js";
/** The dark theme's background (themes: theme.js). */
export declare const BACKGROUND: string;
export type TickResult = {
  /**
   * something is still moving or fading: keep ticking
   */
  busy: boolean;
  /**
   * seconds since the last tick, unclamped (0 for the first after a rest)
   */
  gap: number;
  /**
   * wall time spent moving nodes this tick (morph and physics), ms
   */
  simMs: number;
  /**
   * mean squared node speed
   */
  energy: number;
  /**
   * "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest"
   */
  state: string;
};
export type Restyle = {
  /**
   * styleVersion after it
   */
  version: number;
  /**
   * the nodes restyled (indices into the graph on screen); null: every one
   */
  nodes: Int32Array | null;
  /**
   * the edges restyled; null: every one
   */
  edges: Int32Array | null;
};
export type Scene = {
  /**
   * the graph on screen, with reference chips and ghosts after
   * its own nodes
   */
  graph: import("./render.js").DisplayGraph;
  /**
   * how edges bend
   */
  routing: import("./layouts.js").Routing;
  camera: import("./camera.js").Camera;
  /**
   * the node options
   */
  node: Record<string, any>;
  /**
   * the edge options, with the layout's own defaults
   */
  edge: Record<string, any>;
  /**
   * per node and edge of `graph`
   */
  looks: import("./render.js").Looks;
  /**
   * per node, 0–1: how lit it is by the hover or selection
   */
  shade: Float32Array;
  /**
   * per node, 0–1: how far it has faded in (or out, for a ghost)
   */
  appear: Float32Array;
  /**
   * how far unlit nodes fade (the animation's hoverDim)
   */
  dim: number;
  /**
   * the real nodes' positions and footprints
   */
  matrix: import("./matrix.js").Matrix;
  /**
   * each real node's label width, as the layout kept room for it
   */
  labelWidths: Float64Array | null;
  /**
   * the hovered node (an index), or -1
   */
  hover: number;
  /**
   * per real node, 1 when selected (null: nothing is)
   */
  selected: Uint8Array | null;
  selectionVersion: number;
  /**
   * per real node, 1 when its children are folded away (null: none are)
   */
  collapsed: Uint8Array | null;
  /**
   * per real node, how many nodes are hidden below it (a "+N" badge)
   */
  hidden: Int32Array | null;
  foldVersion: number;
  /**
   * bumped when anything moved
   */
  version: number;
  /**
   * bumped when only brightness or the selection changed
   */
  shadeVersion: number;
  /**
   * bumped when the layout, the styles or the graph changed
   */
  geometryVersion: number;
  /**
   * CSS px
   */
  width: number;
  height: number;
  /**
   * device pixels per CSS px
   */
  dpr: number;
  theme: import("./theme.js").Theme;
  background: string;
  styleVersion: number;
  /**
   * the latest restyles, oldest first
   */
  restyles: Restyle[];
};
export type LayoutName = "tree" | "merged" | "radial";
export type PhysicsMode = "static" | "elastic" | "floating";
export type ControllerOptions = {
  /**
   * "tree" (the default), "merged" or "radial" (see LAYOUTS)
   */
  layout?: LayoutName;
  /**
   * the layout's options, all or some
   */
  layoutOptions?: import("./layouts.js").LayoutOptions;
  /**
   * "static" (the default), "elastic" or "floating": what the layout offers
   * (LAYOUTS[layout].physics; a mode it doesn't offer is "static")
   */
  physics?: PhysicsMode;
  /**
   * the mode's options, all or some
   */
  physicsOptions?: import("./physics.js").PhysicsOptions;
  /**
   * ANIMATION_OPTIONS, all or some
   */
  animation?: Partial<import("./animation.js").AnimationOptions>;
  /**
   * every event (see `on` for one type at
   * a time)
   */
  onEvent?: (type: keyof ControllerEvents, detail?: any) => void;
  /**
   * after every drawn frame (the renderer
   * calls it)
   */
  onFrame?: (stats: import("./renderer.js").FrameStats) => void;
  /**
   * something changed that needs a tick (renderers wake their frame loop)
   */
  onChange?: () => void;
  /**
   * the time now, ms (for changes made between ticks)
   */
  clock?: () => number;
  /**
   * where layouts run: "auto" (the default) in a worker for big graphs, true
   * always in a worker, false always on the page's thread (see layouter.js)
   */
  worker?: boolean | "auto";
  /**
   * where the layout worker's script is, for bundlers that don't follow
   * `new URL("./layout-worker.js", import.meta.url)` (a module worker running layout-worker.js)
   */
  workerUrl?: string | URL;
  /**
   * what a plain wheel or two-finger scroll does: "auto" (the default)
   * zooms with a mouse wheel and pans with a trackpad; a pinch (ctrl+wheel) always zooms
   */
  wheel?: "auto" | "zoom" | "pan";
  /**
   * a tap selects the node under it (shift, ctrl or cmd: adds or removes it) and a
   * tap on empty space clears the selection (default true)
   */
  tapSelects?: boolean;
  /**
   * progressive disclosure: show this many levels below the roots and collapse
   * the rest (0: just the roots; null, the default: everything). Applies to the first graph, to `setModel`, and to
   * a graph that shares no nodes with the one before (`setGraph` with a different graph)
   */
  depth?: number | null;
  /**
   * a double tap on a node expands or collapses it (default false: a double tap
   * is only reported, so an app can give it its own meaning)
   */
  doubleTapToggles?: boolean;
  /**
   * the colours the engine picks itself (see theme.js; default
   * "dark")
   */
  theme?: import("./theme.js").ThemeInput;
};
export type PointDetail = {
  /**
   * the node's id, or null for empty space
   */
  node: string | null;
  /**
   * the node was found through one of its reference chips
   */
  reference: boolean;
  /**
   * CSS px from the canvas's left
   */
  x: number;
  y: number;
  /**
   * the same point in world coordinates
   */
  world: {
    x: number;
    y: number;
  };
  /**
   * "mouse", "touch" or "pen"
   */
  pointerType: string;
};
export type GraphDetail = {
  /**
   * in the model
   */
  nodes: number;
  edges: number;
  /**
   * nodes added (after a change; absent for a first graph)
   */
  added?: number;
  /**
   * nodes removed
   */
  removed?: number;
  /**
   * problems found (see `graphIssue`)
   */
  issues: number;
  /**
   * the model's shape (roots, depth, layers, cross-links…), worked
   * out when first read
   */
  stats: ReturnType<GraphModel["stats"]>;
};
export type DisclosureDetail = {
  /**
   * the node expanded or collapsed (null: expandAll or collapseTo)
   */
  node: string | null;
  /**
   * levels shown (expand, expandAll, collapseTo)
   */
  depth?: number;
  /**
   * the expand opened the way to a node (reveal, focus)
   */
  reveal?: boolean;
  /**
   * nodes shown now
   */
  visible: number;
  /**
   * nodes folded away now
   */
  hidden: number;
};
export type ControllerEvents = {
  /**
   * a graph was shown, or nodes or edges came or went
   */
  graph: GraphDetail;
  /**
   * a problem in the graph or a change to it (one per problem)
   */
  graphIssue: import("./model.js").Issue;
  /**
   * only data changed: nothing is drawn differently
   */
  graphData: {
    nodes: number;
    edges: number;
  };
  /**
   * nodes' or edges' labels or styles changed
   */
  graphRestyle: {
    nodes: number;
    edges: number;
  };
  /**
   * node options changed: the new values
   */
  nodeStyle: Partial<import("./style.js").NodeOptions>;
  /**
   * edge options changed: the new values
   */
  edgeStyle: Partial<import("./style.js").EdgeOptions>;
  /**
   * the layout changed (setLayout): it, and all its
   * options
   */
  layout: {
    layout: LayoutName;
  } & Record<string, any>;
  /**
   * the physics changed (setPhysics): the mode, and all
   * its options
   */
  physics: {
    mode: PhysicsMode;
  } & Record<string, any>;
  /**
   * the animation options changed (setAnimation): all
   * of them
   */
  animation: import("./animation.js").AnimationOptions;
  /**
   * the theme changed (setTheme): "dark", "light" or "custom"
   */
  theme: {
    name: string;
  };
  /**
   * the renderer changed (setRenderer): "webgl" or "canvas"
   */
  renderer: {
    renderer: string;
  };
  /**
   * everything is going back to its home (reset)
   */
  reset: undefined;
  /**
   * a snapshot is shown (restore): its node count and time
   */
  restore: {
    nodes: number;
    time: string;
  };
  /**
   * a layout is in place
   */
  laidOut: {
    layout: LayoutName;
    nodes: number;
    edges: number;
  };
  /**
   * the view has come to rest (see `settled()`)
   */
  settled: {
    nodes: number;
  };
  /**
   * the camera frames the graph (pending: a layout is on its way, and
   * another "fit" follows when it lands)
   */
  fit: {
    k: number;
    pending?: boolean;
  };
  /**
   * the camera is on its way to a node
   */
  focus: {
    node: string;
    k: number;
  };
  /**
   * the selection changed
   */
  select: {
    selected: string[];
  };
  /**
   * nodes were expanded (expand, expandAll, reveal)
   */
  expand: DisclosureDetail;
  /**
   * nodes were collapsed (collapse, collapseTo)
   */
  collapse: DisclosureDetail;
  /**
   * the pointer is over a node (or one of its chips)
   */
  hoverEnter: {
    node: string;
    reference: boolean;
  };
  /**
   * the pointer left it
   */
  hoverLeave: {
    node: string;
  };
  /**
   * a press that didn't wander (with `tapSelects`, it also selects)
   */
  tap: PointDetail;
  /**
   * the second of two quick taps in about the same place
   */
  doubleTap: PointDetail;
  /**
   * a press held still for half a second (its release isn't a tap)
   */
  longPress: PointDetail;
  /**
   * a node is being dragged (`carried`: it and its subtree)
   */
  dragStart: {
    node: string;
    carried: number;
  };
  /**
   * the drag ended:
   * whether the node was thrown (and how fast, screen px/s), or the drag was cancelled (a pinch began, the node left)
   */
  dragEnd: {
    node: string;
    thrown: boolean;
    screenSpeed: number;
    cancelled?: boolean;
  };
  /**
   * a pan began: where it started, CSS px
   */
  panStart: {
    x: number;
    y: number;
  };
  /**
   * the pan ended
   * (thrown: the camera glides on)
   */
  panEnd: {
    node?: undefined;
    thrown: boolean;
    screenSpeed: number;
    cancelled?: boolean;
  };
  /**
   * two pointers are zooming: the scale they started at
   */
  pinchStart: {
    k: number;
  };
  /**
   * the pinch ended: the scale it left
   */
  pinchEnd: {
    k: number;
  };
  /**
   * a layout failed, or the layout worker was given up on
   */
  error: {
    message: string;
  };
};
/**
 * @typedef {object} TickResult
 * @property {boolean} busy   something is still moving or fading: keep ticking
 * @property {number} gap     seconds since the last tick, unclamped (0 for the first after a rest)
 * @property {number} simMs   wall time spent moving nodes this tick (morph and physics), ms
 * @property {number} energy  mean squared node speed
 * @property {string} state   "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest"
 *
 * @typedef {object} Restyle A restyle of a few nodes and edges, for painters to patch their buffers by.
 * @property {number} version            styleVersion after it
 * @property {Int32Array | null} nodes   the nodes restyled (indices into the graph on screen); null: every one
 * @property {Int32Array | null} edges   the edges restyled; null: every one
 *
 * @typedef {object} Scene What to draw (`controller.scene`, made by every `tick`): all a painter reads.
 * @property {import("./render.js").DisplayGraph} graph the graph on screen, with reference chips and ghosts after
 *   its own nodes
 * @property {import("./layouts.js").Routing} routing how edges bend
 * @property {import("./camera.js").Camera} camera
 * @property {Record<string, any>} node  the node options
 * @property {Record<string, any>} edge  the edge options, with the layout's own defaults
 * @property {import("./render.js").Looks} looks per node and edge of `graph`
 * @property {Float32Array} shade        per node, 0–1: how lit it is by the hover or selection
 * @property {Float32Array} appear       per node, 0–1: how far it has faded in (or out, for a ghost)
 * @property {number} dim                how far unlit nodes fade (the animation's hoverDim)
 * @property {import("./matrix.js").Matrix} matrix the real nodes' positions and footprints
 * @property {Float64Array | null} labelWidths each real node's label width, as the layout kept room for it
 * @property {number} hover              the hovered node (an index), or -1
 * @property {Uint8Array | null} selected per real node, 1 when selected (null: nothing is)
 * @property {number} selectionVersion
 * @property {Uint8Array | null} collapsed per real node, 1 when its children are folded away (null: none are)
 * @property {Int32Array | null} hidden  per real node, how many nodes are hidden below it (a "+N" badge)
 * @property {number} foldVersion
 * @property {number} version            bumped when anything moved
 * @property {number} shadeVersion       bumped when only brightness or the selection changed
 * @property {number} geometryVersion    bumped when the layout, the styles or the graph changed
 * @property {number} width              CSS px
 * @property {number} height
 * @property {number} dpr                device pixels per CSS px
 * @property {import("./theme.js").Theme} theme
 * @property {string} background
 * @property {number} styleVersion
 * @property {Restyle[]} restyles        the latest restyles, oldest first
 *
 * @typedef {"tree" | "merged" | "radial"} LayoutName
 * @typedef {"static" | "elastic" | "floating"} PhysicsMode
 *
 * @typedef {object} ControllerOptions
 * @property {LayoutName} [layout]       "tree" (the default), "merged" or "radial" (see LAYOUTS)
 * @property {import("./layouts.js").LayoutOptions} [layoutOptions] the layout's options, all or some
 * @property {PhysicsMode} [physics]     "static" (the default), "elastic" or "floating": what the layout offers
 *   (LAYOUTS[layout].physics; a mode it doesn't offer is "static")
 * @property {import("./physics.js").PhysicsOptions} [physicsOptions] the mode's options, all or some
 * @property {Partial<import("./animation.js").AnimationOptions>} [animation] ANIMATION_OPTIONS, all or some
 * @property {(type: keyof ControllerEvents, detail?: any) => void} [onEvent] every event (see `on` for one type at
 *   a time)
 * @property {(stats: import("./renderer.js").FrameStats) => void} [onFrame] after every drawn frame (the renderer
 *   calls it)
 * @property {() => void} [onChange]     something changed that needs a tick (renderers wake their frame loop)
 * @property {() => number} [clock]      the time now, ms (for changes made between ticks)
 * @property {boolean | "auto"} [worker] where layouts run: "auto" (the default) in a worker for big graphs, true
 *   always in a worker, false always on the page's thread (see layouter.js)
 * @property {string | URL} [workerUrl]  where the layout worker's script is, for bundlers that don't follow
 *   `new URL("./layout-worker.js", import.meta.url)` (a module worker running layout-worker.js)
 * @property {"auto" | "zoom" | "pan"} [wheel] what a plain wheel or two-finger scroll does: "auto" (the default)
 *   zooms with a mouse wheel and pans with a trackpad; a pinch (ctrl+wheel) always zooms
 * @property {boolean} [tapSelects]      a tap selects the node under it (shift, ctrl or cmd: adds or removes it) and a
 *   tap on empty space clears the selection (default true)
 * @property {number | null} [depth]     progressive disclosure: show this many levels below the roots and collapse
 *   the rest (0: just the roots; null, the default: everything). Applies to the first graph, to `setModel`, and to
 *   a graph that shares no nodes with the one before (`setGraph` with a different graph)
 * @property {boolean} [doubleTapToggles] a double tap on a node expands or collapses it (default false: a double tap
 *   is only reported, so an app can give it its own meaning)
 * @property {import("./theme.js").ThemeInput} [theme] the colours the engine picks itself (see theme.js; default
 *   "dark")
 *
 * @typedef {object} PointDetail Where a tap, double tap or long press was, and what's there.
 * @property {string | null} node        the node's id, or null for empty space
 * @property {boolean} reference         the node was found through one of its reference chips
 * @property {number} x                  CSS px from the canvas's left
 * @property {number} y
 * @property {{ x: number, y: number }} world the same point in world coordinates
 * @property {string} pointerType        "mouse", "touch" or "pen"
 *
 * @typedef {object} GraphDetail
 * @property {number} nodes              in the model
 * @property {number} edges
 * @property {number} [added]            nodes added (after a change; absent for a first graph)
 * @property {number} [removed]          nodes removed
 * @property {number} issues             problems found (see `graphIssue`)
 * @property {ReturnType<GraphModel["stats"]>} stats the model's shape (roots, depth, layers, cross-links…), worked
 *   out when first read
 *
 * @typedef {object} DisclosureDetail
 * @property {string | null} node        the node expanded or collapsed (null: expandAll or collapseTo)
 * @property {number} [depth]            levels shown (expand, expandAll, collapseTo)
 * @property {boolean} [reveal]          the expand opened the way to a node (reveal, focus)
 * @property {number} visible            nodes shown now
 * @property {number} hidden             nodes folded away now
 *
 * @typedef {object} ControllerEvents Every event a controller sends (`on(type, listener)`, `onEvent`), by type: the
 *   detail each listener is given.
 * @property {GraphDetail} graph         a graph was shown, or nodes or edges came or went
 * @property {import("./model.js").Issue} graphIssue a problem in the graph or a change to it (one per problem)
 * @property {{ nodes: number, edges: number }} graphData only data changed: nothing is drawn differently
 * @property {{ nodes: number, edges: number }} graphRestyle nodes' or edges' labels or styles changed
 * @property {Partial<import("./style.js").NodeOptions>} nodeStyle node options changed: the new values
 * @property {Partial<import("./style.js").EdgeOptions>} edgeStyle edge options changed: the new values
 * @property {{ layout: LayoutName } & Record<string, any>} layout the layout changed (setLayout): it, and all its
 *   options
 * @property {{ mode: PhysicsMode } & Record<string, any>} physics the physics changed (setPhysics): the mode, and all
 *   its options
 * @property {import("./animation.js").AnimationOptions} animation the animation options changed (setAnimation): all
 *   of them
 * @property {{ name: string }} theme    the theme changed (setTheme): "dark", "light" or "custom"
 * @property {{ renderer: string }} renderer the renderer changed (setRenderer): "webgl" or "canvas"
 * @property {undefined} reset           everything is going back to its home (reset)
 * @property {{ nodes: number, time: string }} restore a snapshot is shown (restore): its node count and time
 * @property {{ layout: LayoutName, nodes: number, edges: number }} laidOut a layout is in place
 * @property {{ nodes: number }} settled the view has come to rest (see `settled()`)
 * @property {{ k: number, pending?: boolean }} fit the camera frames the graph (pending: a layout is on its way, and
 *   another "fit" follows when it lands)
 * @property {{ node: string, k: number }} focus the camera is on its way to a node
 * @property {{ selected: string[] }} select the selection changed
 * @property {DisclosureDetail} expand   nodes were expanded (expand, expandAll, reveal)
 * @property {DisclosureDetail} collapse nodes were collapsed (collapse, collapseTo)
 * @property {{ node: string, reference: boolean }} hoverEnter the pointer is over a node (or one of its chips)
 * @property {{ node: string }} hoverLeave the pointer left it
 * @property {PointDetail} tap          a press that didn't wander (with `tapSelects`, it also selects)
 * @property {PointDetail} doubleTap     the second of two quick taps in about the same place
 * @property {PointDetail} longPress     a press held still for half a second (its release isn't a tap)
 * @property {{ node: string, carried: number }} dragStart a node is being dragged (`carried`: it and its subtree)
 * @property {{ node: string, thrown: boolean, screenSpeed: number, cancelled?: boolean }} dragEnd the drag ended:
 *   whether the node was thrown (and how fast, screen px/s), or the drag was cancelled (a pinch began, the node left)
 * @property {{ x: number, y: number }} panStart a pan began: where it started, CSS px
 * @property {{ node?: undefined, thrown: boolean, screenSpeed: number, cancelled?: boolean }} panEnd the pan ended
 *   (thrown: the camera glides on)
 * @property {{ k: number }} pinchStart  two pointers are zooming: the scale they started at
 * @property {{ k: number }} pinchEnd    the pinch ended: the scale it left
 * @property {{ message: string }} error a layout failed, or the layout worker was given up on
 */
export declare class GraphController {
  #private;
  theme: Readonly<import("./theme.js").Theme>;
  styleVersion: number;
  restyles: any[];
  onEvent: (type: keyof ControllerEvents, detail?: any) => void;
  onFrame: (stats: import("./renderer.js").FrameStats) => void;
  onChange: () => void;
  clock: () => number;
  wheelMode: "auto" | "pan" | "zoom";
  tapSelects: boolean;
  doubleTapToggles: boolean;
  /** Levels shown below the roots when a graph is first shown (null: all of them). See ControllerOptions.depth. */
  depth: number;
  /** @type {Set<string>} the ids of collapsed nodes (view state: the model keeps every node) */
  folds: Set<string>;
  foldVersion: number;
  pivot: any;
  /** @type {Map<string, Set<(detail: any) => void>>} listeners by event type (see `on`) */
  listeners: Map<string, Set<(detail: any) => void>>;
  layout: LayoutName;
  layoutOpts: Record<string, any>;
  mode: PhysicsMode;
  modeOpts: Record<string, any>;
  anim: import("./animation.js").AnimationOptions;
  camera: {
    x: number;
    y: number;
    k: number;
  };
  glide: any;
  shift: {
    dx: number;
    dy: number;
    start: number;
    done: number;
  };
  framed: boolean;
  pendingFit: string;
  pendingFocus: {
    id: string;
    zoom: number;
    animate: boolean;
  };
  focused: string;
  width: number;
  height: number;
  dpr: number;
  hover: number;
  hoverReference: boolean;
  gestures: Gestures;
  tween: {
    x: Float64Array<ArrayBuffer>;
    y: Float64Array<ArrayBuffer>;
    start: number;
  };
  cameraTween:
    | {
        from: {
          x: number;
          y: number;
          k: number;
        };
        to: cam.Camera;
        start: number;
        node?: undefined;
      }
    | {
        from: {
          x: number;
          y: number;
          k: number;
        };
        to: {
          k: number;
          x: number;
          y: number;
        };
        start: number;
        node: string;
      }
    | {
        node?: undefined;
        from: {
          x: number;
          y: number;
          k: number;
        };
        to: cam.Camera;
        start: number;
      };
  last: number;
  version: number;
  shadeVersion: number;
  geometryVersion: number;
  /** @type {Set<string>} selected node ids, in the order they were selected */
  selection: Set<string>;
  selectionVersion: number;
  selectionCache: {
    key: number;
    graph: any;
    mask: any;
    lit: any;
  };
  lineages: LineageCache;
  grid: {
    graph: any;
    version: number;
    index: any;
  };
  lit: any;
  fading: boolean;
  arriving: boolean;
  calm: boolean;
  layoutWaiters: any[];
  settleWaiters: any[];
  /** @type {import("./ghosts.js").Ghost[]} nodes that left the graph, folding away */
  ghosts: import("./ghosts.js").Ghost[];
  /** @type {Scene | null} what to draw, made by every tick */
  scene: Scene | null;
  /** @type {import("./renderer.js").Renderer | null} */
  renderer: import("./renderer.js").Renderer | null;
  model: GraphModel;
  unlisten: () => void;
  graph: Graph;
  looks: import("./render.js").Looks;
  /** @type {import("./layouts.js").Routing} how edges bend, for the layout on screen */
  routing: import("./layouts.js").Routing;
  homeBox: cam.Box;
  layouter: Layouter;
  layoutRequest: number;
  /** True while a layout is being worked out in the worker (the graph on screen carries on meanwhile). */
  layoutPending: boolean;
  shade: Float32Array<ArrayBuffer>;
  appear: Float32Array<ArrayBuffer>;
  sim: Simulation;
  quiet: boolean;
  labelWidths: any;
  /**
   * @param {GraphModel | object} model  the graph to show (JSON is made into a model)
   * @param {import("./renderer.js").Renderer | null} [renderer] the screen; none runs headless
   * @param {ControllerOptions} [options]
   */
  constructor(
    model: GraphModel | object,
    renderer?: import("./renderer.js").Renderer | null,
    {
      layout,
      layoutOptions,
      physics,
      physicsOptions: physicsOpts,
      animation,
      onEvent,
      onFrame,
      onChange,
      clock,
      worker,
      workerUrl,
      wheel,
      tapSelects,
      depth,
      doubleTapToggles,
      theme,
    }?: ControllerOptions,
  );
  /**
   * How nodes look: the model's node options.
   * @returns {import("./style.js").NodeOptions}
   */
  get node(): import("./style.js").NodeOptions;
  /**
   * How edges look: the model's edge options, with the layout's own defaults (LAYOUTS[layout].edgeDefaults) for any
   * key the model's options leave at its default (`model.explicit`). So an edge's own style wins, then an edge option
   * set on purpose, then the layout's default, then EDGE_OPTIONS' default.
   * @returns {import("./style.js").EdgeOptions}
   */
  get edge(): import("./style.js").EdgeOptions;
  /**
   * Call `listener(detail)` on every event of `type` (or `onEvent` for all of them). Returns a function that stops
   * it.
   * @template {keyof ControllerEvents} K
   * @param {K} type
   * @param {(detail: ControllerEvents[K]) => void} listener
   * @returns {() => void}
   */
  on<K extends keyof ControllerEvents>(
    type: K,
    listener: (detail: ControllerEvents[K]) => void,
  ): () => void;
  /**
   * The colours the engine picks itself: "dark", "light", or an object of colours over one of them (theme.js).
   * Graph and option colours that were set stay as they are.
   * @param {import("./theme.js").ThemeInput} theme
   * @returns {Readonly<import("./theme.js").Theme>} the theme now in use
   */
  setTheme(
    theme: import("./theme.js").ThemeInput,
  ): Readonly<import("./theme.js").Theme>;
  /**
   * Replace the graph: the model takes `input` (JSON, or another model's graph) and keeps what's unchanged.
   * @param {import("./model.js").GraphJSON | GraphModel} input
   * @returns {import("./model.js").Change | null}
   */
  setGraph(
    input: import("./model.js").GraphJSON | GraphModel,
  ): import("./model.js").Change | null;
  /**
   * Change the graph by a delta (see GraphModel.update).
   * @param {import("./model.js").Delta} delta
   * @returns {import("./model.js").Change | null}
   */
  update(delta: import("./model.js").Delta): import("./model.js").Change | null;
  /**
   * Show a different model: its nodes glide from where the same ids were in the old one.
   * @param {GraphModel | import("./model.js").GraphJSON} model
   */
  setModel(model: GraphModel | import("./model.js").GraphJSON): void;
  /**
   * Everything needed to show this view again exactly: the graph, settings, camera, selection, collapsed nodes and
   * every shown node's layout state (see snapshot.js and next/MODEL.md). While a layout is on its way, it's the graph
   * on screen. `settings.explicit` lists the node and edge options set on purpose (the rest are defaults, the
   * layout's or the engine's).
   * @param {string} [note] why it's taken (kept in the snapshot)
   * @returns {import("./snapshot.js").Snapshot}
   */
  snapshot(note?: string): import("./snapshot.js").Snapshot;
  /**
   * Show a snapshot: its graph, settings, camera, selection, collapsed nodes and node positions, as they were (no
   * morph). Throws on anything that isn't a snapshot this engine can read.
   * @param {import("./snapshot.js").Snapshot} snapshot
   */
  restore(snapshot: import("./snapshot.js").Snapshot): void;
  /**
   * Draw on `renderer` from now on (the old one lets go of the screen). Its text measurement becomes the model's,
   * unless the model was given its own.
   * @param {import("./renderer.js").Renderer | null} renderer
   */
  setRenderer(renderer: import("./renderer.js").Renderer | null): void;
  /** Stop listening to the model, let go of the renderer, and stop the layout worker. */
  destroy(): void;
  /**
   * How things move between states (ANIMATION_OPTIONS, all or some).
   * @param {Partial<import("./animation.js").AnimationOptions>} [opts]
   */
  setAnimation(opts?: Partial<import("./animation.js").AnimationOptions>): void;
  /**
   * Lay out with layout `name` (see LAYOUTS) and its options, all or some. A new layout is framed. An unknown name
   * throws.
   * @param {LayoutName} name
   * @param {import("./layouts.js").LayoutOptions} [opts]
   */
  setLayout(
    name: LayoutName,
    opts?: import("./layouts.js").LayoutOptions,
  ): void;
  /**
   * Move with physics `mode` ("static", "elastic", "floating": what the layout offers, see LAYOUTS) and its options,
   * all or some. Leave out the mode (null) to change only options. A mode the layout doesn't offer throws, and
   * changes nothing.
   * @param {PhysicsMode | null} [mode]
   * @param {import("./physics.js").PhysicsOptions} [opts]
   */
  setPhysics(
    mode?: PhysicsMode | null,
    opts?: import("./physics.js").PhysicsOptions,
  ): void;
  /**
   * How nodes look (NODE_OPTIONS, all or some): the model's options, so every view of it changes.
   * @param {Partial<import("./style.js").NodeOptions>} opts
   */
  setNodeStyle(opts: Partial<import("./style.js").NodeOptions>): void;
  /**
   * How edges look (EDGE_OPTIONS, all or some).
   * @param {Partial<import("./style.js").EdgeOptions>} opts
   */
  setEdgeStyle(opts: Partial<import("./style.js").EdgeOptions>): void;
  /** Send everything back to its home (a node being dragged is let go first). */
  reset(): void;
  /**
   * The drawing area's size in CSS px, and device pixels per CSS px. Frames again if the camera hasn't been moved.
   * (A renderer calls this; headless, call it yourself.)
   * @param {number} width
   * @param {number} height
   * @param {number} [dpr]
   */
  setViewport(width: number, height: number, dpr?: number): void;
  /**
   * A point on the canvas (CSS px from its top-left) in world coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  toWorld(
    x: number,
    y: number,
  ): {
    x: number;
    y: number;
  };
  /**
   * A world point on the canvas (CSS px from its top-left).
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  toScreen(
    x: number,
    y: number,
  ): {
    x: number;
    y: number;
  };
  /**
   * Frame the graph where it is (or where it's heading, mid-transition). While a layout is on its way, the graph it
   * brings is framed when it arrives (and the graph on screen meanwhile).
   * @param {boolean} [animate] glide there (the default), or jump
   */
  fit(animate?: boolean): void;
  /**
   * Bring node `id` to the middle of the view, gliding there (and following it if it moves on the way, or if a new
   * layout moves it). `zoom`: the scale to arrive at (default: as it is, but at least 1, so its label can be read).
   * A node that's in the model but still being laid out is focused once it's in place. Returns false for an id
   * that isn't there.
   * @param {string} id
   * @param {{ zoom?: number, animate?: boolean }} [options]
   */
  focus(
    id: string,
    {
      zoom,
      animate,
    }?: {
      zoom?: number;
      animate?: boolean;
    },
  ): boolean;
  /**
   * How far the camera may zoom: in to 8×, out to 0.05×, or further if that's what it takes to see the whole graph
   * (half its fit, so there's room around it).
   * @returns {{ min: number, max: number }}
   */
  zoomLimits(): {
    min: number;
    max: number;
  };
  /**
   * Zoom by `factor` about canvas point (x, y) (default: the middle), keeping the world point under it in place.
   * For zoom buttons, and the renderer's pinch gestures.
   * @param {number} factor above 1 zooms in
   * @param {number} [x]
   * @param {number} [y]
   */
  zoomBy(factor: number, x?: number, y?: number): void;
  /**
   * A promise that resolves once the newest layout asked for is in place: `graph`, `fit()` and `snapshot()` then
   * see the graph as the model has it. Straight away when nothing is being laid out (small graphs lay out on the
   * spot); after the worker answers for big ones. Rejects if that layout fails.
   * @returns {Promise<void>}
   */
  laidOut(): Promise<void>;
  /**
   * A promise that resolves once the view has settled: the newest layout is in place, and the morph, camera moves,
   * fade-ins and ghosts are done, nothing is held, and the physics is at rest (a graph that drifts forever counts
   * once everything else is done). It's ticks that move things on: with a renderer that's the frame loop; headless,
   * whoever calls `tick`. A "settled" event is sent at the same moment.
   * @returns {Promise<void>}
   */
  settled(): Promise<void>;
  /**
   * Advance everything to `now` (ms): layout morphs, physics, the camera, hover and fades, ghosts, long presses.
   * Then `scene` holds what to draw. Returns whether anything is still moving.
   * @param {number} now ms, on the controller's clock
   * @returns {TickResult}
   */
  tick(now: number): TickResult;
  /** Nothing more to do for now: the next tick starts timing afresh instead of seeing one long gap. */
  rest(): void;
  /**
   * Tick from `start` to `start + ms`, `step` ms at a time (tests and headless use). Returns the last result.
   * @param {number} ms
   * @param {{ start?: number, step?: number }} [options]
   * @returns {TickResult | null}
   */
  run(
    ms: number,
    {
      start,
      step,
    }?: {
      start?: number;
      step?: number;
    },
  ): TickResult | null;
  /** The selected node ids, in the order they were selected. */
  get selected(): string[];
  /**
   * Select node `ids` (one id, a list, or null for none) in place of the selection; with `add`, as well as it; with
   * `toggle`, flipping each in or out. Ids the model doesn't have are skipped. Sends a "select" event and returns
   * true when the selection changed.
   * @param {string | string[] | null} ids
   * @param {{ add?: boolean, toggle?: boolean }} [options]
   */
  select(
    ids: string | string[] | null,
    {
      add,
      toggle,
    }?: {
      add?: boolean;
      toggle?: boolean;
    },
  ): boolean;
  /** The ids of the collapsed nodes. */
  get collapsed(): string[];
  /**
   * Whether node `id` is collapsed (its children are folded away).
   * @param {string} id
   * @returns {boolean}
   */
  isCollapsed(id: string): boolean;
  /**
   * Whether node `id` is in the model but not shown (folded away under a collapsed node).
   * @param {string} id
   * @returns {boolean}
   */
  isHidden(id: string): boolean;
  /**
   * How many nodes are hidden below node `id` (0 unless it's shown and collapsed): what a "+N" badge shows.
   * @param {string} id
   * @returns {number}
   */
  hiddenCount(id: string): number;
  /**
   * Collapse node `id`: what's below it, and not shown through another path, folds into it. Leaves can't be.
   * @param {string} id
   * @returns {boolean} whether anything changed
   */
  collapse(id: string): boolean;
  /**
   * Expand node `id` to show `depth` levels below it (default 1, its children; Infinity: everything below it).
   * Nodes those levels bring into view that lead on to more hidden nodes start collapsed, so one expand never spills
   * a whole subtree; nodes already shown elsewhere stay as they are. An expanded node that's itself hidden stays
   * hidden (see `reveal`).
   * @param {string} id
   * @param {{ depth?: number }} [options]
   * @returns {boolean} whether anything changed
   */
  expand(
    id: string,
    {
      depth,
    }?: {
      depth?: number;
    },
  ): boolean;
  /**
   * Expand node `id` if it's collapsed, else collapse it.
   * @param {string} id
   * @returns {boolean} whether anything changed
   */
  toggle(id: string): boolean;
  /**
   * Show everything: no node collapsed.
   * @returns {boolean} whether anything changed
   */
  expandAll(): boolean;
  /**
   * Show `depth` levels below the roots (0: just the roots) and collapse everything deeper.
   * @param {number} depth
   * @returns {boolean} whether anything changed
   */
  collapseTo(depth: number): boolean;
  /**
   * Show node `id`: expand the collapsed nodes on its path from a root (whatever else that brings into view starts
   * collapsed, so only the path opens). False when it's shown already or not in the model. `focus` does this itself.
   * @param {string} id
   * @returns {boolean}
   */
  reveal(id: string): boolean;
  /**
   * A press at canvas point (x, y). The first pointer grabs the node there or starts a pan; a second one turns the
   * two into a pinch (the drag or pan ends); any more are ignored until those lift.
   * @param {import("./gestures.js").PointerInput} input
   */
  pointerDown(input: import("./gestures.js").PointerInput): void;
  /**
   * A pointer moved to canvas point (x, y): a pressed one drags, pans or pinches; one that isn't pressed (a mouse
   * or pen hovering) hovers.
   * @param {import("./gestures.js").PointerInput} input
   */
  pointerMove(input: import("./gestures.js").PointerInput): void;
  /**
   * The press ended: a dragged node is let go (thrown, if it was moving), a pan glides on, a pinch's other pointer
   * pans on. A press that didn't wander is a tap (two quick ones a double tap), unless it was a long press.
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerUp(input?: Partial<import("./gestures.js").PointerInput>): void;
  /**
   * The press was taken away (the browser's pointercancel: a system gesture, the pointer lost): like a release, but
   * nothing is thrown and it's never a tap.
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerCancel(input?: Partial<import("./gestures.js").PointerInput>): void;
  /**
   * The pointer left the canvas: no more hover (a press in progress carries on).
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerLeave(input?: Partial<import("./gestures.js").PointerInput>): void;
  /**
   * A wheel or a trackpad at canvas point (x, y). A pinch on a trackpad (ctrl+wheel) zooms about the point, and so
   * does a mouse wheel; a two-finger scroll on a trackpad pans (see the `wheel` option). Lines and pages
   * (`deltaMode` 1 and 2) are turned into pixels first, so every browser zooms at the same speed.
   * @param {import("./gestures.js").WheelInput} input
   */
  wheel(input: import("./gestures.js").WheelInput): void;
  /**
   * A double-click at canvas point (x, y): on empty space, frame the graph. (Taps find double taps themselves.)
   * @param {{ x: number, y: number }} input
   */
  doubleClick({ x, y }: { x: number; y: number }): void;
  /** Pressed pointers by id (see gestures.js). */
  get pointers(): Map<number, import("./gestures.js").Pointer>;
  /** The pressed pointer that's dragging a node or panning (there's at most one), or null. */
  get pointer(): import("./gestures.js").Pointer;
  /** Two pointers pinching, or null. */
  get pinch(): {
    a: any;
    b: any;
    dist: number;
    k: number;
    anchor: {
      x: number;
      y: number;
    };
  };
  /**
   * What the pointer should look like: "grab" over a node, "grabbing" while dragging one, "default" over a
   * reference (it lights up its ingredient but can't be dragged), "" otherwise.
   */
  get cursor(): "" | "default" | "grab" | "grabbing";
  /**
   * The topmost node under a world point, or -1. With `references`, a reference under the point counts as its
   * ingredient (for hover: pointing at a reference lights up the ingredient and everything that uses it).
   * @param {{ x: number, y: number }} p
   * @param {{ references?: boolean }} [options]
   * @returns {number} an index into `graph`
   */
  hit(
    p: {
      x: number;
      y: number;
    },
    {
      references,
    }?: {
      references?: boolean;
    },
  ): number;
}
