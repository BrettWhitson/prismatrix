// GraphController: the middle of the engine. It's handed a GraphModel (what the graph is and how it looks) and a
// renderer (the screen), and works between them:
//
//   - it listens to the model and keeps up with every change: a new colour is redrawn, a new label or size is laid
//     out again, new or removed nodes are laid out again and morphed into place, new data costs nothing on screen;
//   - it owns everything that moves and must be fast: the matrix of node positions and velocities (graph.js,
//     matrix.js), the layout, physics, animation, camera, hover, selection and drags;
//   - every frame, the renderer asks it to `tick` and draws the `scene` it builds.
//
// It has no DOM: a renderer (renderer.js) turns pointer and wheel events into the calls below and runs the frame
// loop. Without one it runs headless: tests set a viewport, press, drag, release, tick time forward and look at the
// result. Input coordinates are CSS pixels from the canvas's top-left corner; times are milliseconds on one clock
// (the renderer's frame timestamps and event times, or a test's own).
//
// What happens between frames is kept by node id, not by row: when nodes come or go the working graph is rebuilt
// with new rows, and a drag, the hover, the selection and fades carry over to the same ids.
//
// The parts: gestures.js (what pointers and wheels mean), camera.js (framing, zoom limits, coasting), transitions.js
// (morphs, arrivals, shading), picking.js (what's under the pointer, lineages). This file coordinates them with the
// model and the layouts.

import { ANIMATION_OPTIONS, EASINGS } from "./animation.js";
import { footprint, labelAngle } from "./boxes.js";
import { departures, withGhosts } from "./ghosts.js";
import {
  collapsedAt,
  disclose,
  expandedTo,
  hiddenBelow,
  revealed,
} from "./disclosure.js";
import { referenceRadius, withReferences } from "./references.js";
import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { applyState, snapshotModel, takeSnapshot } from "./snapshot.js";
import { LAYOUTS, constrainer } from "./layouts.js";
import { Simulation, physicsOptions, referencedEdges } from "./physics.js";
import { drawScene, looksOf, patchLooks } from "./render.js";
import { iconStore } from "./icons.js";
import { resolveTheme } from "./theme.js";
import { labelPlace } from "./style.js";
import {
  hintFrom,
  runLayout,
  sizingSpec,
  unpackRouting,
} from "./layout-job.js";
import { Layouter } from "./layouter.js";
import { resolve } from "./schema.js";
import { HIT_SCALE, HitGrid, LineageCache, lineageMask } from "./picking.js";
import { Gestures } from "./gestures.js";
import * as cam from "./camera.js";
import { arrive, fade, morph, progress } from "./transitions.js";

/** Restyles the scene's log keeps (see #restyle): a painter further behind than this rebuilds everything. */
const RESTYLE_LOG = 16;

/** Whether two integer arrays hold the same values. */
const sameInts = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether two sets hold the same values. */
const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

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
 * @property {Uint8Array | null} highlighted per real node, 1 when highlighted (null: nothing is)
 * @property {Float32Array | null} flashes per real node, how strongly it's flashing, 0–1 (null: none is)
 * @property {Float32Array | null} pulses per real node, how far through a pulse it is, 0–1 (null: none is; 0 for none)
 * @property {Uint8Array | null} lineage the lineage lit by the hover or the selection: a lineageMask per real node
 *   (bit 2: reached going up, bit 4: going down), or null (also while a highlight is what's lit)
 * @property {import("./animation.js").AnimationOptions} anim
 * @property {number} time               ms, on the controller's clock (for flow)
 * @property {number} selectionVersion   bumped when the selection, highlight, a flash or a pulse changes
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
 * @property {import("./camera.js").Camera} camera the camera moved (any way: a pan, a zoom, a fit, a glide), once a
 *   tick at most: where it is now
 * @property {{ selected: string[] }} select the selection changed
 * @property {{ highlighted: string[] }} highlight the highlighted nodes changed (highlight)
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

/** How long a pulse takes, ms. */
const PULSE_MS = 450;

/** Wait (up to `ms`) for every icon and badge image in `looks` to finish loading (or fail), in `icons`. */
function iconsReady(icons, looks, ms) {
  const waiting = new Set();
  for (const list of [looks.icon, looks.badgeIcon])
    for (const source of list ?? []) {
      const entry = icons.get(source);
      if (entry?.state === "loading") waiting.add(entry);
    }
  if (!waiting.size) return Promise.resolve();
  return new Promise((/** @type {(value?: void) => void} */ done) => {
    const finish = () => {
      clearTimeout(timer);
      stop();
      done();
    };
    const timer = setTimeout(finish, ms);
    const stop = icons.onReady((entry) => {
      waiting.delete(entry);
      if (!waiting.size) finish();
    });
  });
}

/** A picture of the graph (toImage) is at most this many px on a side, and this many px in all. */
const IMAGE_SIDE = 16_000;
const IMAGE_PIXELS = 120_000_000;

export class GraphController {
  #shownCache = null; // the display graph with references, and what it was made from
  #edgeCache = null; // the edge options with the layout's own defaults, and what they were made from
  #disclosed = null; // what's shown with the collapsed nodes as they are (see #disclosure)
  #parts = 0; // parts of the model shown so far, numbered (each one's graph key)
  #marks = null; // the scene's collapsed flags and hidden counts, and what they were made for

  /**
   * @param {GraphModel | object} model  the graph to show (JSON is made into a model)
   * @param {import("./renderer.js").Renderer | null} [renderer] the screen; none runs headless
   * @param {ControllerOptions} [options]
   */
  constructor(
    model,
    renderer = null,
    {
      layout = "tree",
      layoutOptions,
      physics = "static",
      physicsOptions: physicsOpts,
      animation,
      onEvent,
      onFrame,
      onChange,
      clock = () => performance.now(),
      worker = "auto",
      workerUrl,
      wheel = "auto",
      tapSelects = true,
      depth = null,
      doubleTapToggles = false,
      theme,
    } = {},
  ) {
    this.theme = resolveTheme(theme);
    // Restyles of a few nodes and edges, newest last, for painters to patch their buffers by: { version, nodes,
    // edges } (indices; null for a restyle of everything), version being styleVersion after it.
    this.styleVersion = 0;
    this.restyles = [];
    this.onEvent = onEvent;
    this.onFrame = onFrame;
    this.onChange = onChange;
    this.clock = clock;
    this.wheelMode = wheel;
    this.tapSelects = tapSelects;
    this.doubleTapToggles = doubleTapToggles;
    /** Levels shown below the roots when a graph is first shown (null: all of them). See ControllerOptions.depth. */
    this.depth = depth;
    /** @type {Set<string>} the ids of collapsed nodes (view state: the model keeps every node) */
    this.folds = new Set();
    this.foldVersion = 0; // bumped whenever the collapsed set changes
    this.pivot = null; // the node just expanded or collapsed: the camera holds still on it while the rest moves
    /** @type {Map<string, Set<(detail: any) => void>>} listeners by event type (see `on`) */
    this.listeners = new Map();
    if (!LAYOUTS[layout]) throw new Error(`Unknown layout "${layout}"`);
    this.layout = layout;
    this.layoutOpts = resolve(LAYOUTS[layout].options, layoutOptions);
    this.mode = LAYOUTS[layout].physics[physics] ? physics : "static";
    this.modeOpts = physicsOptions(layout, this.mode, physicsOpts);
    this.anim = /** @type {import("./animation.js").AnimationOptions} */ (
      resolve(ANIMATION_OPTIONS, animation)
    );
    this.camera = { x: 0, y: 0, k: 1 };
    this.cameraSent = null; // the camera as the last "camera" event had it
    this.glide = null; // the camera's coasting speed after a pan, world px/s
    // The camera keeping step with a morph, so the node it's anchored on stays put on screen (see #holdPlace).
    this.shift = null;
    // True while the camera shows a framing the controller chose (not one the user panned or zoomed to): a resize
    // then frames again, so a view sized late (a hidden tab, a panel opening) doesn't stay zoomed for the wrong size.
    this.framed = false;
    this.pendingFit = null; // "instant" or "animate": how a fit asked for while a layout is on its way frames it
    this.pendingFocus = null; // a focus(id) on a node that's in the model but not yet laid out
    this.focused = null; // the id last focused, until the user moves the camera (an anchor for relayouts)
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.hover = -1; // the node under a hovering pointer (an index into the working graph), or -1
    this.hoverReference = false; // found through one of its references
    this.gestures = new Gestures(this, {
      emit: (type, detail) => this.#emit(type, detail),
      changed: () => this.#changed(),
      pick: (p, references) => this.#pick(p, references),
      hover: (index, reference) => this.#setHover(index, reference),
      carried: (index) => this.#carried(index),
      userCamera: () => this.#userCamera(),
    });
    this.tween = null;
    this.cameraTween = null;
    this.last = 0;
    // Bumped whenever node positions, the graph or the styles change: a renderer can keep what it built for a
    // frame until it moves (panning and zooming redraw without rebuilding).
    this.version = 0;
    this.shadeVersion = 0; // bumped when only brightness or selection changes: no geometry to rebuild
    // Bumped when the layout, the styles or the graph change, not when nodes move: what a renderer builds from
    // homes and looks (edge pieces) lasts until then.
    this.geometryVersion = 0;
    /** @type {Set<string>} selected node ids, in the order they were selected */
    this.selection = new Set();
    this.selectionVersion = 0;
    this.selectionCache = { key: -1, graph: null, mask: null, lit: null };
    /** @type {Set<string>} highlighted node ids (highlight) */
    this.highlightIds = new Set();
    this.highlightVersion = 0;
    this.highlightCache = { key: -1, graph: null, mask: null };
    /** @type {Map<string, { start: number, ms: number }>} nodes flashing (flash) */
    this.flashes = new Map();
    /** @type {Map<string, number>} nodes pulsing (pulse): when each started */
    this.pulses = new Map();
    this.lineages = new LineageCache();
    this.grid = { graph: null, version: -1, index: null };
    this.lit = null; // the lineage mask the shading is heading for (null: everything lit)
    this.fading = false; // shading or fade-ins still on their way
    this.arriving = false; // new nodes still fading in
    this.calm = false; // the last tick found everything settled (see settled())
    this.layoutWaiters = [];
    this.settleWaiters = [];
    /** @type {import("./ghosts.js").Ghost[]} nodes that left the graph, folding away */
    this.ghosts = [];
    /** @type {Scene | null} what to draw, made by every tick */
    this.scene = null;
    /** @type {import("./renderer.js").Renderer | null} */
    this.renderer = null;

    this.model = GraphModel.from(model);
    this.unlisten = this.model.onChange((change) => this.#onModel(change));
    if (this.depth !== null) this.folds = collapsedAt(this.model, this.depth);
    this.graph = new Graph(); // empty until the first layout below
    this.#carry(null, null);
    this.looks = looksOf(this.graph, this.node, this.edge, this.theme);
    /** @type {import("./layouts.js").Routing} how edges bend, for the layout on screen */
    this.routing = { kind: "tree", direction: "TB" };
    this.homeBox = null;
    this.layouter = new Layouter({
      worker,
      workerUrl,
      onFallback: (message) => this.#emit("error", { message }),
    });
    this.layoutRequest = 0;
    /** True while a layout is being worked out in the worker (the graph on screen carries on meanwhile). */
    this.layoutPending = false;
    // The renderer first: it brings the viewport size and real text measurement, which the first layout uses.
    if (renderer) this.setRenderer(renderer);
    this.#relayout();
    this.#reportGraph();
    for (const issue of this.model.issues) this.#emit("graphIssue", issue);
  }

  /**
   * How nodes look: the model's node options.
   * @returns {import("./style.js").NodeOptions}
   */
  get node() {
    return this.model.opts.node;
  }

  /**
   * How edges look: the model's edge options, with the layout's own defaults (LAYOUTS[layout].edgeDefaults) for any
   * key the model's options leave at its default (`model.explicit`). So an edge's own style wins, then an edge option
   * set on purpose, then the layout's default, then EDGE_OPTIONS' default.
   * @returns {import("./style.js").EdgeOptions}
   */
  get edge() {
    const opts = this.model.opts.edge;
    const defaults = LAYOUTS[this.layout].edgeDefaults;
    if (!defaults) return opts;
    const c = this.#edgeCache;
    if (c && c.opts === opts && c.layout === this.layout) return c.edge;
    const edge = { ...opts };
    for (const [key, value] of Object.entries(defaults))
      if (!this.model.explicit.edge.has(key)) edge[key] = value;
    this.#edgeCache = { opts, layout: this.layout, edge };
    return edge;
  }

  // ---- events --------------------------------------------------------------------------------------------------

  /**
   * Call `listener(detail)` on every event of `type` (or `onEvent` for all of them). Returns a function that stops
   * it.
   * @template {keyof ControllerEvents} K
   * @param {K} type
   * @param {(detail: ControllerEvents[K]) => void} listener
   * @returns {() => void}
   */
  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  #emit(type, detail) {
    // A listener that throws is reported, not passed on: it mustn't leave the controller half way through a change.
    const call = (fn, ...args) => {
      try {
        fn(...args);
      } catch (error) {
        console.error(`Prismatrix: a "${type}" listener threw`, error);
      }
    };
    if (this.onEvent) call(this.onEvent, type, detail);
    const set = this.listeners.get(type);
    if (set) for (const fn of [...set]) call(fn, detail);
  }

  /** Something changed that needs a frame. */
  #changed() {
    this.renderer?.invalidate();
    this.onChange?.();
  }

  // ---- the model -----------------------------------------------------------------------------------------------

  /**
   * The model changed (an update, a replace, new options): do as little as that change needs. Nodes or edges came
   * or went → lay out again and morph (kept nodes glide from where they are, new ones arrive as the animation's
   * `enter` setting says, removed ones fold back into their family). A node's room changed → lay out again. Only
   * looks changed → restyle, nothing moves. Only data changed → nothing to draw.
   */
  #onModel(change) {
    if (this.quiet) return;
    for (const issue of change.issues) this.#emit("graphIssue", issue);
    if (change.options) {
      const { node, edge } = change.options;
      if (Object.keys(node).length) this.#emit("nodeStyle", node);
      if (Object.keys(edge).length) this.#emit("edgeStyle", edge);
      if (change.sizes) this.#relayout({ fit: null });
      else this.#restyle();
      return;
    }
    if (change.structure) {
      const shown = this.graph.nodes.length;
      this.#keepFolds(change);
      this.#relayout();
      this.#reportGraph(
        shown && {
          added: change.nodesAdded.length,
          removed: change.nodesRemoved.length,
        },
      );
      return;
    }
    // The same nodes and edges with new records: the graph on screen takes the changed ones (unless a new structure
    // is being laid out: the graph that brings takes the model's records when it's put in place).
    this.#patchRecords(change);
    const counts = {
      nodes: change.nodesChanged.length,
      edges: change.edgesChanged.length,
    };
    // Data alone (a price, a rarity): nothing is drawn differently and nothing moves. No frame, no rebuild.
    if (change.dataOnly) return this.#emit("graphData", counts);
    if (change.sizes) this.#relayout({ fit: null });
    else this.#restyle(change);
    this.#emit("graphRestyle", counts);
  }

  /**
   * The changed nodes' and edges' new records, onto the working graph (when it's the model's current structure).
   * Nodes and edges folded away have none there: the graph that shows them takes the model's records when it's made.
   */
  #patchRecords({ nodesChanged, edgesChanged }) {
    const { graph, model } = this;
    if (!this.#isCurrent()) return;
    for (const id of nodesChanged) {
      const i = graph.indexOf(model.index.get(id));
      if (i >= 0) graph.nodes[i].record = model.node(id);
    }
    for (const id of edgesChanged) {
      const i = graph.edgeIndexOf(model.edgeIndex.get(id));
      if (i < 0) continue;
      const record = model.edge(id);
      graph.edges[i].label = record.label;
      graph.edges[i].style = record.style;
      graph.edges[i].data = record.data;
    }
  }

  /**
   * A "graph" event: how many nodes and edges, what came and went (`extra`), issues, and `stats` (the model's
   * shape: roots, depth, layers, cross-links…), worked out only if a listener reads it (it walks the whole graph).
   */
  #reportGraph(extra = {}) {
    const { model } = this;
    let stats = null;
    this.#emit("graph", {
      nodes: model.size,
      edges: model.edgeIndex.size,
      ...extra,
      issues: model.issues.length,
      get stats() {
        return (stats ??= model.stats());
      },
    });
  }

  /**
   * Looks changed, nothing moved: new colours and sizes for the renderer. A model change that restyled some nodes
   * and edges (`change`) redoes just their looks and logs which (`restyles`), so painters patch just those; anything
   * else (new options, a theme) redoes every look.
   */
  #restyle(change = null) {
    const { graph, model } = this;
    this.styleVersion++;
    let nodes = null,
      edges = null;
    if (change && this.#isCurrent()) {
      // By their index in the graph on screen; nodes and edges folded away aren't there.
      const shown = (ids, index, local) =>
        ids.map((id) => local(index.get(id))).filter((i) => i >= 0);
      const done = patchLooks(
        this.looks,
        graph,
        this.node,
        this.edge,
        shown(change.nodesRestyled, model.index, (i) => graph.indexOf(i)),
        shown(change.edgesRestyled, model.edgeIndex, (i) =>
          graph.edgeIndexOf(i),
        ),
      );
      ({ nodes, edges } = done);
    } else {
      this.looks = looksOf(graph, this.node, this.edge, this.theme);
      this.version++;
      this.geometryVersion++;
    }
    this.restyles.push({ version: this.styleVersion, nodes, edges });
    if (this.restyles.length > RESTYLE_LOG) this.restyles.shift();
    this.#changed();
  }

  /**
   * The colours the engine picks itself: "dark", "light", or an object of colours over one of them (theme.js).
   * Graph and option colours that were set stay as they are.
   * @param {import("./theme.js").ThemeInput} theme
   * @returns {Readonly<import("./theme.js").Theme>} the theme now in use
   */
  setTheme(theme) {
    this.theme = resolveTheme(theme);
    this.#restyle();
    this.#emit("theme", { name: this.theme.name });
    return this.theme;
  }

  /**
   * Replace the graph: the model takes `input` (JSON, or another model's graph) and keeps what's unchanged.
   * @param {import("./model.js").GraphJSON | GraphModel} input
   * @returns {import("./model.js").Change | null}
   */
  setGraph(input) {
    return this.model.replace(input);
  }

  /**
   * Change the graph by a delta (see GraphModel.update).
   * @param {import("./model.js").Delta} delta
   * @returns {import("./model.js").Change | null}
   */
  update(delta) {
    return this.model.update(delta);
  }

  /**
   * Show a different model: its nodes glide from where the same ids were in the old one.
   * @param {GraphModel | import("./model.js").GraphJSON} model
   */
  setModel(model) {
    this.unlisten();
    this.model = GraphModel.from(model);
    if (this.renderer?.measureText && !this.model.measured)
      this.model.setMeasure(this.renderer.measureText);
    this.unlisten = this.model.onChange((change) => this.#onModel(change));
    this.folds =
      this.depth === null ? new Set() : collapsedAt(this.model, this.depth);
    this.foldVersion++;
    this.#relayout();
    this.#reportGraph();
  }

  /**
   * Per-node state for a new working graph (`this.graph`), carried over by id from `previous` (the graph that was on
   * screen, or null): the simulation, hover, shading and fade-ins, drags in progress, and the selection.
   * @param {Graph | null} previous
   * @param {Int32Array | null} was  per node of the new graph, its index in `previous` (-1: new)
   */
  #carry(previous, was) {
    const { graph } = this;
    const count = graph.nodes.length;
    const shade = new Float32Array(count).fill(1);
    const appear = new Float32Array(count).fill(1);
    if (previous)
      for (let i = 0; i < count; i++)
        if (was[i] >= 0) {
          shade[i] = this.shade[was[i]];
          appear[i] = this.appear[was[i]];
        }
    // Per node, 0–1: how lit it is by the hover (eased toward its target), and how far it has faded in.
    this.shade = shade;
    this.appear = appear;
    this.fading = this.arriving = true; // worked out again by the next fade
    this.sim = new Simulation(graph);
    const hover =
      previous && this.hover >= 0
        ? (graph.byId.get(previous.nodes[this.hover].id)?.index ?? -1)
        : -1;
    if (hover < 0) this.#setHover(-1, false, previous);
    else this.hover = hover;
    // Drags hold the same nodes at their new rows (one whose node is gone ends, and its pointer pans on).
    this.gestures.rebind();
    // The selection is by id: ids that left the model leave it (ones only folded away stay selected).
    const gone = [...this.selection].filter((id) => !this.model.node(id));
    if (gone.length && previous) {
      for (const id of gone) this.selection.delete(id);
      this.selectionVersion++;
      this.#emit("select", { selected: this.selected });
    }
  }

  /**
   * Everything needed to show this view again exactly: the graph, settings, camera, selection, collapsed nodes and
   * every shown node's layout state (see snapshot.js and MODEL.md). While a layout is on its way, it's the graph
   * on screen. `settings.explicit` lists the node and edge options set on purpose (the rest are defaults, the
   * layout's or the engine's).
   * @param {string} [note] why it's taken (kept in the snapshot)
   * @returns {import("./snapshot.js").Snapshot}
   */
  snapshot(note = "") {
    return takeSnapshot(
      {
        graph: this.graph,
        settings: {
          layout: this.layout,
          layoutOptions: this.layoutOpts,
          physics: this.mode,
          physicsOptions: this.modeOpts,
          node: this.node,
          edge: this.edge,
          explicit: {
            node: [...this.model.explicit.node],
            edge: [...this.model.explicit.edge],
          },
          animation: this.anim,
          renderer: this.renderer?.name,
        },
        camera: this.camera,
        selection: this.selected,
        collapsed: this.collapsed,
      },
      note,
    );
  }

  /**
   * Show a snapshot: its graph, settings, camera, selection, collapsed nodes and node positions, as they were (no
   * morph). Throws on anything that isn't a snapshot this engine can read.
   * @param {import("./snapshot.js").Snapshot} snapshot
   */
  restore(snapshot) {
    const graph = snapshotModel(snapshot).toJSON();
    const {
      settings = /** @type {Partial<import("./snapshot.js").SnapshotSettings>} */ ({}),
    } = snapshot;
    const { explicit } = settings;
    // Only the options that were set on purpose are set again (so a layout's own defaults still apply to the rest);
    // an older snapshot, without that list, sets them all.
    const only = (values = {}, keys = []) =>
      Object.fromEntries(
        keys.filter((k) => k in values).map((k) => [k, values[k]]),
      );
    this.quiet = true; // apply everything, then lay out once
    try {
      if (settings.animation) this.setAnimation(settings.animation);
      this.model.setOptions(
        explicit
          ? {
              node: only(settings.node, explicit.node),
              edge: only(settings.edge, explicit.edge),
            }
          : { node: settings.node, edge: settings.edge },
        { reset: !!explicit },
      );
      this.model.replace(graph);
    } finally {
      this.quiet = false;
    }
    const known = (ids) =>
      (Array.isArray(ids) ? ids : [])
        .map(String)
        .filter((id) => this.model.node(id));
    this.folds = new Set(known(snapshot.collapsed));
    this.foldVersion++;
    if (settings.layout && LAYOUTS[settings.layout]) {
      this.layout = settings.layout;
      this.layoutOpts = resolve(
        LAYOUTS[this.layout].options,
        settings.layoutOptions,
      );
    }
    const mode = settings.physics ?? this.mode;
    this.mode = LAYOUTS[this.layout].physics[mode] ? mode : "static";
    this.modeOpts = physicsOptions(
      this.layout,
      this.mode,
      settings.physicsOptions,
    );
    // Laid out now (it's about to be overwritten by the snapshot's positions), with no morph and no ghosts.
    this.#relayout({ sync: true });
    this.ghosts = [];
    applyState(this.graph, snapshot.state ?? {});
    this.tween = null;
    this.shift = null;
    if (snapshot.camera) this.camera = { ...snapshot.camera };
    this.cameraTween = null;
    this.framed = false;
    this.sim.wake();
    this.version++;
    this.#changed();
    this.select(known(snapshot.selection));
    this.#emit("restore", { nodes: this.model.size, time: snapshot.time });
  }

  // ---- the renderer --------------------------------------------------------------------------------------------

  /**
   * Draw on `renderer` from now on (the old one lets go of the screen). Its text measurement becomes the model's,
   * unless the model was given its own.
   * @param {import("./renderer.js").Renderer | null} renderer
   */
  setRenderer(renderer) {
    if (renderer === this.renderer) return;
    this.renderer?.detach();
    this.renderer = renderer;
    if (!renderer) return;
    if (renderer.measureText && !this.model.measured) {
      this.model.setMeasure(renderer.measureText);
      if (this.graph.nodes.length) this.#relayout({ fit: null });
    }
    renderer.attach(this);
    this.#emit("renderer", { renderer: renderer.name });
  }

  /** Stop listening to the model, let go of the renderer, and stop the layout worker. */
  destroy() {
    this.unlisten();
    this.layouter.dispose();
    this.renderer?.detach();
    this.renderer = null;
    this.gestures.clear();
  }

  // ---- settings ------------------------------------------------------------------------------------------------
  //
  // Every setter merges: the options given change, the rest stay as they are (as node and edge styles do). Options
  // belong to one layout or one physics mode, so a different layout or mode starts from its own defaults.

  /**
   * How things move between states (ANIMATION_OPTIONS, all or some).
   * @param {Partial<import("./animation.js").AnimationOptions>} [opts]
   */
  setAnimation(opts = {}) {
    this.anim = /** @type {import("./animation.js").AnimationOptions} */ (
      resolve(ANIMATION_OPTIONS, { ...this.anim, ...opts })
    );
    this.#changed();
    this.#emit("animation", this.anim);
  }

  /**
   * Lay out with layout `name` (see LAYOUTS) and its options, all or some. A new layout is framed. An unknown name
   * throws.
   * @param {LayoutName} name
   * @param {import("./layouts.js").LayoutOptions} [opts]
   */
  setLayout(name, opts = {}) {
    if (!LAYOUTS[name]) throw new Error(`Unknown layout "${name}"`);
    const changed = name !== this.layout;
    this.layout = name;
    this.layoutOpts = resolve(
      LAYOUTS[name].options,
      changed ? opts : { ...this.layoutOpts, ...opts },
    );
    if (!LAYOUTS[name].physics[this.mode]) this.mode = "static";
    this.modeOpts = physicsOptions(
      name,
      this.mode,
      changed ? {} : this.modeOpts,
    );
    this.#relayout({ fit: changed ? "animate" : null });
    this.#emit("layout", { layout: name, ...this.layoutOpts });
  }

  /**
   * Move with physics `mode` ("static", "elastic", "floating": what the layout offers, see LAYOUTS) and its options,
   * all or some. Leave out the mode (null) to change only options. A mode the layout doesn't offer throws, and
   * changes nothing.
   * @param {PhysicsMode | null} [mode]
   * @param {import("./physics.js").PhysicsOptions} [opts]
   */
  setPhysics(mode, opts = {}) {
    mode ??= this.mode;
    if (!LAYOUTS[this.layout].physics[mode])
      throw new Error(`Layout "${this.layout}" has no "${mode}" physics`);
    const previous = this.mode;
    this.modeOpts = physicsOptions(
      this.layout,
      mode,
      mode === previous ? { ...this.modeOpts, ...opts } : opts,
    );
    this.mode = mode;
    this.#configureSim();
    // Coming into floating, the graph floats off from wherever it is; any other change settles it on its homes.
    if (mode !== previous && mode !== "floating") this.#startTween();
    this.#changed();
    this.#emit("physics", { mode, ...this.modeOpts });
  }

  /**
   * How nodes look (NODE_OPTIONS, all or some): the model's options, so every view of it changes.
   * @param {Partial<import("./style.js").NodeOptions>} opts
   */
  setNodeStyle(opts) {
    this.model.setOptions({ node: opts });
  }

  /**
   * How edges look (EDGE_OPTIONS, all or some).
   * @param {Partial<import("./style.js").EdgeOptions>} opts
   */
  setEdgeStyle(opts) {
    this.model.setOptions({ edge: opts });
  }

  /** Send everything back to its home (a node being dragged is let go first). */
  reset() {
    this.gestures.releaseDrags();
    this.#startTween();
    this.#changed();
    this.#emit("reset");
  }

  /**
   * The drawing area's size in CSS px, and device pixels per CSS px. Frames again if the camera hasn't been moved.
   * (A renderer calls this; headless, call it yourself.)
   * @param {number} width
   * @param {number} height
   * @param {number} [dpr]
   */
  setViewport(width, height, dpr = 1) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.dpr = dpr;
    if (this.framed && !this.cameraTween && this.graph.nodes.length)
      this.camera = this.#framing(!!this.tween);
    this.#changed();
  }

  // ---- the camera ----------------------------------------------------------------------------------------------

  /**
   * A point on the canvas (CSS px from its top-left) in world coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  toWorld(x, y) {
    return cam.toWorld(this.camera, this.width, this.height, x, y);
  }

  /**
   * A world point on the canvas (CSS px from its top-left).
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  toScreen(x, y) {
    return cam.toScreen(this.camera, this.width, this.height, x, y);
  }

  /**
   * Frame the graph where it is (or where it's heading, mid-transition). While a layout is on its way, the graph it
   * brings is framed when it arrives (and the graph on screen meanwhile).
   * @param {boolean} [animate] glide there (the default), or jump
   */
  fit(animate = true) {
    this.glide = null;
    this.shift = null;
    this.focused = null;
    this.framed = true;
    if (this.layoutPending) this.pendingFit = animate ? "animate" : "instant";
    if (!this.graph.nodes.length) return this.#changed();
    const target = this.#framing(!!this.tween);
    this.#aim(target, animate);
    this.#changed();
    // While a layout is on its way this frames the graph on screen, and another "fit" follows when it lands.
    this.#emit("fit", {
      k: target.k,
      ...(this.layoutPending && { pending: true }),
    });
  }

  /**
   * Bring node `id` to the middle of the view, gliding there (and following it if it moves on the way, or if a new
   * layout moves it). `zoom`: the scale to arrive at (default: as it is, but at least 1, so its label can be read).
   * A node that's in the model but still being laid out is focused once it's in place. Returns false for an id
   * that isn't there.
   * @param {string} id
   * @param {{ zoom?: number, animate?: boolean }} [options]
   */
  focus(id, { zoom, animate = true } = {}) {
    id = String(id);
    if (this.isHidden(id)) this.reveal(id); // folded away: open the way to it first
    const n = this.graph.byId.get(id);
    if (!n) {
      if (!this.layoutPending || !this.model.node(id)) return false;
      this.pendingFocus = { id, zoom, animate };
      return true;
    }
    const { min, max } = this.zoomLimits();
    const k = Math.min(Math.max(zoom ?? Math.max(this.camera.k, 1), min), max);
    this.focused = id;
    this.framed = false;
    this.glide = null;
    this.shift = null;
    const to = { ...this.#whereTo(n.index), k };
    this.#aim(to, animate, id);
    this.#changed();
    this.#emit("focus", { node: id, k });
    return true;
  }

  /**
   * Put the camera at `camera` (`{ x, y, k }`, all or some: the world point at the middle of the view, and the
   * scale), gliding there over the animation's camera time when `animate`. The scale is kept within zoomLimits.
   * Like a pan by hand, it ends any framing or focus the view was keeping.
   * @param {Partial<import("./camera.js").Camera>} camera
   * @param {{ animate?: boolean }} [options]
   */
  setCamera(camera, { animate = false } = {}) {
    const { min, max } = this.zoomLimits();
    const to = {
      x: camera.x ?? this.camera.x,
      y: camera.y ?? this.camera.y,
      k: Math.min(Math.max(camera.k ?? this.camera.k, min), max),
    };
    if (![to.x, to.y, to.k].every(Number.isFinite)) return;
    this.#userCamera();
    this.shift = null;
    this.#aim(to, animate && this.anim.camera > 0);
    this.#changed();
  }

  // ---- where things are ----------------------------------------------------------------------------------------

  /**
   * Where node `id` is drawn now (world px), or null when it isn't shown (folded away, or not in the model).
   * @param {string} id
   * @returns {{ x: number, y: number } | null}
   */
  nodePosition(id) {
    const n = this.graph.byId.get(String(id));
    return n ? { x: n.x, y: n.y } : null;
  }

  /**
   * Where every shown node is drawn now, by id (world px).
   * @returns {Map<string, { x: number, y: number }>}
   */
  positions() {
    const out = new Map();
    for (const n of this.graph.nodes) out.set(n.id, { x: n.x, y: n.y });
    return out;
  }

  /**
   * The box everything shown covers now, labels included (world px).
   * @returns {import("./camera.js").Box}
   */
  bounds() {
    return cam.footprints(this.graph.matrix, false);
  }

  /**
   * A picture of the whole graph as it's shown now (selection, highlight and hover included), drawn with Canvas 2D on
   * a canvas of its own: `scale` device px per world px (less if the picture would be too big: at most 16,000 px a
   * side), `padding` world px round it, on `background` (the theme's by default; null for transparent). Icons are
   * waited for (up to `iconWait` ms). Needs a DOM.
   * @param {{ scale?: number, padding?: number, background?: string | null, iconWait?: number }} [options]
   * @returns {Promise<HTMLCanvasElement>}
   */
  async toImage({
    scale = 2,
    padding = 30,
    background = this.theme.background,
    iconWait = 5000,
  } = {}) {
    await this.laidOut();
    if (!this.scene) this.tick(this.clock());
    const icons = this.renderer?.painter?.icons ?? iconStore();
    await iconsReady(icons, this.scene.looks, iconWait);
    const box = this.bounds();
    const width = box.maxX - box.minX + padding * 2,
      height = box.maxY - box.minY + padding * 2;
    const k = Math.max(
      1e-3,
      Math.min(
        scale,
        IMAGE_SIDE / width,
        IMAGE_SIDE / height,
        Math.sqrt(IMAGE_PIXELS / (width * height)),
      ),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * k));
    canvas.height = Math.max(1, Math.ceil(height * k));
    drawScene(
      canvas.getContext("2d"),
      {
        ...this.scene,
        camera: {
          x: (box.minX + box.maxX) / 2,
          y: (box.minY + box.maxY) / 2,
          k: 1,
        },
        width,
        height,
        dpr: k,
        background,
      },
      icons,
    );
    return canvas;
  }

  /** Where node `i` will be once things settle: its home while a morph takes it there, else where it is. */
  #whereTo(i) {
    const m = this.graph.matrix;
    return this.tween
      ? { x: m.homeX[i], y: m.homeY[i] }
      : { x: m.x[i], y: m.y[i] };
  }

  /**
   * How far the camera may zoom: in to 8×, out to 0.05×, or further if that's what it takes to see the whole graph
   * (half its fit, so there's room around it).
   * @returns {{ min: number, max: number }}
   */
  zoomLimits() {
    return cam.zoomLimits(this.homeBox, this.width, this.height);
  }

  /**
   * Zoom by `factor` about canvas point (x, y) (default: the middle), keeping the world point under it in place.
   * For zoom buttons, and the renderer's pinch gestures.
   * @param {number} factor above 1 zooms in
   * @param {number} [x]
   * @param {number} [y]
   */
  zoomBy(factor, x = this.width / 2, y = this.height / 2) {
    this.#userCamera();
    cam.zoomAbout(
      this.camera,
      this.width,
      this.height,
      factor,
      x,
      y,
      this.zoomLimits(),
    );
    this.#changed();
  }

  /** The user took the camera: it's theirs now (no framing, focusing or easing of its own). */
  #userCamera() {
    this.cameraTween = null;
    this.glide = null;
    this.framed = false;
    this.focused = null;
  }

  /**
   * Glide the camera to `to` (following node `node` on the way, if given), or jump there.
   * @param {import("./camera.js").Camera} to
   * @param {boolean} animate
   * @param {string} [node]
   */
  #aim(to, animate, node) {
    if (animate)
      this.cameraTween = {
        from: { ...this.camera },
        to,
        start: this.clock(),
        node,
      };
    else {
      this.camera = to;
      this.cameraTween = null;
    }
  }

  /** A camera framing the graph, at its positions or its homes. */
  #framing(homes) {
    return cam.framing(
      cam.footprints(this.graph.matrix, homes),
      this.width,
      this.height,
    );
  }

  /**
   * The node the camera holds still on when a new layout moves everything: the one being dragged, the hovered one,
   * the selected or focused one (if it's on screen), or else the one nearest the middle of the view. Its id and
   * where it is now, or null.
   */
  #anchor() {
    const { graph } = this;
    if (!graph.nodes.length) return null;
    const m = graph.matrix;
    const onScreen = (i) => {
      const p = this.toScreen(m.x[i], m.y[i]);
      return p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= this.height;
    };
    const indexOf = (id) =>
      id === null ? -1 : (graph.byId.get(id)?.index ?? -1);
    // Only nodes that will still be shown count (one folding away has no place to hold).
    const stays = (i) => this.#stays(graph.nodes[i].id);
    const candidates = [
      this.pointer?.node ?? -1,
      indexOf(this.pivot),
      this.hover,
      ...[...this.selection].map(indexOf),
      indexOf(this.focused),
    ];
    let at = candidates.find((i) => i >= 0 && onScreen(i) && stays(i)) ?? -1;
    if (at < 0) {
      // Nearest the middle (only nodes that will still be there count, but the check is a lookup: only made for
      // nodes nearer than the best so far).
      const { x: cx, y: cy } = this.camera;
      let best = Infinity;
      for (let i = 0; i < m.count; i++) {
        const d = (m.x[i] - cx) ** 2 + (m.y[i] - cy) ** 2;
        if (d < best && stays(i)) {
          best = d;
          at = i;
        }
      }
    }
    return at < 0 ? null : { id: graph.nodes[at].id, x: m.x[at], y: m.y[at] };
  }

  /**
   * Keep `anchor` where it is on screen while the morph that's starting moves it to its new home: the camera moves
   * with it, eased the same way over the same time. Moves are added to the camera a frame at a time, so a pan or a
   * glide meanwhile still works.
   */
  #holdPlace(anchor) {
    const n = anchor && this.graph.byId.get(anchor.id);
    if (!n || this.sim.held.has(n.index)) return;
    const dx = n.homeX - anchor.x,
      dy = n.homeY - anchor.y;
    if (!Number.isFinite(dx + dy) || (dx === 0 && dy === 0)) return;
    this.shift = { dx, dy, start: this.tween.start, done: 0 };
  }

  /** The camera's own motion this frame: a framing or focus tween, keeping step with a morph, a glide. */
  #moveCamera(now, dt) {
    let busy = false;
    if (this.cameraTween) {
      const { t, f } = progress(
        now,
        this.cameraTween.start,
        this.anim.camera,
        this.anim.easing,
      );
      const { from, to, node } = this.cameraTween;
      // Focusing on a node follows it, wherever it's heading now.
      const n = node !== undefined && this.graph.byId.get(node);
      if (n) Object.assign(to, this.#whereTo(n.index));
      this.camera = cam.between(from, to, f);
      if (t >= 1) this.cameraTween = null;
      busy = true;
    }
    if (this.shift) {
      const { t, f } = progress(
        now,
        this.shift.start,
        this.anim.transition,
        this.anim.easing,
      );
      this.camera.x += (f - this.shift.done) * this.shift.dx;
      this.camera.y += (f - this.shift.done) * this.shift.dy;
      this.shift.done = f;
      if (t >= 1) this.shift = null;
      busy = true;
    }
    if (this.glide) {
      if (cam.coast(this.camera, this.glide, this.modeOpts.friction, dt))
        busy = true;
      else this.glide = null;
    }
    return busy;
  }

  // ---- layout --------------------------------------------------------------------------------------------------

  /**
   * Lay the graph out again, for the model as it is now (on a new working graph when nodes or edges have come or
   * gone) and the current layout and sizes. Small graphs are laid out on the spot; big ones in the layouter's worker,
   * while the graph on screen carries on as it is, and the result is put in place when it arrives, unless a newer
   * layout has been asked for since (only the newest is used).
   * @param {{ fit?: "instant" | "animate" | null, sync?: boolean }} [options] fit: frame the result; sync: lay out
   *   on the spot whatever the graph's size
   */
  #relayout({ fit = null, sync = false } = {}) {
    const rebuilding = !this.#isCurrent();
    const target = rebuilding
      ? new Graph(this.model, this.#disclosure().part)
      : this.graph;
    const spec = sizingSpec(
      target,
      this.model,
      looksOf(target, this.node, this.edge),
    );
    // A new structure keeps what stays where it was: the homes on screen, by id, as a hint (layout-job.js).
    const hint =
      rebuilding && this.graph.nodes.length
        ? hintFrom(this.graph, target, this.routing)
        : null;
    const job = { id: ++this.layoutRequest, target, rebuilding, fit, spec };
    const result = sync
      ? runLayout(target, this.layout, this.layoutOpts, spec, hint)
      : this.layouter.run(target, this.layout, this.layoutOpts, spec, hint);
    if (!(result instanceof Promise)) return this.#settle(job, result);
    this.layoutPending = true;
    this.#changed();
    result.then(
      (r) => this.#settle(job, r),
      (error) => {
        if (job.id !== this.layoutRequest) return;
        this.layoutPending = false;
        this.#emit("error", { message: `layout: ${error.message}` });
        for (const w of this.layoutWaiters.splice(0)) w.reject(error);
        this.#changed();
      },
    );
  }

  /**
   * The real graph with its references (references.js), cached across frames where nothing it shows changed. A new
   * graph, routing, looks, shade or appear always comes with a bump of one of the three versions it's keyed on.
   */
  #shownWithReferences() {
    const c = this.#shownCache;
    if (
      c &&
      c.version === this.version &&
      c.styleVersion === this.styleVersion &&
      c.shadeVersion === this.shadeVersion
    )
      return c.shown;
    const shown = withReferences(this.graph, this.routing.references, {
      looks: this.looks,
      shade: this.shade,
      appear: this.appear,
    });
    this.#shownCache = {
      version: this.version,
      styleVersion: this.styleVersion,
      shadeVersion: this.shadeVersion,
      shown,
    };
    return shown;
  }

  /**
   * Put a layout in place: the homes and routing, and for a new structure the new working graph, with nodes that
   * were already there gliding from where they were, new ones arriving as the animation's `enter` setting says, and
   * removed ones folding back into their family. The camera frames it (a first graph, a fit asked for, a view that
   * was framed), or holds still on a node that stays.
   */
  #settle(job, result) {
    if (job.id !== this.layoutRequest) return; // a newer layout is on its way
    this.layoutPending = false;
    const { target } = job;
    const anchor = this.#anchor();
    this.pivot = null;
    target.matrix.homeX.set(result.homeX);
    target.matrix.homeY.set(result.homeY);
    let previous = null,
      was = null,
      // A framed view frames the new layout, except under a drag or pan: the camera then holds still on what's held.
      fit =
        job.fit ??
        (this.framed && !this.pointer ? (this.pendingFit ?? "animate") : null);
    const asked = this.pendingFit; // a fit() asked for while this layout was on its way
    this.pendingFit = null;
    if (job.rebuilding) {
      previous = this.graph.nodes.length ? this.graph : null;
      was = new Int32Array(target.nodes.length).fill(-1);
      if (previous)
        for (const n of target.nodes)
          was[n.index] = previous.byId.get(n.id)?.index ?? -1;
      // Ghosts still leaving from an earlier change carry on (unless their node came back).
      const now = this.clock();
      this.ghosts = [
        ...this.ghosts.filter(
          (g) => !target.byId.has(g.id) && now - g.start < this.anim.transition,
        ),
        ...(previous && this.anim.transition > 0
          ? departures(previous, target, this.looks, now)
          : []),
      ];
      target.refresh(); // labels and styles may have changed while it was laid out
      this.graph = target;
      this.#carry(previous, was);
      if (!previous) fit = "instant";
    }
    this.routing = unpackRouting(result.routing, this.graph);
    this.version++;
    this.geometryVersion++;
    this.looks = looksOf(this.graph, this.node, this.edge, this.theme);
    this.#placeLabels(job.spec);
    this.homeBox = cam.footprints(this.graph.matrix, true);
    this.#configureSim();
    if (job.rebuilding)
      arrive(this.graph, previous, was, this.anim.enter, this.appear);
    this.shift = null;
    if (fit === "instant") {
      // A camera already framing where everything is heading.
      this.camera = this.#framing(true);
      this.cameraTween = null;
      this.glide = null;
      this.framed = true;
    }
    this.#startTween();
    if (fit === "animate") {
      this.framed = true;
      this.#aim(this.#framing(true), true);
    } else if (!fit && !this.cameraTween) this.#holdPlace(anchor);
    if (asked && fit)
      this.#emit("fit", {
        k: fit === "instant" ? this.camera.k : this.cameraTween.to.k,
      });
    this.#changed();
    this.#emit("laidOut", {
      layout: this.layout,
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
    });
    for (const w of this.layoutWaiters.splice(0)) w.resolve();
    if (this.pendingFocus) {
      const { id, ...options } = this.pendingFocus;
      this.pendingFocus = null;
      this.focus(id, options);
    }
  }

  /**
   * A promise that resolves once the newest layout asked for is in place: `graph`, `fit()` and `snapshot()` then
   * see the graph as the model has it. Straight away when nothing is being laid out (small graphs lay out on the
   * spot); after the worker answers for big ones. Rejects if that layout fails.
   * @returns {Promise<void>}
   */
  laidOut() {
    if (!this.layoutPending) return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.layoutWaiters.push({ resolve, reject }),
    );
  }

  /**
   * A promise that resolves once the view has settled: the newest layout is in place, and the morph, camera moves,
   * fade-ins and ghosts are done, nothing is held, and the physics is at rest (a graph that drifts forever counts
   * once everything else is done). It's ticks that move things on: with a renderer that's the frame loop; headless,
   * whoever calls `tick`. A "settled" event is sent at the same moment.
   * @returns {Promise<void>}
   */
  settled() {
    if (this.#isSettled()) return Promise.resolve();
    this.#changed(); // make sure frames are coming
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  /** Nothing pending, nothing moving (except a drift that never stops). */
  #isSettled() {
    return (
      !this.layoutPending &&
      !this.tween &&
      !this.cameraTween &&
      !this.shift &&
      !this.glide &&
      !this.ghosts.length &&
      !this.pointers.size &&
      !this.arriving &&
      !this.flashes.size &&
      !this.pulses.size &&
      (this.sim.asleep || (this.mode === "floating" && this.modeOpts.drift > 0))
    );
  }

  /** Fix each node's label direction from its home, and the footprint that goes with it. */
  #placeLabels(spec) {
    const m = this.graph.matrix;
    this.labelWidths = spec.widths; // painters start edges past these (startTrims)
    for (let i = 0; i < m.count; i++) {
      const angle = labelAngle(
        labelPlace(this.node),
        this.routing,
        m.homeX[i],
        m.homeY[i],
      );
      const box = footprint(spec.reach[i], angle, spec.widths[i], spec.height);
      m.labelAngle[i] = angle;
      m.radius[i] = spec.reach[i];
      m.boxX0[i] = box.x0;
      m.boxY0[i] = box.y0;
      m.boxX1[i] = box.x1;
      m.boxY1[i] = box.y1;
    }
  }

  #configureSim() {
    this.sim.configure(
      this.mode,
      this.modeOpts,
      constrainer(this.routing, this.modeOpts),
      {
        boxes:
          this.node.look === "card" ||
          (this.node.labelCollide && this.node.labels !== "off"),
        padding: this.node.collisionRadius,
      },
      // Edges drawn as references don't pull: dragging a recipe doesn't tug a far-away ingredient.
      referencedEdges(this.graph, this.routing.references),
    );
  }

  /** Glide every node from where it is to its home, over the animation's transition time (the morph moves them). */
  #startTween() {
    const m = this.graph.matrix;
    m.vx.fill(0);
    m.vy.fill(0);
    this.tween = { x: m.x.slice(), y: m.y.slice(), start: this.clock() };
  }

  // ---- time ----------------------------------------------------------------------------------------------------

  /**
   * Advance everything to `now` (ms): layout morphs, physics, the camera, hover and fades, ghosts, long presses.
   * Then `scene` holds what to draw. Returns whether anything is still moving.
   * @param {number} now ms, on the controller's clock
   * @returns {TickResult}
   */
  tick(now) {
    const gap = this.last ? (now - this.last) / 1000 : 0;
    const dt = gap ? Math.min(gap, 0.1) : 1 / 60;
    this.last = now;

    let busy;
    const simStart = performance.now();
    if (this.tween) {
      const { t, f } = progress(
        now,
        this.tween.start,
        this.anim.transition,
        this.anim.easing,
      );
      morph(this.graph.matrix, this.tween, this.routing, this.sim.held, f);
      if (t >= 1) {
        this.tween = null;
        this.sim.wake();
      }
      this.version++;
      busy = true;
    } else if (this.sim.asleep) {
      // Nothing to step: a simulation at rest stays at rest until it's woken (a release, new settings, a layout) or
      // a node is held. (Frames at rest still come for hover fades: they mustn't pay for physics.)
      busy = false;
    } else {
      this.sim.advance(dt);
      if (this.sim.moved) this.version++;
      busy = !this.sim.asleep;
    }
    const simMs = performance.now() - simStart;
    busy = this.#moveCamera(now, dt) || busy;
    const c = this.camera,
      sent = this.cameraSent;
    if (!sent || sent.x !== c.x || sent.y !== c.y || sent.k !== c.k) {
      this.cameraSent = { x: c.x, y: c.y, k: c.k };
      this.#emit("camera", { ...this.cameraSent });
    }
    this.gestures.longPresses(now);

    const lit = this.#litMask();
    if (this.#fade(dt, lit)) {
      this.shadeVersion++;
      busy = true;
    }
    const marks = this.#timedMarks(now);
    if (marks.busy) busy = true;
    // Pulses run along a lit lineage's edges for as long as it's lit.
    const lineage = lit && lit !== this.highlightCache.mask ? lit : null;
    if (lineage && this.anim.flow !== "off") busy = true;
    // Edge routing knows when a layout morph is running (radial step edges keep their arcs through it).
    this.routing.morphing = !!this.tween;
    // References and ghosts are drawn from a display graph; everything else (physics, hover, hit-testing) uses the
    // real one. It's rebuilt only when something it's made from changed (a pan doesn't), so painters can tell
    // nothing moved.
    let shown = this.#shownWithReferences();
    if (this.ghosts.length) {
      shown = withGhosts(
        shown.graph,
        this.ghosts,
        shown,
        now,
        this.anim.transition,
        EASINGS[this.anim.easing],
      );
      if (shown.live.length !== this.ghosts.length) this.geometryVersion++;
      this.ghosts = shown.live;
      this.version++; // ghosts move every frame
      busy = true;
    }
    this.scene = {
      graph: shown.graph,
      routing: this.routing,
      camera: this.camera,
      node: this.node,
      edge: this.edge,
      looks: shown.looks,
      shade: shown.shade,
      appear: shown.appear,
      dim: this.anim.hoverDim,
      matrix: this.graph.matrix,
      labelWidths: this.labelWidths ?? null, // each real node's label width, as the layout kept room for it
      // Interaction state for painters to show: the hovered node (an index into the real graph, -1 for none), and a
      // flag per real node for the selection (null when nothing's selected). Display-only nodes (references, ghosts)
      // come after the real ones and are never selected.
      hover: this.hover,
      selected: this.#selectionMask(),
      highlighted: this.#highlightMask(),
      flashes: marks.flashes,
      pulses: marks.pulses,
      lineage,
      anim: this.anim,
      time: now,
      selectionVersion: this.selectionVersion,
      // Progressive disclosure, a value per real node (both null when nothing shown is collapsed): `collapsed`, 1 for
      // a node whose children are folded away, and `hidden`, how many nodes are hidden below it (a "+N" badge; 0
      // when everything below it is shown elsewhere). foldVersion changes whenever they might.
      ...this.#foldMarks(),
      foldVersion: this.foldVersion,
      version: this.version,
      shadeVersion: this.shadeVersion,
      geometryVersion: this.geometryVersion,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      theme: this.theme,
      background: this.theme.background,
      // Restyles of a few nodes and edges since a painter last drew: see #restyle.
      styleVersion: this.styleVersion,
      restyles: this.restyles,
    };
    busy ||= this.pointers.size > 0;
    if (!this.#isSettled()) this.calm = false;
    else if (!this.calm) {
      this.calm = true;
      this.#emit("settled", { nodes: this.graph.nodes.length });
      for (const resolve of this.settleWaiters.splice(0)) resolve();
    }
    return {
      busy,
      gap,
      simMs,
      energy: this.sim.energy,
      state: this.layoutPending
        ? "laying out"
        : this.tween
          ? "moving to layout"
          : this.pointer?.node >= 0
            ? "dragging"
            : this.pinch
              ? "zooming"
              : busy
                ? "moving"
                : "at rest",
    };
  }

  /**
   * Ease hover emphasis and fade-ins toward their targets (`lit`: a flag per node to light, or null for all).
   * Skipped once everything has arrived, until the target changes. Returns true while anything is still changing.
   */
  #fade(dt, lit) {
    if (lit !== this.lit) {
      this.lit = lit;
      this.fading = true;
    }
    if (!this.fading) return false;
    const { changing, arriving } = fade(
      this.shade,
      this.appear,
      lit,
      dt,
      this.anim,
    );
    this.fading = changing;
    this.arriving = arriving;
    return changing;
  }

  /**
   * The nodes the shading lights up: the lineage of the node being dragged, or else the hovered one (the part of
   * it the hoverLineage option says), or else the highlighted nodes, or else the selection's lineage (so a tap on a
   * touch screen, with no hover, still shows a node's family; unless selectionLineage is off). Null: all of them.
   */
  #litMask() {
    const on = this.pointer?.node >= 0 ? this.pointer.node : this.hover;
    const part = this.anim.hoverLineage;
    if (on >= 0 && part !== "none")
      return this.lineages.get(this.graph, on, part);
    const highlight = this.#highlightMask();
    if (highlight) return highlight;
    if (!this.selection.size || !this.anim.selectionLineage) return null;
    this.#selectionMask();
    return this.selectionCache.lit;
  }

  /** A flag per node of the working graph for the highlighted nodes, or null when none are shown. */
  #highlightMask() {
    if (!this.highlightIds.size) return null;
    const cache = this.highlightCache;
    if (cache.key === this.highlightVersion && cache.graph === this.graph)
      return cache.mask;
    let mask = new Uint8Array(this.graph.nodes.length);
    let any = false;
    for (const id of this.highlightIds) {
      const n = this.graph.byId.get(id);
      if (!n) continue;
      mask[n.index] = 1;
      any = true;
    }
    if (!any) mask = null;
    Object.assign(cache, {
      key: this.highlightVersion,
      graph: this.graph,
      mask,
    });
    return mask;
  }

  /**
   * How strongly each node flashes and how far through its pulse it is, at `now`: arrays per node of the working
   * graph (null when none is), and whether any is still running (finished ones are let go).
   */
  #timedMarks(now) {
    if (!this.flashes.size && !this.pulses.size)
      return { flashes: null, pulses: null, busy: false };
    const count = this.graph.nodes.length;
    let flashes = null,
      pulses = null;
    for (const [id, { start, ms }] of this.flashes) {
      const t = (now - start) / ms;
      if (t >= 1) {
        this.flashes.delete(id);
        continue;
      }
      const n = this.graph.byId.get(id);
      // In quickly, held, then out over the last third.
      if (n)
        (flashes ??= new Float32Array(count))[n.index] = Math.min(
          1,
          t * 8,
          (1 - t) * 3,
        );
    }
    for (const [id, start] of this.pulses) {
      const t = (now - start) / PULSE_MS;
      if (t >= 1) {
        this.pulses.delete(id);
        continue;
      }
      const n = this.graph.byId.get(id);
      if (n) (pulses ??= new Float32Array(count))[n.index] = Math.max(t, 1e-3);
    }
    // The halos are redrawn every frame they move.
    this.selectionVersion++;
    return {
      flashes,
      pulses,
      busy: this.flashes.size > 0 || this.pulses.size > 0,
    };
  }

  /** A flag per node of the working graph for the selection (null when nothing's selected), and its lineage. */
  #selectionMask() {
    if (!this.selection.size) return null;
    const cache = this.selectionCache;
    if (cache.key === this.selectionVersion && cache.graph === this.graph)
      return cache.mask;
    const count = this.graph.nodes.length;
    const mask = new Uint8Array(count);
    let lit = null;
    for (const id of this.selection) {
      const n = this.graph.byId.get(id);
      if (!n) continue;
      mask[n.index] = 1;
      lit = lineageMask(this.graph, n.index, lit ?? new Uint8Array(count));
    }
    Object.assign(cache, {
      key: this.selectionVersion,
      graph: this.graph,
      mask,
      lit,
    });
    return mask;
  }

  /** Nothing more to do for now: the next tick starts timing afresh instead of seeing one long gap. */
  rest() {
    this.last = 0;
  }

  /**
   * Tick from `start` to `start + ms`, `step` ms at a time (tests and headless use). Returns the last result.
   * @param {number} ms
   * @param {{ start?: number, step?: number }} [options]
   * @returns {TickResult | null}
   */
  run(ms, { start = this.clock(), step = 1000 / 60 } = {}) {
    let result = null;
    for (let t = 0; t <= ms; t += step) result = this.tick(start + t);
    return result;
  }

  // ---- selection -----------------------------------------------------------------------------------------------

  /** The selected node ids, in the order they were selected. */
  get selected() {
    return [...this.selection];
  }

  /**
   * Select node `ids` (one id, a list, or null for none) in place of the selection; with `add`, as well as it; with
   * `toggle`, flipping each in or out. Ids the model doesn't have are skipped. Sends a "select" event and returns
   * true when the selection changed.
   * @param {string | string[] | null} ids
   * @param {{ add?: boolean, toggle?: boolean }} [options]
   */
  select(ids, { add = false, toggle = false } = {}) {
    const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
    const next = new Set(add || toggle ? this.selection : []);
    for (const raw of list) {
      const id = String(raw);
      if (!this.model.node(id)) continue;
      if (toggle && next.has(id)) next.delete(id);
      else next.add(id);
    }
    const before = this.selected;
    if (
      next.size === before.length &&
      [...next].every((id, i) => id === before[i])
    )
      return false;
    this.selection = next;
    this.selectionVersion++;
    this.shadeVersion++;
    this.fading = true;
    this.#changed();
    this.#emit("select", { selected: this.selected });
    return true;
  }

  // ---- highlights, flashes and pulses ----------------------------------------------------------------------------

  /** The highlighted node ids. */
  get highlighted() {
    return [...this.highlightIds];
  }

  /**
   * Highlight node `ids` (a list, one id, or null for none): each gets a halo in the theme's `highlight` colour,
   * and they stay lit while everything else dims (as a hover's lineage does; a hover still shows its own). Ids the
   * model doesn't have are skipped. Sends a "highlight" event and returns true when the highlight changed.
   * @param {string | Iterable<string> | null} ids
   */
  highlight(ids) {
    const list = ids == null ? [] : typeof ids === "string" ? [ids] : [...ids];
    const next = new Set();
    for (const raw of list) {
      const id = String(raw);
      if (this.model.node(id)) next.add(id);
    }
    const before = this.highlightIds;
    if (sameSet(next, before)) return false;
    this.highlightIds = next;
    this.highlightVersion++;
    this.selectionVersion++;
    this.shadeVersion++;
    this.fading = true;
    this.#changed();
    this.#emit("highlight", { highlighted: this.highlighted });
    return true;
  }

  /**
   * Make nodes `ids` flash for `ms` (a halo in the theme's `focus` colour that comes on, holds, and fades): to
   * show where something is ("this one"). Ids the model doesn't have are skipped.
   * @param {string | Iterable<string>} ids
   */
  flash(ids, ms = 2200) {
    const start = this.clock();
    const list = typeof ids === "string" ? [ids] : [...ids];
    for (const raw of list) {
      const id = String(raw);
      if (this.model.node(id))
        this.flashes.set(id, { start, ms: Math.max(1, ms) });
    }
    this.#changed();
  }

  /**
   * A quick ring that leaves node `id` and fades as it spreads, in the node's colour: feedback for a tap.
   * @param {string} id
   */
  pulse(id) {
    if (!this.model.node(String(id))) return;
    this.pulses.set(String(id), this.clock());
    this.#changed();
  }

  // ---- progressive disclosure ----------------------------------------------------------------------------------
  //
  // Collapsing is view state: the model keeps every node, and the working graph is built from the part of it that's
  // shown (disclosure.js has the rule: a node is hidden when every path to it from a root passes through a collapsed
  // node). Expanding is a structural change like any other: the new nodes grow out of the node that opened, and
  // collapsing folds them back into it as ghosts; the camera holds still on that node meanwhile. Each call sends an
  // "expand" or "collapse" event ({ node, visible, hidden, … }) and returns whether anything changed.

  /** The ids of the collapsed nodes. */
  get collapsed() {
    return [...this.folds];
  }

  /**
   * Whether node `id` is collapsed (its children are folded away).
   * @param {string} id
   * @returns {boolean}
   */
  isCollapsed(id) {
    return this.folds.has(String(id));
  }

  /**
   * Whether node `id` is in the model but not shown (folded away under a collapsed node).
   * @param {string} id
   * @returns {boolean}
   */
  isHidden(id) {
    const i = this.model.index.get(String(id));
    return i !== undefined && !this.#disclosure().shown[i];
  }

  /**
   * How many nodes are hidden below node `id` (0 unless it's shown and collapsed): what a "+N" badge shows.
   * @param {string} id
   * @returns {number}
   */
  hiddenCount(id) {
    const i = this.model.index.get(String(id));
    if (i === undefined) return 0;
    const d = this.#disclosure();
    if (!d.shown[i] || !d.folded[i]) return 0;
    return (d.counts ??= hiddenBelow(this.model, d))[i];
  }

  /**
   * Collapse node `id`: what's below it, and not shown through another path, folds into it. Leaves can't be.
   * @param {string} id
   * @returns {boolean} whether anything changed
   */
  collapse(id) {
    id = String(id);
    const i = this.model.index.get(id);
    if (i === undefined || this.folds.has(id)) return false;
    const { outStart } = this.model.adjacency();
    if (outStart[i + 1] === outStart[i]) return false; // nothing to fold
    return this.#setFolds(new Set(this.folds).add(id), "collapse", {
      node: id,
    });
  }

  /**
   * Expand node `id` to show `depth` levels below it (default 1, its children; Infinity: everything below it).
   * Nodes those levels bring into view that lead on to more hidden nodes start collapsed, so one expand never spills
   * a whole subtree; nodes already shown elsewhere stay as they are. An expanded node that's itself hidden stays
   * hidden (see `reveal`).
   * @param {string} id
   * @param {{ depth?: number }} [options]
   * @returns {boolean} whether anything changed
   */
  expand(id, { depth = 1 } = {}) {
    id = String(id);
    const i = this.model.index.get(id);
    if (i === undefined) return false;
    const levels = depth >= 1 ? Math.floor(depth) : 1;
    const next = expandedTo(
      this.model,
      this.folds,
      i,
      levels,
      this.#disclosure().shown,
    );
    return this.#setFolds(next, "expand", { node: id, depth: levels });
  }

  /**
   * Expand node `id` if it's collapsed, else collapse it.
   * @param {string} id
   * @returns {boolean} whether anything changed
   */
  toggle(id) {
    return this.isCollapsed(id) ? this.expand(id) : this.collapse(id);
  }

  /**
   * Show everything: no node collapsed.
   * @returns {boolean} whether anything changed
   */
  expandAll() {
    return this.#setFolds(new Set(), "expand", { node: null, depth: Infinity });
  }

  /**
   * Show `depth` levels below the roots (0: just the roots) and collapse everything deeper.
   * @param {number} depth
   * @returns {boolean} whether anything changed
   */
  collapseTo(depth) {
    const levels = depth >= 0 ? Math.floor(depth) : 0;
    return this.#setFolds(collapsedAt(this.model, levels), "collapse", {
      node: null,
      depth: levels,
    });
  }

  /**
   * Show node `id`: expand the collapsed nodes on its path from a root (whatever else that brings into view starts
   * collapsed, so only the path opens). False when it's shown already or not in the model. `focus` does this itself.
   * @param {string} id
   * @returns {boolean}
   */
  reveal(id) {
    id = String(id);
    const i = this.model.index.get(id);
    if (i === undefined) return false;
    const next = revealed(this.model, this.folds, i, this.#disclosure());
    return !!next && this.#setFolds(next, "expand", { node: id, reveal: true });
  }

  /** Make `next` the collapsed set: lay out what it shows (if that changed) and tell listeners. */
  #setFolds(next, type, detail) {
    if (sameSet(next, this.folds)) return false;
    this.folds = next;
    this.foldVersion++;
    this.version++; // the collapsed marks are drawn
    const d = this.#disclosure();
    this.pivot = detail.node;
    if (this.layoutPending || !this.#isCurrent()) this.#relayout();
    else {
      this.pivot = null; // the same nodes are shown: only the marks change
      this.#changed();
    }
    const visible = d.nodes ? d.nodes.length : this.model.size;
    this.#emit(type, {
      ...detail,
      visible,
      hidden: this.model.size - visible,
    });
    return true;
  }

  /** Whether the graph on screen is the one made for the model and folds as they are now. */
  #isCurrent() {
    const { graph } = this;
    return (
      graph.model === this.model && graph.structure === this.#disclosure().key
    );
  }

  /**
   * What's shown of the model with the collapsed nodes as they are (disclosure.js), worked out once per structure
   * and collapsed set. `part` is what the working graph is built from (null: all of it) and `key` names it: a graph
   * whose `structure` is that key is current. A collapse that changes nothing shown keeps the part and its key.
   */
  #disclosure() {
    const { model } = this;
    const c = this.#disclosed;
    // A new model (setModel) always bumps foldVersion.
    if (
      c &&
      c.structure === model.structureVersion &&
      c.folds === this.foldVersion
    )
      return c;
    const d = disclose(model, this.folds);
    let part = null;
    if (!d.all) {
      const same =
        c?.part &&
        c.model === model &&
        c.structure === model.structureVersion &&
        sameInts(c.part.nodes, d.nodes) &&
        sameInts(c.part.edges, d.edges);
      part = same
        ? c.part
        : {
            nodes: d.nodes,
            edges: d.edges,
            key: `${model.structureVersion}/${++this.#parts}`,
          };
    }
    this.#disclosed = {
      ...d,
      model,
      structure: model.structureVersion,
      folds: this.foldVersion,
      part,
      key: part ? part.key : model.structureVersion,
      counts: null, // hidden counts, worked out when first asked for
    };
    return this.#disclosed;
  }

  /** Whether node `id` is in the model and shown: it will be on screen once the newest layout is in. */
  #stays(id) {
    const i = this.model.index.get(id);
    return i !== undefined && this.#disclosure().shown[i] === 1;
  }

  /**
   * After nodes or edges came or went: collapsed nodes that left the model leave the set, and a graph that's all
   * new (it shares no node with the one before) starts at the `depth` option's levels again. A node added under a
   * collapsed one is hidden like the rest.
   */
  #keepFolds({ nodesAdded, nodesRemoved }) {
    const { model } = this;
    let next = null;
    if (this.depth !== null && model.size && nodesAdded.length === model.size)
      next = collapsedAt(model, this.depth);
    else if (this.folds.size && nodesRemoved.length) {
      next = new Set([...this.folds].filter((id) => model.node(id)));
      if (next.size === this.folds.size) next = null;
    }
    if (!next) return;
    this.folds = next;
    this.foldVersion++;
  }

  /** The scene's collapsed flags and hidden counts per node of the graph on screen (both null when there are none). */
  #foldMarks() {
    const { graph, model } = this;
    const m = this.#marks;
    if (
      m &&
      m.graph === graph &&
      m.folds === this.foldVersion &&
      m.structure === model.structureVersion
    )
      return m.out;
    let out = { collapsed: null, hidden: null };
    if (this.folds.size && graph.nodes.length) {
      const d = this.#disclosure();
      const counts = (d.counts ??= hiddenBelow(model, d));
      // The graph on screen is usually the one made for this disclosure (its rows are the part's nodes); while a
      // newer layout is on its way it may be an older one, matched by id.
      const current = this.#isCurrent();
      const count = graph.nodes.length;
      const collapsed = new Uint8Array(count),
        hidden = new Int32Array(count);
      let any = false;
      for (let i = 0; i < count; i++) {
        const mi = current
          ? graph.part
            ? graph.part.nodes[i]
            : i
          : model.index.get(graph.nodes[i].id);
        if (mi === undefined || !d.folded[mi]) continue;
        collapsed[i] = 1;
        hidden[i] = counts[mi];
        any = true;
      }
      if (any) out = { collapsed, hidden };
    }
    this.#marks = {
      graph,
      folds: this.foldVersion,
      structure: model.structureVersion,
      out,
    };
    return out;
  }

  // ---- interaction ---------------------------------------------------------------------------------------------
  //
  // What pointers and wheels mean is worked out in gestures.js: these are the calls a renderer makes.

  /**
   * A press at canvas point (x, y). The first pointer grabs the node there or starts a pan; a second one turns the
   * two into a pinch (the drag or pan ends); any more are ignored until those lift.
   * @param {import("./gestures.js").PointerInput} input
   */
  pointerDown(input) {
    this.gestures.down(input);
  }

  /**
   * A pointer moved to canvas point (x, y): a pressed one drags, pans or pinches; one that isn't pressed (a mouse
   * or pen hovering) hovers.
   * @param {import("./gestures.js").PointerInput} input
   */
  pointerMove(input) {
    this.gestures.move(input);
  }

  /**
   * The press ended: a dragged node is let go (thrown, if it was moving), a pan glides on, a pinch's other pointer
   * pans on. A press that didn't wander is a tap (two quick ones a double tap), unless it was a long press.
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerUp(input) {
    this.gestures.up(input);
  }

  /**
   * The press was taken away (the browser's pointercancel: a system gesture, the pointer lost): like a release, but
   * nothing is thrown and it's never a tap.
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerCancel(input) {
    this.gestures.cancel(input);
  }

  /**
   * The pointer left the canvas: no more hover (a press in progress carries on).
   * @param {Partial<import("./gestures.js").PointerInput>} [input]
   */
  pointerLeave(input) {
    this.gestures.leave(input);
  }

  /**
   * A wheel or a trackpad at canvas point (x, y). A pinch on a trackpad (ctrl+wheel) zooms about the point, and so
   * does a mouse wheel; a two-finger scroll on a trackpad pans (see the `wheel` option). Lines and pages
   * (`deltaMode` 1 and 2) are turned into pixels first, so every browser zooms at the same speed.
   * @param {import("./gestures.js").WheelInput} input
   */
  wheel(input) {
    this.gestures.wheel(input);
  }

  /**
   * A double-click at canvas point (x, y): on empty space, frame the graph. (Taps find double taps themselves.)
   * @param {{ x: number, y: number }} input
   */
  doubleClick({ x, y }) {
    if (this.hit(this.toWorld(x, y)) < 0) this.fit();
  }

  /** Pressed pointers by id (see gestures.js). */
  get pointers() {
    return this.gestures.pointers;
  }

  /** The pressed pointer that's dragging a node or panning (there's at most one), or null. */
  get pointer() {
    return this.gestures.primary;
  }

  /** Two pointers pinching, or null. */
  get pinch() {
    return this.gestures.pinch;
  }

  /**
   * What the pointer should look like: "grab" over a node, "grabbing" while dragging one, "default" over a
   * reference (it lights up its ingredient but can't be dragged), "" otherwise.
   */
  get cursor() {
    if (this.pointer?.node >= 0) return "grabbing";
    if (this.hover < 0) return "";
    return this.hoverReference ? "default" : "grab";
  }

  /**
   * The topmost node under a world point, or -1. With `references`, a reference under the point counts as its
   * ingredient (for hover: pointing at a reference lights up the ingredient and everything that uses it).
   * @param {{ x: number, y: number }} p
   * @param {{ references?: boolean }} [options]
   * @returns {number} an index into `graph`
   */
  hit(p, { references = false } = {}) {
    const { index, reference } = this.#pick(p, references);
    return reference && !references ? -1 : index;
  }

  /**
   * The node under world point `p`: { index, reference } where reference says it was found by one of its
   * references. Nodes come first (found through the hit grid), references only if `references` and no node is hit.
   */
  #pick(p, references = true) {
    const slack = 4 / this.camera.k;
    const m = this.graph.matrix;
    const grid = this.grid;
    if (grid.graph !== this.graph || grid.version !== this.version) {
      // Built at most once per frame that moved something, and kept while nothing moves.
      grid.graph = this.graph;
      grid.version = this.version;
      grid.index = new HitGrid(m, this.node.look === "card");
    }
    const direct = grid.index.at(p.x, p.y, slack);
    if (direct >= 0 || !references) return { index: direct, reference: false };
    for (const ref of this.routing.references ?? []) {
      const s = ref.source;
      const rx = ref.x + m.x[s] - m.homeX[s],
        ry = ref.y + m.y[s] - m.homeY[s];
      const r = referenceRadius(ref, m.radius[ref.target]);
      if (Math.hypot(rx - p.x, ry - p.y) <= r * HIT_SCALE + slack)
        return { index: ref.target, reference: true };
    }
    return { index: -1, reference: false };
  }

  /** The node and, when static drags carry subtrees, everything below it. */
  #carried(index) {
    if (this.mode !== "static" || !this.modeOpts.dragSubtree) return [index];
    const out = [index];
    for (let k = 0; k < out.length; k++)
      for (const c of this.graph.nodes[out[k]].children) out.push(c);
    return out;
  }

  /**
   * The hover moves to node `index` (-1: none), found directly or through one of its references. Sends hoverLeave
   * and hoverEnter (the node left is looked up in `graph`, the one it was found in).
   */
  #setHover(index, reference, graph = this.graph) {
    const before = this.hover;
    this.hoverReference = index >= 0 && reference;
    if (index === before) return;
    this.hover = index;
    if (before >= 0 && graph?.nodes[before])
      this.#emit("hoverLeave", { node: graph.nodes[before].id });
    if (index >= 0)
      this.#emit("hoverEnter", {
        node: this.graph.nodes[index].id,
        reference,
      });
    this.#changed();
  }
}
