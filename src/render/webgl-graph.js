import { Camera } from "./camera.js";
import { SpatialGrid } from "./spatial-grid.js";
import { AtlasPacker } from "./atlas-packer.js";
import {
  arrowTemplate,
  pointAlong,
  pointsBounds,
  polylineLength,
} from "./edge-geometry.js";
import { Spring, springFor } from "./spring.js";
import { parseColor, parseColorAlpha } from "./color.js";
import {
  LABEL_PAD_X,
  LABEL_PAD_Y,
  labelBitmapScale,
  labelBox,
  labelFont,
  layoutLabel,
} from "./labels.js";
import {
  ARROW_FLOATS,
  EDGE_FLOATS,
  InstanceData,
  NODE_FLOATS,
} from "./instance-data.js";
import {
  ARROW_FRAGMENT,
  ARROW_VERTEX,
  EDGE_FRAGMENT,
  EDGE_VERTEX,
  NODE_VERTEX,
  nodeFragmentSource,
} from "./shaders.js";
import { CARD_TAG_ROOM, drawCardText } from "./card-text.js";
import {
  customShapeGlsl,
  disableShape,
  glslShapeNames,
  pluginVersion,
} from "./plugins.js";

/**
 * Prismatrix's renderer. This is its engine: WebGL2 draws every node, edge and arrowhead in a handful of instanced calls, a
 * 2D canvas on top draws the labels, and springs move everything (nodes, fades, glows, the camera), so any change can
 * interrupt any other and motion stays continuous. Layout is the caller's: nodes arrive with positions.
 *
 *   const graph = new WebGLGraph(container, { onNodeTap, onNodeHover, onNodeDrag… });
 *   graph.setGraph({ nodes, edges, routing: "taxi", flowAxis: "x" }, { animate: true, spawnFrom });
 *   graph.fitView({ animate: true });
 *
 * Node: { id, x, y, width, height, style } and Edge: { id, source, target, style }, styles from ../style.js.
 * Interaction state (hover, selection, emphasis, dimming, lineage) is set with the methods below and animated here.
 */

const ICON_SIZE = 64; // atlas cell, pixels
const ATLAS_SIZE = 2048; // 961 icons (31 × 31: 64 px cells, 2 px apart)
const ICON_RETRY_MS = 10000; // an icon that failed to load is tried again when next asked for, after this long
const LABEL_RENDER_SCALE = 2; // label bitmaps are drawn at 2× and scaled down
/** How far a press must move before it's a drag: fingers wobble more than mice, and a tap must stay a tap. */
const FLICK_WINDOW_MS = 90; // pan moves this recent set the glide's speed
/** Input timings and distances; setOptions({ input }) changes any of them. */
export const DEFAULT_INPUT = {
  smoothZoom: true,
  zoomSpeed: 1,
  draggable: true,
  doubleTapMs: 300,
  longPressMs: 550,
  /** How far a pointer moves before a press becomes a drag, per pointer type (CSS px). */
  dragThreshold: { mouse: 4, pen: 6, touch: 10 },
  /** Time constant of the camera's glide after a flick (seconds); 0: no glide. */
  panInertia: 0.28,
  /** px/s; slower than this, letting go of a pan just stops. */
  flickMinSpeed: 120,
};
const MAX_EXPORT_PIXELS = 16_777_216; // exported images stay within what browsers allow a canvas (4096²)
const MIN_NODE_SIZE = 1; // world units, for nodes whose size isn't a usable number
/** Interaction and label colours; override any of them with the constructor's `colors` option. */
export const DEFAULT_COLORS = {
  selected: "#f0c46a",
  hover: "#cfd8ea",
  labelText: "#e3e6ec",
  edgeLabelText: "#8a93a6",
  labelBackdrop: "rgba(11, 14, 20, 0.8)",
  edgeLabelBackdrop: "rgba(13, 16, 23, 0.9)",
  /** Card nodes: the title and the value, the subtitle, the inside of the port dots. */
  cardText: "#e3e6ec",
  cardMuted: "#8a93a6",
  portFill: "#0d1017",
};

/** Card text bitmaps kept at once, in pixels (about 4 bytes each), least recently used dropped first. */
const CARD_CACHE_PIXELS = 24_000_000;
export { parseColor };
export { wrapLabel } from "./labels.js";

export class WebGLGraph {
  camera = new Camera();
  /** Timings of the last frame, for profiling. */
  stats = {
    drawMs: 0,
    uploadMs: 0,
    partialUpload: false,
    /** Frames drawn so far (the engine only draws when something changes). */
    frames: 0,
    labels: 0,
    visibleNodes: 0,
    animating: 0,
  };

  /** Live nodes, in draw order, and the ones leaving (fading into their destination). */
  #nodes = [];
  #ghosts = [];
  #byId = new Map();
  #edges = [];
  #edgeById = new Map();
  #layout = {
    routing: "straight",
    flowAxis: "y",
    cornerRadius: 10,
    curvature: 1,
    portDirection: { x: 0, y: 0 },
  };
  #labels = {
    position: "right",
    backdrop: true,
    fadeZoom: 0.35,
    maxWidth: 120,
    overflow: "wrap",
    /** Card nodes: below this zoom only their titles are drawn (below fadeZoom, no text at all). */
    cardDetailZoom: 0.55,
  };
  #motion = { enabled: true, params: springFor(450), durationMs: 450 };
  #input = {
    ...DEFAULT_INPUT,
    dragThreshold: { ...DEFAULT_INPUT.dragThreshold },
  };
  /** @type {WebGLVertexArrayObject} */ nodeVao;
  /** @type {WebGLBuffer} */ nodeBuffer;
  /** @type {WebGLVertexArrayObject} */ topNodeVao;
  /** @type {WebGLBuffer} */ topNodeBuffer;
  /** The plugin registry version the node shader and arrow meshes were built for. */
  #builtPlugins = -1;
  #dimAlpha = 0.18;
  #flowSpeed = 1;

  #instances = new InstanceData();
  #touched = new Set(); // records changed since the last upload (see #syncGeometry)
  #bufferCapacity = new Map(); // GL buffer → floats allocated on the GPU

  #grid = new SpatialGrid(200);
  #gridDirty = true;
  #geometryDirty = true;
  #selected = null;
  #hovered = null;
  #dragged = null;
  #dimmed = null;
  #emphasis = new Map(); // node id → colour
  #labelFocus = new Set();
  #edgeEmphasis = new Map(); // edge id → { color, flow, boost }
  #moving = new Set(); // node / edge records with springs in motion
  #tickers = new Set();
  /** The pointer gesture under way: { kind: "pan" | "node" | "drag" | "pinch" | "done", … }, or null. */
  #gesture = null;
  #longPress = 0;
  #destroyed = false;
  #contextLost = false;
  /** Matches the current device pixel ratio; changes when the page moves to a screen with another (or zooms). */
  #pixelRatioQuery = null;

  #frame = 0;
  #lastFrameTime = 0;
  #startTime = performance.now();
  #zoomTarget = null;
  #cameraSprings = null;
  #glide = null;

  #iconSlots = new Map(); // url → { u0, v0, u1, v1, uv } | { loading } | { failedAt, spot }
  #iconPacker = new AtlasPacker(ATLAS_SIZE, 2);
  #atlasDirty = false;
  #iconRefresh = 0;
  #badgeUrl = null;
  #colors = DEFAULT_COLORS;
  #labelCache = new Map();
  #measureContext = null;
  #arrowGroups = new Map(); // shape → { vao, buffer, templateCount, count }

  /**
   * @param {HTMLElement} container  the graph fills it
   * @param {{ onNodeTap?, onNodeDoubleTap?, onNodeContextTap?, onNodeHover?, onPointerMove?, onBackgroundTap?,
   *           onViewportChange?, onNodeDragStart?, onNodeDrag?, onNodeDragEnd? }} [handlers]
   * @param {{ preserveDrawingBuffer?: boolean, badgeUrl?: string, colors?: Partial<typeof DEFAULT_COLORS> }} [options]
   *   badgeUrl: the image drawn in the corner of nodes whose style has `badge: true`
   */
  constructor(
    container,
    handlers = {},
    { preserveDrawingBuffer = false, badgeUrl = null, colors = {} } = {},
  ) {
    this.container = container;
    this.#colors = { ...DEFAULT_COLORS, ...colors };
    this.handlers = handlers;
    const madeRelative = getComputedStyle(container).position === "static";
    const previousPosition = container.style.position;
    if (madeRelative) container.style.position = "relative"; // the canvases are positioned inside it
    this.canvas = document.createElement("canvas");
    this.labelCanvas = document.createElement("canvas");
    for (const canvas of [this.canvas, this.labelCanvas])
      Object.assign(canvas.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
      });
    this.canvas.style.touchAction = "none";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Graph");
    this.labelCanvas.style.pointerEvents = "none";
    container.append(this.canvas, this.labelCanvas);
    try {
      const gl = this.canvas.getContext("webgl2", {
        antialias: true,
        premultipliedAlpha: true,
        alpha: true,
        preserveDrawingBuffer,
      });
      if (!gl) throw new Error("WebGL2 isn't available");
      this.gl = gl;
      this.labelContext = this.labelCanvas.getContext("2d");
      this.#setUpGl();
    } catch (error) {
      // Leave the page as it was.
      this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
      this.canvas.remove();
      this.labelCanvas.remove();
      if (madeRelative) container.style.position = previousPosition;
      throw error;
    }
    this.canvas.addEventListener("webglcontextlost", this.#onContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.#onContextRestored,
    );
    this.#bindInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    if (badgeUrl) {
      this.#badgeUrl = badgeUrl;
      this.#loadIcon(badgeUrl);
    }
  }

  /** The GPU dropped the context (driver reset, too many contexts…): stop drawing until it's back. */
  #onContextLost = (event) => {
    event.preventDefault(); // tells the browser we'll restore it
    this.#contextLost = true;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  };

  /** The context is back, empty: rebuild everything the GPU held from what's kept here. */
  #onContextRestored = () => {
    if (this.#destroyed) return;
    this.#contextLost = false;
    this.#bufferCapacity.clear();
    this.#arrowGroups.clear();
    this.#setUpGl();
    this.#atlasDirty = true;
    this.#geometryDirty = true;
    this.#lastFrameTime = 0;
    this.requestRender();
  };

  // ---------------------------------------------------------------- options

  /**
   * @param {{ motion?: { enabled?: boolean, durationMs?: number, feel?: string }, dimAlpha?: number,
   *           flowSpeed?: number, smoothZoom?: boolean, zoomSpeed?: number, draggable?: boolean,
   *           input?: Partial<typeof DEFAULT_INPUT>,
   *           labels?: Partial<{ position: string, backdrop: boolean, fadeZoom: number, maxWidth: number,
   *           overflow: string, cardDetailZoom: number }> }} options
   */
  setOptions(options) {
    if (options.motion) {
      const motion = { ...this.#motion, ...options.motion };
      const params = springFor(motion.durationMs, motion.feel);
      // Springs share one params object: update it in place so moving values pick up the change.
      Object.assign(this.#motion.params, params);
      this.#motion = { ...motion, params: this.#motion.params };
    }
    if (options.dimAlpha != null) this.#dimAlpha = options.dimAlpha;
    if (options.flowSpeed != null) this.#flowSpeed = options.flowSpeed;
    for (const key of ["smoothZoom", "zoomSpeed", "draggable"])
      if (options[key] != null) this.#input[key] = options[key];
    if (options.input)
      for (const [key, value] of Object.entries(options.input))
        if (value != null && key in DEFAULT_INPUT)
          this.#input[key] =
            key === "dragThreshold"
              ? {
                  ...this.#input.dragThreshold,
                  .../** @type {object} */ (value),
                }
              : value;
    if (options.labels) {
      this.#labels = { ...this.#labels, ...options.labels };
      this.#labelCache.clear();
    }
    for (const record of [...this.#nodes, ...this.#ghosts])
      this.#retargetNode(record);
    for (const record of this.#edges) this.#retargetEdge(record); // dimAlpha
    this.#geometryDirty = true;
    this.requestRender();
  }

  /** The interaction colours (DEFAULT_COLORS), a copy. */
  get colors() {
    return { ...this.#colors };
  }

  /** Change any interaction colours (selection, hover, label text and backdrops): they apply at once. */
  setColors(patch) {
    this.#colors = { ...this.#colors, ...patch };
    this.#labelCache.clear();
    for (const record of [...this.#nodes, ...this.#ghosts])
      this.#retargetNode(record);
    this.#geometryDirty = true;
    this.requestRender();
  }

  get motionEnabled() {
    return this.#motion.enabled;
  }

  // ---------------------------------------------------------------- data

  /**
   * Replace the graph. Nodes that stay keep their place on screen and glide to their new position; with `animate`,
   * new nodes grow out of `spawnFrom` (id → point) after `delays` (id → ms), and removed nodes fade into `ghostTo`
   * (id → point). Without it everything snaps. The camera isn't moved (see fitView / moveCamera). A node being dragged
   * stays under the pointer if it's still there; if it's gone, the drag ends (onNodeDragEnd). Positions and sizes
   * that aren't finite numbers are read as 0 and the smallest size.
   *
   * @param {{ nodes: { id: string, x: number, y: number, width: number, height: number, style: any }[],
   *           edges: { id: string, source: string, target: string, style: any }[], routing?: string,
   *           flowAxis?: string, cornerRadius?: number, curvature?: number,
   *           portDirection?: { x: number, y: number } }} graph
   * @param {{ animate?: boolean, spawnFrom?: Map<string, {x: number, y: number}>, delays?: Map<string, number>,
   *           ghostTo?: Map<string, {x: number, y: number}> }} [transition]
   */
  setGraph(graph, { animate = false, spawnFrom, delays, ghostTo } = {}) {
    animate &&= this.#motion.enabled;
    this.#layout = {
      routing: graph.routing ?? "straight",
      flowAxis: graph.flowAxis ?? "y",
      cornerRadius: graph.cornerRadius ?? 10,
      curvature: graph.curvature ?? 1,
      portDirection: graph.portDirection ?? { x: 0, y: 0 },
    };
    const params = this.#motion.params;
    const previous = this.#byId;
    const next = new Map();
    const nodes = [];
    // A node coming back while it's still fading out is picked up where it is.
    const returning = new Map(this.#ghosts.map((ghost) => [ghost.id, ghost]));
    for (const raw of graph.nodes) {
      const input = {
        ...raw,
        x: finiteOr(raw.x, 0),
        y: finiteOr(raw.y, 0),
        width: Math.max(MIN_NODE_SIZE, finiteOr(raw.width, 0)),
        height: Math.max(MIN_NODE_SIZE, finiteOr(raw.height, 0)),
      };
      let record = previous.get(input.id) ?? returning.get(input.id);
      returning.delete(input.id);
      const isNew = !record;
      if (isNew) {
        const spawn = animate && spawnFrom?.get(input.id);
        const start =
          spawn && Number.isFinite(spawn.x) && Number.isFinite(spawn.y)
            ? spawn
            : input;
        record = {
          id: input.id,
          px: new Spring(start.x, params, 0.05), // world units: well under a pixel
          py: new Spring(start.y, params, 0.05),
          alpha: new Spring(animate ? 0 : 1, params),
          scale: new Spring(animate ? 0.55 : 1, params),
          glow: new Spring(0, params),
          glowColor: [1, 1, 1],
          wait: 0,
        };
      }
      record.ghost = false;
      this.#resize(record, input.width, input.height, animate && !isNew);
      this.#applyNodeStyle(record, input.style, { fade: !isNew && animate });
      // The dragged node stays under the pointer.
      if (input.id !== this.#dragged) {
        record.px.set(input.x);
        record.py.set(input.y);
        if (!animate) {
          record.px.snap(input.x);
          record.py.snap(input.y);
        }
      }
      record.wait = isNew && animate ? (delays?.get(input.id) ?? 0) / 1000 : 0;
      this.#retargetNode(record);
      if (!animate) {
        record.alpha.snap(record.alpha.target);
        record.scale.snap(record.scale.target);
      }
      next.set(input.id, record);
      record.gridIndex = nodes.length;
      nodes.push(record);
      this.#moving.add(record);
    }
    // Leaving nodes become ghosts: they glide into their destination and fade out, then are dropped.
    for (const [id, record] of previous) {
      if (next.has(id)) continue;
      if (!animate) continue;
      record.ghost = true;
      const destination = ghostTo?.get(id);
      if (destination) {
        record.px.set(destination.x);
        record.py.set(destination.y);
      }
      this.#retargetNode(record);
      this.#ghosts.push(record);
      this.#moving.add(record);
    }
    this.#ghosts = animate
      ? this.#ghosts.filter((ghost) => !next.has(ghost.id))
      : [];
    this.#nodes = nodes;
    this.#byId = next;

    const previousEdges = this.#edgeById;
    this.#edgeById = new Map();
    this.#edges = [];
    for (const input of graph.edges) {
      const source = next.get(input.source),
        target = next.get(input.target);
      if (!source || !target) continue;
      let record = previousEdges.get(input.id);
      const isNew =
        !record || record.source !== source || record.target !== target;
      if (isNew)
        record = {
          id: input.id,
          alpha: new Spring(animate ? 0 : 1, params),
          emphasis: new Spring(0, params),
          wait: 0,
        };
      record.source = source;
      record.target = target;
      this.#applyEdgeStyle(record, input.style, { fade: !isNew && animate });
      record.wait =
        isNew && animate
          ? Math.max(source.wait, target.wait) +
            (this.#motion.durationMs / 1000) * 0.45
          : 0;
      this.#retargetEdge(record);
      if (!animate) record.alpha.snap(record.alpha.target);
      this.#edgeById.set(input.id, record);
      this.#edges.push(record);
      this.#moving.add(record);
    }
    if (this.#hovered && !next.has(this.#hovered)) this.#hovered = null;
    if (this.#selected && !next.has(this.#selected)) this.#selected = null;
    // A press on a node that's gone: a drag ends; a press that hadn't become one yet is dropped.
    const gesture = this.#gesture;
    if (gesture?.record && !next.has(gesture.record.id)) {
      if (gesture.kind === "drag") this.#endDrag();
      else this.#gesture = { kind: "done" };
      clearTimeout(this.#longPress);
    }
    this.canvas.setAttribute(
      "aria-label",
      `Graph of ${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
    );
    this.#geometryDirty = this.#gridDirty = true;
    this.requestRender();
  }

  /**
   * Restyle nodes and edges in place (no movement): [{ id, style }]. A node whose size changed (`style.width` and
   * `style.height`, or `style.size` for both) is resized to it where it stands, on a spring when animations are on.
   */
  updateStyles(nodeUpdates = [], edgeUpdates = []) {
    for (const { id, style } of nodeUpdates) {
      const record = this.#byId.get(id);
      if (!record) continue;
      const width = style.width ?? style.size,
        height = style.height ?? style.size;
      if (width != null && height != null)
        this.#resize(
          record,
          Math.max(MIN_NODE_SIZE, finiteOr(width, 0)),
          Math.max(MIN_NODE_SIZE, finiteOr(height, 0)),
          this.#motion.enabled,
        );
      this.#applyNodeStyle(record, style, { fade: true });
    }
    for (const { id, style } of edgeUpdates) {
      const record = this.#edgeById.get(id);
      if (record) this.#applyEdgeStyle(record, style, { fade: true });
    }
    // Sizes and `events` both change what the grid holds.
    this.#geometryDirty = this.#gridDirty = true;
    this.requestRender();
  }

  /**
   * Move nodes (a force simulation, a drag): entries of [id, x, y]. They jump there: whatever is calling this is
   * already animating them.
   */
  moveNodes(entries) {
    for (const [id, x, y] of entries) {
      const record = this.#byId.get(id);
      if (!record) continue;
      record.px.snap(x);
      record.py.snap(y);
      this.#touched.add(record);
      this.#gridMoved.add(record);
    }
    this.requestRender();
  }

  /**
   * A node's size: at once, or (`animate`) growing or shrinking to it on springs, from wherever it is now. Everything
   * that reads a node's box (edges, hits, labels, bounds) follows as it changes.
   */
  #resize(record, width, height, animate) {
    record.width = width;
    record.height = height;
    const hw = width / 2,
      hh = height / 2;
    if (
      animate &&
      record.hw != null &&
      (record.hw !== hw || record.hh !== hh)
    ) {
      const params = this.#motion.params;
      record.hwSpring ??= new Spring(record.hw, params, 0.05);
      record.hhSpring ??= new Spring(record.hh, params, 0.05);
      record.hwSpring.set(hw);
      record.hhSpring.set(hh);
      this.#moving.add(record);
      return;
    }
    record.hwSpring = record.hhSpring = null;
    record.hw = hw;
    record.hh = hh;
  }

  /** A node's look. `fade`: blend from the colours on screen to the new ones instead of switching. */
  #applyNodeStyle(record, style, { fade = false } = {}) {
    // A colour's own alpha (#rrggbbaa, rgba()…) multiplies the style's.
    const withAlpha = (color, alpha) => {
      const [r, g, b, a] = parseColorAlpha(color);
      return [r, g, b, a * alpha];
    };
    const colors = {
      fill: withAlpha(style.fill, style.fillAlpha ?? 1),
      border: withAlpha(style.border, 1),
      aura: style.aura ? withAlpha(style.aura, 1) : [0, 0, 0, 0],
      ring: style.ring ? withAlpha(style.ring, 0.9) : [0, 0, 0, 0],
      stripe: style.stripe ? withAlpha(style.stripe, 1) : [0, 0, 0, 0],
      portIn: style.portIn ? withAlpha(style.portIn, 1) : [0, 0, 0, 0],
      portOut: style.portOut ? withAlpha(style.portOut, 1) : [0, 0, 0, 0],
    };
    this.#fadeColors(record, colors, fade);
    record.style = style;
    if (style.icon) this.#loadIcon(style.icon);
    if (style.badge && this.#badgeUrl) this.#loadIcon(this.#badgeUrl); // a retry, if it failed
  }

  #applyEdgeStyle(record, style, { fade = false } = {}) {
    this.#fadeColors(record, { color: parseColor(style.color) }, fade);
    record.style = style;
  }

  /**
   * Set a record's colours (`colors`: field → [r, g, b(, a)]). With `fade`, and when any changed, it starts from what's
   * on screen (mid-fade included) and blends over one motion duration on a spring.
   */
  #fadeColors(record, colors, fade) {
    const changed = Object.keys(colors).some(
      (key) => !record[key] || colors[key].some((v, i) => v !== record[key][i]),
    );
    if (
      fade &&
      changed &&
      this.#motion.enabled &&
      record[Object.keys(colors)[0]]
    ) {
      const mix = Math.min(1, Math.max(0, record.colorMix?.value ?? 1));
      const from = {};
      for (const key of Object.keys(colors)) {
        const to = record[key],
          start = record.colorFrom?.[key] ?? to;
        from[key] = to.map((v, i) => start[i] + (v - start[i]) * mix);
      }
      record.colorFrom = from;
      record.colorMix = new Spring(0, this.#motion.params);
      record.colorMix.set(1);
      this.#moving.add(record);
    }
    Object.assign(record, colors);
  }

  /** Spring targets from state: ghosts fade and shrink, dimmed nodes fade, hovered and dragged ones lift and glow. */
  #retargetNode(record) {
    const id = record.id;
    const dimmed = !record.ghost && this.#dimmed?.has(id);
    record.alpha.set(record.ghost ? 0 : dimmed ? this.#dimAlpha : 1);
    record.scale.set(
      record.ghost
        ? 0.35
        : id === this.#dragged
          ? 1.12
          : id === this.#hovered
            ? 1.06
            : 1,
    );
    let glow = 0,
      color = this.#colors.hover;
    if (!record.ghost) {
      if (id === this.#selected) {
        glow = 0.9;
        color = this.#colors.selected;
      } else if (this.#emphasis.has(id)) {
        glow = 0.8;
        color = this.#emphasis.get(id);
      } else if (id === this.#hovered || id === this.#dragged) glow = 0.35;
    }
    if (glow > 0) record.glowColor = parseColor(color);
    record.glow.set(glow);
    this.#moving.add(record);
  }

  #retargetEdge(record) {
    const emphasis = this.#edgeEmphasis.get(record.id);
    const dimmed =
      !emphasis &&
      this.#dimmed &&
      (this.#dimmed.has(record.source.id) ||
        this.#dimmed.has(record.target.id));
    record.alpha.set(dimmed ? this.#dimAlpha : 1);
    record.emphasis.set(emphasis ? 1 : 0);
    if (emphasis) record.emphasisState = emphasis;
    this.#moving.add(record);
  }

  // ---------------------------------------------------------------- interaction state

  /** Select a node (null, or an id not in the graph, for none). */
  select(id) {
    const previous = this.#selected;
    this.#selected = id != null && this.#byId.has(id) ? id : null;
    for (const nodeId of [previous, this.#selected]) {
      const record = nodeId && this.#byId.get(nodeId);
      if (record) this.#retargetNode(record);
    }
    this.requestRender();
  }

  get selected() {
    return this.#selected;
  }

  /** Nodes drawn faded (their edges too, unless emphasised); null for none. */
  setDimmed(ids) {
    this.#dimmed = ids ? new Set(ids) : null;
    for (const record of this.#nodes) this.#retargetNode(record);
    for (const record of this.#edges) this.#retargetEdge(record);
    this.requestRender();
  }

  /** Nodes that glow in a colour (highlights, flashes): Map id → colour, or null. */
  setEmphasis(colorsById) {
    const changed = new Set([
      ...this.#emphasis.keys(),
      ...(colorsById?.keys() ?? []),
    ]);
    this.#emphasis = new Map(colorsById ?? []);
    for (const id of changed) {
      const record = this.#byId.get(id);
      if (record) this.#retargetNode(record);
    }
    this.requestRender();
  }

  /** Nodes whose labels stay visible however far out you zoom (e.g. a hovered lineage). */
  setLabelFocus(ids) {
    this.#labelFocus = new Set(ids ?? []);
    this.requestRender();
  }

  /** Edges drawn in a colour, wider, optionally with flow: Map id → { color, boost?, flow? (+1 → target, −1 → source) }. */
  setEdgeEmphasis(stateById) {
    this.#edgeEmphasis = new Map(stateById ?? []);
    for (const record of this.#edges) this.#retargetEdge(record);
    this.requestRender();
  }

  /** A kick to a node's glow: it flares and settles back (springs make this a velocity impulse). */
  pulse(id) {
    const record = this.#byId.get(id);
    if (!record || !this.#motion.enabled) return;
    if (record.glow.target === 0)
      record.glowColor = parseColor(this.#colors.selected);
    record.glow.velocity += 9;
    record.scale.velocity += 1.2;
    this.#moving.add(record);
    this.requestRender();
  }

  /** Run `tick(dt)` every frame until it returns false (physics, custom animations). */
  addTicker(tick) {
    if (this.#destroyed) return () => false;
    this.#tickers.add(tick);
    this.requestRender();
    return () => this.#tickers.delete(tick);
  }

  // ---------------------------------------------------------------- queries

  hasNode(id) {
    return this.#byId.has(id);
  }

  nodeIds() {
    return [...this.#byId.keys()];
  }

  /** Where a node is headed (its layout position), or null. */
  positionOf(id) {
    const record = this.#byId.get(id);
    return record ? { x: record.px.target, y: record.py.target } : null;
  }

  /** Where a node is right now (world units, mid-animation included), or null. */
  livePositionOf(id) {
    const record = this.#byId.get(id);
    return record ? { x: record.px.value, y: record.py.value } : null;
  }

  /**
   * Change how edges are routed (a style setting) without replacing the graph. `portDirection`: a unit vector toward
   * the root side of the flow, where card nodes put their out port (their in port is opposite); zero for none.
   */
  setRouting({ routing, flowAxis, cornerRadius, curvature, portDirection }) {
    this.#layout = {
      routing: routing ?? this.#layout.routing,
      flowAxis: flowAxis ?? this.#layout.flowAxis,
      cornerRadius: cornerRadius ?? this.#layout.cornerRadius,
      curvature: curvature ?? this.#layout.curvature,
      portDirection: portDirection ?? this.#layout.portDirection,
    };
    this.#geometryDirty = true;
    this.requestRender();
  }

  /** Where a node is on screen right now (CSS pixels), or null. */
  screenPositionOf(id) {
    const record = this.#byId.get(id);
    return record
      ? this.camera.toScreen(record.px.value, record.py.value)
      : null;
  }

  /** World box around the given nodes' final positions (all nodes by default). */
  bounds(ids = null) {
    const records = ids
      ? [...ids].map((id) => this.#byId.get(id)).filter(Boolean)
      : this.#nodes;
    if (!records.length) return { x1: 0, y1: 0, x2: 1, y2: 1 };
    return pointsBounds(
      records.flatMap((r) => [
        { x: r.px.target - r.hw, y: r.py.target - r.hh },
        { x: r.px.target + r.hw, y: r.py.target + r.hh },
      ]),
    );
  }

  // ---------------------------------------------------------------- camera

  /**
   * Move the camera to { zoom, panX, panY }. Animated moves ride springs on the view's centre and (log) zoom, so they
   * can be retargeted mid-flight; any direct input (wheel, drag) takes over at once.
   */
  moveCamera({ zoom, panX, panY }, { animate = true } = {}) {
    zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, zoom));
    const centreX = (this.width / 2 - panX) / zoom;
    const centreY = (this.height / 2 - panY) / zoom;
    this.#zoomTarget = null;
    this.#glide = null;
    if (!animate || !this.#motion.enabled || !this.width) {
      this.#cameraSprings = null;
      Object.assign(this.camera, { zoom, panX, panY });
      this.#viewportChanged();
      return;
    }
    const params = springFor(Math.min(this.#motion.durationMs, 520), "smooth");
    const current = this.#cameraSprings ?? {
      x: new Spring(
        (this.width / 2 - this.camera.panX) / this.camera.zoom,
        params,
      ),
      y: new Spring(
        (this.height / 2 - this.camera.panY) / this.camera.zoom,
        params,
      ),
      z: new Spring(Math.log(this.camera.zoom), params),
    };
    // Close enough is a third of a pixel at the zoom it's headed for.
    current.x.precision = current.y.precision = 0.3 / zoom;
    current.x.set(centreX);
    current.y.set(centreY);
    current.z.set(Math.log(zoom));
    this.#cameraSprings = current;
    this.requestRender();
  }

  /** The camera that fits `bounds` (default: every node) with `padding` pixels to spare. */
  viewFor(bounds = this.bounds(), { padding = 40, maxZoom = 1.6 } = {}) {
    const camera = new Camera({
      minZoom: this.camera.minZoom,
      maxZoom: this.camera.maxZoom,
    });
    camera.fit(bounds, this.width, this.height, {
      padding,
      maxFitZoom: maxZoom,
    });
    return { zoom: camera.zoom, panX: camera.panX, panY: camera.panY };
  }

  fitView({ animate = true, ids = null, padding = 40, maxZoom = 1.6 } = {}) {
    if (!this.width || !this.height) return;
    this.moveCamera(this.viewFor(this.bounds(ids), { padding, maxZoom }), {
      animate,
    });
  }

  /** Zoom around the middle of the view. */
  zoomBy(factor, { animate = true } = {}) {
    const base = this.#cameraTarget();
    const zoom = Math.min(
      this.camera.maxZoom,
      Math.max(this.camera.minZoom, base.zoom * factor),
    );
    const ratio = zoom / base.zoom;
    const cx = this.width / 2,
      cy = this.height / 2;
    this.moveCamera(
      {
        zoom,
        panX: cx - (cx - base.panX) * ratio,
        panY: cy - (cy - base.panY) * ratio,
      },
      { animate },
    );
  }

  /** Put a node in the middle of the view (at `zoom`, or the current zoom). */
  centerOn(id, { zoom = null, animate = true } = {}) {
    const position = this.positionOf(id);
    if (!position) return;
    const z = zoom ?? this.#cameraTarget().zoom;
    this.moveCamera(
      {
        zoom: z,
        panX: this.width / 2 - position.x * z,
        panY: this.height / 2 - position.y * z,
      },
      { animate },
    );
  }

  /** Pan (not zoom) just enough to bring a node on screen with `margin` pixels to spare. */
  reveal(id, { margin = 60, animate = true } = {}) {
    const position = this.positionOf(id);
    if (!position) return;
    const view = this.#cameraTarget();
    const x = position.x * view.zoom + view.panX,
      y = position.y * view.zoom + view.panY;
    const dx =
      x < margin
        ? margin - x
        : x > this.width - margin
          ? this.width - margin - x
          : 0;
    const dy =
      y < margin
        ? margin - y
        : y > this.height - margin
          ? this.height - margin - y
          : 0;
    if (dx || dy)
      this.moveCamera(
        { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy },
        { animate },
      );
  }

  /** Where the camera is headed (or is, when it isn't moving). */
  #cameraTarget() {
    const springs = this.#cameraSprings;
    if (!springs)
      return {
        zoom: this.camera.zoom,
        panX: this.camera.panX,
        panY: this.camera.panY,
      };
    const zoom = Math.exp(springs.z.target);
    return {
      zoom,
      panX: this.width / 2 - springs.x.target * zoom,
      panY: this.height / 2 - springs.y.target * zoom,
    };
  }

  /** The camera's destination, for callers that plan relative to it. */
  get cameraTarget() {
    return this.#cameraTarget();
  }

  #stopCamera() {
    this.#cameraSprings = null;
    this.#glide = null;
  }

  #viewportChanged() {
    this.handlers.onViewportChange?.();
    this.requestRender();
  }

  resize() {
    if (this.#destroyed) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (dpr !== this.dpr) this.#watchPixelRatio(dpr);
    const width = this.container.clientWidth,
      height = this.container.clientHeight;
    // Keep what's in the middle in the middle.
    if (this.width && width && height) {
      this.camera.panX += (width - this.width) / 2;
      this.camera.panY += (height - this.height) / 2;
    }
    this.width = width;
    this.height = height;
    for (const canvas of [this.canvas, this.labelCanvas]) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    }
    this.dpr = dpr;
    this.requestRender();
  }

  /**
   * A new device pixel ratio (a window dragged to another screen, browser zoom) changes no CSS size, so the
   * ResizeObserver misses it: watch for it with a media query matching the current ratio, re-armed on each change.
   */
  #watchPixelRatio(dpr) {
    this.#pixelRatioQuery?.removeEventListener("change", this.#onPixelRatio);
    this.#pixelRatioQuery =
      globalThis.matchMedia?.(`(resolution: ${dpr}dppx)`) ?? null;
    this.#pixelRatioQuery?.addEventListener("change", this.#onPixelRatio);
  }

  #onPixelRatio = () => this.resize();

  /** Stop everything, remove the canvases and let go of the GPU. The graph can't be used afterwards. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    clearTimeout(this.#iconRefresh);
    clearTimeout(this.#longPress);
    this.#tickers.clear();
    this.#moving.clear();
    this.#touched.clear();
    this.#gridMoved.clear();
    this.#gesture = null;
    this.#cameraSprings = this.#glide = this.#zoomTarget = null;
    this.resizeObserver.disconnect();
    this.#pixelRatioQuery?.removeEventListener("change", this.#onPixelRatio);
    this.#pixelRatioQuery = null;
    this.canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.#onContextRestored,
    );
    this.canvas.remove();
    this.labelCanvas.remove();
    // Drop what's cached: nodes, labels, icons, GPU buffers.
    this.#nodes = [];
    this.#ghosts = [];
    this.#edges = [];
    this.#byId.clear();
    this.#edgeById.clear();
    this.#labelCache.clear();
    this.#iconSlots.clear();
    this.#arrowGroups.clear();
    this.#bufferCapacity.clear();
    this.uniforms?.clear();
    if (this.atlasCanvas) this.atlasCanvas.width = this.atlasCanvas.height = 0;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // ---------------------------------------------------------------- GL setup

  /** Programs, buffers and the icon texture: at start, and again when a lost context comes back. */
  #setUpGl() {
    const gl = this.gl;
    this.#buildNodeProgram();
    this.edgeProgram = this.#program(EDGE_VERTEX, EDGE_FRAGMENT);
    this.arrowProgram = this.#program(ARROW_VERTEX, ARROW_FRAGMENT);
    this.uniforms = new Map();

    // Nodes, and the lifted ones again (drawn last, over everything).
    const nodeLayer = () => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      this.#staticBuffer(0, [-1, -1, 1, -1, -1, 1, 1, 1], 2);
      const buffer = gl.createBuffer();
      this.#instanceLayout(buffer, [
        [1, 2],
        [2, 2],
        [3, 4],
        [4, 4],
        [5, 4],
        [6, 4],
        [7, 4],
        [8, 4],
        [9, 4],
        [10, 4],
        [11, 4],
        [12, 4],
        [13, 4],
        [14, 4],
        [15, 4],
      ]);
      return [vao, buffer];
    };
    [this.nodeVao, this.nodeBuffer] = nodeLayer();
    [this.topNodeVao, this.topNodeBuffer] = nodeLayer();

    this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);
    this.#staticBuffer(0, [0, -1, 1, -1, 0, 1, 1, 1], 2);
    this.edgeBuffer = gl.createBuffer();
    this.#instanceLayout(this.edgeBuffer, [
      [1, 2],
      [2, 2],
      [3, 4],
      [4, 4],
      [5, 4],
    ]);
    gl.bindVertexArray(null);

    // Icon atlas: a 2D canvas the icons are drawn into, uploaded as one texture (premultiplied, mipmapped). The canvas
    // outlives a lost context, so the icons come back with it.
    if (!this.atlasCanvas) {
      this.atlasCanvas = document.createElement("canvas");
      this.atlasCanvas.width = this.atlasCanvas.height = ATLAS_SIZE;
      this.atlasContext = this.atlasCanvas.getContext("2d");
    }
    this.iconTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * The node shader, with the registered custom shapes compiled in. A custom GLSL shape that doesn't compile is left
   * out (and drawn as the default shape), with a warning, rather than taking every node down with it.
   */
  #buildNodeProgram() {
    this.#builtPlugins = pluginVersion();
    const old = this.nodeProgram;
    const build = (skip) =>
      this.#program(NODE_VERTEX, nodeFragmentSource(customShapeGlsl(skip)));
    try {
      this.nodeProgram = build(new Set());
    } catch (error) {
      const names = glslShapeNames();
      const broken = new Set(
        names.filter((name) => {
          try {
            this.gl.deleteProgram(
              build(new Set(names.filter((other) => other !== name))),
            );
            return false;
          } catch {
            return true;
          }
        }),
      );
      if (!broken.size) throw error;
      for (const name of broken) disableShape(name); // reported once: later shaders leave it out
      console.warn(
        `Prismatrix: node shape${broken.size > 1 ? "s" : ""} ${[...broken].map((n) => `"${n}"`).join(", ")} didn't compile and ${broken.size > 1 ? "are" : "is"} drawn as the default shape:
${error.message}`,
      );
      this.nodeProgram = build(broken);
    }
    if (old && old !== this.nodeProgram) {
      this.uniforms?.delete(old);
      this.gl.deleteProgram(old);
    }
  }

  /** Something was registered (plugins.js): rebuild what depends on it. */
  #applyPlugins() {
    this.#buildNodeProgram();
    for (const group of this.#arrowGroups.values()) {
      this.gl.deleteVertexArray(group.vao);
      this.gl.deleteBuffer(group.buffer);
    }
    this.#arrowGroups.clear();
    this.#layout = { ...this.#layout }; // routes are cached per layout: route again
    this.#geometryDirty = true;
  }

  #program(vertexSource, fragmentSource) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    return program;
  }

  #uniform(program, name) {
    let byName = this.uniforms.get(program);
    if (!byName) this.uniforms.set(program, (byName = new Map()));
    if (!byName.has(name))
      byName.set(name, this.gl.getUniformLocation(program, name));
    return byName.get(name);
  }

  #staticBuffer(location, data, size) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  /** Per-instance attributes interleaved in one buffer: [[location, size], …]. */
  #instanceLayout(buffer, attributes) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = attributes.reduce((sum, [, size]) => sum + size, 0) * 4;
    let offset = 0;
    for (const [location, size] of attributes) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
      offset += size * 4;
    }
  }

  /** One VAO per arrow shape: its template mesh plus an instance buffer of tips. */
  #arrowGroup(shape) {
    let group = this.#arrowGroups.get(shape);
    if (group) return group;
    const gl = this.gl;
    const template = arrowTemplate(shape);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.#staticBuffer(0, template.triangles.flat(), 2);
    const buffer = gl.createBuffer();
    this.#instanceLayout(buffer, [
      [1, 2],
      [2, 2],
      [3, 4],
      [4, 1],
    ]);
    gl.bindVertexArray(null);
    group = {
      vao,
      buffer,
      vertices: template.triangles.length,
      inset: template.inset,
      count: 0,
    };
    this.#arrowGroups.set(shape, group);
    return group;
  }

  // ---------------------------------------------------------------- geometry

  /** Send `list`'s dirty span to `buffer`, growing the GPU buffer (and sending it all) when it no longer fits. */
  #upload(buffer, list) {
    const gl = this.gl;
    const span = list.takeDirty();
    if (!span && this.#bufferCapacity.has(buffer)) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (list.data.length !== this.#bufferCapacity.get(buffer)) {
      gl.bufferData(gl.ARRAY_BUFFER, list.data.byteLength, gl.DYNAMIC_DRAW);
      this.#bufferCapacity.set(buffer, list.data.length);
      if (list.length)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, list.data, 0, list.length);
      return;
    }
    if (span)
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        span[0] * 4,
        list.data,
        span[0],
        span[1] - span[0],
      );
  }

  /**
   * Bring the GPU's instance data up to date: rewrite just what moved since the last frame when the draw order still
   * holds, everything otherwise (a new graph, restyles, a node lifted on top, icons arriving).
   */
  #syncGeometry() {
    if (!this.#geometryDirty && !this.#touched.size) return;
    const started = performance.now();
    const scene = {
      ghosts: this.#ghosts,
      nodes: this.#nodes,
      edges: this.#edges,
      top: [this.#selected, this.#hovered, this.#dragged].filter(
        (id) => id != null,
      ),
      layout: this.#layout,
      iconUv: (url) => {
        const slot = this.#iconSlots.get(url);
        return slot?.uv ?? null;
      },
    };
    const instances = this.#instances;
    const partial =
      !this.#geometryDirty && instances.update(this.#touched, scene);
    if (!partial) instances.rebuild(scene);
    this.#touched.clear();
    this.#geometryDirty = false;

    this.#upload(this.edgeBuffer, instances.edges);
    this.edgePieceCount = instances.edges.length / EDGE_FLOATS;
    for (const [shape, list] of instances.arrows) {
      const group = this.#arrowGroup(shape);
      this.#upload(group.buffer, list);
      group.count = list.length / ARROW_FLOATS;
    }
    this.#upload(this.nodeBuffer, instances.nodes);
    this.nodeCount = instances.nodes.length / NODE_FLOATS;
    this.#upload(this.topNodeBuffer, instances.topNodes);
    this.topNodeCount = instances.topNodes.length / NODE_FLOATS;
    this.stats.uploadMs = performance.now() - started;
    this.stats.partialUpload = partial;
  }

  /**
   * Bring the hit-testing grid up to date: move just the nodes that moved, or rebuild it when much of the graph
   * moved (or its nodes changed).
   */
  #syncGrid() {
    const moved = this.#gridMoved;
    if (this.#gridDirty || moved.size > this.#nodes.length / 4)
      this.#rebuildGrid();
    else
      for (const record of moved) {
        if (this.#nodes[record.gridIndex] !== record) continue; // no longer drawn
        this.#grid.move(record.gridIndex, {
          x1: record.px.value - record.hw,
          y1: record.py.value - record.hh,
          x2: record.px.value + record.hw,
          y2: record.py.value + record.hh,
        });
      }
    moved.clear();
  }

  #gridMoved = new Set(); // nodes moved since the grid was last brought up to date

  #rebuildGrid() {
    const cell = Math.max(
      100,
      ...this.#nodes.slice(0, 50).map((n) => n.width * 3),
    );
    this.#grid = new SpatialGrid(cell);
    // Every node, `events: false` ones too: the grid also finds the labels on screen. Hit tests skip those.
    this.#nodes.forEach((record, index) => {
      this.#grid.insert(index, {
        x1: record.px.value - record.hw,
        y1: record.py.value - record.hh,
        x2: record.px.value + record.hw,
        y2: record.py.value + record.hh,
      });
    });
    this.#gridDirty = false;
  }

  #loadIcon(url) {
    const slot = this.#iconSlots.get(url);
    // Loaded, loading, or failed a moment ago: nothing to do. A failure long enough ago gets another try.
    if (slot && !(performance.now() - slot.failedAt > ICON_RETRY_MS)) return;
    const spot = slot?.spot ?? this.#iconPacker.place(ICON_SIZE, ICON_SIZE);
    if (!spot || spot.page > 0) {
      // Atlas full: drawn without its icon.
      this.#iconSlots.set(url, { failedAt: performance.now(), spot: null });
      return;
    }
    this.#iconSlots.set(url, { loading: true });
    const image = new Image();
    image.crossOrigin = "anonymous"; // hosts that allow it (CORS) keep the texture uploadable
    image.onload = () => {
      if (this.#destroyed) return;
      this.atlasContext.clearRect(spot.x, spot.y, ICON_SIZE, ICON_SIZE);
      this.atlasContext.drawImage(image, spot.x, spot.y, ICON_SIZE, ICON_SIZE);
      const u0 = spot.x / ATLAS_SIZE,
        v0 = spot.y / ATLAS_SIZE,
        u1 = (spot.x + ICON_SIZE) / ATLAS_SIZE,
        v1 = (spot.y + ICON_SIZE) / ATLAS_SIZE;
      this.#iconSlots.set(url, { u0, v0, u1, v1, uv: [u0, v0, u1, v1] });
      this.#atlasDirty = true;
      this.#scheduleIconRefresh();
    };
    // Keep the spot for the next try.
    image.onerror = () =>
      this.#iconSlots.set(url, { failedAt: performance.now(), spot });
    image.src = url;
  }

  /** Icons arrive one by one: refresh the atlas and node data at most every 100 ms, not per icon. */
  #scheduleIconRefresh() {
    if (this.#iconRefresh) return;
    this.#iconRefresh = setTimeout(() => {
      this.#iconRefresh = 0;
      this.#geometryDirty = true;
      this.requestRender();
    }, 100);
  }

  // ---------------------------------------------------------------- the frame loop

  /** Draw a frame soon (once, however often it's asked for). Nothing happens after destroy() or while the GPU is lost. */
  requestRender() {
    if (this.#frame || this.#destroyed || this.#contextLost) return;
    this.#frame = requestAnimationFrame((time) => {
      this.#frame = 0;
      this.#step(time);
    });
  }

  /** Advance every animation by the time since the last frame, draw, and keep going while anything moves. */
  #step(time) {
    const started = performance.now();
    const dt = this.#lastFrameTime
      ? Math.min(0.05, Math.max(0.001, (time - this.#lastFrameTime) / 1000))
      : 1 / 60;
    this.#lastFrameTime = time;
    let active = false;

    if (this.#zoomTarget) active = this.#stepWheelZoom(dt) || active;
    if (this.#cameraSprings) active = this.#stepCamera(dt) || active;
    if (this.#glide) active = this.#stepGlide(dt) || active;
    for (const tick of [...this.#tickers]) {
      if (tick(dt)) active = true;
      else this.#tickers.delete(tick);
    }
    if (this.#moving.size) {
      for (const record of [...this.#moving]) {
        if (record.wait > 0) {
          record.wait -= dt;
          continue;
        }
        this.#touched.add(record);
        let moving;
        if (record.px) {
          let moved = record.px.step(dt) | record.py.step(dt);
          if (record.hwSpring) {
            const resizing =
              record.hwSpring.step(dt) | record.hhSpring.step(dt);
            record.hw = record.hwSpring.value;
            record.hh = record.hhSpring.value;
            if (resizing) moved = 1;
            else record.hwSpring = record.hhSpring = null;
          }
          if (moved && !record.ghost) this.#gridMoved.add(record);
          moving = moved | record.scale.step(dt) | record.glow.step(dt);
        } else moving = !!(record.emphasis.step(dt) | 0);
        moving = record.alpha.step(dt) || moving;
        if (record.colorMix)
          if (record.colorMix.step(dt)) moving = true;
          else record.colorMix = record.colorFrom = null; // faded in
        if (!moving) this.#moving.delete(record);
      }
      // Ghosts leave once faded.
      const leaving = this.#ghosts.filter(
        (g) => g.alpha.value > 0.01 && this.#moving.has(g),
      );
      if (leaving.length !== this.#ghosts.length) {
        this.#ghosts = leaving;
        this.#geometryDirty = true;
      }
      active ||= this.#moving.size > 0;
    }
    const flowing = [...this.#edgeEmphasis.values()].some(
      (state) => state.flow,
    );
    this.stats.animating = this.#moving.size;

    this.#draw();
    this.stats.drawMs = performance.now() - started;
    this.stats.frames++;
    if (active || flowing) this.requestRender();
    else this.#lastFrameTime = 0;
  }

  #stepWheelZoom(dt) {
    const target = this.#zoomTarget;
    const ratio = target.zoom / this.camera.zoom;
    if (Math.abs(Math.log(ratio)) < 0.002) {
      this.camera.zoomAround(ratio, target.x, target.y);
      this.#zoomTarget = null;
    } else
      this.camera.zoomAround(
        Math.pow(ratio, 1 - Math.exp(-dt / 0.07)),
        target.x,
        target.y,
      );
    this.handlers.onViewportChange?.();
    return !!this.#zoomTarget;
  }

  #stepCamera(dt) {
    const springs = this.#cameraSprings;
    const moving = springs.x.step(dt) | springs.y.step(dt) | springs.z.step(dt);
    const zoom = Math.exp(springs.z.value);
    this.camera.zoom = zoom;
    this.camera.panX = this.width / 2 - springs.x.value * zoom;
    this.camera.panY = this.height / 2 - springs.y.value * zoom;
    this.handlers.onViewportChange?.();
    if (!moving) this.#cameraSprings = null;
    return !!moving;
  }

  #stepGlide(dt) {
    const glide = this.#glide;
    this.camera.panBy(glide.vx * dt, glide.vy * dt);
    const decay = Math.exp(-dt / Math.max(0.001, this.#input.panInertia));
    glide.vx *= decay;
    glide.vy *= decay;
    this.handlers.onViewportChange?.();
    if (Math.hypot(glide.vx, glide.vy) < 8) this.#glide = null;
    return !!this.#glide;
  }

  /** Send the icon atlas to the GPU if icons arrived since it was last sent. */
  #flushAtlas() {
    const gl = this.gl;
    if (this.#atlasDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.atlasCanvas,
      );
      gl.generateMipmap(gl.TEXTURE_2D);
      this.#atlasDirty = false;
    }
  }

  #draw() {
    const gl = this.gl;
    if (this.#builtPlugins !== pluginVersion()) this.#applyPlugins();
    this.#flushAtlas();
    this.#syncGeometry();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.#drawScene({
      camera: this.camera,
      width: this.width,
      height: this.height,
      pixelRatio: this.dpr,
    });
    const context = this.labelContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.#drawLabels(context, {
      camera: this.camera,
      width: this.width,
      height: this.height,
    });
  }

  /** Edges, arrowheads and nodes for `camera` into the bound framebuffer, `width` × `height` CSS pixels. */
  #drawScene({ camera, width, height, pixelRatio, lineScale = pixelRatio }) {
    const gl = this.gl;
    const view = camera.clipMatrix(width, height);
    const viewportX = width * pixelRatio,
      viewportY = height * pixelRatio;
    const time = (performance.now() - this.#startTime) / 1000;

    gl.useProgram(this.edgeProgram);
    gl.uniformMatrix3fv(this.#uniform(this.edgeProgram, "view"), false, view);
    gl.uniform2f(
      this.#uniform(this.edgeProgram, "viewport"),
      viewportX,
      viewportY,
    );
    gl.uniform1f(
      this.#uniform(this.edgeProgram, "zoomPx"),
      camera.zoom * pixelRatio,
    );
    gl.uniform1f(this.#uniform(this.edgeProgram, "pixelScale"), lineScale);
    gl.uniform1f(this.#uniform(this.edgeProgram, "time"), time);
    gl.uniform1f(this.#uniform(this.edgeProgram, "flowSpeed"), this.#flowSpeed);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.edgePieceCount);

    gl.useProgram(this.arrowProgram);
    gl.uniformMatrix3fv(this.#uniform(this.arrowProgram, "view"), false, view);
    gl.uniform2f(
      this.#uniform(this.arrowProgram, "viewport"),
      viewportX,
      viewportY,
    );
    gl.uniform1f(this.#uniform(this.arrowProgram, "pixelScale"), lineScale);
    for (const group of this.#arrowGroups.values()) {
      if (!group.count) continue;
      gl.bindVertexArray(group.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, group.vertices, group.count);
    }

    gl.useProgram(this.nodeProgram);
    gl.uniformMatrix3fv(this.#uniform(this.nodeProgram, "view"), false, view);
    gl.uniform1f(
      this.#uniform(this.nodeProgram, "pxWorld"),
      1 / (camera.zoom * pixelRatio),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
    gl.uniform1i(this.#uniform(this.nodeProgram, "icons"), 0);
    const { x: portX, y: portY } = this.#layout.portDirection;
    gl.uniform2f(this.#uniform(this.nodeProgram, "portDir"), portX, portY);
    const [pr, pg, pb, pa] = parseColorAlpha(this.#colors.portFill);
    gl.uniform4f(
      this.#uniform(this.nodeProgram, "portFill"),
      pr * pa,
      pg * pa,
      pb * pa,
      pa,
    );
    const badge = this.#badgeUrl && this.#iconSlots.get(this.#badgeUrl);
    if (badge?.uv)
      gl.uniform4f(
        this.#uniform(this.nodeProgram, "badgeRect"),
        badge.u0,
        badge.v0,
        badge.u1,
        badge.v1,
      );
    else gl.uniform4f(this.#uniform(this.nodeProgram, "badgeRect"), 0, 0, 0, 0);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    if (this.topNodeCount) {
      gl.bindVertexArray(this.topNodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.topNodeCount);
    }
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- labels

  /** How visible ordinary labels are at `zoom`: fully from 1.6 × the fade zoom, gone at it. */
  #labelOpacity(zoom) {
    const fade = this.#labels.fadeZoom;
    if (!fade) return 1;
    return Math.min(1, Math.max(0, (zoom - fade) / (fade * 0.6)));
  }

  /**
   * Labels on the 2D layer (context already scaled to CSS pixels). On screen they're thinned so they never overlap:
   * higher-priority labels (hovered, selected, lineage, root…) claim their space first. `all` draws every label with
   * no thinning (image export).
   */
  #drawLabels(context, { camera, width, height, all = false }) {
    this.#syncGrid();
    const zoom = camera.zoom;
    const visible = all
      ? new Set(this.#nodes.keys())
      : this.#grid.query(camera.visibleWorld(width, height, 80));
    this.stats.visibleNodes = visible.size;
    this.stats.labels = 0;
    const baseOpacity = all ? 1 : this.#labelOpacity(zoom);
    const priority = (record) =>
      record.id === this.#hovered || record.id === this.#dragged
        ? 1e9
        : record.id === this.#selected
          ? 1e8
          : this.#labelFocus.has(record.id)
            ? 1e7
            : this.#emphasis.has(record.id)
              ? 1e6
              : (record.style.labelPriority ?? 0) * 1e5 + record.width;
    const candidates = [];
    // Card nodes carry their text inside: drawn under the labels, never thinned (it can't collide).
    const cardOpacity = all ? 1 : this.#labelOpacity(zoom);
    const detail = all || zoom >= this.#labels.cardDetailZoom;
    // New cards' bitmaps are made within a time budget per frame; past it, a card's text is drawn straight onto the
    // layer this frame (cheaper once, no bitmap), so panning into a crowd of new cards never stalls a frame.
    const bitmapDeadline = all ? Infinity : performance.now() + 4;
    for (const index of visible) {
      const record = this.#nodes[index];
      if (record?.style.look !== "card") continue;
      const opacity = cardOpacity * Math.min(1, record.alpha.value * 1.2);
      if (opacity < 0.02) continue;
      const s = record.scale.value * zoom;
      const centre = camera.toScreen(record.px.value, record.py.value);
      const w = record.hw * 2 * s,
        h = (record.hh * 2 + CARD_TAG_ROOM) * s;
      const x1 = centre.x - record.hw * s,
        y1 = centre.y - (record.hh + CARD_TAG_ROOM) * s;
      if (!all && (x1 > width || x1 + w < 0 || y1 > height || y1 + h < 0))
        continue;
      context.globalAlpha = opacity;
      const { image, card } = this.#cardImage(
        record,
        s * (all ? 1 : this.dpr),
        detail,
        performance.now() < bitmapDeadline,
      );
      if (image) {
        context.drawImage(image, x1, y1, w, h);
        continue;
      }
      context.save();
      context.translate(x1, y1);
      context.scale(w / card.width, h / (card.height + CARD_TAG_ROOM));
      drawCardText(context, card, { detail });
      context.restore();
    }
    for (const index of visible) {
      const record = this.#nodes[index];
      if (!record?.style.label || record.style.look === "card") continue;
      const pinned =
        (record.style.labelPriority ?? 0) > 0 ||
        record.id === this.#hovered ||
        record.id === this.#selected ||
        this.#labelFocus.has(record.id) ||
        this.#emphasis.has(record.id);
      const opacity =
        (pinned ? 1 : baseOpacity) * Math.min(1, record.alpha.value * 1.2);
      if (opacity < 0.02) continue;
      candidates.push({ record, opacity, rank: priority(record) });
    }
    if (!all) candidates.sort((a, b) => b.rank - a.rank);
    const taken = new SpatialGrid(120);
    let takenCount = 0;
    for (const { record, opacity } of candidates) {
      const style = record.style;
      const image = this.#labelImage(style.label, {
        fontSize: style.fontSize ?? 11,
        bold: style.bold,
        color: this.#colors.labelText,
        backdrop: this.#labels.backdrop ? this.#colors.labelBackdrop : null,
        wrapWidth: this.#labels.maxWidth,
        overflow: this.#labels.overflow,
      });
      // Text is world-sized (it scales with the layout's spacing), within readable limits.
      const scale = all ? zoom : Math.min(2, Math.max(0.8, zoom));
      const w = image.width * scale,
        h = image.height * scale;
      const s = record.scale.value * zoom;
      const centre = camera.toScreen(record.px.value, record.py.value);
      const offset = labelBox(
        this.#labels.position,
        record.hw * s,
        record.hh * s,
        w,
        h,
        5 * scale,
      );
      const box = {
        x1: centre.x + offset.x1,
        y1: centre.y + offset.y1,
        x2: centre.x + offset.x2,
        y2: centre.y + offset.y2,
      };
      if (!all) {
        if (box.x1 > width || box.x2 < 0 || box.y1 > height || box.y2 < 0)
          continue;
        if (taken.query(box).size) continue;
        taken.insert(takenCount++, box);
      }
      context.globalAlpha = opacity;
      context.drawImage(image.canvas, box.x1, box.y1, w, h);
      this.stats.labels++;
    }

    // Edge labels (quantities) at each edge's midpoint, once they're big enough to read; they give way to node labels.
    for (const edge of this.#edges) {
      const style = edge.style;
      if (!style.label || !edge.points) continue;
      if (!all && (style.fontSize ?? 10) * zoom < 7.5) break;
      const alpha =
        edge.alpha.value *
        Math.min(edge.source.alpha.value, edge.target.alpha.value) *
        (all ? 1 : baseOpacity);
      if (alpha < 0.05) continue;
      const middle = pointAlong(edge.points, polylineLength(edge.points) / 2);
      const screen = camera.toScreen(middle.x, middle.y);
      if (
        !all &&
        (screen.x < -50 ||
          screen.x > width + 50 ||
          screen.y < -20 ||
          screen.y > height + 20)
      )
        continue;
      const image = this.#labelImage(style.label, {
        fontSize: style.fontSize ?? 10,
        color: this.#colors.edgeLabelText,
        backdrop: this.#colors.edgeLabelBackdrop,
      });
      const w = image.width * zoom,
        h = image.height * zoom;
      const box = {
        x1: screen.x - w / 2,
        y1: screen.y - h / 2,
        x2: screen.x + w / 2,
        y2: screen.y + h / 2,
      };
      if (!all) {
        if (taken.query(box).size) continue;
        taken.insert(takenCount++, box);
      }
      context.globalAlpha = alpha;
      context.drawImage(image.canvas, box.x1, box.y1, w, h);
    }
    context.globalAlpha = 1;
  }

  /**
   * A card's text as a bitmap (card-text.js), drawn at `pixelsPerUnit` rounded up to a power of two (between ½ and 4),
   * so zooming reuses a few sizes. Kept in a least-recently-used cache capped by pixels.
   */
  #cardImage(record, pixelsPerUnit, detail, create = true) {
    const style = record.style;
    const bucket =
      2 **
      Math.min(
        2,
        Math.max(-1, Math.ceil(Math.log2(Math.max(0.01, pixelsPerUnit)))),
      );
    const width = Math.round(record.hw * 2),
      height = Math.round(record.hh * 2);
    const colors = this.#colors;
    const card = {
      width,
      height,
      title: style.label ?? "",
      subtitle: style.subtitle,
      value: style.value,
      tag: style.tag,
      titleSize: style.fontSize ?? 12.5,
      subtitleSize: style.subtitleSize ?? 11,
      valueSize: style.valueSize ?? 12,
      textLeft:
        style.icon && (style.iconSize ?? 28) > 0
          ? (style.iconInset ?? 11) + (style.iconSize ?? 28) + 9
          : (style.stripeWidth ?? 3) + 10,
      padding: style.cardPadding ?? 10,
      text: colors.cardText,
      muted: colors.cardMuted,
      valueColor: style.valueColor ?? null,
      tagColor: style.tagColor ?? null,
      tagBackground: colors.portFill,
    };
    const key = JSON.stringify([card, bucket, detail]);
    const cache = this.#cardCache;
    let image = cache.get(key);
    if (image) {
      cache.delete(key); // most recently used goes last
      cache.set(key, image);
      return { image, card };
    }
    if (!create) return { image: null, card };
    image = document.createElement("canvas");
    image.width = Math.max(1, Math.ceil(width * bucket));
    image.height = Math.max(1, Math.ceil((height + CARD_TAG_ROOM) * bucket));
    const context = image.getContext("2d");
    context.scale(bucket, bucket);
    drawCardText(context, card, { detail });
    cache.set(key, image);
    this.#cardCachePixels += image.width * image.height;
    for (const [oldKey, old] of cache) {
      if (this.#cardCachePixels <= CARD_CACHE_PIXELS) break;
      cache.delete(oldKey);
      this.#cardCachePixels -= old.width * old.height;
      old.width = old.height = 0;
    }
    return { image, card };
  }

  #cardCache = new Map();
  #cardCachePixels = 0;

  /**
   * A label drawn once at 2× into its own canvas (with its backdrop pill or text outline), then reused:
   * { canvas, width, height } with its size in CSS pixels at zoom 1. Huge labels are drawn at less than 2×.
   */
  #labelImage(
    text,
    {
      fontSize,
      bold = false,
      color,
      backdrop,
      wrapWidth = 0,
      overflow = "wrap",
    },
  ) {
    const key = `${fontSize}|${bold}|${color}|${backdrop}|${wrapWidth}|${overflow}|${text}`;
    let image = this.#labelCache.get(key);
    if (image) return image;
    if (this.#labelCache.size > 4000) this.#labelCache.clear();
    const font = labelFont(fontSize, bold);
    const measure = (this.#measureContext ??= document
      .createElement("canvas")
      .getContext("2d"));
    measure.font = font;
    const { lines, lineHeight, width, height } = layoutLabel(
      text,
      { fontSize, wrapWidth, overflow },
      (t) => measure.measureText(t).width,
    );
    const padX = LABEL_PAD_X,
      padY = LABEL_PAD_Y;
    const canvas = document.createElement("canvas");
    const bitmapScale = labelBitmapScale(width, height, LABEL_RENDER_SCALE);
    canvas.width = Math.max(1, Math.ceil(width * bitmapScale));
    canvas.height = Math.max(1, Math.ceil(height * bitmapScale));
    image = { canvas, width, height };
    const context = canvas.getContext("2d");
    context.scale(bitmapScale, bitmapScale);
    context.font = font;
    context.textBaseline = "middle";
    if (backdrop) {
      context.fillStyle = backdrop;
      context.beginPath();
      context.roundRect(0, 0, width, height, Math.min(6, height / 2));
      context.fill();
    } else {
      context.strokeStyle = this.#colors.labelBackdrop;
      context.lineWidth = 3;
      context.lineJoin = "round";
      lines.forEach((line, i) =>
        context.strokeText(line, padX, padY + lineHeight * (i + 0.5)),
      );
    }
    context.fillStyle = color;
    lines.forEach((line, i) =>
      context.fillText(line, padX, padY + lineHeight * (i + 0.5)),
    );
    this.#labelCache.set(key, image);
    return image;
  }

  // ---------------------------------------------------------------- export

  /**
   * The whole graph as a canvas at `scale` (world units → pixels), every label drawn, over `background` (a CSS
   * colour; null or "transparent" for none). It's drawn as it is on screen right now (mid-transition included).
   * Rendered in tiles, so it can be larger than the GPU's own limits; `scale` shrinks to keep it within `maxSide` and
   * `maxPixels`. Throws when the GPU context is lost or the browser can't make a canvas that big.
   */
  renderToCanvas({
    scale = 1,
    background = null,
    padding = 30,
    maxSide = 16000,
    maxPixels = MAX_EXPORT_PIXELS,
  } = {}) {
    const gl = this.gl;
    if (this.#destroyed || gl.isContextLost())
      throw new Error("The graph can't be drawn: its WebGL context is gone");
    const stats = { ...this.stats }; // the export isn't a frame: leave the on-screen numbers alone
    this.#flushAtlas();
    this.#syncGeometry();
    const nodeBounds = this.#liveBounds();
    const labelRoom = this.#labels.maxWidth + 20;
    const bounds = {
      x1:
        nodeBounds.x1 -
        padding -
        (this.#labels.position === "left" ? labelRoom : 0),
      y1: nodeBounds.y1 - padding - 30,
      x2:
        nodeBounds.x2 +
        padding +
        (this.#labels.position === "right" ? labelRoom : 0),
      y2:
        nodeBounds.y2 + padding + (this.#labels.position === "below" ? 50 : 0),
    };
    const boundsW = bounds.x2 - bounds.x1,
      boundsH = bounds.y2 - bounds.y1;
    scale = Math.min(
      scale,
      maxSide / boundsW,
      maxSide / boundsH,
      Math.sqrt(maxPixels / (boundsW * boundsH)),
    );
    if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
    const sizeAt = (s) => [
      Math.max(1, Math.ceil(boundsW * s)),
      Math.max(1, Math.ceil(boundsH * s)),
    ];
    let [width, height] = sizeAt(scale);
    // Rounding up can push it just over.
    while (width * height > maxPixels && width * height > 1)
      [width, height] = sizeAt((scale *= 0.995));
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d");
    if (!context)
      throw new Error(`Couldn't make a ${width} × ${height} canvas to draw on`);

    const tile = Math.min(2048, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      tile,
      tile,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    // Cleared to the background, premultiplied (the readback below undoes that).
    const [br, bg, bb, ba] = background
      ? parseColorAlpha(background)
      : [0, 0, 0, 0];
    const pixels = new Uint8Array(tile * tile * 4);
    const camera = new Camera({ minZoom: 0, maxZoom: Infinity });
    camera.zoom = scale;
    try {
      for (let ty = 0; ty < height; ty += tile)
        for (let tx = 0; tx < width; tx += tile) {
          const w = Math.min(tile, width - tx),
            h = Math.min(tile, height - ty);
          camera.panX = -bounds.x1 * scale - tx;
          camera.panY = -bounds.y1 * scale - ty;
          gl.viewport(0, 0, w, h);
          gl.clearColor(br * ba, bg * ba, bb * ba, ba);
          gl.clear(gl.COLOR_BUFFER_BIT);
          this.#drawScene({
            camera,
            width: w,
            height: h,
            pixelRatio: 1,
            lineScale: scale,
          });
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const imageData = context.createImageData(w, h);
          for (let row = 0; row < h; row++) {
            const from = (h - 1 - row) * w * 4; // GL rows run bottom-up
            for (let i = 0; i < w * 4; i += 4) {
              const alpha = pixels[from + i + 3];
              const unpremultiply = alpha ? 255 / alpha : 0;
              const to = row * w * 4 + i;
              imageData.data[to] = Math.min(
                255,
                pixels[from + i] * unpremultiply,
              );
              imageData.data[to + 1] = Math.min(
                255,
                pixels[from + i + 1] * unpremultiply,
              );
              imageData.data[to + 2] = Math.min(
                255,
                pixels[from + i + 2] * unpremultiply,
              );
              imageData.data[to + 3] = alpha;
            }
          }
          context.putImageData(imageData, tx, ty);
        }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    }
    camera.panX = -bounds.x1 * scale;
    camera.panY = -bounds.y1 * scale;
    this.#drawLabels(context, { camera, width, height, all: true });
    Object.assign(this.stats, stats);
    this.requestRender(); // the screen's framebuffer was left alone, but redraw to be safe
    return output;
  }

  /**
   * World box around what's drawn right now: live nodes and ghosts where they are (at their current scale), and the
   * edges between them.
   */
  #liveBounds() {
    const points = [];
    for (const r of [...this.#nodes, ...this.#ghosts]) {
      const hw = r.hw * r.scale.value,
        hh = r.hh * r.scale.value;
      points.push(
        { x: r.px.value - hw, y: r.py.value - hh },
        { x: r.px.value + hw, y: r.py.value + hh },
      );
    }
    for (const edge of this.#edges)
      if (edge.points) points.push(...edge.points);
    return points.length
      ? pointsBounds(points)
      : { x1: 0, y1: 0, x2: 1, y2: 1 };
  }

  // ---------------------------------------------------------------- input

  #nodeAt(event) {
    this.#syncGrid();
    const rect = this.canvas.getBoundingClientRect();
    const world = this.camera.toWorld(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    const index = this.#grid.hit(
      world.x,
      world.y,
      (i) => this.#nodes[i].style.events !== false,
    );
    return index >= 0 ? this.#nodes[index] : null;
  }

  #setHovered(record, event) {
    const id = record?.id ?? null;
    if (id === this.#hovered) return;
    const previous = this.#hovered && this.#byId.get(this.#hovered);
    this.#hovered = id;
    if (previous) this.#retargetNode(previous);
    if (record) this.#retargetNode(record);
    this.canvas.style.cursor = record
      ? this.#input.draggable
        ? "grab"
        : "pointer"
      : "";
    this.handlers.onNodeHover?.(id, event);
    this.requestRender();
  }

  /**
   * End a drag under way, if there is one (the pointer let go, a second finger came down, the node was removed): the
   * node settles and onNodeDragEnd is called. What's left of the press does nothing more.
   */
  #endDrag(cursor = "") {
    const gesture = this.#gesture;
    if (gesture?.kind !== "drag") return;
    this.#gesture = { kind: "done" };
    this.#dragged = null;
    this.#retargetNode(gesture.record);
    this.canvas.style.cursor = cursor;
    this.handlers.onNodeDragEnd?.(gesture.record.id);
  }

  #bindInput() {
    const canvas = this.canvas;
    const pointers = new Map(); // the (at most two) pointers down: id → where
    let lastTap = { id: null, at: 0 };
    let samples = []; // recent pan moves for the glide

    const local = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.#stopCamera();
        const unit =
          event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        const pixels = Math.max(-240, Math.min(240, event.deltaY * unit));
        const boost = event.ctrlKey ? 5 : 1; // trackpad pinch arrives as ctrl+wheel with small deltas
        const factor = Math.exp(
          -pixels * 0.0018 * this.#input.zoomSpeed * boost,
        );
        const point = local(event);
        if (!this.#input.smoothZoom) {
          this.camera.zoomAround(factor, point.x, point.y);
          this.#viewportChanged();
          return;
        }
        // Smooth zoom: aim for a target and ease toward it.
        const base = this.#zoomTarget?.zoom ?? this.camera.zoom;
        this.#zoomTarget = {
          zoom: Math.min(
            this.camera.maxZoom,
            Math.max(this.camera.minZoom, base * factor),
          ),
          ...point,
        };
        this.requestRender();
      },
      { passive: false },
    );

    canvas.addEventListener("contextmenu", (event) => {
      const record = this.#nodeAt(event);
      if (!record) return;
      event.preventDefault();
      this.handlers.onNodeContextTap?.(record.id, event);
    });

    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if (pointers.size >= 2) return; // a third finger: pinching takes two
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone (cancelled, or a synthetic event): carry on without capture.
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.#stopCamera();
      this.#zoomTarget = null;
      clearTimeout(this.#longPress);
      if (pointers.size === 2) {
        this.#endDrag(); // a second finger turns a drag into a pinch: the drag ends properly first
        const [a, b] = [...pointers.values()];
        this.#gesture = {
          kind: "pinch",
          distance: Math.hypot(a.x - b.x, a.y - b.y),
        };
        return;
      }
      const record = this.#nodeAt(event);
      const start = { x: event.clientX, y: event.clientY };
      samples = [];
      if (record) {
        const world = this.camera.toWorld(local(event).x, local(event).y);
        this.#gesture = {
          kind: "node",
          record,
          start,
          grab: { x: world.x - record.px.value, y: world.y - record.py.value },
        };
        if (event.pointerType !== "mouse")
          this.#longPress = setTimeout(() => {
            if (this.#gesture?.kind !== "node") return;
            this.#gesture = { kind: "done" };
            this.handlers.onNodeContextTap?.(record.id, event);
          }, this.#input.longPressMs);
      } else this.#gesture = { kind: "pan", start };
    });

    canvas.addEventListener("pointermove", (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) {
        if (pointers.size) return; // another finger, beyond the two in play
        this.handlers.onPointerMove?.(event);
        this.#setHovered(this.#nodeAt(event), event);
        return;
      }
      const current = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, current);
      let gesture = this.#gesture;
      if (!gesture) return;
      if (gesture.kind === "pinch" && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = canvas.getBoundingClientRect();
        if (gesture.distance)
          this.camera.zoomAround(
            distance / gesture.distance,
            (a.x + b.x) / 2 - rect.left,
            (a.y + b.y) / 2 - rect.top,
          );
        gesture.distance = distance;
        this.#viewportChanged();
        return;
      }
      const moved = Math.hypot(
        current.x - gesture.start?.x,
        current.y - gesture.start?.y,
      );
      const threshold =
        this.#input.dragThreshold[event.pointerType] ??
        this.#input.dragThreshold.mouse;
      if (gesture.kind === "node" && moved > threshold) {
        clearTimeout(this.#longPress);
        if (this.#input.draggable && gesture.record.style.events !== false) {
          gesture.kind = "drag";
          this.#dragged = gesture.record.id;
          this.#setHovered(null, event);
          this.#retargetNode(gesture.record);
          canvas.style.cursor = "grabbing";
          this.handlers.onNodeDragStart?.(gesture.record.id);
        } else gesture = this.#gesture = { kind: "pan", start: gesture.start };
      }
      if (gesture.kind === "drag") {
        const point = local(event);
        const world = this.camera.toWorld(point.x, point.y);
        const x = world.x - gesture.grab.x,
          y = world.y - gesture.grab.y;
        gesture.record.px.snap(x);
        gesture.record.py.snap(y);
        this.#touched.add(gesture.record);
        this.#gridMoved.add(gesture.record);
        this.handlers.onNodeDrag?.(gesture.record.id, x, y);
        this.requestRender();
      } else if (gesture.kind === "pan") {
        const dx = current.x - previous.x,
          dy = current.y - previous.y;
        if (moved > threshold) gesture.moved = true;
        this.camera.panBy(dx, dy);
        const now = performance.now();
        samples.push({ at: now, dx, dy });
        samples = samples.filter((sample) => now - sample.at < FLICK_WINDOW_MS);
        this.#viewportChanged();
      }
    });

    const finish = (event, cancelled) => {
      if (!pointers.delete(event.pointerId)) return; // not one of ours (a third finger)
      clearTimeout(this.#longPress);
      const ended = this.#gesture;
      if (!ended) return;
      if (ended.kind === "pinch") {
        if (pointers.size === 0) this.#gesture = null;
        return;
      }
      if (ended.kind === "drag") {
        this.#endDrag("grab");
        this.#gesture = null;
        return;
      }
      this.#gesture = null;
      if (cancelled || ended.kind === "done") return;
      if (ended.kind === "pan") {
        if (ended.moved) {
          // Let go mid-flick: the view glides on and slows down.
          const velocity =
            this.#motion.enabled && this.#input.panInertia > 0
              ? flickVelocity(
                  samples,
                  performance.now(),
                  this.#input.flickMinSpeed,
                )
              : null;
          if (velocity) {
            this.#glide = velocity;
            this.requestRender();
          }
          return;
        }
        this.handlers.onBackgroundTap?.();
        return;
      }
      // A tap on a node.
      const id = ended.record.id;
      const now = performance.now();
      if (lastTap.id === id && now - lastTap.at < this.#input.doubleTapMs) {
        lastTap = { id: null, at: 0 };
        this.handlers.onNodeDoubleTap?.(id, event);
      } else {
        lastTap = { id, at: now };
        this.handlers.onNodeTap?.(id, event);
      }
    };
    canvas.addEventListener("pointerup", (event) => finish(event, false));
    canvas.addEventListener("pointercancel", (event) => finish(event, true));
    canvas.addEventListener("pointerleave", (event) => {
      if (!pointers.has(event.pointerId)) this.#setHovered(null, null);
    });
  }
}

/**
 * The glide velocity (px/s) for letting go of a pan at `now`, from its recent moves ({ at, dx, dy }), or null for no
 * glide. Only moves in the last FLICK_WINDOW_MS count, so holding still before letting go stops the view.
 */
export function flickVelocity(
  samples,
  now,
  minSpeed = DEFAULT_INPUT.flickMinSpeed,
) {
  const recent = samples.filter((sample) => now - sample.at < FLICK_WINDOW_MS);
  const span = recent.length > 1 ? recent.at(-1).at - recent[0].at : 0;
  if (span <= 10) return null;
  // The first move happened before the span starts, so it isn't part of it.
  const dx = recent.slice(1).reduce((sum, s) => sum + s.dx, 0),
    dy = recent.slice(1).reduce((sum, s) => sum + s.dy, 0);
  const vx = (dx / span) * 1000,
    vy = (dy / span) * 1000;
  return Math.hypot(vx, vy) > minSpeed ? { vx, vy } : null;
}

/** `value` when it's a finite number, else `fallback`. */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
