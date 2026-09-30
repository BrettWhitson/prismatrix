import { Emitter } from "./layout/index.js";
import { WebGLGraph } from "./render/webgl-graph.js";
export type GraphNode = {
  id: string;
  label?: string;
  color?: string;
  icon?: string;
  classes?: string[] | string;
  root?: boolean;
  style?: import("./style.js").NodeRule;
  [data: string]: any;
};
export type GraphEdge = {
  id?: string;
  source: string;
  target: string;
  label?: string;
  sourceColor?: string;
  targetColor?: string;
  classes?: string[] | string;
  style?: import("./style.js").EdgeRule;
  [data: string]: any;
};
export type Viewport = {
  zoom: number;
  panX: number;
  panY: number;
};
export type GraphViewEvents = {
  nodeTap: [
    {
      id: string;
      originalEvent: PointerEvent;
    },
  ];
  nodeDoubleTap: [
    {
      id: string;
      originalEvent: PointerEvent;
    },
  ];
  /**
   * right click or long press
   */
  nodeContextTap: [
    {
      id: string;
      originalEvent: PointerEvent;
    },
  ];
  backgroundTap: [
    {
      originalEvent?: PointerEvent;
    },
  ];
  nodeHoverStart: [
    {
      id: string;
      originalEvent: PointerEvent;
    },
  ];
  nodeHoverEnd: [{}];
  pointerMove: [
    {
      originalEvent: PointerEvent;
    },
  ];
  /**
   * pan or zoom (every frame while it moves)
   */
  viewportChange: [
    {
      viewport: Viewport;
    },
  ];
  dragStart: [
    {
      id: string;
    },
  ];
  /**
   * the held node moved (graph coordinates)
   */
  drag: [
    {
      id: string;
      x: number;
      y: number;
    },
  ];
  dragEnd: [
    {
      id: string;
    },
  ];
  /**
   * "drag", "shake" or "float-in"
   */
  physicsStart: [
    {
      reason: string;
    },
  ];
  /**
   * the physics went still
   */
  physicsSettle: [{}];
  /**
   * after render()
   */
  render: [
    {
      nodeCount: number;
      edgeCount: number;
      layoutMs: number;
    },
  ];
  select: [
    {
      id: string | null;
    },
  ];
  optionsChange: [
    {
      changed: string[];
    },
  ];
  themeChange: [
    {
      changed: string[];
    },
  ];
  destroy: [{}];
};
/** Handler names (the constructor's `handlers`) → the event they listen to. */
declare const HANDLER_EVENTS: {
  onNodeTap: string;
  onNodeDoubleTap: string;
  onNodeContextTap: string;
  onBackgroundTap: string;
  onNodeHoverStart: string;
  onNodeHoverEnd: string;
  onPointerMove: string;
  onViewportChange: string;
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
export declare class GraphView extends Emitter<GraphViewEvents> {
  #private;
  graph: WebGLGraph;
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
    options,
    theme,
    tuning,
    classStyles,
    handlers,
    strict,
    rendererOptions,
  }: {
    container: HTMLElement;
    canvasWrapper?: HTMLElement;
    options?: Partial<import("./options.js").Options>;
    theme?: Partial<import("./style.js").Theme>;
    tuning?: Partial<import("./layout/index.js").Tuning>;
    classStyles?: import("./style.js").ClassRules;
    handlers?: Partial<Record<keyof typeof HANDLER_EVENTS, Function>>;
    strict?: boolean;
    rendererOptions?: {
      preserveDrawingBuffer?: boolean;
      badgeUrl?: string;
      colors?: object;
    };
  });
  /** The options in effect (a copy). */
  get options(): any;
  /**
   * Change any options (checked: see options.js). Looks apply at once, node sizes (nodeSizeScale, rootSizeScale)
   * and label wrapping included; layout and physics options (layout, direction, layered, physicsMode, the forces)
   * apply from the next render(), as does the room the layout leaves for the new sizes and labels.
   * @param {Partial<import('./options.js').Options>} patch
   */
  setOptions(patch: Partial<import("./options.js").Options>): void;
  /**
   * Lay the graph on screen out again, morphing into the new layout (for example after changing layout options,
   * which otherwise apply from the next render()). The view stays where it is.
   */
  relayout(): void;
  /** Put options back to their defaults: these keys, or all of them. */
  resetOptions(keys: any): void;
  /** The theme in effect (a copy). */
  get theme(): any;
  /**
   * Change any theme colours (checked: see style.js THEME_SCHEMA).
   * @param {Partial<import('./style.js').Theme>} patch
   */
  setTheme(patch: Partial<import("./style.js").Theme>): void;
  get rootNodeId(): any;
  /**
   * Looks for the caller's own classes (see style.js): any NodeStyle or EdgeStyle field, per class, applied in order.
   * { nodes: { className: { ring: "#ffd166", size: 60, shape: "hexagon", … } }, edges: { className: { … } } }
   * @param {import('./style.js').ClassRules} rules
   */
  setClassStyles(rules: import("./style.js").ClassRules): void;
  /**
   * Replace the graph, morphing from the previous one: survivors glide to their new places, new nodes grow out of
   * their nearest surviving ancestor (level by level from the root for a new graph), removed ones fold into theirs.
   * @param {{ nodes: GraphNode[], edges: GraphEdge[], fit?: boolean | "smart", anchorNodeId?: string | null,
   *           grow?: boolean }} graph
   *   fit: fit the view to the graph ("smart": but open on the root when that would be too small to read)
   *   anchorNodeId: keep this node where it is on screen
   *   grow: a new graph (nothing morphs from the previous one; it grows out of its root)
   */
  render({
    nodes,
    edges,
    fit,
    anchorNodeId,
    grow,
  }: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    fit?: boolean | "smart";
    anchorNodeId?: string | null;
    grow?: boolean;
  }): void;
  /**
   * Prismatrix's constants (TUNING_SCHEMA) for this view, checked; everything not given goes back to its default.
   * Applies to what's running too; layout constants apply from the next render().
   * @param {Partial<import('./layout/index.js').Tuning>} tuning
   */
  setPhysicsTuning(tuning: Partial<import("./layout/index.js").Tuning>): void;
  get physicsTuning(): any;
  /** The layout's force simulation (for developer tools: its alpha, positions, tuning). */
  get simulation(): any;
  /** The elastic net while a node is held and until it settles, or null (for developer tools). */
  get elasticNet(): any;
  /**
   * Drag a node from code, the way a pointer drag does (the same physics, either mode): for developer tools and
   * tests. Returns { move(x, y), end() } in world coordinates.
   */
  beginDrag(id: any): {
    move: (x: any, y: any) => void;
    end: () => void;
  };
  /**
   * Shake the physics and watch it settle: optionally scatter every node by up to `scatter` world units, heat the
   * simulation to `heat` (0..1) and let it cool, animated. Returns false when the layout has no simulation.
   */
  settle({ heat, scatter }?: { heat?: number; scatter?: number }): boolean;
  /** Is the physics running live (a drag, settle(), floating in)? */
  get physicsRunning(): boolean;
  /** Stop any live physics (a drag settling, settle(), floating in). */
  stopPhysics(): void;
  /** Remove everything: no nodes, no running animation or physics, no selection, highlight or flash. */
  clear(): void;
  /** Stop everything and remove the canvases. Listeners hear "destroy", then are all removed. */
  destroy(): void;
  /**
   * New labels, colours and classes without a re-layout (e.g. new data arrived).
   * @param {Partial<GraphNode>[]} nodeUpdates  each with its id
   * @param {Partial<GraphEdge>[]} [edgeUpdates]  each with its id
   */
  updateInPlace(
    nodeUpdates: Partial<GraphNode>[],
    edgeUpdates?: Partial<GraphEdge>[],
  ): void;
  /** Select a node; null (or an id that isn't in the graph) for none. */
  select(nodeId: any): void;
  /** The selected node, or null. */
  get selectedId(): any;
  hasNode(nodeId: any): boolean;
  nodeIds(): any[];
  /** The selection flares briefly. */
  pulse(nodeId: any): void;
  /** Make nodes glow for a moment (e.g. after jumping to them from elsewhere on the page). */
  flash(nodeIds: any, durationMs?: number): void;
  /** These nodes glow and everything else fades (e.g. a legend entry): any iterable of ids. Null or empty clears it. */
  setHighlightedNodes(nodeIds: any): void;
  /** Light the node's ancestors and/or descendants (per hoverMode), after a short debounce. */
  showLineage(nodeId: any): void;
  /** Pointer left the node: back to the selection's lineage (if it's pinned). */
  clearLineage(): void;
  fit(): void;
  zoomBy(factor: any): void;
  centerOnRoot(): void;
  /** Pan (not zoom) just enough to bring a node on screen, e.g. during keyboard navigation. */
  revealNode(nodeId: any): void;
  /** Fit some nodes (and optionally their neighbours) into view. */
  focusOn(
    nodeIds: any,
    {
      padding,
      includeNeighbours,
      maxZoom,
    }?: {
      includeNeighbours?: boolean;
      maxZoom?: any;
      padding?: any;
    },
  ): void;
  resize(): void;
  /** Where the camera is (or is heading, mid-animation): save it to restore the view later. */
  getViewport(): {
    zoom: number;
    panX: number;
    panY: number;
  };
  /**
   * Move the camera (any of zoom, panX, panY).
   * @param {Partial<Viewport>} viewport
   * @param {{ animate?: boolean }} [options]  default: when animations are on
   */
  setViewport(
    viewport: Partial<Viewport>,
    {
      animate,
    }?: {
      animate?: boolean;
    },
  ): void;
  /** Graph coordinates → CSS pixels in the container. */
  toScreen(
    x: any,
    y: any,
  ): {
    x: number;
    y: number;
  };
  /** CSS pixels in the container → graph coordinates. */
  toGraph(
    x: any,
    y: any,
  ): {
    x: number;
    y: number;
  };
  /** Where a node is drawn now (graph coordinates, mid-animation included), or null. */
  positionOf(nodeId: any): {
    x: any;
    y: any;
  };
  /** Every node's position now: id → { x, y } (save them, or hand them to your own code). */
  positions(): Map<
    any,
    {
      x: any;
      y: any;
    }
  >;
  /**
   * A "dots" or "grid" canvasBackground follows pan and zoom, so the canvas feels like one surface: this sets the
   * wrapper's data-bg attribute and its background size and position. The pattern itself is the page's CSS.
   */
  syncBackground(): void;
  /** The whole graph as a PNG data URI, every label drawn. */
  toPngDataUri({
    scale,
    backgroundColor,
  }?: {
    backgroundColor?: any;
    scale?: number;
  }): string;
  /** Model-space box around everything drawn. */
  boundingBox(): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    w: number;
    h: number;
  };
}
export {};
