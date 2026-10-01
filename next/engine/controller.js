// GraphController: the engine without a screen. It holds the graph (a GraphModel and the working graph built from
// it), the view's settings and every bit of state that changes over time (positions, the camera, hover, fades,
// morphs, ghosts), and it orchestrates them: graph changes, layouts, physics, animation, interaction, events and
// snapshots. Each tick it advances time and builds the scene a renderer draws.
//
// It has no DOM. A GraphView (view.js) connects one to a canvas: it measures text, turns pointer and wheel events
// into the calls below, and runs the frame loop. Tests drive a controller directly: set a graph, press, drag,
// release, tick time forward, and look at the result.
//
// Input coordinates are CSS pixels relative to the canvas's top-left corner; times are milliseconds on one clock
// (the view's frame timestamps, or a test's own).

import { ANIMATION_OPTIONS, EASINGS, approach } from "./animation.js";
import { LINE, footprint, labelAngle, reach } from "./boxes.js";
import { departures, withGhosts } from "./ghosts.js";
import { REFERENCE_SCALE, withReferences } from "./references.js";
import { Graph } from "./graph.js";
import { GraphModel } from "./model.js";
import { applyState, snapshotModel, takeSnapshot } from "./snapshot.js";
import { LAYOUTS, constrainer } from "./layouts.js";
import { Simulation, physicsOptions } from "./physics.js";
import { lineage, looksOf } from "./render.js";
import { resolve } from "./schema.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "./style.js";

export const BACKGROUND = "#0e1016";
const MAX_THROW = 1800; // fastest throw or pan glide, in screen px/s
/** Node options that change how much room nodes take, so changing them lays the graph out again. */
const SIZE_KEYS = [
  "shape",
  "size",
  "sizeBy",
  "labels",
  "labelSize",
  "collisionRadius",
  "labelCollide",
];

/** Text width without a canvas: about right for a sans-serif face. Views measure for real. */
export const roughMeasure = (text, size) => text.length * size * 0.56;

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

/** The keys whose values differ, with their new values. */
function changes(before, after) {
  const out = {};
  for (const k of Object.keys(after))
    if (before[k] !== after[k]) out[k] = after[k];
  return out;
}

/**
 * @typedef {object} TickResult
 * @property {boolean} busy   something is still moving or fading: keep ticking
 * @property {number} gap     seconds since the last tick, unclamped (0 for the first after a rest)
 * @property {number} simMs   time spent moving nodes this tick
 * @property {number} energy  mean squared node speed
 * @property {string} state   "moving to layout", "dragging", "moving" or "at rest"
 */

export class GraphController {
  /**
   * @param {object} [options]
   * @param {(text: string, size: number) => number} [options.measureText] a label's width at a font size (world px)
   * @param {(type: string, detail?: object) => void} [options.onEvent] settings changes and interactions
   * @param {() => void} [options.onChange] something changed that needs a tick (a view wakes its frame loop)
   * @param {() => number} [options.clock] the time now, ms (for changes made between ticks)
   */
  constructor({
    measureText = roughMeasure,
    onEvent,
    onChange,
    clock = () => performance.now(),
  } = {}) {
    this.measureText = measureText;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this.clock = clock;
    this.graph = new Graph();
    this.sim = new Simulation(this.graph);
    this.layout = "tree";
    this.layoutOpts = resolve(LAYOUTS.tree.options);
    this.routing = { kind: "tree", direction: "TB" };
    this.mode = "static";
    this.modeOpts = physicsOptions("tree", "static");
    this.node = resolve(NODE_OPTIONS);
    this.edge = resolve(EDGE_OPTIONS);
    this.anim = resolve(ANIMATION_OPTIONS);
    this.looks = looksOf(this.graph, this.node, this.edge);
    this.camera = { x: 0, y: 0, k: 1 };
    this.glide = null; // the camera's coasting speed after a pan, world px/s
    // True while the camera shows a framing the controller chose (not one the user panned or zoomed to): a resize
    // then frames again, so a view sized late (a hidden tab, a panel opening) doesn't stay zoomed for the wrong size.
    this.framed = false;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.hover = -1;
    this.hoverReference = false;
    this.pointer = null;
    this.tween = null;
    this.cameraTween = null;
    this.last = 0;
    // Bumped whenever node positions, the graph or the styles change: a renderer can keep what it built for a
    // frame until it moves (panning and zooming redraw without rebuilding).
    this.version = 0;
    this.shadeVersion = 0; // bumped when only brightness changes (hover, fades): no geometry to rebuild
    this.focusCache = { key: -1, set: null };
    /** @type {import("./ghosts.js").Ghost[]} nodes that left the graph, folding away */
    this.ghosts = [];
    // Per node, 0–1: how lit it is by the hover (eased toward its target), and how far it has faded in.
    this.shade = new Float32Array(0);
    this.appear = new Float32Array(0);
    this.scene = null;
  }

  // ---- the graph -----------------------------------------------------------------------------------------------

  /**
   * Replace the graph: a GraphModel, prismatrix-graph JSON, or plain `{ nodes, edges }`. The first graph grows into
   * its layout; after that the change morphs: nodes that are still there glide from where they are to their new
   * place, new ones arrive as the animation's `enter` setting says, removed ones fold back into their family, and
   * the camera eases to the new framing (unless it was moved by hand). Problems in the input (a duplicate id, an
   * edge to a missing node) are left out and listed in `model.issues`.
   */
  setGraph(input) {
    const model = GraphModel.from(input);
    const previous = this.graph.nodes.length ? this.graph : null;
    const previousLooks = this.looks;
    this.graph = new Graph(model);
    // Nodes that left fold back into what's left of their family; ghosts still leaving from an earlier change
    // carry on (unless their node came back).
    const now = this.clock();
    this.ghosts = [
      ...this.ghosts.filter(
        (g) =>
          !this.graph.byId.has(g.id) && now - g.start < this.anim.transition,
      ),
      ...(previous && this.anim.transition > 0
        ? departures(previous, this.graph, previousLooks, now)
        : []),
    ];
    this.#fresh();
    this.#relayout({
      fit: !previous ? "instant" : this.framed ? "animate" : null,
      arrive: previous ?? false,
    });
    const change = previous ? model.diff(previous.model) : null;
    this.#emit("graph", {
      ...model.stats(),
      ...(change && {
        added: change.nodesAdded.length,
        removed: change.nodesRemoved.length,
        kept: change.nodesKept.length,
      }),
    });
    for (const issue of model.issues) this.#emit("graphIssue", issue);
  }

  /** The graph shown, as an immutable GraphModel. */
  get model() {
    return this.graph.model;
  }

  /** New per-node state for a new working graph. */
  #fresh() {
    this.sim = new Simulation(this.graph);
    this.hover = -1;
    this.hoverReference = false;
    this.pointer = null;
    this.shade = new Float32Array(this.graph.nodes.length).fill(1);
    this.appear = new Float32Array(this.graph.nodes.length).fill(1);
  }

  /**
   * Everything needed to show this view again exactly: the graph, settings, camera and every node's layout state
   * (see snapshot.js and next/MODEL.md). `extra` settings (a view's renderer, say) are recorded with the rest.
   */
  snapshot(note = "", extra = {}) {
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
          ...extra,
        },
        camera: this.camera,
      },
      note,
    );
  }

  /** Show a snapshot: its graph, settings, camera and node positions, as they were (no morph). */
  restore(snapshot) {
    const model = snapshotModel(snapshot);
    const { settings = {} } = snapshot;
    if (settings.animation) this.setAnimation(settings.animation);
    if (settings.node) this.setNodeStyle(settings.node);
    if (settings.edge) this.setEdgeStyle(settings.edge);
    if (settings.layout)
      this.setLayout(settings.layout, settings.layoutOptions);
    if (settings.physics)
      this.setPhysics(settings.physics, settings.physicsOptions);
    this.ghosts = [];
    this.graph = new Graph(model);
    this.#fresh();
    this.#relayout({ fit: null });
    applyState(this.graph, snapshot.state ?? {});
    this.tween = null;
    if (snapshot.camera) this.camera = { ...snapshot.camera };
    this.cameraTween = null;
    this.framed = false;
    this.sim.wake();
    this.version++;
    this.#changed();
    this.#emit("restore", { nodes: model.size, time: snapshot.time });
  }

  // ---- settings ------------------------------------------------------------------------------------------------

  /** How things move between states: see ANIMATION_OPTIONS. */
  setAnimation(opts) {
    this.anim = resolve(ANIMATION_OPTIONS, opts);
    this.#changed();
    this.#emit("animation", this.anim);
  }

  setLayout(name, opts = {}) {
    if (!LAYOUTS[name]) throw new Error(`Unknown layout "${name}"`);
    const changed = name !== this.layout;
    this.layout = name;
    this.layoutOpts = resolve(LAYOUTS[name].options, opts);
    if (!LAYOUTS[name].physics[this.mode]) this.mode = "static";
    this.modeOpts = physicsOptions(
      name,
      this.mode,
      changed ? {} : this.modeOpts,
    );
    this.#relayout({ fit: changed ? "animate" : null });
    this.#emit("layout", { layout: name, ...this.layoutOpts });
  }

  setPhysics(mode, opts = {}) {
    const previous = this.mode;
    this.mode = mode;
    this.modeOpts = physicsOptions(this.layout, mode, opts);
    this.#configureSim();
    // Coming into floating, the graph floats off from wherever it is; any other change settles it on its homes.
    if (mode !== previous && mode !== "floating") this.#startTween();
    this.#changed();
    this.#emit("physics", { mode, ...this.modeOpts });
  }

  setNodeStyle(opts) {
    this.version++;
    const before = this.node;
    this.node = resolve(NODE_OPTIONS, opts);
    if (SIZE_KEYS.some((k) => before[k] !== this.node[k]))
      this.#relayout({ fit: null });
    else this.looks = looksOf(this.graph, this.node, this.edge);
    this.#changed();
    this.#emit("nodeStyle", changes(before, this.node));
  }

  setEdgeStyle(opts) {
    this.version++;
    const before = this.edge;
    this.edge = resolve(EDGE_OPTIONS, opts);
    this.looks = looksOf(this.graph, this.node, this.edge);
    this.#changed();
    this.#emit("edgeStyle", changes(before, this.edge));
  }

  /** Send everything back to its home. */
  reset() {
    this.#startTween();
    this.#changed();
    this.#emit("reset");
  }

  /** The drawing area's size in CSS px, and device pixels per CSS px. Frames again if the camera hasn't been moved. */
  setViewport(width, height, dpr = 1) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.dpr = dpr;
    if (this.framed && !this.cameraTween)
      this.camera = this.#framing(!!this.tween);
    this.#changed();
  }

  /** Frame the graph where it is (or where it's heading, mid-transition). */
  fit(animate = true) {
    const target = this.#framing(!!this.tween);
    this.glide = null;
    this.framed = true;
    if (animate)
      this.cameraTween = {
        from: { ...this.camera },
        to: target,
        start: this.clock(),
      };
    else this.camera = target;
    this.#changed();
    this.#emit("fit", { k: target.k });
  }

  #emit(type, detail) {
    this.onEvent?.(type, detail);
  }

  #changed() {
    this.onChange?.();
  }

  #framing(homes) {
    // Frame footprints, not just centres, so labels at the edge stay on screen.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of this.graph.nodes) {
      const x = homes ? n.homeX : n.x;
      const y = homes ? n.homeY : n.y;
      minX = Math.min(minX, x + n.box.x0);
      minY = Math.min(minY, y + n.box.y0);
      maxX = Math.max(maxX, x + n.box.x1);
      maxY = Math.max(maxY, y + n.box.y1);
    }
    if (!this.graph.nodes.length) minX = minY = maxX = maxY = 0;
    const pad = 40;
    const k = Math.min(
      (this.width - pad * 2) / Math.max(maxX - minX, 1),
      (this.height - pad * 2) / Math.max(maxY - minY, 1),
      2.5,
    );
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      k: Math.max(k, 0.05),
    };
  }

  #relayout({ fit, arrive = undefined }) {
    this.version++;
    this.looks = looksOf(this.graph, this.node, this.edge);
    const sizing = this.#sizing();
    this.routing = LAYOUTS[this.layout].run(
      this.graph,
      this.layoutOpts,
      sizing,
    );
    this.#placeLabels(sizing);
    this.#configureSim();
    if (arrive !== undefined) this.#arrive(arrive || null);
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
    }
    this.#changed();
  }

  /** Label widths, and the footprint each node takes up for a given label direction. */
  #sizing() {
    const { node, graph, looks } = this;
    const labelled = node.labels !== "off";
    const height = node.labelSize * LINE;
    const widths = new Float64Array(graph.nodes.length);
    if (labelled)
      for (const n of graph.nodes)
        widths[n.index] = this.measureText(n.label, node.labelSize);
    const fixed = node.labels === "right" ? 0 : Math.PI / 2;
    return {
      widths,
      height,
      gap: node.collisionRadius,
      /** With label collision off, labels don't count: they may overlap. */
      box: (i, angle) =>
        footprint(
          looks.radius[i] * reach(looks.shape[i]),
          node.labels === "outward" ? angle : fixed,
          labelled && node.labelCollide ? widths[i] : 0,
          height,
        ),
    };
  }

  /** Fix each node's label direction from its home, and the footprint that goes with it. */
  #placeLabels(sizing) {
    const labelled = this.node.labels !== "off";
    for (const n of this.graph.nodes) {
      n.labelAngle = labelAngle(
        this.node.labels,
        this.routing,
        n.homeX,
        n.homeY,
      );
      n.radius = this.looks.radius[n.index] * reach(this.looks.shape[n.index]);
      n.box = footprint(
        n.radius,
        n.labelAngle,
        labelled ? sizing.widths[n.index] : 0,
        sizing.height,
      );
    }
  }

  /**
   * Where a new graph's nodes start. Nodes the previous graph had start where they were. New ones, by the `enter`
   * setting: grow out of their nearest ancestor that was already there (or their root's new place), fade in where
   * they land, or just appear there.
   */
  #arrive(previous) {
    const { nodes } = this.graph;
    const root = new Int32Array(nodes.length);
    for (const i of this.graph.order)
      root[i] = nodes[i].parent < 0 ? i : root[nodes[i].parent];
    const enter = this.anim.enter;
    for (const n of nodes) {
      const old = previous?.byId.get(n.id);
      if (old) {
        n.x = old.x;
        n.y = old.y;
        continue;
      }
      this.appear[n.index] = enter === "none" ? 1 : 0;
      if (enter !== "grow") {
        n.x = n.homeX;
        n.y = n.homeY;
        continue;
      }
      let from = null;
      for (let p = n.parent; p >= 0 && !from; p = nodes[p].parent)
        from = previous?.byId.get(nodes[p].id) ?? null;
      const r = nodes[root[n.index]];
      n.x = from ? from.x : r.homeX;
      n.y = from ? from.y : r.homeY;
    }
  }

  /** Progress 0–1 of an animation that started at `start` and lasts `ms`, eased. */
  #progress(now, start, ms) {
    const t = ms > 0 ? Math.min((now - start) / ms, 1) : 1;
    return { t, f: (EASINGS[this.anim.easing] ?? EASINGS.smooth)(t) };
  }

  /** Ease hover emphasis and fade-ins toward their targets. Returns true while anything is still changing. */
  #fade(dt, focus) {
    let changing = false;
    const { shade, appear } = this;
    for (let i = 0; i < shade.length; i++) {
      const target = !focus || focus.has(i) ? 1 : 0;
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
      }
    }
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

  #startTween() {
    const from = this.graph.nodes.map((n) => [n.x, n.y]);
    for (const n of this.graph.nodes) n.vx = n.vy = 0;
    this.tween = { from, start: this.clock() };
  }

  // ---- time ----------------------------------------------------------------------------------------------------

  /**
   * Advance everything to `now` (ms): layout morphs, physics, the camera, hover and fades, ghosts. Then `scene` holds
   * what to draw. Returns whether anything is still moving.
   * @returns {TickResult}
   */
  tick(now) {
    const gap = this.last ? (now - this.last) / 1000 : 0;
    const dt = gap ? Math.min(gap, 0.1) : 1 / 60;
    this.last = now;

    let busy;
    if (this.tween) {
      const { t, f } = this.#progress(
        now,
        this.tween.start,
        this.anim.transition,
      );
      const polar = this.routing.kind === "radial";
      for (const n of this.graph.nodes) {
        if (this.sim.held.has(n.index)) continue;
        const [x0, y0] = this.tween.from[n.index];
        if (polar)
          [n.x, n.y] = alongRings(this.routing, x0, y0, n.homeX, n.homeY, f);
        else {
          n.x = x0 + (n.homeX - x0) * f;
          n.y = y0 + (n.homeY - y0) * f;
        }
      }
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
    const simMs = performance.now() - now;
    if (this.cameraTween) {
      const { t, f } = this.#progress(
        now,
        this.cameraTween.start,
        this.anim.camera,
      );
      const { from, to } = this.cameraTween;
      // Zoom moves in log space so it feels even.
      this.camera = {
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        k: from.k * (to.k / from.k) ** f,
      };
      if (t >= 1) this.cameraTween = null;
      busy = true;
    }
    if (this.glide) busy = this.#coast(dt) || busy;

    const focusOn = this.pointer?.node ?? this.hover;
    if (this.focusCache.key !== focusOn || this.focusCache.graph !== this.graph)
      this.focusCache = {
        key: focusOn,
        graph: this.graph,
        set: focusOn >= 0 ? lineage(this.graph, focusOn) : null,
      };
    if (this.#fade(dt, this.focusCache.set)) {
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
      version: this.version,
      shadeVersion: this.shadeVersion,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      background: BACKGROUND,
    };
    return {
      busy: busy || !!this.pointer,
      gap,
      simMs,
      energy: this.sim.energy,
      state: this.tween
        ? "moving to layout"
        : this.pointer?.node >= 0
          ? "dragging"
          : busy
            ? "moving"
            : "at rest",
    };
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
    const slack = 4 / this.camera.k;
    for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
      const n = this.graph.nodes[i];
      if (Math.hypot(n.x - p.x, n.y - p.y) <= n.radius * 1.15 + slack) return i;
    }
    if (references)
      for (const ref of this.routing.references ?? []) {
        const s = this.graph.nodes[ref.source];
        const x = ref.x + s.x - s.homeX,
          y = ref.y + s.y - s.homeY;
        const r = this.graph.nodes[ref.target].radius * REFERENCE_SCALE;
        if (Math.hypot(x - p.x, y - p.y) <= r * 1.15 + slack) return ref.target;
      }
    return -1;
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

  /** The node and, when static drags carry subtrees, everything below it. */
  #carried(index) {
    if (this.mode !== "static" || !this.modeOpts.dragSubtree) return [index];
    const out = [index];
    for (let k = 0; k < out.length; k++)
      out.push(...this.graph.nodes[out[k]].children);
    return out;
  }

  /** A press at canvas point (x, y): grabs the node there, or starts a pan. */
  pointerDown({ id = 1, x, y, time = this.clock() }) {
    const p = this.toWorld(x, y);
    const node = this.hit(p);
    this.cameraTween = null;
    this.glide = null;
    this.pointer = { id, node, screen: { x, y }, vx: 0, vy: 0, t: time };
    if (node >= 0) {
      const n = this.graph.nodes[node];
      this.pointer.offset = { x: n.x - p.x, y: n.y - p.y };
      this.pointer.carried = this.#carried(node);
      for (const i of this.pointer.carried) {
        this.sim.held.add(i);
        this.graph.nodes[i].vx = this.graph.nodes[i].vy = 0;
      }
    }
    this.#emit(node >= 0 ? "dragStart" : "panStart", {
      node: node >= 0 ? this.graph.nodes[node].id : undefined,
      carried: this.pointer.carried?.length,
    });
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

  /** The pointer moved to canvas point (x, y): drags, pans, or (with nothing pressed) hovers. */
  pointerMove({ id = 1, x, y, time = this.clock() }) {
    const ptr = this.pointer;
    if (!ptr || ptr.id !== id) {
      const p = this.toWorld(x, y);
      const direct = this.hit(p);
      const h = direct >= 0 ? direct : this.hit(p, { references: true });
      this.hoverReference = direct < 0 && h >= 0;
      if (h !== this.hover) {
        this.hover = h;
        this.#changed();
      }
      return;
    }
    if (ptr.node < 0) {
      const dx = -(x - ptr.screen.x) / this.camera.k;
      const dy = -(y - ptr.screen.y) / this.camera.k;
      this.camera.x += dx;
      this.camera.y += dy;
      this.framed = false;
      this.#track(ptr, dx, dy, time);
      ptr.screen = { x, y };
      this.#changed();
      return;
    }
    const p = this.toWorld(x, y);
    const n = this.graph.nodes[ptr.node];
    const dx = p.x + ptr.offset.x - n.x,
      dy = p.y + ptr.offset.y - n.y;
    this.#track(ptr, dx, dy, time);
    this.version++;
    for (const i of ptr.carried) {
      this.graph.nodes[i].x += dx;
      this.graph.nodes[i].y += dy;
    }
    this.#changed();
  }

  /** The press ended: a node is let go (thrown, if it was moving), or a pan glides on. */
  pointerUp({ id = 1, time = this.clock() } = {}) {
    const ptr = this.pointer;
    if (!ptr || ptr.id !== id) return;
    // A pointer that stopped before letting go throws nothing.
    const thrown = time - ptr.t < 80;
    if (ptr.node >= 0) {
      this.sim.wake();
      for (const i of ptr.carried) {
        this.sim.held.delete(i);
        if (this.modeOpts.fling && thrown) {
          this.graph.nodes[i].vx = ptr.vx;
          this.graph.nodes[i].vy = ptr.vy;
        }
      }
    } else if (thrown) {
      this.glide = { x: ptr.vx, y: ptr.vy };
    }
    const speed = Math.round(Math.hypot(ptr.vx, ptr.vy) * this.camera.k);
    this.#emit(ptr.node >= 0 ? "dragEnd" : "panEnd", {
      node: ptr.node >= 0 ? this.graph.nodes[ptr.node].id : undefined,
      thrown: thrown && (ptr.node < 0 || this.modeOpts.fling),
      screenSpeed: thrown ? speed : 0,
    });
    this.pointer = null;
    this.#changed();
  }

  /** The pointer left the canvas: no more hover (a press in progress carries on). */
  pointerLeave() {
    if (this.pointer || this.hover < 0) return;
    this.hover = -1;
    this.hoverReference = false;
    this.#changed();
  }

  /** Zoom by a wheel step at canvas point (x, y), keeping the world point under it in place. */
  wheel({ x, y, deltaY }) {
    const before = this.toWorld(x, y);
    this.cameraTween = null;
    this.framed = false;
    this.camera.k = Math.min(
      Math.max(this.camera.k * Math.exp(-deltaY * 0.0015), 0.05),
      8,
    );
    const after = this.toWorld(x, y);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.#changed();
  }

  /** A double-click at canvas point (x, y): on empty space, frame the graph. */
  doubleClick({ x, y }) {
    if (this.hit(this.toWorld(x, y)) < 0) this.fit();
  }
}
