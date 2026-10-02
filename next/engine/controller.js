// GraphController: the middle of the engine. It's handed a GraphModel (what the graph is and how it looks) and a
// renderer (the screen), and works between them:
//
//   - it listens to the model and keeps up with every change: a new colour is redrawn, a new label or size is laid
//     out again, new or removed nodes are laid out again and morphed into place;
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

import { ANIMATION_OPTIONS, EASINGS, approach } from "./animation.js";
import { footprint, labelAngle, reach } from "./boxes.js";
import { departures, withGhosts } from "./ghosts.js";
import { REFERENCE_SCALE, withReferences } from "./references.js";
import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { applyState, snapshotModel, takeSnapshot } from "./snapshot.js";
import { LAYOUTS, constrainer } from "./layouts.js";
import { Simulation, physicsOptions } from "./physics.js";
import { looksOf } from "./render.js";
import { runLayout, unpackRouting } from "./layout-job.js";
import { Layouter, WORKER_MIN } from "./layouter.js";
import { resolve } from "./schema.js";
import { HIT_SCALE, HitGrid, LineageCache, lineageMask } from "./picking.js";

export const BACKGROUND = "#0e1016";
const MAX_THROW = 1800; // fastest throw or pan glide, in screen px/s
const MAX_ZOOM = 8;
const MIN_ZOOM = 0.05; // the furthest out a zoom may go, unless the graph needs further to fit
const FIT_PAD = 40; // screen px kept clear around a framed graph
const FIT_MAX = 2.5; // the closest a fit zooms in (a tiny graph isn't blown up)
/** How far a press may wander, in CSS px, and still be a tap or a long press (a finger wobbles more than a mouse). */
const TAP_SLOP = { touch: 10, pen: 6, mouse: 5 };
const LONG_PRESS = 500; // ms held still before a press is a long press
const DOUBLE_TAP = { ms: 300, px: 24 }; // a second tap this soon and this close is a double tap
const LINE_PX = 33; // a wheel "line" (deltaMode 1, Firefox's mouse wheel) in px: three lines a notch, like Chrome's 100
const WHEEL_BURST = 150; // ms: wheel events closer than this are one gesture (one kind: zoom or pan)

/**
 * A point `f` of the way from (x0, y0) to (x1, y1) around a radial layout's centre: angle and radius each change
 * evenly (the angle the short way round), so nodes swing along their rings instead of cutting across the middle.
 */
export function alongRings({ cx, cy }, x0, y0, x1, y1, f) {
  const r0 = Math.hypot(x0 - cx, y0 - cy),
    r1 = Math.hypot(x1 - cx, y1 - cy);
  // At (or very near) the centre a point has no angle of its own: take the other end's.
  const a1 =
    r1 > 1e-6 ? Math.atan2(y1 - cy, x1 - cx) : Math.atan2(y0 - cy, x0 - cx);
  const a0 = r0 > 1e-6 ? Math.atan2(y0 - cy, x0 - cx) : a1;
  let turn = a1 - a0;
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  const r = r0 + (r1 - r0) * f,
    a = a0 + turn * f;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

/**
 * @typedef {object} TickResult
 * @property {boolean} busy   something is still moving or fading: keep ticking
 * @property {number} gap     seconds since the last tick, unclamped (0 for the first after a rest)
 * @property {number} simMs   wall time spent moving nodes this tick (morph and physics), ms
 * @property {number} energy  mean squared node speed
 * @property {string} state   "laying out", "moving to layout", "dragging", "zooming", "moving" or "at rest"
 *
 * @typedef {object} ControllerOptions
 * @property {string} [layout]           "tree", "radial" or "merged" (see LAYOUTS)
 * @property {object} [layoutOptions]
 * @property {string} [physics]          "static", "elastic" or "floating" (each layout offers some)
 * @property {object} [physicsOptions]
 * @property {object} [animation]        ANIMATION_OPTIONS
 * @property {(type: string, detail?: object) => void} [onEvent] every event (see `on` for one type at a time)
 * @property {(stats: object) => void} [onFrame] after every drawn frame (the renderer calls it)
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
 *
 * @typedef {object} PointerInput        a pointer event, in the controller's terms
 * @property {number} [id]               the pointer's id (each finger has its own)
 * @property {number} x                  CSS px from the canvas's left
 * @property {number} y
 * @property {number} [time]             ms, on the controller's clock
 * @property {string} [pointerType]      "mouse", "touch" or "pen"
 * @property {number} [button]           which button pressed (2, the secondary, is left to the page)
 * @property {boolean} [shiftKey]
 * @property {boolean} [ctrlKey]
 * @property {boolean} [metaKey]
 * @property {boolean} [altKey]
 *
 * @typedef {object} Pointer             a pressed pointer, and what it's doing
 * @property {number} id
 * @property {"drag" | "pan" | "pinch" | "idle"} role  dragging a node, panning, one of a pinch's two, or ignored
 * @property {string} type               pointerType
 * @property {number} node               the node dragged (an index into the working graph), or -1
 * @property {string} [nodeId]           its id, so the drag survives a rebuild of the working graph
 * @property {number[]} [carried]        the nodes it carries (itself, and its subtree when static drags carry them)
 * @property {{ x: number, y: number }} [offset] from the pointer to the node, world px
 * @property {{ x: number, y: number }} screen   where it is
 * @property {{ x: number, y: number, time: number }} start where and when it was pressed
 * @property {number} t                  when it last moved
 * @property {number} vx                 smoothed speed, world px/s
 * @property {number} vy
 * @property {boolean} tap               still a tap (or a long press): hasn't wandered, wasn't part of a pinch
 * @property {boolean} long              a long press was reported
 * @property {boolean} started           a dragStart or panStart was reported
 * @property {boolean} additive          shift, ctrl or cmd was held (a tap adds to or removes from the selection)
 */

export class GraphController {
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
    } = {},
  ) {
    this.onEvent = onEvent;
    this.onFrame = onFrame;
    this.onChange = onChange;
    this.clock = clock;
    this.wheelMode = wheel;
    this.tapSelects = tapSelects;
    /** @type {Map<string, Set<(detail: any) => void>>} listeners by event type (see `on`) */
    this.listeners = new Map();
    if (!LAYOUTS[layout]) throw new Error(`Unknown layout "${layout}"`);
    this.layout = layout;
    this.layoutOpts = resolve(LAYOUTS[layout].options, layoutOptions);
    this.mode = LAYOUTS[layout].physics[physics] ? physics : "static";
    this.modeOpts = physicsOptions(layout, this.mode, physicsOpts);
    this.anim = resolve(ANIMATION_OPTIONS, animation);
    this.camera = { x: 0, y: 0, k: 1 };
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
    /** @type {Map<number, Pointer>} pressed pointers by id */
    this.pointers = new Map();
    this.hover = -1; // the node under a hovering pointer (an index into the working graph), or -1
    this.hoverReference = false; // found through one of its references
    this.pinch = null; // two pointers zooming: { a, b, dist, k, anchor }
    this.lastTap = null; // { time, x, y, node }: the first half of a possible double tap
    this.wheelBurst = { time: -Infinity, zoom: true };
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
    this.selectionCache = { key: "", mask: null, lit: null };
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
    this.scene = null;
    this.renderer = null;

    this.model = GraphModel.from(model);
    this.unlisten = this.model.onChange((change) => this.#onModel(change));
    this.graph = new Graph(); // empty until the first layout below
    this.#carry(null, null);
    this.looks = looksOf(this.graph, this.node, this.edge);
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
    this.#emit("graph", this.model.stats());
    for (const issue of this.model.issues) this.#emit("graphIssue", issue);
  }

  /** How nodes look: the model's node options. */
  get node() {
    return this.model.opts.node;
  }

  /** How edges look: the model's edge options. */
  get edge() {
    return this.model.opts.edge;
  }

  // ---- events --------------------------------------------------------------------------------------------------

  /**
   * Call `listener(detail)` on every event of `type` (see the README of events in next/MODEL.md, or `onEvent` for
   * all of them). Returns a function that stops it.
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
   * looks or data changed → restyle, nothing moves.
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
      this.#relayout();
      const report = () =>
        this.#emit("graph", {
          ...this.model.stats(),
          ...(shown && {
            added: change.nodesAdded.length,
            removed: change.nodesRemoved.length,
          }),
        });
      // The stats walk the whole graph: for a big one, after this frame rather than in the middle of the update.
      if (this.onEvent && this.model.size >= WORKER_MIN) setTimeout(report, 0);
      else report();
      return;
    }
    // While a new structure is being laid out, the graph on screen is the old one: it keeps its records (the new one
    // takes the model's when it's put in place).
    if (
      this.graph.model === this.model &&
      this.graph.structure === this.model.structureVersion
    )
      this.graph.refresh();
    if (change.sizes) this.#relayout({ fit: null });
    else this.#restyle();
    this.#emit("graphRestyle", {
      nodes: change.nodesChanged.length,
      edges: change.edgesChanged.length,
    });
  }

  /** Looks changed, nothing moved: new colours and sizes for the renderer. */
  #restyle() {
    this.looks = looksOf(this.graph, this.node, this.edge);
    this.version++;
    this.geometryVersion++;
    this.#changed();
  }

  /** Replace the graph: the model takes `input` (JSON, or another model's graph) and keeps what's unchanged. */
  setGraph(input) {
    return this.model.replace(input);
  }

  /** Change the graph by a delta (see GraphModel.update). */
  update(delta) {
    return this.model.update(delta);
  }

  /** Show a different model: its nodes glide from where the same ids were in the old one. */
  setModel(model) {
    this.unlisten();
    this.model = GraphModel.from(model);
    if (this.renderer?.measureText && !this.model.measured)
      this.model.setMeasure(this.renderer.measureText);
    this.unlisten = this.model.onChange((change) => this.#onModel(change));
    this.#relayout();
    this.#emit("graph", this.model.stats());
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
    const kept = (i) =>
      previous && i >= 0
        ? (graph.byId.get(previous.nodes[i].id)?.index ?? -1)
        : -1;
    const hover = kept(this.hover);
    if (hover < 0) this.#setHover(-1, false, previous);
    else this.hover = hover;
    for (const ptr of this.pointers.values()) {
      if (ptr.role !== "drag") continue;
      const at = graph.byId.get(ptr.nodeId)?.index ?? -1;
      if (at >= 0) {
        // Still here: the drag carries on, holding the same node (and, for a subtree drag, its subtree as it is now).
        ptr.node = at;
        ptr.carried = this.#carried(at);
        for (const i of ptr.carried) this.sim.held.add(i);
        continue;
      }
      // The node it held is gone: the drag ends, and the pointer pans from here.
      if (ptr.started)
        this.#emit("dragEnd", {
          node: ptr.nodeId,
          thrown: false,
          screenSpeed: 0,
          cancelled: true,
        });
      Object.assign(ptr, {
        role: "pan",
        node: -1,
        nodeId: undefined,
        carried: undefined,
        started: false,
        vx: 0,
        vy: 0,
      });
    }
    // The selection is by id: ids that left the graph leave it.
    const gone = [...this.selection].filter((id) => !graph.byId.has(id));
    if (gone.length && previous) {
      for (const id of gone) this.selection.delete(id);
      this.selectionVersion++;
      this.#emit("select", { selected: this.selected });
    }
  }

  /**
   * Everything needed to show this view again exactly: the graph, settings, camera and every node's layout state
   * (see snapshot.js and next/MODEL.md). While a layout is on its way, it's the graph on screen.
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
          animation: this.anim,
          renderer: this.renderer?.name,
        },
        camera: this.camera,
      },
      note,
    );
  }

  /** Show a snapshot: its graph, settings, camera and node positions, as they were (no morph). */
  restore(snapshot) {
    const graph = snapshotModel(snapshot).toJSON();
    const { settings = {} } = snapshot;
    this.quiet = true; // apply everything, then lay out once
    try {
      if (settings.animation) this.setAnimation(settings.animation);
      this.model.setOptions({ node: settings.node, edge: settings.edge });
      this.model.replace(graph);
    } finally {
      this.quiet = false;
    }
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
    this.#emit("restore", { nodes: this.model.size, time: snapshot.time });
  }

  // ---- the renderer --------------------------------------------------------------------------------------------

  /**
   * Draw on `renderer` from now on (the old one lets go of the screen). Its text measurement becomes the model's,
   * unless the model was given its own.
   */
  setRenderer(renderer) {
    if (renderer === this.renderer) return;
    this.renderer?.detach(this);
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
    this.renderer?.detach(this);
    this.renderer = null;
    this.pointers.clear();
    this.pinch = null;
  }

  // ---- settings ------------------------------------------------------------------------------------------------
  //
  // Every setter merges: the options given change, the rest stay as they are (as node and edge styles do). Options
  // belong to one layout or one physics mode, so a different layout or mode starts from its own defaults.

  /** How things move between states (ANIMATION_OPTIONS, all or some). */
  setAnimation(opts = {}) {
    this.anim = resolve(ANIMATION_OPTIONS, { ...this.anim, ...opts });
    this.#changed();
    this.#emit("animation", this.anim);
  }

  /** Lay out with layout `name` (see LAYOUTS) and its options, all or some. A new layout is framed. */
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
   */
  setPhysics(mode = this.mode, opts = {}) {
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

  /** How nodes look (NODE_OPTIONS, all or some): the model's options, so every view of it changes. */
  setNodeStyle(opts) {
    this.model.setOptions({ node: opts });
  }

  /** How edges look (EDGE_OPTIONS, all or some). */
  setEdgeStyle(opts) {
    this.model.setOptions({ edge: opts });
  }

  /** Send everything back to its home (a node being dragged is let go first). */
  reset() {
    for (const ptr of this.pointers.values())
      if (ptr.role === "drag") this.#endGesture(ptr, { cancel: true });
    this.#startTween();
    this.#changed();
    this.#emit("reset");
  }

  /** The drawing area's size in CSS px, and device pixels per CSS px. Frames again if the camera hasn't been moved. */
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
   * Frame the graph where it is (or where it's heading, mid-transition). While a layout is on its way, the graph it
   * brings is framed when it arrives (and the graph on screen meanwhile).
   */
  fit(animate = true) {
    this.glide = null;
    this.shift = null;
    this.focused = null;
    this.framed = true;
    if (this.layoutPending) this.pendingFit = animate ? "animate" : "instant";
    if (!this.graph.nodes.length) return this.#changed();
    const target = this.#framing(!!this.tween);
    if (animate)
      this.cameraTween = {
        from: { ...this.camera },
        to: target,
        start: this.clock(),
      };
    else {
      this.camera = target;
      this.cameraTween = null;
    }
    this.#changed();
    this.#emit("fit", { k: target.k });
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
    if (animate)
      this.cameraTween = {
        from: { ...this.camera },
        to,
        start: this.clock(),
        node: id,
      };
    else {
      this.camera = to;
      this.cameraTween = null;
    }
    this.#changed();
    this.#emit("focus", { node: id, k });
    return true;
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
   */
  zoomLimits() {
    const fit = this.homeBox ? this.#fitScale(this.homeBox) : MIN_ZOOM;
    return { min: Math.min(MIN_ZOOM, fit / 2), max: MAX_ZOOM };
  }

  /**
   * Zoom by `factor` about canvas point (x, y) (default: the middle), keeping the world point under it in place.
   * For zoom buttons, and the renderer's pinch gestures.
   */
  zoomBy(factor, x = this.width / 2, y = this.height / 2) {
    const before = this.toWorld(x, y);
    const { min, max } = this.zoomLimits();
    this.#userCamera();
    this.camera.k = Math.min(Math.max(this.camera.k * factor, min), max);
    const after = this.toWorld(x, y);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.#changed();
  }

  /** The user took the camera: it's theirs now (no framing, focusing or easing of its own). */
  #userCamera() {
    this.cameraTween = null;
    this.glide = null;
    this.framed = false;
    this.focused = null;
  }

  /** The scale that fits a box of world px (with padding) in the view, at most FIT_MAX. */
  #fitScale({ minX, minY, maxX, maxY }) {
    return Math.min(
      (this.width - FIT_PAD * 2) / Math.max(maxX - minX, 1),
      (this.height - FIT_PAD * 2) / Math.max(maxY - minY, 1),
      FIT_MAX,
    );
  }

  /** The box every node's footprint covers, at its position or its home. */
  #footprints(homes) {
    const m = this.graph.matrix;
    const xs = homes ? m.homeX : m.x,
      ys = homes ? m.homeY : m.y;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < m.count; i++) {
      // A node flung off to infinity can't be framed: leave it out rather than lose the whole graph.
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
      minX = Math.min(minX, xs[i] + m.boxX0[i]);
      minY = Math.min(minY, ys[i] + m.boxY0[i]);
      maxX = Math.max(maxX, xs[i] + m.boxX1[i]);
      maxY = Math.max(maxY, ys[i] + m.boxY1[i]);
    }
    if (minX > maxX) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY };
  }

  /** A camera framing the graph: footprints, not just centres, so labels at the edge stay on screen. */
  #framing(homes) {
    const box = this.#footprints(homes);
    return {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      // However wide the graph, it fits: no floor but a tiny one that keeps the arithmetic finite.
      k: Math.max(this.#fitScale(box), 1e-6),
    };
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
    const candidates = [
      this.pointer?.node ?? -1,
      this.hover,
      ...[...this.selection].map((id) => graph.byId.get(id)?.index ?? -1),
      this.focused === null ? -1 : (graph.byId.get(this.focused)?.index ?? -1),
    ];
    let at = candidates.find((i) => i >= 0 && onScreen(i)) ?? -1;
    if (at < 0) {
      // Nearest the middle (only nodes that will still be there count, but the check is a map lookup: only made for
      // nodes nearer than the best so far).
      const { x: cx, y: cy } = this.camera;
      const next = this.model;
      let best = Infinity;
      for (let i = 0; i < m.count; i++) {
        const d = (m.x[i] - cx) ** 2 + (m.y[i] - cy) ** 2;
        if (d < best && next.node(graph.nodes[i].id)) {
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
    const rebuilding =
      this.graph.model !== this.model ||
      this.graph.structure !== this.model.structureVersion;
    const target = rebuilding ? new Graph(this.model) : this.graph;
    const spec = this.#sizingSpec(
      target,
      looksOf(target, this.node, this.edge),
    );
    const job = { id: ++this.layoutRequest, target, rebuilding, fit, spec };
    const result = sync
      ? runLayout(target, this.layout, this.layoutOpts, spec)
      : this.layouter.run(target, this.layout, this.layoutOpts, spec);
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
    target.matrix.homeX.set(result.homeX);
    target.matrix.homeY.set(result.homeY);
    let previous = null,
      was = null,
      fit = job.fit ?? (this.framed ? (this.pendingFit ?? "animate") : null);
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
    this.looks = looksOf(this.graph, this.node, this.edge);
    this.#placeLabels(job.spec);
    this.homeBox = this.#footprints(true);
    this.#configureSim();
    if (job.rebuilding) this.#arrive(previous, was);
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
      this.cameraTween = {
        from: { ...this.camera },
        to: this.#framing(true),
        start: this.clock(),
      };
    } else if (!fit && !this.cameraTween) this.#holdPlace(anchor);
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
      (this.sim.asleep || (this.mode === "floating" && this.modeOpts.drift > 0))
    );
  }

  /**
   * What a layout needs to know about sizes (layout-job.js): each node's label width (the model's, measured once
   * each) and how far its shape reaches, and the label settings that turn those into footprints.
   */
  #sizingSpec(graph, looks) {
    const { node } = this;
    const labelled = node.labels !== "off";
    return {
      widths: labelled
        ? this.model.labelWidths()
        : new Float64Array(graph.nodes.length),
      reach: Float64Array.from(
        graph.nodes,
        (n) => looks.radius[n.index] * reach(looks.shape[n.index]),
      ),
      height: this.model.labelHeight,
      gap: node.collisionRadius,
      labels: node.labels,
      collide: labelled && node.labelCollide,
    };
  }

  /** Fix each node's label direction from its home, and the footprint that goes with it. */
  #placeLabels(spec) {
    const m = this.graph.matrix;
    for (let i = 0; i < m.count; i++) {
      const angle = labelAngle(
        this.node.labels,
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

  /**
   * Where a new graph's nodes start. Nodes the previous graph had start where they were. New ones, by the `enter`
   * setting: grow out of their nearest ancestor that was already there (or their root's new place), fade in where
   * they land, or just appear there. One pass, parents before children: each new node takes its parent's answer.
   * @param {Graph | null} previous
   * @param {Int32Array | null} was  per node, its index in `previous` (-1: new)
   */
  #arrive(previous, was) {
    const { nodes, matrix: m, order } = this.graph;
    const count = nodes.length;
    const enter = this.anim.enter;
    // Per node: the previous graph's index of its nearest ancestor that was already there (-1: none), and its root.
    const from = new Int32Array(count).fill(-1);
    const root = Int32Array.from({ length: count }, (_, i) => i);
    for (const i of order) {
      const p = nodes[i].parent;
      if (p < 0) continue;
      root[i] = root[p];
      from[i] = was && was[p] >= 0 ? was[p] : from[p];
    }
    for (let i = 0; i < count; i++) {
      const old = was ? was[i] : -1;
      if (old >= 0) {
        m.x[i] = previous.matrix.x[old];
        m.y[i] = previous.matrix.y[old];
        continue;
      }
      this.appear[i] = enter === "none" ? 1 : 0;
      if (enter !== "grow") {
        m.x[i] = m.homeX[i];
        m.y[i] = m.homeY[i];
      } else if (from[i] >= 0) {
        m.x[i] = previous.matrix.x[from[i]];
        m.y[i] = previous.matrix.y[from[i]];
      } else {
        m.x[i] = m.homeX[root[i]];
        m.y[i] = m.homeY[root[i]];
      }
    }
    this.fading = true;
  }

  /** Progress 0–1 of an animation that started at `start` and lasts `ms`, eased. */
  #progress(now, start, ms) {
    // A frame stamped a little before the change that started it counts as its start, not as before it.
    const t = ms > 0 ? Math.min(Math.max((now - start) / ms, 0), 1) : 1;
    return { t, f: (EASINGS[this.anim.easing] ?? EASINGS.smooth)(t) };
  }

  /**
   * Ease hover emphasis and fade-ins toward their targets (`lit`: a flag per node to light, or null for all).
   * Returns true while anything is still changing.
   */
  #fade(dt, lit) {
    if (lit !== this.lit) {
      this.lit = lit;
      this.fading = true;
    }
    if (!this.fading) return false;
    let changing = false,
      arriving = false;
    const { shade, appear } = this;
    for (let i = 0; i < shade.length; i++) {
      const target = !lit || lit[i] ? 1 : 0;
      if (shade[i] !== target) {
        shade[i] = approach(shade[i], target, dt, this.anim.hoverFade);
        changing = true;
      }
      if (appear[i] < 1) {
        appear[i] =
          this.anim.transition > 0
            ? Math.min(1, appear[i] + (dt * 1000) / this.anim.transition)
            : 1;
        changing = true;
        arriving ||= appear[i] < 1;
      }
    }
    this.fading = changing;
    this.arriving = arriving;
    return changing;
  }

  #configureSim() {
    this.sim.configure(
      this.mode,
      this.modeOpts,
      constrainer(this.routing, this.modeOpts),
      {
        boxes: this.node.labelCollide && this.node.labels !== "off",
        padding: this.node.collisionRadius,
      },
    );
  }

  /** Glide every node from where it is to its home, over the animation's transition time. */
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
   * @returns {TickResult}
   */
  tick(now) {
    const gap = this.last ? (now - this.last) / 1000 : 0;
    const dt = gap ? Math.min(gap, 0.1) : 1 / 60;
    this.last = now;

    let busy;
    const simStart = performance.now();
    if (this.tween) {
      const { t, f } = this.#progress(
        now,
        this.tween.start,
        this.anim.transition,
      );
      this.#morph(f);
      if (t >= 1) {
        this.tween = null;
        this.sim.wake();
      }
      this.version++;
      busy = true;
    } else {
      this.sim.advance(dt);
      if (this.sim.moved) this.version++;
      busy = !this.sim.asleep;
    }
    const simMs = performance.now() - simStart;
    if (this.cameraTween) {
      const { t, f } = this.#progress(
        now,
        this.cameraTween.start,
        this.anim.camera,
      );
      const { from, to, node } = this.cameraTween;
      // Focusing on a node follows it, wherever it's heading now.
      const n = node !== undefined && this.graph.byId.get(node);
      if (n) Object.assign(to, this.#whereTo(n.index));
      // Zoom moves in log space so it feels even.
      this.camera = {
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        k: from.k * (to.k / from.k) ** f,
      };
      if (t >= 1) this.cameraTween = null;
      busy = true;
    }
    if (this.shift) {
      const { t, f } = this.#progress(
        now,
        this.shift.start,
        this.anim.transition,
      );
      this.camera.x += (f - this.shift.done) * this.shift.dx;
      this.camera.y += (f - this.shift.done) * this.shift.dy;
      this.shift.done = f;
      if (t >= 1) this.shift = null;
      busy = true;
    }
    if (this.glide) busy = this.#coast(dt) || busy;
    this.#longPresses(now);

    if (this.#fade(dt, this.#litMask())) {
      this.shadeVersion++;
      busy = true;
    }
    // Edge routing knows when a layout morph is running (radial step edges keep their arcs through it).
    this.routing.morphing = !!this.tween;
    // References and ghosts are drawn from a display graph; everything else (physics, hover, hit-testing) uses the
    // real one.
    let shown = withReferences(this.graph, this.routing.references, {
      looks: this.looks,
      shade: this.shade,
      appear: this.appear,
    });
    if (this.ghosts.length) {
      shown = withGhosts(
        shown.graph,
        this.ghosts,
        shown,
        now,
        this.anim.transition,
        EASINGS[this.anim.easing] ?? EASINGS.smooth,
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
      // Interaction state for painters to show: the hovered node (an index into the real graph, -1 for none), and a
      // flag per real node for the selection (null when nothing's selected). Display-only nodes (references, ghosts)
      // come after the real ones and are never selected.
      hover: this.hover,
      selected: this.#selectionMask(),
      selectionVersion: this.selectionVersion,
      version: this.version,
      shadeVersion: this.shadeVersion,
      geometryVersion: this.geometryVersion,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      background: BACKGROUND,
    };
    busy ||= this.pointers.size > 0;
    if (!this.#isSettled()) this.calm = false;
    else if (!this.calm) {
      this.calm = true;
      this.#emit("settled", { nodes: this.graph.nodes.length });
      for (const resolve of this.settleWaiters.splice(0)) resolve();
    }
    const dragging = this.pointer?.node >= 0;
    return {
      busy,
      gap,
      simMs,
      energy: this.sim.energy,
      state: this.layoutPending
        ? "laying out"
        : this.tween
          ? "moving to layout"
          : dragging
            ? "dragging"
            : this.pinch
              ? "zooming"
              : busy
                ? "moving"
                : "at rest",
    };
  }

  /**
   * The nodes the shading lights up: the lineage of the node being dragged, or else the hovered one, or else of
   * the selection (so a tap on a touch screen, with no hover, still shows a node's family). Null: all of them.
   */
  #litMask() {
    const on = this.pointer?.node >= 0 ? this.pointer.node : this.hover;
    if (on >= 0) return this.lineages.get(this.graph, on);
    if (!this.selection.size) return null;
    this.#selectionMask();
    return this.selectionCache.lit;
  }

  /** A flag per node of the working graph for the selection (null when nothing's selected), and its lineage. */
  #selectionMask() {
    if (!this.selection.size) return null;
    const key = `${this.selectionVersion}`;
    const cache = this.selectionCache;
    if (cache.key === key && cache.graph === this.graph) return cache.mask;
    const count = this.graph.nodes.length;
    const mask = new Uint8Array(count);
    let lit = null;
    for (const id of this.selection) {
      const n = this.graph.byId.get(id);
      if (!n) continue;
      mask[n.index] = 1;
      lit = lineageMask(this.graph, n.index, lit ?? new Uint8Array(count));
    }
    Object.assign(cache, { key, graph: this.graph, mask, lit });
    return mask;
  }

  /** One morph frame: every node `f` of the way from where it started to its home (round the rings in a radial). */
  #morph(f) {
    const m = this.graph.matrix;
    const { x, y, homeX, homeY, count } = m;
    const { x: x0, y: y0 } = this.tween;
    const held = this.sim.held;
    if (this.routing.kind === "radial") {
      for (let i = 0; i < count; i++) {
        if (held.size && held.has(i)) continue;
        [x[i], y[i]] = alongRings(
          this.routing,
          x0[i],
          y0[i],
          homeX[i],
          homeY[i],
          f,
        );
      }
      return;
    }
    for (let i = 0; i < count; i++) {
      if (held.size && held.has(i)) continue;
      x[i] = x0[i] + (homeX[i] - x0[i]) * f;
      y[i] = y0[i] + (homeY[i] - y0[i]) * f;
    }
  }

  /** Nothing more to do for now: the next tick starts timing afresh instead of seeing one long gap. */
  rest() {
    this.last = 0;
  }

  /** Tick from `start` to `start + ms`, `step` ms at a time (tests and headless use). Returns the last result. */
  run(ms, { start = this.clock(), step = 1000 / 60 } = {}) {
    let result = null;
    for (let t = 0; t <= ms; t += step) result = this.tick(start + t);
    return result;
  }

  /** The camera coasting after a pan, slowed by the same friction as the nodes. Returns false once stopped. */
  #coast(dt) {
    const keep = Math.exp(-this.modeOpts.friction * dt);
    const speed = Math.hypot(this.glide.x, this.glide.y);
    const slowed = Math.max(speed * keep - this.modeOpts.friction * 6 * dt, 0);
    if (slowed < 2) {
      this.glide = null;
      return false;
    }
    this.glide.x *= slowed / speed;
    this.glide.y *= slowed / speed;
    this.camera.x += this.glide.x * dt;
    this.camera.y += this.glide.y * dt;
    return true;
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

  // ---- interaction ---------------------------------------------------------------------------------------------

  /** A point on the canvas (CSS px from its top-left) in world coordinates. */
  toWorld(x, y) {
    return {
      x: (x - this.width / 2) / this.camera.k + this.camera.x,
      y: (y - this.height / 2) / this.camera.k + this.camera.y,
    };
  }

  /** A world point on the canvas (CSS px from its top-left). */
  toScreen(x, y) {
    return {
      x: (x - this.camera.x) * this.camera.k + this.width / 2,
      y: (y - this.camera.y) * this.camera.k + this.height / 2,
    };
  }

  /**
   * The topmost node under a world point, or -1. With `references`, a reference under the point counts as its
   * ingredient (for hover: pointing at a reference lights up the ingredient and everything that uses it).
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
      grid.index = new HitGrid(m);
    }
    const direct = grid.index.at(p.x, p.y, slack);
    if (direct >= 0 || !references) return { index: direct, reference: false };
    for (const ref of this.routing.references ?? []) {
      const s = ref.source;
      const rx = ref.x + m.x[s] - m.homeX[s],
        ry = ref.y + m.y[s] - m.homeY[s];
      const r = m.radius[ref.target] * REFERENCE_SCALE;
      if (Math.hypot(rx - p.x, ry - p.y) <= r * HIT_SCALE + slack)
        return { index: ref.target, reference: true };
    }
    return { index: -1, reference: false };
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

  /** The pressed pointer that's dragging a node or panning (there's at most one), or null. */
  get pointer() {
    for (const ptr of this.pointers.values())
      if (ptr.role === "drag" || ptr.role === "pan") return ptr;
    return null;
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
   * A press at canvas point (x, y). The first pointer grabs the node there or starts a pan; a second one turns the
   * two into a pinch (the drag or pan ends); any more are ignored until those lift.
   * @param {PointerInput} input
   */
  pointerDown({
    id = 1,
    x,
    y,
    time = this.clock(),
    pointerType = "mouse",
    button = 0,
    shiftKey = false,
    ctrlKey = false,
    metaKey = false,
  }) {
    if (button === 2) return; // the secondary button is the page's (a context menu)
    if (this.pointers.has(id)) this.pointerCancel({ id, time }); // its release was missed
    /** @type {Pointer} */
    const ptr = {
      id,
      role: "idle",
      type: pointerType,
      node: -1,
      screen: { x, y },
      start: { x, y, time },
      t: time,
      vx: 0,
      vy: 0,
      tap: true,
      long: false,
      started: false,
      additive: shiftKey || ctrlKey || metaKey,
    };
    const first = this.pinch ? null : this.pointer;
    this.pointers.set(id, ptr);
    this.cameraTween = null;
    this.glide = null;
    if (this.pinch)
      ptr.tap = false; // a third finger: ignored
    else if (first) {
      // A second finger: whatever the first was doing stops, and the two pinch.
      this.#endGesture(first, { cancel: true });
      this.#startPinch(first, ptr);
    } else {
      const p = this.toWorld(x, y);
      const node = this.#pick(p, false).index;
      if (node >= 0) {
        const m = this.graph.matrix;
        Object.assign(ptr, {
          role: "drag",
          node,
          nodeId: this.graph.nodes[node].id,
          offset: { x: m.x[node] - p.x, y: m.y[node] - p.y },
          carried: this.#carried(node),
        });
        // Held from the press, so a node in motion stops under the finger; the drag starts once it moves.
        for (const i of ptr.carried) {
          this.sim.held.add(i);
          m.vx[i] = m.vy[i] = 0;
        }
      } else ptr.role = "pan";
    }
    this.#changed();
  }

  /** Smoothed pointer speed in world px/s, capped so a hard flick can't send anything off into the distance. */
  #track(ptr, dx, dy, time) {
    const dt = Math.max((time - ptr.t) / 1000, 1 / 240);
    ptr.vx += (dx / dt - ptr.vx) * 0.4;
    ptr.vy += (dy / dt - ptr.vy) * 0.4;
    const cap = MAX_THROW / this.camera.k;
    const speed = Math.hypot(ptr.vx, ptr.vy);
    if (speed > cap) {
      ptr.vx *= cap / speed;
      ptr.vy *= cap / speed;
    }
    ptr.t = time;
  }

  /**
   * A pointer moved to canvas point (x, y): a pressed one drags, pans or pinches; one that isn't pressed (a mouse
   * or pen hovering) hovers.
   * @param {PointerInput} input
   */
  pointerMove({ id = 1, x, y, time = this.clock() }) {
    const ptr = this.pointers.get(id);
    if (!ptr) {
      const { index, reference } = this.#pick(this.toWorld(x, y));
      this.#setHover(index, reference);
      return;
    }
    const last = ptr.screen;
    ptr.screen = { x, y };
    if (
      ptr.tap &&
      Math.hypot(x - ptr.start.x, y - ptr.start.y) >
        (TAP_SLOP[ptr.type] ?? TAP_SLOP.mouse)
    )
      ptr.tap = false;
    if (ptr.role === "pinch") return this.#pinchMove();
    if (ptr.role === "pan") {
      const dx = -(x - last.x) / this.camera.k;
      const dy = -(y - last.y) / this.camera.k;
      this.#userCamera();
      this.camera.x += dx;
      this.camera.y += dy;
      this.#track(ptr, dx, dy, time);
      if (!ptr.tap && !ptr.started) {
        ptr.started = true;
        this.#emit("panStart", { x: ptr.start.x, y: ptr.start.y });
      }
      this.#changed();
      return;
    }
    if (ptr.role !== "drag") return;
    const p = this.toWorld(x, y);
    const m = this.graph.matrix;
    const dx = p.x + ptr.offset.x - m.x[ptr.node],
      dy = p.y + ptr.offset.y - m.y[ptr.node];
    this.#track(ptr, dx, dy, time);
    this.version++;
    for (const i of ptr.carried) {
      m.x[i] += dx;
      m.y[i] += dy;
    }
    if (!ptr.tap && !ptr.started) {
      ptr.started = true;
      this.#emit("dragStart", {
        node: ptr.nodeId,
        carried: ptr.carried.length,
      });
    }
    this.#changed();
  }

  /**
   * The press ended: a dragged node is let go (thrown, if it was moving), a pan glides on, a pinch's other pointer
   * pans on. A press that didn't wander is a tap (two quick ones a double tap), unless it was a long press.
   * @param {Partial<PointerInput>} [input]
   */
  pointerUp({ id = 1, time = this.clock() } = {}) {
    const ptr = this.pointers.get(id);
    if (!ptr) return;
    this.#longPresses(time);
    this.pointers.delete(id);
    if (ptr.role === "pinch") this.#endPinch();
    else {
      this.#endGesture(ptr, { time });
      if (ptr.tap && !ptr.long) this.#tap(ptr, time);
    }
    this.#changed();
  }

  /**
   * The press was taken away (the browser's pointercancel: a system gesture, the pointer lost): like a release, but
   * nothing is thrown and it's never a tap.
   * @param {Partial<PointerInput>} [input]
   */
  pointerCancel({ id = 1, time = this.clock() } = {}) {
    const ptr = this.pointers.get(id);
    if (!ptr) return;
    this.pointers.delete(id);
    if (ptr.role === "pinch") this.#endPinch();
    else this.#endGesture(ptr, { cancel: true, time });
    this.#changed();
  }

  /**
   * End what a pointer was doing: let a dragged node go (thrown if it was still moving, unless `cancel`), or let a
   * pan glide on. Sends dragEnd or panEnd if it had started. The pointer is left idle.
   */
  #endGesture(ptr, { cancel = false, time = this.clock() } = {}) {
    const thrown = !cancel && time - ptr.t < 80; // a pointer that stopped before letting go throws nothing
    if (ptr.role === "drag") {
      const m = this.graph.matrix;
      this.sim.wake();
      for (const i of ptr.carried) {
        this.sim.held.delete(i);
        if (this.modeOpts.fling && thrown) {
          m.vx[i] = ptr.vx;
          m.vy[i] = ptr.vy;
        }
      }
    } else if (ptr.role === "pan" && thrown && ptr.started) {
      this.glide = { x: ptr.vx, y: ptr.vy };
    }
    if (ptr.started) {
      const speed = Math.round(Math.hypot(ptr.vx, ptr.vy) * this.camera.k);
      const drag = ptr.role === "drag";
      this.#emit(drag ? "dragEnd" : "panEnd", {
        node: drag ? ptr.nodeId : undefined,
        thrown: thrown && (!drag || this.modeOpts.fling),
        screenSpeed: thrown ? speed : 0,
        ...(cancel && { cancelled: true }),
      });
    }
    Object.assign(ptr, {
      role: "idle",
      node: -1,
      carried: undefined,
      started: false,
    });
  }

  /** Two pointers down: from now on their midpoint pans and their spread zooms. */
  #startPinch(a, b) {
    a.role = b.role = "pinch";
    a.tap = b.tap = false;
    const mid = {
      x: (a.screen.x + b.screen.x) / 2,
      y: (a.screen.y + b.screen.y) / 2,
    };
    this.#userCamera();
    this.pinch = {
      a: a.id,
      b: b.id,
      dist: Math.max(
        Math.hypot(a.screen.x - b.screen.x, a.screen.y - b.screen.y),
        1,
      ),
      k: this.camera.k,
      // The world point under the fingers' midpoint stays under it.
      anchor: this.toWorld(mid.x, mid.y),
    };
    this.#emit("pinchStart", { k: this.camera.k });
  }

  #pinchMove() {
    const { a, b, dist, k, anchor } = this.pinch;
    const pa = this.pointers.get(a).screen,
      pb = this.pointers.get(b).screen;
    const { min, max } = this.zoomLimits();
    const spread = Math.max(Math.hypot(pa.x - pb.x, pa.y - pb.y), 1);
    const scale = Math.min(Math.max((k * spread) / dist, min), max);
    const mx = (pa.x + pb.x) / 2,
      my = (pa.y + pb.y) / 2;
    this.camera = {
      x: anchor.x - (mx - this.width / 2) / scale,
      y: anchor.y - (my - this.height / 2) / scale,
      k: scale,
    };
    this.#changed();
  }

  /** One of a pinch's pointers lifted: the pinch ends, and the one still down pans from where it is. */
  #endPinch() {
    const { a, b } = this.pinch;
    this.pinch = null;
    for (const id of [a, b]) {
      const ptr = this.pointers.get(id);
      if (!ptr) continue;
      Object.assign(ptr, {
        role: "pan",
        start: { ...ptr.screen, time: ptr.t },
        vx: 0,
        vy: 0,
      });
    }
    this.#emit("pinchEnd", { k: this.camera.k });
  }

  /** Long presses: a pointer held still for LONG_PRESS ms, reported once (and then its release isn't a tap). */
  #longPresses(now) {
    for (const ptr of this.pointers.values()) {
      if (!ptr.tap || ptr.long || now - ptr.start.time < LONG_PRESS) continue;
      ptr.long = true;
      this.#emit("longPress", this.#at(ptr.screen, ptr.type));
    }
  }

  /** What's at a canvas point, for tap and press events: the node (id, or null), and where, on screen and world. */
  #at({ x, y }, pointerType) {
    const world = this.toWorld(x, y);
    const { index, reference } = this.#pick(world);
    return {
      node: index >= 0 ? this.graph.nodes[index].id : null,
      reference,
      x,
      y,
      world,
      pointerType,
    };
  }

  /**
   * A tap: sends "tap" (and "doubleTap" for the second of two quick ones in about the same place), selects what was
   * tapped (if `tapSelects`), and frames the graph on a double tap on empty space.
   */
  #tap(ptr, time) {
    const detail = this.#at(ptr.screen, ptr.type);
    this.#emit("tap", detail);
    const last = this.lastTap;
    if (
      last &&
      time - last.time <= DOUBLE_TAP.ms &&
      Math.hypot(detail.x - last.x, detail.y - last.y) <= DOUBLE_TAP.px &&
      last.node === detail.node
    ) {
      this.lastTap = null;
      this.#emit("doubleTap", detail);
      if (detail.node === null) this.fit();
      return;
    }
    this.lastTap = { time, x: detail.x, y: detail.y, node: detail.node };
    if (!this.tapSelects) return;
    if (detail.node === null) {
      if (!ptr.additive) this.select(null);
    } else
      this.select(detail.node, { toggle: ptr.additive, add: ptr.additive });
  }

  /** The hover moves to node `index` (-1: none), found directly or through one of its references. */
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

  /** The pointer left the canvas: no more hover (a press in progress carries on). */
  pointerLeave({ id } = {}) {
    if (this.pointers.has(id) || this.pointer) return;
    this.#setHover(-1, false);
  }

  /**
   * A wheel or a trackpad at canvas point (x, y). A pinch on a trackpad (ctrl+wheel) zooms about the point, and so
   * does a mouse wheel; a two-finger scroll on a trackpad pans (see the `wheel` option). Lines and pages
   * (`deltaMode` 1 and 2) are turned into pixels first, so every browser zooms at the same speed.
   * @param {{ x: number, y: number, deltaX?: number, deltaY?: number, deltaMode?: number, ctrlKey?: boolean,
   *   wheelDeltaY?: number, time?: number }} input
   */
  wheel({
    x,
    y,
    deltaX = 0,
    deltaY = 0,
    deltaMode = 0,
    ctrlKey = false,
    wheelDeltaY,
    time = this.clock(),
  }) {
    const unit = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? this.height : 1;
    const dx = deltaX * unit,
      dy = deltaY * unit;
    let zoom = ctrlKey || this.wheelMode === "zoom";
    if (!ctrlKey && this.wheelMode === "auto") {
      // One gesture is one kind: decided by its first event (a trackpad's later events can look like a wheel's).
      if (time - this.wheelBurst.time > WHEEL_BURST)
        this.wheelBurst.zoom = !looksLikeTrackpad(
          dx,
          dy,
          deltaMode,
          wheelDeltaY,
        );
      this.wheelBurst.time = time;
      zoom = this.wheelBurst.zoom;
    }
    if (zoom) this.zoomBy(Math.exp(-dy * (ctrlKey ? 0.01 : 0.0015)), x, y);
    else {
      this.#userCamera();
      this.camera.x += dx / this.camera.k;
      this.camera.y += dy / this.camera.k;
      this.#changed();
    }
  }

  /** A double-click at canvas point (x, y): on empty space, frame the graph. (Taps find double taps themselves.) */
  doubleClick({ x, y }) {
    if (this.hit(this.toWorld(x, y)) < 0) this.fit();
  }
}

/**
 * Whether a wheel event (deltas in px) looks like a trackpad's two-finger scroll rather than a mouse wheel's notch.
 * A sideways scroll is a trackpad's (or a tilt wheel's: panning suits both). Chrome and Safari give a mouse wheel's
 * legacy `wheelDeltaY` as multiples of 120, and a trackpad's as exactly -3 × deltaY; Firefox's mouse wheel scrolls
 * by lines. With nothing to tell by, it's a wheel (zoom, as before).
 */
export function looksLikeTrackpad(dx, dy, deltaMode, wheelDeltaY) {
  if (deltaMode !== 0) return false;
  if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) return true;
  if (wheelDeltaY) return Math.abs(wheelDeltaY + 3 * dy) < 1;
  return false;
}
