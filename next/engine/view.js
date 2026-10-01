// GraphView: one canvas, one graph. Owns the camera, the pointer, the animation loop, and hands positions between
// layout, physics and the renderer.

import { LINE, footprint, labelAngle, reach } from "./boxes.js";
import { Graph } from "./graph.js";
import { LAYOUTS, constrainer } from "./layouts.js";
import { Simulation, physicsOptions } from "./physics.js";
import { CanvasRenderer, lineage, nodeLooks } from "./render.js";
import { WebGLRenderer, webglAvailable } from "./webgl.js";
import { resolve } from "./schema.js";
import { EDGE_OPTIONS, NODE_OPTIONS } from "./style.js";

const TRANSITION_MS = 650;
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

/** The keys whose values differ, with their new values. */
function changes(before, after) {
  const out = {};
  for (const k of Object.keys(after))
    if (before[k] !== after[k]) out[k] = after[k];
  return out;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class GraphView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [hooks]
   * @param {(stats: FrameStats) => void} [hooks.onFrame] after every drawn frame
   * @param {(type: string, detail?: object) => void} [hooks.onEvent] settings changes and interactions
   * @param {object} [options]
   * @param {"webgl" | "canvas"} [options.renderer] "webgl" (the default) falls back to "canvas" without WebGL2
   *
   * @typedef {object} FrameStats
   * @property {number} fps        smoothed
   * @property {number} dt         seconds since the previous frame, unclamped (0 for the first after a rest)
   * @property {number} simMs      time spent moving nodes this frame
   * @property {number} drawMs     time spent drawing this frame
   * @property {number} energy     mean squared node speed
   * @property {string} state      "moving to layout", "dragging", "moving" or "at rest"
   */
  constructor(canvas, hooks = {}, { renderer = "webgl" } = {}) {
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
    this.focusCache = { key: -1, set: null };
    this.fps = 60;

    this.renderer = null;
    this.setRenderer(renderer);
    this.resizer = new ResizeObserver(() => this.#resize());
    this.resizer.observe(canvas);
    this.#resize();
    this.#bindPointer();
  }

  /** Replace the graph. Nodes start at the centre and grow into the layout. */
  setGraph({ nodes, edges }) {
    this.graph = new Graph(nodes, edges);
    this.sim = new Simulation(this.graph);
    this.hover = -1;
    this.#relayout({ fit: "instant" });
    this.#emit("graph", {
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      roots: this.graph.roots.length,
      depth: this.graph.maxDepth,
    });
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
    cancelAnimationFrame(this.frame);
    this.resizer.disconnect();
    this.unbind?.();
  }

  #relayout({ fit }) {
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
    if (fit === "instant") {
      // Everything grows out of the centre into a camera already framing the result.
      for (const n of this.graph.nodes) n.x = n.y = 0;
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

  #wake() {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(now) {
    this.frame = 0;
    const gap = this.last ? (now - this.last) / 1000 : 0;
    const dt = gap ? Math.min(gap, 0.1) : 1 / 60;
    this.last = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.1;

    let busy;
    if (this.tween) {
      const t = Math.min((now - this.tween.start) / TRANSITION_MS, 1);
      const f = ease(t);
      for (const n of this.graph.nodes) {
        if (this.sim.held.has(n.index)) continue;
        const [x0, y0] = this.tween.from[n.index];
        n.x = x0 + (n.homeX - x0) * f;
        n.y = y0 + (n.homeY - y0) * f;
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
      const t = Math.min((now - this.cameraTween.start) / TRANSITION_MS, 1);
      const f = ease(t);
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
    const drawStart = performance.now();
    this.renderer.draw({
      graph: this.graph,
      routing: this.routing,
      camera: this.camera,
      node: this.node,
      edge: this.edge,
      looks: this.looks,
      focus: this.focusCache.set,
      focusKey: focusOn,
      version: this.version,
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
