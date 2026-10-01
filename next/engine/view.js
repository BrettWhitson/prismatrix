// GraphView: one canvas, one graph. Owns the camera, the pointer, the animation loop, and hands positions between
// layout, physics and the renderer.

import { ANIMATION_OPTIONS, EASINGS, approach } from "./animation.js";
import { LINE, footprint, labelAngle, reach } from "./boxes.js";
import { departures, withGhosts } from "./ghosts.js";
import { Graph } from "./graph.js";
import { LAYOUTS, constrainer } from "./layouts.js";
import { Simulation, physicsOptions } from "./physics.js";
import { CanvasRenderer, lineage, nodeLooks } from "./render.js";
import { WebGLRenderer, webglAvailable } from "./webgl.js";
import { resolve } from "./schema.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "./style.js";

const BACKGROUND = "#0e1016";
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

export class GraphView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [hooks]
   * @param {(stats: FrameStats) => void} [hooks.onFrame] after every drawn frame
   * @param {(type: string, detail?: object) => void} [hooks.onEvent] settings changes and interactions
   * @param {object} [options]
   * @param {"webgl" | "canvas"} [options.renderer] "webgl" (the default) falls back to "canvas" without WebGL2
   * @param {"display" | "uncapped"} [options.frameRate] "display" (the default) draws once per screen refresh
   *
   * @typedef {object} FrameStats
   * @property {number} fps        smoothed
   * @property {number} dt         seconds since the previous frame, unclamped (0 for the first after a rest)
   * @property {number} simMs      time spent moving nodes this frame
   * @property {number} drawMs     time spent drawing this frame
   * @property {number} energy     mean squared node speed
   * @property {string} state      "moving to layout", "dragging", "moving" or "at rest"
   */
  constructor(
    canvas,
    hooks = {},
    { renderer = "webgl", frameRate = "display" } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d"); // also measures label text
    this.hooks = hooks;
    this.graph = new Graph();
    this.sim = new Simulation(this.graph);
    this.layout = "tree";
    this.layoutOpts = resolve(LAYOUTS.tree.options);
    this.routing = { kind: "tree", direction: "TB" };
    this.mode = "static";
    this.modeOpts = physicsOptions("tree", "static");
    this.node = resolve(NODE_OPTIONS);
    this.edge = resolve(EDGE_OPTIONS);
    this.camera = { x: 0, y: 0, k: 1 };
    this.glide = null; // the camera's coasting speed after a pan, world px/s
    // True while the camera shows a framing the view chose (not one the user panned or zoomed to): a resize then
    // frames again, so a view sized late (a hidden tab, a panel opening) doesn't stay zoomed for the wrong size.
    this.framed = false;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.hover = -1;
    this.pointer = null;
    this.tween = null;
    this.cameraTween = null;
    this.frame = 0;
    this.last = 0;
    // Bumped whenever node positions, the graph or the styles change: a renderer can keep what it built for a
    // frame until it moves (panning and zooming redraw without rebuilding).
    this.version = 0;
    this.shadeVersion = 0; // bumped when only brightness changes (hover, fades): no geometry to rebuild
    this.focusCache = { key: -1, set: null };
    /** @type {import("./ghosts.js").Ghost[]} nodes that left the graph, folding away */
    this.ghosts = [];
    this.anim = resolve(ANIMATION_OPTIONS);
    // Per node, 0–1: how lit it is by the hover (eased toward its target), and how far it has faded in.
    this.shade = new Float32Array(0);
    this.appear = new Float32Array(0);
    this.fps = 60;

    this.renderer = null;
    this.frameRate = "display";
    this.setRenderer(renderer);
    if (frameRate === "uncapped") this.setFrameRate(frameRate);
    this.resizer = new ResizeObserver(() => this.#resize());
    this.resizer.observe(canvas);
    this.#resize();
    this.#bindPointer();
  }

  /**
   * Replace the graph. The first graph grows into its layout; after that the change morphs: nodes that are still
   * there glide from where they are to their new place, new ones arrive as the animation's `enter` setting says,
   * and the camera eases to the new framing (unless it was moved by hand).
   */
  setGraph({ nodes, edges }) {
    const previous = this.graph.nodes.length ? this.graph : null;
    const previousLooks = this.looks;
    this.graph = new Graph(nodes, edges);
    // Nodes that left fold back into what's left of their family; ghosts still leaving from an earlier change
    // carry on (unless their node came back).
    const now = performance.now();
    this.ghosts = [
      ...this.ghosts.filter(
        (g) =>
          !this.graph.byId.has(g.id) && now - g.start < this.anim.transition,
      ),
      ...(previous && this.anim.transition > 0
        ? departures(previous, this.graph, previousLooks, now)
        : []),
    ];
    this.sim = new Simulation(this.graph);
    this.hover = -1;
    this.shade = new Float32Array(this.graph.nodes.length).fill(1);
    this.appear = new Float32Array(this.graph.nodes.length).fill(1);
    this.#relayout({
      fit: !previous ? "instant" : this.framed ? "animate" : null,
      arrive: previous ?? false,
    });
    this.#emit("graph", {
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      roots: this.graph.roots.length,
      depth: this.graph.maxDepth,
      kept: previous
        ? this.graph.nodes.filter((n) => previous.byId.has(n.id)).length
        : 0,
    });
  }

  /** How things move between states: see ANIMATION_OPTIONS. */
  setAnimation(opts) {
    this.anim = resolve(ANIMATION_OPTIONS, opts);
    this.#wake();
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
    this.#wake();
    this.#emit("physics", { mode, ...this.modeOpts });
  }

  setNodeStyle(opts) {
    this.version++;
    const before = this.node;
    this.node = resolve(NODE_OPTIONS, opts);
    if (SIZE_KEYS.some((k) => before[k] !== this.node[k]))
      this.#relayout({ fit: null });
    else this.looks = nodeLooks(this.graph, this.node);
    this.#wake();
    this.#emit("nodeStyle", changes(before, this.node));
  }

  setEdgeStyle(opts) {
    this.version++;
    const before = this.edge;
    this.edge = resolve(EDGE_OPTIONS, opts);
    this.#wake();
    this.#emit("edgeStyle", changes(before, this.edge));
  }

  /** Send everything back to its home. */
  reset() {
    this.#startTween();
    this.#wake();
    this.#emit("reset");
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
        start: performance.now(),
      };
    else this.camera = target;
    this.#wake();
    this.#emit("fit", { k: target.k });
  }

  #emit(type, detail) {
    this.hooks.onEvent?.(type, detail);
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

  /**
   * Switch how frames are drawn. Asking for "webgl" where WebGL2 isn't available (or fails to start) gives "canvas".
   * @returns {"webgl" | "canvas"} the renderer now in use
   */
  setRenderer(name) {
    if (this.renderer?.name === name) return name;
    this.renderer?.dispose();
    this.renderer = null;
    if (name === "webgl" && webglAvailable()) {
      try {
        this.renderer = new WebGLRenderer(this.canvas);
      } catch (error) {
        console.warn(
          `Prismatrix: WebGL renderer failed (${error.message}); using Canvas 2D`,
        );
      }
    }
    this.renderer ??= new CanvasRenderer(this.canvas);
    this.renderer.resize(this.width, this.height, this.dpr);
    this.#wake();
    this.#emit("renderer", { renderer: this.renderer.name });
    return this.renderer.name;
  }

  destroy() {
    this.renderer?.dispose();
    if (this.frame > 0) cancelAnimationFrame(this.frame);
    this.channel?.port1.close();
    this.resizer.disconnect();
    this.unbind?.();
  }

  #relayout({ fit, arrive = undefined }) {
    this.version++;
    this.looks = nodeLooks(this.graph, this.node);
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
        start: performance.now(),
      };
    }
    this.#wake();
  }

  /** Label widths, and the footprint each node takes up for a given label direction. */
  #sizing() {
    const { node, graph, looks } = this;
    const labelled = node.labels !== "off";
    const height = node.labelSize * LINE;
    const widths = new Float64Array(graph.nodes.length);
    if (labelled) {
      this.ctx.font = `${node.labelSize}px system-ui, sans-serif`;
      for (const n of graph.nodes)
        widths[n.index] = this.ctx.measureText(n.label).width;
    }
    const fixed = node.labels === "right" ? 0 : Math.PI / 2;
    const shapeReach = reach(node.shape);
    return {
      widths,
      height,
      gap: node.collisionRadius,
      /** With label collision off, labels don't count: they may overlap. */
      box: (i, angle) =>
        footprint(
          looks.radius[i] * shapeReach,
          node.labels === "outward" ? angle : fixed,
          labelled && node.labelCollide ? widths[i] : 0,
          height,
        ),
    };
  }

  /** Fix each node's label direction from its home, and the footprint that goes with it. */
  #placeLabels(sizing) {
    const shapeReach = reach(this.node.shape);
    const labelled = this.node.labels !== "off";
    for (const n of this.graph.nodes) {
      n.labelAngle = labelAngle(
        this.node.labels,
        this.routing,
        n.homeX,
        n.homeY,
      );
      n.radius = this.looks.radius[n.index] * shapeReach;
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
    this.tween = { from, start: performance.now() };
  }

  /**
   * "display" draws once per screen refresh (requestAnimationFrame). "uncapped" draws again as soon as a frame is
   * done, for benchmarking: the screen still only shows one frame per refresh, so the extra frames cost power and
   * show nothing, but the frame rate shows how much headroom the engine has. A hidden page always waits for the
   * display.
   */
  setFrameRate(mode) {
    this.frameRate = mode === "uncapped" ? "uncapped" : "display";
    if (this.frameRate === "uncapped" && !this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.#tick(performance.now());
    }
    this.#emit("frameRate", { frameRate: this.frameRate });
    this.#wake();
    return this.frameRate;
  }

  #wake() {
    if (this.frame) return;
    if (this.frameRate === "uncapped" && !document.hidden) {
      this.frame = -1;
      this.channel.port2.postMessage(0);
    } else this.frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(now) {
    this.frame = 0;
    const gap = this.last ? (now - this.last) / 1000 : 0;
    const dt = gap ? Math.min(gap, 0.1) : 1 / 60;
    this.last = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.1;

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
    const drawStart = performance.now();
    // Ghosts are drawn from a display graph; everything else (physics, hover, hit-testing) uses the real one.
    let shown = {
      graph: this.graph,
      looks: this.looks,
      shade: this.shade,
      appear: this.appear,
    };
    if (this.ghosts.length) {
      shown = withGhosts(
        this.graph,
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
    this.renderer.draw({
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
    });
    this.hooks.onFrame?.({
      fps: this.fps,
      dt: gap,
      simMs,
      drawMs: performance.now() - drawStart,
      energy: this.sim.energy,
      state: this.tween
        ? "moving to layout"
        : this.pointer?.node >= 0
          ? "dragging"
          : busy
            ? "moving"
            : "at rest",
    });
    // Labels still being drawn into the atlas keep the frames coming until they're all in.
    if (this.renderer.pending) busy = true;
    if (busy || this.pointer) this.#wake();
    else this.last = 0;
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

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(rect.width, 1);
    this.height = Math.max(rect.height, 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.renderer?.resize(this.width, this.height, this.dpr);
    if (this.framed && !this.cameraTween)
      this.camera = this.#framing(!!this.tween);
    this.#wake();
  }

  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.width / 2) / this.camera.k + this.camera.x,
      y: (clientY - rect.top - this.height / 2) / this.camera.k + this.camera.y,
    };
  }

  /** The topmost node under a world point, or -1. */
  hit(p) {
    const slack = 4 / this.camera.k;
    for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
      const n = this.graph.nodes[i];
      if (Math.hypot(n.x - p.x, n.y - p.y) <= n.radius * 1.15 + slack) return i;
    }
    return -1;
  }

  /** The node and, when static drags carry subtrees, everything below it. */
  #carried(index) {
    if (this.mode !== "static" || !this.modeOpts.dragSubtree) return [index];
    const out = [index];
    for (let k = 0; k < out.length; k++)
      out.push(...this.graph.nodes[out[k]].children);
    return out;
  }

  #bindPointer() {
    const c = this.canvas;
    const down = (e) => {
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the browser no longer tracks (or a synthetic one) can't be captured; the drag still works.
      }
      const p = this.toWorld(e.clientX, e.clientY);
      const node = this.hit(p);
      this.cameraTween = null;
      this.glide = null;
      this.pointer = {
        id: e.pointerId,
        node,
        screen: { x: e.clientX, y: e.clientY },
        vx: 0,
        vy: 0,
        t: e.timeStamp,
      };
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
      this.#wake();
    };
    /** Smoothed pointer speed in world px/s, capped so a hard flick can't send anything off into the distance. */
    const track = (ptr, dx, dy, e) => {
      const dt = Math.max((e.timeStamp - ptr.t) / 1000, 1 / 240);
      ptr.vx += (dx / dt - ptr.vx) * 0.4;
      ptr.vy += (dy / dt - ptr.vy) * 0.4;
      const cap = MAX_THROW / this.camera.k;
      const speed = Math.hypot(ptr.vx, ptr.vy);
      if (speed > cap) {
        ptr.vx *= cap / speed;
        ptr.vy *= cap / speed;
      }
      ptr.t = e.timeStamp;
    };
    const move = (e) => {
      const p = this.toWorld(e.clientX, e.clientY);
      const ptr = this.pointer;
      if (!ptr || ptr.id !== e.pointerId) {
        const h = this.hit(p);
        if (h !== this.hover) {
          this.hover = h;
          c.style.cursor = h >= 0 ? "grab" : "";
          this.#wake();
        }
        return;
      }
      if (ptr.node < 0) {
        const dx = -(e.clientX - ptr.screen.x) / this.camera.k;
        const dy = -(e.clientY - ptr.screen.y) / this.camera.k;
        this.camera.x += dx;
        this.camera.y += dy;
        this.framed = false;
        track(ptr, dx, dy, e);
        ptr.screen = { x: e.clientX, y: e.clientY };
        this.#wake();
        return;
      }
      const n = this.graph.nodes[ptr.node];
      const dx = p.x + ptr.offset.x - n.x,
        dy = p.y + ptr.offset.y - n.y;
      track(ptr, dx, dy, e);
      this.version++;
      for (const i of ptr.carried) {
        this.graph.nodes[i].x += dx;
        this.graph.nodes[i].y += dy;
      }
      c.style.cursor = "grabbing";
      this.#wake();
    };
    const up = (e) => {
      const ptr = this.pointer;
      if (!ptr || ptr.id !== e.pointerId) return;
      // A pointer that stopped before letting go throws nothing.
      const thrown = e.timeStamp - ptr.t < 80;
      if (ptr.node >= 0) {
        this.sim.wake();
        for (const i of ptr.carried) {
          this.sim.held.delete(i);
          if (this.modeOpts.fling && thrown) {
            this.graph.nodes[i].vx = ptr.vx;
            this.graph.nodes[i].vy = ptr.vy;
          }
        }
        c.style.cursor = "grab";
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
      this.#wake();
    };
    const leave = () => {
      if (this.pointer || this.hover < 0) return;
      this.hover = -1;
      this.#wake();
    };
    const wheel = (e) => {
      e.preventDefault();
      const before = this.toWorld(e.clientX, e.clientY);
      this.cameraTween = null;
      this.framed = false;
      this.camera.k = Math.min(
        Math.max(this.camera.k * Math.exp(-e.deltaY * 0.0015), 0.05),
        8,
      );
      const after = this.toWorld(e.clientX, e.clientY);
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
      this.#wake();
    };
    const dbl = (e) => {
      if (this.hit(this.toWorld(e.clientX, e.clientY)) < 0) this.fit();
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    this.unbind = () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
    };
  }
}
