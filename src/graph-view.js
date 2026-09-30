import {
  Emitter,
  LayoutGraph,
  LivePhysics,
  runLayout,
  flowOf,
  uniqueById,
} from "./layout/index.js";
import { WebGLGraph } from "./render/webgl-graph.js";
import { planTransition } from "./render/transition-plan.js";
import { labelBox, labelFont, layoutLabel } from "./render/labels.js";
import { resolveOptions } from "./options.js";
import {
  RENDERER_COLOR_KEYS,
  resolveEdgeStyle,
  resolveFlowAxis,
  resolveLabelPosition,
  resolveNodeStyle,
  resolveRouting,
  resolveTheme,
} from "./style.js";

/**
 * @typedef {{ id: string, label?: string, color?: string, icon?: string, classes?: string[] | string,
 *             root?: boolean, style?: import('./style.js').NodeRule, [data: string]: any }} GraphNode
 *   style: this node's own style overrides (any NodeStyle field); other fields are yours (the style hooks see them)
 * @typedef {{ id?: string, source: string, target: string, label?: string, sourceColor?: string,
 *             targetColor?: string, classes?: string[] | string, style?: import('./style.js').EdgeRule,
 *             [data: string]: any }} GraphEdge
 * @typedef {{ zoom: number, panX: number, panY: number }} Viewport
 *   the camera: a graph point (x, y) is drawn at (x × zoom + panX, y × zoom + panY) CSS pixels
 */

/**
 * The events a GraphView emits (view.on(type, listener) returns an unsubscribe function):
 * @typedef {object} GraphViewEvents
 * @property {[{ id: string, originalEvent: PointerEvent }]} nodeTap
 * @property {[{ id: string, originalEvent: PointerEvent }]} nodeDoubleTap
 * @property {[{ id: string, originalEvent: PointerEvent }]} nodeContextTap  right click or long press
 * @property {[{ originalEvent?: PointerEvent }]} backgroundTap
 * @property {[{ id: string, originalEvent: PointerEvent }]} nodeHoverStart
 * @property {[{}]} nodeHoverEnd
 * @property {[{ originalEvent: PointerEvent }]} pointerMove
 * @property {[{ viewport: Viewport }]} viewportChange  pan or zoom (every frame while it moves)
 * @property {[{ id: string }]} dragStart
 * @property {[{ id: string, x: number, y: number }]} drag  the held node moved (graph coordinates)
 * @property {[{ id: string }]} dragEnd
 * @property {[{ reason: string }]} physicsStart  "drag", "shake" or "float-in"
 * @property {[{}]} physicsSettle  the physics went still
 * @property {[{ nodeCount: number, edgeCount: number, layoutMs: number }]} render  after render()
 * @property {[{ id: string | null }]} select
 * @property {[{ changed: string[] }]} optionsChange
 * @property {[{ changed: string[] }]} themeChange
 * @property {[{}]} destroy
 */

/** Options that change every node's box: changing one lays the graph out again. */
const RELAYOUT_OPTIONS = new Set(["nodeLook", "cardWidth", "cardHeight"]);

/** Handler names (the constructor's `handlers`) → the event they listen to. */
const HANDLER_EVENTS = {
  onNodeTap: "nodeTap",
  onNodeDoubleTap: "nodeDoubleTap",
  onNodeContextTap: "nodeContextTap",
  onBackgroundTap: "backgroundTap",
  onNodeHoverStart: "nodeHoverStart",
  onNodeHoverEnd: "nodeHoverEnd",
  onPointerMove: "pointerMove",
  onViewportChange: "viewportChange",
};

/**
 * Prismatrix's graphing engine: give it nodes and edges, and it styles them (style.js) and draws them (render/), then
 * handles everything after: morphing to the next graph, hover lineage, selection, highlights, fitting and PNG export.
 * Prismatrix does all the physics: it lays the graph out, and moves nodes when one is dragged (LivePhysics); this view
 * passes it the pointer's moves and draws the positions it returns.
 *
 * Edges run parent → child, from the root outward. The root is the node with `root: true`, or else the first node.
 *
 *   const view = new GraphView({ container, options: { direction: "LR" } });
 *   view.on("nodeTap", ({ id }) => view.select(id));
 *   view.render({ nodes, edges, fit: true });
 *
 * Options and theme are checked against their schemas (options.js, style.js): bad values are clamped or replaced by
 * their defaults with a warning, or throw with `strict: true`.
 * @extends {Emitter<GraphViewEvents>}
 */
export class GraphView extends Emitter {
  #options;
  #theme;
  #strict;
  #canvasWrapper;
  #classStyles = {};
  /** What's drawn: id → { data, classes: Set }, and the edges with their ends. */
  #nodes = new Map();
  #edges = new Map();
  /** child → parent in the graph on screen, so removed nodes can fold into their parents. */
  #parentOf = new Map();
  #outgoing = new Map();
  #incoming = new Map();
  /** Prismatrix moves the nodes after the layout (drags, shakes, floating in); this view draws what it returns. */
  #physics;
  /** Stops the per-frame loop that steps the physics, while one runs. */
  #stopTicker = null;
  #hoverTimer = 0;
  #pinnedNodeId = null;
  /** The node held by a drag (pointer or beginDrag), so a render mid-drag can hand it to the new layout. */
  #heldId = null;
  #lineage = { nodeId: null, isPinned: false, dimmed: null };
  #highlightIds = null;
  #flashIds = null;
  #flashTimer = 0;
  #pendingFit = false;
  #resizeObserver;

  /**
   * @param {{ container: HTMLElement, canvasWrapper?: HTMLElement,
   *           options?: Partial<import('./options.js').Options>, theme?: Partial<import('./style.js').Theme>,
   *           tuning?: Partial<import('./layout/index.js').Tuning>, classStyles?: import('./style.js').ClassRules,
   *           handlers?: Partial<Record<keyof typeof HANDLER_EVENTS, Function>>, strict?: boolean,
   *           rendererOptions?: { preserveDrawingBuffer?: boolean, badgeUrl?: string, colors?: object } }} config
   *   handlers: a shortcut for on(): onNodeTap(id, event), onNodeDoubleTap(id, event), onNodeContextTap(id, event),
   *   onBackgroundTap(), onNodeHoverStart(id, event), onNodeHoverEnd(), onPointerMove(event), onViewportChange()
   *   canvasWrapper: the element whose CSS background follows pan and zoom (see syncBackground)
   *   tuning: Prismatrix's constants for this view (see setPhysicsTuning)
   *   strict: invalid options and theme colours throw instead of warning
   *   rendererOptions.colors: theme colours (older name; pass them in `theme`)
   */
  constructor({
    container,
    canvasWrapper,
    options = {},
    theme = {},
    tuning,
    classStyles,
    handlers = {},
    strict = false,
    rendererOptions = {},
  }) {
    super();
    this.#strict = strict;
    this.#options = resolveOptions(options, { strict });
    this.#physics = new LivePhysics(this.#options);
    if (tuning) this.#physics.tuning = tuning;
    this.#physics.on("start", ({ reason }) =>
      this.emit("physicsStart", { reason }),
    );
    this.#physics.on("settle", () => this.emit("physicsSettle", {}));
    const { colors = {}, ...renderer } = rendererOptions;
    this.#theme = resolveTheme({ ...colors, ...theme }, { strict });
    if (classStyles) this.#classStyles = classStyles;
    this.#canvasWrapper = canvasWrapper ?? null;
    // The old handlers object: each one listens to its event, called the old way (positional arguments).
    for (const [name, handler] of Object.entries(handlers ?? {})) {
      const type = HANDLER_EVENTS[name];
      if (!type || typeof handler !== "function") continue;
      this.on(type, (detail) =>
        "id" in detail
          ? handler(detail.id, detail.originalEvent)
          : type === "pointerMove"
            ? handler(detail.originalEvent)
            : handler(),
      );
    }
    this.graph = new WebGLGraph(
      container,
      {
        onNodeTap: (id, event) =>
          this.emit("nodeTap", { id, originalEvent: event }),
        onNodeDoubleTap: (id, event) =>
          this.emit("nodeDoubleTap", { id, originalEvent: event }),
        onNodeContextTap: (id, event) =>
          this.emit("nodeContextTap", { id, originalEvent: event }),
        onBackgroundTap: (event) =>
          this.emit("backgroundTap", { originalEvent: event }),
        onNodeHover: (id, event) =>
          id
            ? this.emit("nodeHoverStart", { id, originalEvent: event })
            : this.emit("nodeHoverEnd", {}),
        onPointerMove: (event) =>
          this.emit("pointerMove", { originalEvent: event }),
        onViewportChange: () => this.#onViewportChange(),
        onNodeDragStart: (id) => this.#grab(id),
        onNodeDrag: (id, x, y) => this.#drag(id, x, y),
        onNodeDragEnd: (id) => this.#release(id),
      },
      { ...renderer, colors: this.#rendererColors() },
    );
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#pendingFit && container.clientWidth) this.fit();
    });
    this.#resizeObserver.observe(container);
    this.#applyOptions();
    this.syncBackground();
  }

  /** The options in effect (a copy). */
  get options() {
    return { ...this.#options };
  }

  /**
   * Change any options (checked: see options.js). Looks apply at once, node sizes (nodeSizeScale, rootSizeScale)
   * and label wrapping included; layout and physics options (layout, direction, layered, physicsMode, the forces)
   * apply from the next render(), as does the room the layout leaves for the new sizes and labels.
   * @param {Partial<import('./options.js').Options>} patch
   */
  setOptions(patch) {
    const next = resolveOptions(patch, {
      base: this.#options,
      strict: this.#strict,
    });
    const changed = Object.keys(next).filter(
      (key) => next[key] !== this.#options[key],
    );
    if (!changed.length) return;
    // In place: Prismatrix's LivePhysics reads this same object on every grab.
    Object.assign(this.#options, next);
    this.#applyOptions();
    this.#restyle();
    this.#showPinnedLineage({ force: true });
    this.syncBackground();
    this.emit("optionsChange", { changed });
    // A new node look (or card size) changes every box: lay the graph out again, morphing into it.
    if (changed.some((key) => RELAYOUT_OPTIONS.has(key)) && this.#nodes.size)
      this.relayout();
  }

  /**
   * Lay the graph on screen out again, morphing into the new layout (for example after changing layout options,
   * which otherwise apply from the next render()). The view stays where it is.
   */
  relayout() {
    if (!this.#nodes.size) return;
    this.render({
      nodes: [...this.#nodes.values()].map(({ data }) => data),
      edges: [...this.#edges.values()].map(({ data }) => data),
    });
  }

  /** Put options back to their defaults: these keys, or all of them. */
  resetOptions(keys) {
    const defaults = resolveOptions({});
    this.setOptions(
      Object.fromEntries(
        (keys ?? Object.keys(defaults)).map((key) => [key, defaults[key]]),
      ),
    );
  }

  /** The theme in effect (a copy). */
  get theme() {
    return { ...this.#theme };
  }

  /**
   * Change any theme colours (checked: see style.js THEME_SCHEMA).
   * @param {Partial<import('./style.js').Theme>} patch
   */
  setTheme(patch) {
    const next = resolveTheme(patch, {
      base: this.#theme,
      strict: this.#strict,
    });
    const changed = Object.keys(next).filter(
      (key) => next[key] !== this.#theme[key],
    );
    if (!changed.length) return;
    this.#theme = next;
    this.graph.setColors(this.#rendererColors());
    this.#restyle();
    this.#syncEmphasis();
    this.#showPinnedLineage({ force: true });
    this.emit("themeChange", { changed });
  }

  /** The theme colours the renderer draws with itself. */
  #rendererColors() {
    return Object.fromEntries(
      RENDERER_COLOR_KEYS.map((key) => [key, this.#theme[key]]),
    );
  }

  get rootNodeId() {
    for (const [id, node] of this.#nodes)
      if (node.classes.has("root")) return id;
    return undefined;
  }

  /**
   * Looks for the caller's own classes (see style.js): any NodeStyle or EdgeStyle field, per class, applied in order.
   * { nodes: { className: { ring: "#ffd166", size: 60, shape: "hexagon", … } }, edges: { className: { … } } }
   * @param {import('./style.js').ClassRules} rules
   */
  setClassStyles(rules) {
    this.#classStyles = rules ?? {};
    this.#restyle();
  }

  // ---------------------------------------------------------------- rendering

  /**
   * Replace the graph, morphing from the previous one: survivors glide to their new places, new nodes grow out of
   * their nearest surviving ancestor (level by level from the root for a new graph), removed ones fold into theirs.
   * @param {{ nodes: GraphNode[], edges: GraphEdge[], fit?: boolean | "smart", anchorNodeId?: string | null,
   *           grow?: boolean }} graph
   *   fit: fit the view to the graph ("smart": but open on the root when that would be too small to read)
   *   anchorNodeId: keep this node where it is on screen
   *   grow: a new graph (nothing morphs from the previous one; it grows out of its root)
   */
  render({ nodes, edges, fit = false, anchorNodeId = null, grow = false }) {
    const started = performance.now();
    // Ids are unique: the first of each is kept (with a warning). An edge's id is its `id`, or "source->target".
    nodes = uniqueById(nodes, "Prismatrix: render() nodes");
    edges = uniqueById(
      edges.map((edge) => ({ ...edge, id: edgeId(edge) })),
      "Prismatrix: render() edges (give parallel edges their own ids)",
    );
    const o = this.#options;
    const graph = this.graph;
    this.#clearTimers();
    this.#stopPhysics();
    this.#lineage = { nodeId: null, isPinned: false, dimmed: null };
    this.#highlightIds = this.#flashIds = null;

    const rootId = (nodes.find((node) => node.root) ?? nodes[0])?.id;
    const previous = new Map(
      grow ? [] : graph.nodeIds().map((id) => [id, graph.positionOf(id)]),
    );
    const anchorScreen =
      anchorNodeId && previous.has(anchorNodeId)
        ? graph.screenPositionOf(anchorNodeId)
        : null;
    const parentOf = new Map(edges.map((edge) => [edge.target, edge.source]));
    const plan = planTransition({
      previous,
      nodeIds: nodes.map((node) => node.id),
      parentOf,
      previousParentOf: this.#parentOf,
      rootId,
    });
    this.#parentOf = parentOf;

    this.#resolvedStyles.clear();
    this.#nodes = new Map(
      nodes.map((node) => {
        const classes = classSet(node.classes);
        if (node.id === rootId) classes.add("root");
        return [node.id, { data: node, classes }];
      }),
    );
    this.#edges = new Map(
      edges.map((edge) => {
        const id = edgeId(edge);
        return [
          id,
          {
            data: edge,
            classes: classSet(edge.classes),
            source: edge.source,
            target: edge.target,
          },
        ];
      }),
    );
    this.#indexEdges();

    // Lay out, seeded with where things are now (the physics continues from there).
    const styles = new Map(
      nodes.map((node) => [node.id, this.#nodeStyle(node.id)]),
    );
    const layoutGraph = new LayoutGraph(
      nodes.map(({ id }) => {
        const style = styles.get(id);
        const start = plan.startOf(id) ?? { x: 0, y: 0 };
        return {
          id,
          w: style.width,
          h: style.height,
          ...this.#footprint(style),
          x: start.x,
          y: start.y,
          root: id === rootId,
        };
      }),
      edges.map(({ source, target }) => ({ source, target })),
    );
    // Floating graphs can float into place: shown at their seed layout, then settled live (after setGraph, below).
    const floatIn =
      o.physicsMode === "floating" &&
      this.#physics.tuning.floatIn &&
      o.animationsEnabled &&
      nodes.length <= o.maxAnimatedNodes;
    this.#physics.simulation = runLayout(layoutGraph, o, {
      tuning: this.#physics.tuning,
      settle: !floatIn,
    });
    const layoutMs = performance.now() - started;

    const finalPositions = new Map();
    const placed = layoutGraph.ids.map((id, i) => {
      const position = { x: layoutGraph.x[i], y: layoutGraph.y[i] };
      finalPositions.set(id, position);
      const style = styles.get(id);
      return {
        id,
        ...position,
        width: style.width,
        height: style.height,
        style,
      };
    });
    const animate =
      o.animationsEnabled &&
      placed.length <= o.maxAnimatedNodes &&
      graph.width > 0;
    const duration = o.animationDuration;
    const stagger =
      grow && o.growNewGraphs && placed.length <= o.maxStaggeredNodes;
    const depths = stagger ? this.#depthsFrom(rootId) : null;
    const delays = new Map();
    const spawnFrom = new Map();
    for (const { id } of placed) {
      if (grow) spawnFrom.set(id, finalPositions.get(rootId));
      else if (!previous.has(id)) spawnFrom.set(id, plan.startOf(id));
      if (stagger)
        delays.set(
          id,
          Math.min(
            (depths.get(id) ?? 0) * duration * o.growStagger,
            duration * o.growMaxDelay,
          ),
        );
    }
    graph.setGraph(
      {
        nodes: placed,
        edges: [...this.#edges].map(([id, edge]) => ({
          id,
          source: edge.source,
          target: edge.target,
          style: this.#edgeStyle(id),
        })),
        ...this.#routing(),
      },
      {
        animate,
        spawnFrom,
        delays,
        ghostTo: plan.ghostDestinations(finalPositions, anchorNodeId),
      },
    );
    graph.setDimmed(null);
    graph.setEmphasis(null);
    graph.setEdgeEmphasis(null);
    graph.setLabelFocus(null);

    const view = this.#targetView({ fit, anchorNodeId, anchorScreen });
    if (view) graph.moveCamera(view, { animate });
    if (floatIn && this.#physics.floatIn()) this.#drive();
    // A node still held (a drag through the render) is handed to the new layout, which the rest of the graph rests on
    // from now; if the node went, setGraph let go of it.
    if (this.#heldId != null && this.#nodes.has(this.#heldId))
      this.#grab(this.#heldId, { fromLayout: true });
    // The selection survives a render when its node does: so does its lineage.
    if (this.#pinnedNodeId && !this.#nodes.has(this.#pinnedNodeId))
      this.#pinnedNodeId = null;
    this.#showPinnedLineage();
    this.emit("render", {
      nodeCount: this.#nodes.size,
      edgeCount: this.#edges.size,
      layoutMs,
    });
  }

  /** Links from the root to each node, following edges (for growing a new graph level by level). */
  #depthsFrom(rootId) {
    const depths = new Map([[rootId, 0]]);
    const queue = [rootId];
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      for (const edgeId of this.#outgoing.get(id) ?? []) {
        const next = this.#edges.get(edgeId).target;
        if (depths.has(next)) continue;
        depths.set(next, depths.get(id) + 1);
        queue.push(next);
      }
    }
    return depths;
  }

  // ---------------------------------------------------------------- physics (the layout layer)

  /**
   * Prismatrix's constants (TUNING_SCHEMA) for this view, checked; everything not given goes back to its default.
   * Applies to what's running too; layout constants apply from the next render().
   * @param {Partial<import('./layout/index.js').Tuning>} tuning
   */
  setPhysicsTuning(tuning) {
    this.#physics.tuning = tuning;
  }

  get physicsTuning() {
    return this.#physics.tuning;
  }

  /** The layout's force simulation (for developer tools: its alpha, positions, tuning). */
  get simulation() {
    return this.#physics.simulation;
  }

  /** The elastic net while a node is held and until it settles, or null (for developer tools). */
  get elasticNet() {
    return this.#physics.elasticNet;
  }

  /**
   * Drag a node from code, the way a pointer drag does (the same physics, either mode): for developer tools and
   * tests. Returns { move(x, y), end() } in world coordinates.
   */
  beginDrag(id) {
    const start = this.graph.livePositionOf(id);
    if (!start) return null;
    this.#grab(id);
    return {
      move: (x, y) => {
        this.graph.moveNodes([[id, x, y]]);
        this.#drag(id, x, y);
      },
      end: () => this.#release(id),
    };
  }

  /**
   * Shake the physics and watch it settle: optionally scatter every node by up to `scatter` world units, heat the
   * simulation to `heat` (0..1) and let it cool, animated. Returns false when the layout has no simulation.
   */
  settle({ heat = 0.6, scatter = 0 } = {}) {
    this.#stopPhysics();
    if (!this.#physics.shake(this.#positionOf, { heat, scatter })) return false;
    this.#drive();
    return true;
  }

  /** Is the physics running live (a drag, settle(), floating in)? */
  get physicsRunning() {
    return !!this.#stopTicker;
  }

  /** Stop any live physics (a drag settling, settle(), floating in). */
  stopPhysics() {
    this.#stopPhysics();
  }

  #stopPhysics() {
    this.#stopTicker?.();
    this.#physics.stop();
  }

  #positionOf = (id) => this.graph.livePositionOf(id);

  /**
   * @param {string} id
   * @param {{ fromLayout?: boolean }} [how]  fromLayout: the other nodes start from the layout, not the screen
   */
  #grab(id, { fromLayout = false } = {}) {
    this.#heldId = id;
    this.#stopPhysics();
    if (!fromLayout) this.emit("dragStart", { id });
    this.#physics.grab(id, {
      ids: this.graph.nodeIds(),
      links: [...this.#edges.values()],
      positionOf: fromLayout
        ? (nodeId) =>
            nodeId === id
              ? this.graph.livePositionOf(nodeId)
              : this.graph.positionOf(nodeId)
        : this.#positionOf,
    });
    this.#drive();
  }

  #drag(id, x, y) {
    this.#physics.drag(id, { x, y });
    this.#drive();
    if (this.hasListeners("drag")) this.emit("drag", { id, x, y });
  }

  #release(id) {
    const wasHeld = this.#heldId === id;
    if (wasHeld) this.#heldId = null;
    this.#physics.release(id);
    this.#drive();
    if (wasHeld) this.emit("dragEnd", { id });
  }

  /**
   * Step Prismatrix every frame while anything moves, drawing what moved, and stop when it's still (a node held still
   * costs nothing); the next drag, release or shake starts it again.
   */
  #drive() {
    if (this.#stopTicker || !this.#physics.active) return;
    const stop = this.graph.addTicker(() => {
      const { moving, moved } = this.#physics.step();
      if (moved.length) this.graph.moveNodes(moved);
      if (moving) return true;
      this.#stopTicker = null;
      return false;
    });
    this.#stopTicker = () => {
      stop();
      this.#stopTicker = null;
    };
  }

  /** Remove everything: no nodes, no running animation or physics, no selection, highlight or flash. */
  clear() {
    this.#clearTimers();
    this.#stopPhysics();
    this.#physics.simulation = null;
    this.#lineage = { nodeId: null, isPinned: false, dimmed: null };
    this.#pinnedNodeId = null;
    this.#highlightIds = this.#flashIds = null;
    this.#resolvedStyles.clear();
    this.#nodes = new Map();
    this.#edges = new Map();
    this.#parentOf = new Map();
    this.#indexEdges();
    this.graph.setGraph({ nodes: [], edges: [] });
    this.graph.select(null);
    this.graph.setDimmed(null);
    this.graph.setEmphasis(null);
    this.graph.setEdgeEmphasis(null);
    this.graph.setLabelFocus(null);
  }

  /** Stop everything and remove the canvases. Listeners hear "destroy", then are all removed. */
  destroy() {
    this.#clearTimers();
    this.#stopPhysics();
    this.#physics.removeAllListeners();
    cancelAnimationFrame(this.#viewportFrame);
    this.#resizeObserver.disconnect();
    this.graph.destroy();
    this.emit("destroy", {});
    this.removeAllListeners();
  }

  /**
   * New labels, colours and classes without a re-layout (e.g. new data arrived).
   * @param {Partial<GraphNode>[]} nodeUpdates  each with its id
   * @param {Partial<GraphEdge>[]} [edgeUpdates]  each with its id
   */
  updateInPlace(nodeUpdates, edgeUpdates = []) {
    const nodeStyles = [],
      edgeStyles = [];
    for (const { id, classes, ...data } of nodeUpdates) {
      const node = this.#nodes.get(id);
      if (!node) continue;
      node.data = { ...node.data, ...data };
      if (classes !== undefined) {
        const isRoot = node.classes.has("root");
        node.classes = classSet(classes);
        if (isRoot) node.classes.add("root");
      }
      nodeStyles.push({ id, style: this.#nodeStyle(id) });
    }
    for (const { id, classes, ...data } of edgeUpdates) {
      const edge = this.#edges.get(id);
      if (!edge) continue;
      edge.data = { ...edge.data, ...data };
      if (classes !== undefined) edge.classes = classSet(classes);
      edgeStyles.push({ id, style: this.#edgeStyle(id) });
    }
    this.graph.updateStyles(nodeStyles, edgeStyles);
  }

  #restyle() {
    this.graph.updateStyles(
      [...this.#nodes.keys()].map((id) => ({ id, style: this.#nodeStyle(id) })),
      [...this.#edges.keys()].map((id) => ({ id, style: this.#edgeStyle(id) })),
    );
    this.graph.setRouting(this.#routing());
  }

  #applyOptions() {
    const o = this.#options;
    this.graph.camera.minZoom = o.minZoom;
    this.graph.camera.maxZoom = Math.max(o.minZoom, o.maxZoom);
    this.graph.setOptions({
      motion: {
        enabled: o.animationsEnabled,
        durationMs: o.animationDuration,
        feel: o.animationEasing,
      },
      dimAlpha: o.dimOpacity,
      flowSpeed: o.flowSpeed,
      input: {
        smoothZoom: o.smoothZoom,
        zoomSpeed: o.zoomSpeed,
        draggable: o.nodesDraggable,
        doubleTapMs: o.doubleTapMs,
        longPressMs: o.longPressMs,
        dragThreshold: {
          mouse: o.dragThresholdMouse,
          pen: o.dragThresholdPen,
          touch: o.dragThresholdTouch,
        },
        panInertia: o.panInertia,
        flickMinSpeed: o.flickMinSpeed,
      },
      labels: {
        position: resolveLabelPosition(o),
        backdrop: o.labelBackdrop,
        fadeZoom: o.labelFadeZoom,
        maxWidth: o.labelWidth * o.labelWrapScale,
        overflow: o.labelOverflow,
        cardDetailZoom: o.cardDetailZoom,
      },
    });
  }

  #routing() {
    const o = this.#options;
    return {
      routing: resolveRouting(o),
      flowAxis: resolveFlowAxis(o),
      cornerRadius: o.edgeCornerRadius,
      curvature: o.edgeCurvature ?? 1,
      portDirection: flowOf(o).rootSide, // where a card's out port sits (the layout layer knows where the root is)
    };
  }

  /**
   * A node's footprint with its label (the box they make together), as the renderer will draw it at zoom 1. The
   * layouts leave this much room.
   */
  #footprint(style) {
    const width = style.width,
      height = style.height;
    // Cards carry their text inside.
    if (!style.label || style.look === "card")
      return { fullW: width, fullH: height };
    const o = this.#options;
    const font = labelFont(style.fontSize, style.bold);
    const wrapWidth = o.labelWidth * o.labelWrapScale;
    const key = `${font}|${wrapWidth}|${o.labelOverflow}|${style.label}`;
    let label = this.#labelSizes.get(key);
    if (!label) {
      const measure = (this.#measureContext ??= document
        .createElement("canvas")
        .getContext("2d"));
      measure.font = font;
      label = layoutLabel(
        style.label,
        { fontSize: style.fontSize, wrapWidth, overflow: o.labelOverflow },
        (text) => measure.measureText(text).width,
      );
      if (this.#labelSizes.size > 20000) this.#labelSizes.clear();
      this.#labelSizes.set(key, label);
    }
    const halfW = width / 2,
      halfH = height / 2;
    const box = labelBox(
      resolveLabelPosition(o),
      halfW,
      halfH,
      label.width,
      label.height,
    );
    return {
      fullW: Math.max(halfW, box.x2) - Math.min(-halfW, box.x1),
      fullH: Math.max(halfH, box.y2) - Math.min(-halfH, box.y1),
    };
  }

  #labelSizes = new Map();
  #measureContext = null;

  #nodeStyle(id) {
    const { data, classes } = this.#nodes.get(id);
    const style = resolveNodeStyle(
      classes,
      data,
      this.#options,
      this.#theme,
      this.#classStyles,
    );
    style.icon = data.icon ?? null;
    // Ports only where edges meet the card: in on the leaf side (it has children), out on the root side (a parent).
    if (!this.#outgoing.get(id)?.length) style.portIn = null;
    if (!this.#incoming.get(id)?.length) style.portOut = null;
    if (this.#options.cardConnectors === "arrows")
      style.portIn = style.portOut = null;
    this.#resolvedStyles.set(id, style);
    return style;
  }

  /** Each node's most recently resolved style (for its edges' ends). */
  #resolvedStyles = new Map();

  #edgeStyle(id) {
    const { data, classes, source, target } = this.#edges.get(id);
    const style = resolveEdgeStyle(
      classes,
      data,
      this.#options,
      this.#theme,
      this.#classStyles,
    );
    // Where an edge meets a card, cardConnectors decides: dots only (no arrowhead), or an arrowhead (on the end
    // arrowEnd picks, showArrows or not).
    const o = this.#options;
    const arrow = o.arrowShape;
    for (const [end, key, wanted] of [
      [source, "arrowAtSource", o.arrowEnd !== "target"],
      [target, "arrowAtTarget", o.arrowEnd !== "source"],
    ]) {
      if (!this.#isCard(end)) continue;
      if (o.cardConnectors === "dots") style[key] = null;
      else if (wanted) style[key] ??= arrow;
    }
    return style;
  }

  /** Is this node drawn as a card? (its look, from the options, a class rule or the hook) */
  #isCard(id) {
    const node = this.#nodes.get(id);
    if (!node) return false;
    // Only rules and hooks can change a node's look: without them, the option decides. With them, the node's style
    // was just resolved (nodes always are before their edges): read it back rather than resolve it again.
    if (
      !this.#classStyles.nodes &&
      !this.#options.nodeStyle &&
      !node.data.style?.look
    )
      return this.#options.nodeLook === "card";
    return (
      (this.#resolvedStyles.get(id) ?? this.#nodeStyle(id)).look === "card"
    );
  }

  #indexEdges() {
    this.#outgoing = new Map();
    this.#incoming = new Map();
    for (const [id, edge] of this.#edges) {
      if (!this.#outgoing.has(edge.source)) this.#outgoing.set(edge.source, []);
      this.#outgoing.get(edge.source).push(id);
      if (!this.#incoming.has(edge.target)) this.#incoming.set(edge.target, []);
      this.#incoming.get(edge.target).push(id);
    }
  }

  // ---------------------------------------------------------------- selection & highlights

  /** Select a node; null (or an id that isn't in the graph) for none. */
  select(nodeId) {
    if (!this.hasNode(nodeId)) nodeId = null;
    const changed = nodeId !== this.#pinnedNodeId;
    this.graph.select(nodeId);
    this.#pinnedNodeId = nodeId;
    if (!this.#lineage.nodeId || this.#lineage.isPinned)
      this.#showPinnedLineage();
    if (changed) this.emit("select", { id: nodeId });
  }

  /** The selected node, or null. */
  get selectedId() {
    return this.#pinnedNodeId;
  }

  hasNode(nodeId) {
    return !!nodeId && this.#nodes.has(nodeId);
  }

  nodeIds() {
    return [...this.#nodes.keys()];
  }

  /** The selection flares briefly. */
  pulse(nodeId) {
    if (this.#options.animationsEnabled) this.graph.pulse(nodeId);
  }

  /** Make nodes glow for a moment (e.g. after jumping to them from elsewhere on the page). */
  flash(nodeIds, durationMs = 2200) {
    clearTimeout(this.#flashTimer);
    this.#flashIds = new Set(nodeIds);
    this.#syncEmphasis();
    this.#flashTimer = setTimeout(() => {
      this.#flashIds = null;
      this.#syncEmphasis();
    }, durationMs);
  }

  /** These nodes glow and everything else fades (e.g. a legend entry): any iterable of ids. Null or empty clears it. */
  setHighlightedNodes(nodeIds) {
    const ids = new Set(nodeIds ?? []);
    this.#highlightIds = ids.size ? ids : null;
    this.#syncEmphasis();
    this.#syncDimmed();
  }

  #syncEmphasis() {
    const colors = new Map();
    for (const id of this.#highlightIds ?? [])
      colors.set(id, this.#theme.highlight);
    for (const id of this.#flashIds ?? []) colors.set(id, this.#theme.focus);
    this.graph.setEmphasis(colors.size ? colors : null);
  }

  #syncDimmed() {
    const dimmed = new Set(this.#lineage.dimmed ?? []);
    if (this.#highlightIds)
      for (const id of this.#nodes.keys())
        if (!this.#highlightIds.has(id)) dimmed.add(id);
    this.graph.setDimmed(dimmed.size ? dimmed : null);
  }

  // ---------------------------------------------------------------- hover lineage

  /** Light the node's ancestors and/or descendants (per hoverMode), after a short debounce. */
  showLineage(nodeId) {
    clearTimeout(this.#hoverTimer);
    this.#hoverTimer = setTimeout(
      () => this.#applyLineage(nodeId),
      this.#options.hoverDelay,
    );
  }

  /** Pointer left the node: back to the selection's lineage (if it's pinned). */
  clearLineage() {
    clearTimeout(this.#hoverTimer);
    if (this.#lineage.isPinned) return;
    this.#removeLineage();
    this.#showPinnedLineage();
  }

  #removeLineage() {
    this.#lineage = { nodeId: null, isPinned: false, dimmed: null };
    this.graph.setEdgeEmphasis(null);
    this.graph.setLabelFocus(null);
    this.#syncDimmed();
  }

  #showPinnedLineage({ force = false } = {}) {
    const nodeId = this.#pinnedNodeId;
    const shouldPin =
      this.#options.pinSelectionLineage && nodeId && this.hasNode(nodeId);
    if (
      !force &&
      shouldPin &&
      this.#lineage.isPinned &&
      this.#lineage.nodeId === nodeId
    )
      return;
    if (this.#lineage.isPinned || force) this.#removeLineage();
    if (shouldPin && !this.#lineage.nodeId)
      this.#applyLineage(nodeId, { isPinned: true });
  }

  /** Everything reachable from `start` along edges (forward) or against them, as node and edge id sets. */
  #reach(start, forward) {
    const nodes = new Set(),
      edges = new Set();
    const queue = [start];
    while (queue.length) {
      const id = queue.pop();
      for (const edgeId of (forward ? this.#outgoing : this.#incoming).get(
        id,
      ) ?? []) {
        edges.add(edgeId);
        const edge = this.#edges.get(edgeId);
        const next = forward ? edge.target : edge.source;
        if (!nodes.has(next) && next !== start) {
          nodes.add(next);
          queue.push(next);
        }
      }
    }
    return { nodes, edges };
  }

  #applyLineage(nodeId, { isPinned = false } = {}) {
    const o = this.#options,
      mode = o.hoverMode;
    if (mode === "none" || !this.#nodes.has(nodeId)) return;
    const none = () => ({ nodes: new Set(), edges: new Set() });
    const descendants =
      mode === "ancestors" ? none() : this.#reach(nodeId, true);
    const ancestors =
      mode === "descendants" ? none() : this.#reach(nodeId, false);
    const flow = o.animateFlow ? (o.flowToward === "target" ? 1 : -1) : 0;
    const emphasis = new Map();
    // lineageColor "edge": lit edges keep their own colour (only wider, and flowing); "theme": the lineage colours.
    const tint = (color) => (o.lineageColor === "edge" ? null : color);
    for (const id of descendants.edges)
      emphasis.set(id, {
        color: tint(this.#theme.descendants),
        boost: 0.8,
        flow,
      });
    for (const id of ancestors.edges)
      emphasis.set(id, {
        color: tint(this.#theme.ancestors),
        boost: 1.4,
        flow,
      });
    let dimmed = null;
    if (!isPinned) {
      dimmed = new Set();
      for (const id of this.#nodes.keys())
        if (
          id !== nodeId &&
          !descendants.nodes.has(id) &&
          !ancestors.nodes.has(id)
        )
          dimmed.add(id);
    }
    this.#lineage = { nodeId, isPinned, dimmed };
    this.graph.setEdgeEmphasis(emphasis);
    // Keep names readable around the node even when labels have faded out.
    const focus = new Set([nodeId, ...ancestors.nodes]);
    for (const edgeId of this.#outgoing.get(nodeId) ?? [])
      focus.add(this.#edges.get(edgeId).target);
    this.graph.setLabelFocus(focus);
    this.#syncDimmed();
  }

  // ---------------------------------------------------------------- viewport

  fit() {
    if (!this.graph.width || !this.graph.height) {
      this.#pendingFit = true;
      return;
    }
    this.#pendingFit = false;
    this.graph.fitView({
      animate: this.#options.animationsEnabled,
      maxZoom: this.#options.maxFitZoom,
      padding: this.#options.fitPadding,
    });
  }

  zoomBy(factor) {
    this.graph.zoomBy(factor, { animate: this.#options.animationsEnabled });
  }

  centerOnRoot() {
    const rootId = this.rootNodeId;
    if (!rootId) return;
    this.graph.centerOn(rootId, {
      zoom: Math.max(this.graph.cameraTarget.zoom, 0.8),
      animate: this.#options.animationsEnabled,
    });
  }

  /** Pan (not zoom) just enough to bring a node on screen, e.g. during keyboard navigation. */
  revealNode(nodeId) {
    this.graph.reveal(nodeId, { animate: this.#options.animationsEnabled });
  }

  /** Fit some nodes (and optionally their neighbours) into view. */
  focusOn(
    nodeIds,
    {
      padding = this.#options.focusPadding,
      includeNeighbours = false,
      maxZoom = this.#options.focusMaxZoom,
    } = {},
  ) {
    const ids = new Set([...nodeIds].filter((id) => this.#nodes.has(id)));
    if (!ids.size) return;
    if (includeNeighbours)
      for (const id of [...ids]) {
        for (const edgeId of this.#outgoing.get(id) ?? [])
          ids.add(this.#edges.get(edgeId).target);
        for (const edgeId of this.#incoming.get(id) ?? [])
          ids.add(this.#edges.get(edgeId).source);
      }
    this.graph.fitView({
      ids,
      padding,
      maxZoom,
      animate: this.#options.animationsEnabled,
    });
  }

  resize() {
    this.graph.resize();
  }

  /** Where the camera is (or is heading, mid-animation): save it to restore the view later. */
  getViewport() {
    const { zoom, panX, panY } = this.graph.cameraTarget;
    return { zoom, panX, panY };
  }

  /**
   * Move the camera (any of zoom, panX, panY).
   * @param {Partial<Viewport>} viewport
   * @param {{ animate?: boolean }} [options]  default: when animations are on
   */
  setViewport(viewport, { animate = this.#options.animationsEnabled } = {}) {
    this.graph.moveCamera({ ...this.getViewport(), ...viewport }, { animate });
  }

  /** Graph coordinates → CSS pixels in the container. */
  toScreen(x, y) {
    return this.graph.camera.toScreen(x, y);
  }

  /** CSS pixels in the container → graph coordinates. */
  toGraph(x, y) {
    return this.graph.camera.toWorld(x, y);
  }

  /** Where a node is drawn now (graph coordinates, mid-animation included), or null. */
  positionOf(nodeId) {
    return this.graph.livePositionOf(nodeId) ?? null;
  }

  /** Every node's position now: id → { x, y } (save them, or hand them to your own code). */
  positions() {
    return new Map(
      this.graph.nodeIds().map((id) => [id, this.graph.livePositionOf(id)]),
    );
  }

  /**
   * A "dots" or "grid" canvasBackground follows pan and zoom, so the canvas feels like one surface: this sets the
   * wrapper's data-bg attribute and its background size and position. The pattern itself is the page's CSS.
   */
  syncBackground() {
    const wrapper = this.#canvasWrapper;
    if (!wrapper) return;
    const background = this.#options.canvasBackground;
    wrapper.dataset.bg = background;
    if (background !== "dots" && background !== "grid") {
      wrapper.style.backgroundSize = "";
      wrapper.style.backgroundPosition = "";
      return;
    }
    const camera = this.graph.camera;
    const base = this.#options.backgroundCellSize;
    let cellSize = base * camera.zoom;
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) cellSize = base;
    while (cellSize < 12) cellSize *= 2;
    while (cellSize > 90) cellSize /= 2;
    wrapper.style.backgroundSize = `${cellSize}px ${cellSize}px`;
    wrapper.style.backgroundPosition = `${camera.panX}px ${camera.panY}px`;
  }

  #onViewportChange() {
    if (!this.#viewportFrame)
      this.#viewportFrame = requestAnimationFrame(() => {
        this.#viewportFrame = 0;
        this.syncBackground();
      });
    if (this.hasListeners("viewportChange"))
      this.emit("viewportChange", { viewport: this.getViewport() });
  }

  #viewportFrame = 0;

  /** Where the camera should go after a render: keep the anchor still, or fit (smart: never microscopic). */
  #targetView({ fit, anchorNodeId, anchorScreen }) {
    const graph = this.graph;
    if (!graph.width || !graph.height) {
      if (fit) this.#pendingFit = true;
      return null;
    }
    if (anchorScreen && graph.hasNode(anchorNodeId)) {
      const position = graph.positionOf(anchorNodeId);
      const { zoom } = graph.cameraTarget;
      return {
        zoom,
        panX: anchorScreen.x - position.x * zoom,
        panY: anchorScreen.y - position.y * zoom,
      };
    }
    if (!fit) return null;
    const o = this.#options;
    let view = graph.viewFor(undefined, {
      maxZoom: o.maxFitZoom,
      padding: o.fitPadding,
    });
    const rootId = this.rootNodeId;
    if (
      fit === "smart" &&
      view.zoom < o.smartFitMinZoom &&
      this.#nodes.size > o.smartFitMinNodes &&
      rootId
    ) {
      // Too big to read when fitted: open on the root, near the edge the tree grows away from.
      const zoom = o.smartFitZoom;
      const root = graph.positionOf(rootId);
      const growth = flowOf(o).growth;
      const fractionX = growth === "LR" ? 0.12 : growth === "RL" ? 0.88 : 0.5;
      const fractionY = growth === "TB" ? 0.15 : growth === "BT" ? 0.85 : 0.5;
      view = {
        zoom,
        panX: graph.width * fractionX - root.x * zoom,
        panY: graph.height * fractionY - root.y * zoom,
      };
    }
    return view;
  }

  // ---------------------------------------------------------------- export

  /** The whole graph as a PNG data URI, every label drawn. */
  toPngDataUri({ scale = 2, backgroundColor = null } = {}) {
    return this.graph
      .renderToCanvas({ scale, background: backgroundColor })
      .toDataURL("image/png");
  }

  /** Model-space box around everything drawn. */
  boundingBox() {
    const { x1, y1, x2, y2 } = this.graph.bounds();
    return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
  }

  #clearTimers() {
    clearTimeout(this.#hoverTimer);
    clearTimeout(this.#flashTimer);
  }
}

function classSet(classes) {
  if (!classes) return new Set();
  return new Set(
    (Array.isArray(classes) ? classes : String(classes).split(" ")).filter(
      Boolean,
    ),
  );
}

function edgeId(edge) {
  return edge.id ?? `${edge.source}->${edge.target}`;
}
