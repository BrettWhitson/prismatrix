// Canvas 2D drawing. Deliberately plain for now: the look is what's being worked out, speed comes later.

import { edgeRoute, fanJunctions, startTrims, trim } from "./geometry.js";
import { TEXT_HALO, font, planText, textBox, textFitter } from "./labels.js";
import { LINK, linkGlyphs } from "./references.js";
import {
  ROUNDED_CORNER,
  TILE_CORNER,
  iconBox,
  iconShown,
  iconStore,
} from "./icons.js";
import {
  DEFAULT_THEME,
  EDGE_COLOUR_DEFAULT,
  NODE_COLOUR_DEFAULT,
} from "./theme.js";

/**
 * @typedef {object} Looks How every node and edge of a graph looks, by index (looksOf).
 * @property {Float64Array} radius     per node, world px
 * @property {string[]} fill           per node, "#rrggbb"
 * @property {string[]} shape          per node
 * @property {(string | null)[]} stroke per node, its border colour (null: none)
 * @property {Float64Array} strokeWidth per node (0: no border)
 * @property {any[]} icon              per node, a URL or an image (null: none)
 * @property {string[]} edgeColour     per edge
 * @property {Float64Array} edgeWidth  per edge, world px
 * @property {{ colour: string, width: number, byTarget: boolean }} edgeDefault an edge's look without a style of its own
 * @property {import("./theme.js").Theme} theme
 * @property {string} iconFit          the node option
 * @property {Int32Array | null} branch per node, which branch of its root it's on (colouring by branch), or null
 *
 * @typedef {object} DisplayNode A node as painters read it: a working graph's node (graph.js), or one that's only
 *   drawn (a reference chip, a ghost).
 * @property {string} id
 * @property {string} label
 * @property {number} index
 * @property {number} x
 * @property {number} y
 * @property {number} homeX
 * @property {number} homeY
 * @property {number} parent      its parent's index, or -1
 * @property {number[]} children
 * @property {number} depth
 * @property {number} [labelAngle]
 * @property {number} [descendants]
 * @property {Record<string, any>} [style]
 * @property {Record<string, any>} [data]
 * @property {number} [reference] a reference chip: its ingredient's index
 * @property {boolean} [ghost]    a node that left the graph, folding away
 *
 * @typedef {object} DisplayEdge An edge as painters read it (graph.js's Edge, or one that's only drawn).
 * @property {string} [id]
 * @property {number} source
 * @property {number} target
 * @property {boolean} tree
 * @property {string} [label]
 * @property {Record<string, any>} [style]
 * @property {Record<string, any>} [data]
 * @property {boolean} [reference] ends at a reference chip
 * @property {boolean} [ghost]
 *
 * @typedef {object} DisplayGraph What painters draw: a working graph (graph.js), or one with reference chips
 *   (references.js) and ghosts (ghosts.js) appended after its own nodes.
 * @property {DisplayNode[]} nodes
 * @property {DisplayEdge[]} edges
 * @property {Map<string, any>} byId
 * @property {number[]} roots
 * @property {number[]} order
 * @property {ReadonlyArray<ReadonlyArray<number>>} [incoming] per node, the edges into it
 * @property {ReadonlyArray<ReadonlyArray<number>>} [outgoing] per node, the edges out of it
 * @property {Map<number, number>} [uses] per referenced ingredient (node index), how many use it
 *
 * @typedef {object} Shown A display graph and what painters read per node and edge of it.
 * @property {DisplayGraph} graph
 * @property {Looks} looks
 * @property {Float32Array} shade  per node, 0–1: how lit it is
 * @property {Float32Array} appear per node, 0–1: how far it has faded in
 */

/**
 * How every node and edge looks: each element's own `style` (from the model) first, then the view's node and edge
 * options (sizing, colouring rules, defaults), then the theme (the palette, and the colours of options left at their
 * defaults). Per node: radius, fill, shape, stroke colour (null for none) and width, icon (a URL or an image, null
 * for none). Per edge: colour and width. patchLooks redoes some of them in place.
 * @param {DisplayGraph} graph
 * @param {Record<string, any>} node the node options (NODE_OPTIONS, resolved)
 * @param {Record<string, any>} edge the edge options (EDGE_OPTIONS, resolved)
 * @param {import("./theme.js").Theme} [theme]
 * @returns {Looks}
 */
export function looksOf(graph, node, edge, theme = DEFAULT_THEME) {
  const count = graph.nodes.length;
  const looks = {
    radius: new Float64Array(count),
    fill: new Array(count),
    shape: new Array(count),
    stroke: new Array(count),
    strokeWidth: new Float64Array(count),
    icon: new Array(count),
    edgeColour: new Array(graph.edges.length),
    edgeWidth: new Float64Array(graph.edges.length),
    edgeDefault: {
      colour: edge.color === EDGE_COLOUR_DEFAULT ? theme.edge : edge.color,
      width: edge.width,
      byTarget: edge.colorBy === "target",
    },
    theme,
    iconFit: node.iconFit ?? "cover",
    branch: node.colorBy === "branch" ? branches(graph) : null,
  };
  for (const n of graph.nodes) nodeLook(looks, n, node);
  for (let i = 0; i < graph.edges.length; i++)
    edgeLook(looks, graph.edges[i], i, edge);
  return looks;
}

/**
 * Redo the looks of nodes `nodes` and edges `edges` (indices) in place, after their own styles changed: a restyle of
 * a few elements costs what they do, not the whole graph. Edges coloured by their child follow a restyled child.
 * The options and theme must be the ones `looks` was made with (new ones need a whole new looksOf).
 * @returns {{ nodes: Int32Array, edges: Int32Array }} every node and edge whose look was redone, ascending
 */
export function patchLooks(looks, graph, node, edge, nodes, edges = []) {
  const doneNodes = Int32Array.from(new Set(nodes)).sort();
  const doneEdges = new Set(edges);
  for (const i of doneNodes) nodeLook(looks, graph.nodes[i], node);
  if (looks.edgeDefault.byTarget && graph.incoming)
    for (const i of doneNodes)
      for (const e of graph.incoming[i]) doneEdges.add(e);
  const sortedEdges = Int32Array.from(doneEdges).sort();
  for (const e of sortedEdges) edgeLook(looks, graph.edges[e], e, edge);
  return { nodes: doneNodes, edges: sortedEdges };
}

function nodeLook(looks, n, node) {
  const style = n.style ?? {};
  const i = n.index;
  const theme = looks.theme;
  let scale = 1;
  if (node.sizeBy === "descendants")
    scale = 1 + 0.35 * Math.log2(1 + n.descendants);
  else if (node.sizeBy === "depth") scale = Math.max(0.4, 1 - n.depth * 0.14);
  looks.radius[i] =
    style.size !== undefined ? style.size / 2 : (node.size / 2) * scale;
  looks.shape[i] = style.shape ?? node.shape;
  const { palette } = theme;
  looks.fill[i] =
    style.color ??
    (node.colorBy === "single"
      ? node.color === NODE_COLOUR_DEFAULT
        ? theme.node
        : node.color
      : node.colorBy === "branch" && looks.branch
        ? n.depth === 0
          ? theme.root
          : palette[looks.branch[i] % palette.length]
        : palette[n.depth % palette.length]);
  looks.stroke[i] = style.stroke ?? null;
  looks.strokeWidth[i] = style.stroke
    ? (style.strokeWidth ?? node.strokeWidth ?? 2)
    : 0;
  looks.icon[i] = style.icon ?? null;
}

function edgeLook(looks, e, i, edge) {
  looks.edgeColour[i] =
    e.style?.color ??
    (looks.edgeDefault.byTarget
      ? looks.fill[e.target]
      : looks.edgeDefault.colour);
  looks.edgeWidth[i] = e.style?.width ?? edge.width;
}

/** Node looks only (radius, fill, shape), for callers that don't draw edges. */
export function nodeLooks(graph, node) {
  return looksOf(graph, node, {
    colorBy: "single",
    color: "#000000",
    width: 1,
  });
}

/** Which of its root's children each node descends from (roots get their own number). */
function branches(graph) {
  const out = new Int32Array(graph.nodes.length);
  let next = 0;
  for (const i of graph.order) {
    const n = graph.nodes[i];
    out[i] = n.depth <= 1 ? next++ : out[n.parent];
  }
  return out;
}

/**
 * The node and everything above and below it: every node it can be reached from and every node it reaches, along
 * any edge (so in a merged tree a shared ingredient lights up with every recipe that uses it).
 */
export function lineage(graph, index) {
  const set = new Set([index]);
  for (const [lists, end] of [
    [graph.incoming, "source"],
    [graph.outgoing, "target"],
  ]) {
    const stack = [index];
    const seen = new Set([index]);
    while (stack.length) {
      for (const ei of lists[stack.pop()]) {
        const next = graph.edges[ei][end];
        if (seen.has(next)) continue;
        seen.add(next);
        set.add(next);
        stack.push(next);
      }
    }
  }
  return set;
}

/**
 * Draw one whole frame on one 2D canvas: background, edges, nodes, labels. Renderers that split the scene across
 * layers (see webgl.js) call the parts below themselves.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("./controller.js").Scene} scene
 */
export function drawScene(ctx, scene, icons = iconStore()) {
  clearTo(ctx, scene, scene.background ?? scene.theme?.background);
  drawEdges(ctx, scene);
  drawNodes(ctx, scene, icons);
  drawHalos(ctx, scene);
  drawGlyphs(ctx, scene);
  drawLabels(ctx, scene);
}

/** A selected node's halo: a ring this many CSS px outside its shape, this many wide, in the node's colour. */
export const HALO_GAP = 3;
export const HALO_WIDTH = 2;

/** Whether node `i` is selected (display-only nodes past the real ones never are). */
export function isSelected(scene, i) {
  return !!scene.selected?.[i];
}

/**
 * A halo round each selected node: the exact outline of its shape pushed out by the gap (so corners come out
 * round), stroked. The WebGL painter draws the same ring as a distance field (HALO_FRAGMENT).
 */
export function drawHalos(ctx, scene) {
  const { graph, looks, camera, selected } = scene;
  if (!selected) return;
  ctx.setTransform(...worldTransform(scene));
  const width = HALO_WIDTH / camera.k;
  const offset = (HALO_GAP + HALO_WIDTH / 2) / camera.k;
  ctx.lineWidth = width;
  const count = Math.min(graph.nodes.length, selected.length);
  for (let i = 0; i < count; i++) {
    if (!selected[i]) continue;
    ctx.globalAlpha = nodeAlpha(scene, i);
    if (!ctx.globalAlpha) continue;
    const n = graph.nodes[i];
    ctx.strokeStyle = looks.fill[i];
    ctx.beginPath();
    haloPath(ctx, looks.shape[i], n.x, n.y, looks.radius[i], offset);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** The outline of a node's shape (centre x, y, radius r), pushed out by `o`. */
function haloPath(ctx, shape, x, y, r, o) {
  const polygon = (corners) => {
    // A convex polygon pushed out: each side moves out along its normal, each corner becomes an arc of radius o.
    const n = corners.length;
    for (let i = 0; i < n; i++) {
      const [px, py] = corners[(i + n - 1) % n],
        [cx, cy] = corners[i],
        [nx, ny] = corners[(i + 1) % n];
      ctx.arc(
        x + cx,
        y + cy,
        o,
        Math.atan2(-(cx - px), cy - py),
        Math.atan2(-(nx - cx), ny - cy),
      );
    }
    ctx.closePath();
  };
  switch (shape) {
    case "square":
      // Corners in order of increasing angle (clockwise on screen), so each arc turns the short way.
      return polygon([
        [r, r],
        [-r, r],
        [-r, -r],
        [r, -r],
      ]);
    case "rounded":
    case "tile":
      return ctx.roundRect(
        x - r - o,
        y - r - o,
        (r + o) * 2,
        (r + o) * 2,
        r * (shape === "tile" ? TILE_CORNER : ROUNDED_CORNER) + o,
      );
    case "diamond":
      return polygon([
        [r * 1.25, 0],
        [0, r * 1.25],
        [-r * 1.25, 0],
        [0, -r * 1.25],
      ]);
    case "hexagon":
      return polygon(
        Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          return [Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1];
        }),
      );
    case "ring":
      return ctx.arc(x, y, r + Math.max(1.5, r * 0.35) / 2 + o, 0, Math.PI * 2);
    default:
      ctx.arc(x, y, r + o, 0, Math.PI * 2);
  }
}

/** Fill the canvas with `colour`, or clear it to transparent when there's none. */
export function clearTo(ctx, { width, height, dpr }, colour) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (colour) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
  } else ctx.clearRect(0, 0, width * dpr, height * dpr);
}

/** The canvas transform from world coordinates to device pixels. */
function worldTransform({ camera, width, height, dpr }) {
  const k = camera.k * dpr;
  return [
    k,
    0,
    0,
    k,
    dpr * (width / 2 - camera.x * camera.k),
    dpr * (height / 2 - camera.y * camera.k),
  ];
}

/**
 * How visible things are: faded in (`scene.appear`, 0–1 per node, for nodes arriving) and lit or dimmed by hover
 * (`scene.shade`, 0–1 per node, 1 lit). `scene.dim` is how far a fully dimmed thing fades; edges and labels fade a
 * little further than nodes so the lit lineage stands out. Either array may be missing (everything 1).
 */
export function nodeAlpha(scene, i) {
  const appear = scene.appear ? scene.appear[i] : 1;
  const shade = scene.shade ? scene.shade[i] : 1;
  return appear * (1 - (scene.dim ?? 0.75) * (1 - shade));
}

export function labelAlpha(scene, i) {
  const appear = scene.appear ? scene.appear[i] : 1;
  const shade = scene.shade ? scene.shade[i] : 1;
  return (
    appear * (1 - Math.min(1, ((scene.dim ?? 0.75) * 0.8) / 0.75) * (1 - shade))
  );
}

export function edgeAlpha(scene, e) {
  const appear = scene.appear
    ? Math.min(scene.appear[e.source], scene.appear[e.target])
    : 1;
  const shade = scene.shade
    ? Math.min(scene.shade[e.source], scene.shade[e.target])
    : 1;
  return (
    appear *
    (1 - Math.min(1, ((scene.dim ?? 0.75) * 0.85) / 0.75) * (1 - shade))
  );
}

/** Edge brightness is drawn in steps of this, so edges at the same step can share a layer. */
const ALPHA_STEPS = 16;

/**
 * Edges go onto their own layer at full strength, and the layer onto the scene at the edge's brightness, so where
 * edges overlap (siblings sharing a trunk, the joints of a tapered edge) they don't add up to brighter lines. Edges
 * at different brightnesses (dimmed by hover, fading in) get a layer pass per brightness step. Fully opaque edges at
 * full brightness skip the layer.
 */
export function drawEdges(ctx, scene) {
  const { graph, routing, edge, looks } = scene;
  const world = worldTransform(scene);
  const junctions = edge.shape === "fan" ? fanJunctions(graph, routing) : null;
  const index = new Map(graph.edges.map((e, i) => [e, i]));
  const starts = startTrims(scene); // past each source's own label
  const draw = (target, e) =>
    drawEdge(
      target,
      edgeRoute(
        graph,
        routing,
        edge.shape,
        e,
        junctions && e.tree ? junctionAt(junctions, e.source) : null,
      ),
      edge,
      looks,
      graph.nodes[e.source],
      graph.nodes[e.target],
      index.get(e),
      starts[index.get(e)],
    );
  const style = (target) => {
    target.setTransform(...world);
    target.lineCap = "round";
    target.lineJoin = "round";
  };
  const groups = new Map();
  for (const e of graph.edges) {
    const step = Math.round(edgeAlpha(scene, e) * ALPHA_STEPS);
    if (!step) continue;
    const group = groups.get(step);
    if (group) group.push(e);
    else groups.set(step, [e]);
  }
  if (edge.opacity >= 1 && groups.size === 1 && groups.has(ALPHA_STEPS)) {
    style(ctx);
    for (const e of graph.edges) draw(ctx, e);
    return;
  }
  const layer = edgeLayer(ctx.canvas);
  for (const step of [...groups.keys()].sort((x, y) => x - y)) {
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    style(layer.ctx);
    for (const e of groups.get(step)) draw(layer.ctx, e);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = (edge.opacity * step) / ALPHA_STEPS;
    ctx.drawImage(layer.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
}

/**
 * Every node: its fill, its icon (from `icons`, once loaded, clipped to the shape), its border, its outline. Icons
 * still loading leave the node as it is without one.
 */
export function drawNodes(ctx, scene, icons = iconStore()) {
  const { graph, node, looks, camera } = scene;
  const background = scene.background ?? scene.theme?.background;
  ctx.setTransform(...worldTransform(scene));
  ctx.imageSmoothingQuality = "high";
  for (const n of graph.nodes) {
    const alpha = nodeAlpha(scene, n.index);
    if (!alpha) continue;
    const i = n.index;
    const r = looks.radius[i];
    const shape = looks.shape[i];
    let icon = null,
      shown = 0;
    if (shape !== "ring" && looks.icon?.[i]) {
      shown = iconShown(r, camera.k);
      const entry = shown > 0 ? icons.get(looks.icon[i]) : null;
      if (entry?.state === "ready") icon = entry;
      else shown = 0;
    }
    const look = {
      shape,
      outline: node.outline,
      n,
      r,
      fill: looks.fill[i],
      background,
      alpha,
      icon,
      shown,
      fit: looks.iconFit,
      stroke: looks.stroke?.[i] ?? null,
      strokeWidth: looks.strokeWidth?.[i] ?? 0,
    };
    const layered =
      alpha < 1 &&
      shape !== "ring" &&
      (shown > 0 || (look.stroke && look.strokeWidth > 0) || node.outline > 0);
    if (!layered) {
      drawNode(ctx, look);
      continue;
    }
    // Drawn whole on a layer, and the layer onto the canvas at the node's alpha: a faded node's fill doesn't show
    // through its icon or border (as the WebGL painter blends them before fading).
    const layer = edgeLayer(ctx.canvas, nodeLayers);
    const [a, , , d, e, f] = worldTransform(scene);
    const reachPx = (r * 1.25 + node.outline) * a + 2;
    const x0 = Math.max(0, Math.floor(n.x * a + e - reachPx)),
      y0 = Math.max(0, Math.floor(n.y * d + f - reachPx));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(n.x * a + e + reachPx)),
      y1 = Math.min(ctx.canvas.height, Math.ceil(n.y * d + f + reachPx));
    if (x1 <= x0 || y1 <= y0) continue;
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    layer.ctx.setTransform(...worldTransform(scene));
    layer.ctx.imageSmoothingQuality = "high";
    drawNode(layer.ctx, { ...look, alpha: 1 });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    const w = x1 - x0,
      h = y1 - y0;
    ctx.drawImage(layer.canvas, x0, y0, w, h, x0, y0, w, h);
    ctx.setTransform(...worldTransform(scene));
  }
  ctx.globalAlpha = 1;
}

/** Layers for drawing faded nodes whole (see drawNodes), one per canvas. */
const nodeLayers = new WeakMap();

/**
 * Whether labels show at this zoom. Labels with room kept for them (label collision) show until their text is
 * smaller than LABEL_MIN_PX (a smudge, and with a whole big graph in view, tens of thousands of them to rasterise);
 * others drop out when too small to read (6 px).
 */
export function labelsShown(node, camera) {
  if (node.labels === "off") return false;
  return node.labelSize * camera.k >= (node.labelCollide ? LABEL_MIN_PX : 6);
}

/** Text smaller than this many CSS px is never drawn. */
export const LABEL_MIN_PX = 2;

/** Each canvas's text measurement (and label fitting), kept with it. */
const fitters = new WeakMap();

/**
 * All the text (labels.js plans it: node and edge labels, counts, badges, pinned labels), each piece with its halo
 * (or pill) under it, for what's on or near the screen.
 */
export function drawLabels(ctx, scene) {
  const { node, camera, width, height } = scene;
  let fitter = fitters.get(ctx);
  if (!fitter) {
    const widths = new Map();
    const measure = (text, size) => {
      const key = `${size}|${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        if (widths.size > 50000) widths.clear();
        ctx.font = font(size);
        w = ctx.measureText(text).width;
        widths.set(key, w);
      }
      return w;
    };
    fitter = { measure, fit: textFitter(measure) };
    fitters.set(ctx, fitter);
  }
  const k = camera.k;
  // The view, and room round it for text reaching in from nodes just outside.
  const margin = (node.labelMaxWidth || 400) + 40;
  const near = {
    x0: camera.x - width / 2 / k - margin,
    x1: camera.x + width / 2 / k + margin,
    y0: camera.y - height / 2 / k - margin,
    y1: camera.y + height / 2 / k + margin,
  };
  const items = planText(scene, { fit: fitter.fit, near });
  if (!items.length) return;
  ctx.setTransform(...worldTransform(scene));
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const item of items) {
    const u = item.screen ? 1 / k : 1; // world px per unit
    const box = textBox(item, fitter.measure(item.text, item.size));
    const size = item.size * u;
    const y = item.y + box.middle * u;
    ctx.globalAlpha = item.alpha;
    ctx.font = font(size);
    if (item.pill) {
      ctx.fillStyle = item.under;
      ctx.beginPath();
      ctx.roundRect(
        item.x + box.left * u,
        y - (box.height * u) / 2,
        box.width * u,
        box.height * u,
        (box.height * u) / 2,
      );
      ctx.fill();
    } else {
      ctx.strokeStyle = item.under;
      ctx.lineWidth = 2 * TEXT_HALO * size;
      ctx.strokeText(item.text, item.x + box.text * u, y);
    }
    ctx.fillStyle = item.colour;
    ctx.fillText(item.text, item.x + box.text * u, y);
  }
  ctx.globalAlpha = 1;
}

/**
 * The link glyph inside each reference chip big enough to show one: two interlocked links, turned 45°, in the
 * chip's colour (references.js, LINK). The WebGL painter draws the same as a distance field.
 */
export function drawGlyphs(ctx, scene) {
  const glyphs = linkGlyphs(scene);
  if (!glyphs.length) return;
  const world = worldTransform(scene);
  for (const g of glyphs) {
    ctx.globalAlpha = nodeAlpha(scene, g.index);
    if (!ctx.globalAlpha) continue;
    const R = g.radius;
    ctx.setTransform(...world);
    ctx.translate(g.x, g.y);
    ctx.rotate(-Math.PI / 4);
    ctx.strokeStyle = g.colour;
    ctx.lineWidth = LINK.stroke * R;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(
        (side * LINK.offset - LINK.length / 2) * R,
        (-LINK.height / 2) * R,
        LINK.length * R,
        LINK.height * R,
        (LINK.height / 2) * R,
      );
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function junctionAt(junctions, index) {
  const x = junctions[index * 2];
  return Number.isNaN(x) ? null : { x, y: junctions[index * 2 + 1] };
}

/** An offscreen canvas the size of `canvas`, kept with it. */
const layers = new WeakMap();
function edgeLayer(canvas, kept = layers) {
  let layer = kept.get(canvas);
  if (!layer) {
    const off = document.createElement("canvas");
    layer = { canvas: off, ctx: off.getContext("2d") };
    kept.set(canvas, layer);
  }
  if (layer.canvas.width !== canvas.width) layer.canvas.width = canvas.width;
  if (layer.canvas.height !== canvas.height)
    layer.canvas.height = canvas.height;
  return layer;
}

function drawEdge(ctx, route, edge, looks, s, t, ei, from) {
  const end = edge.arrow === "none" ? 0 : edge.arrowSize * 0.9;
  const pts = trim(route, from, looks.radius[t.index] + end);
  if (!pts) return;
  const colour = looks.edgeColour[ei];
  const width = looks.edgeWidth[ei];
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;

  if (edge.taper) {
    // Segment by segment, narrowing along the length.
    let total = 0;
    for (let i = 2; i < pts.length; i += 2)
      total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    let walked = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const len = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      const f = (walked + len / 2) / total;
      walked += len;
      ctx.lineWidth = width * (2 - 1.7 * f);
      ctx.beginPath();
      ctx.moveTo(pts[i - 2], pts[i - 1]);
      ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = width;
    ctx.beginPath();
    roundedPolyline(ctx, pts, edge.corner);
    ctx.stroke();
  }

  if (edge.arrow !== "none") {
    const n = pts.length;
    const x = pts[n - 2],
      y = pts[n - 1];
    const a = Math.atan2(y - pts[n - 3], x - pts[n - 4]);
    const size = edge.arrowSize;
    ctx.beginPath();
    if (edge.arrow === "dot") {
      ctx.arc(
        x + Math.cos(a) * size * 0.45,
        y + Math.sin(a) * size * 0.45,
        size * 0.45,
        0,
        Math.PI * 2,
      );
    } else {
      const tipX = x + Math.cos(a) * end,
        tipY = y + Math.sin(a) * end;
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX - Math.cos(a - 0.45) * size,
        tipY - Math.sin(a - 0.45) * size,
      );
      ctx.lineTo(
        tipX - Math.cos(a + 0.45) * size,
        tipY - Math.sin(a + 0.45) * size,
      );
      ctx.closePath();
    }
    ctx.fill();
  }
}

/** A polyline whose corners are rounded by up to `radius` (never more than half the shorter neighbour). */
function roundedPolyline(ctx, pts, radius) {
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const before = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    const after = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    const r = Math.min(radius, before / 2, after / 2);
    if (r > 0.5) ctx.arcTo(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], r);
    else ctx.lineTo(pts[i], pts[i + 1]);
  }
  ctx.lineTo(pts.at(-2), pts.at(-1));
}

/**
 * One node, at `alpha`. In order: its fill (a tile's fades out as its icon fades in: the icon is the tile), its icon
 * in its box (iconBox) clipped to the shape, its border (`strokeWidth` inside the shape's edge, so the node takes no
 * more room), and the outline. A ring is a stroke round the background, nothing else.
 */
function drawNode(ctx, look) {
  const { shape, outline, n, r, fill, background, alpha, icon, shown } = look;
  const { x, y } = n;
  ctx.beginPath();
  nodePath(ctx, shape, x, y, r);
  if (shape === "ring") {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = background;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.35);
    ctx.strokeStyle = fill;
    ctx.stroke();
    return;
  }
  const fillShown = shape === "tile" && icon ? 1 - shown : 1;
  if (fillShown > 0) {
    ctx.globalAlpha = alpha * fillShown;
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (icon && shown > 0) {
    const [hx, hy] = iconBox(
      shape,
      look.fit,
      icon.width / icon.height,
      r,
      look.strokeWidth,
    );
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = alpha * shown;
    ctx.drawImage(icon.image, x - hx, y - hy, hx * 2, hy * 2);
    ctx.restore();
  }
  ctx.globalAlpha = alpha;
  if (look.stroke && look.strokeWidth > 0) {
    // Twice as wide, clipped to the shape: the inner half is the border.
    ctx.save();
    ctx.clip();
    ctx.lineWidth = look.strokeWidth * 2;
    ctx.strokeStyle = look.stroke;
    ctx.stroke();
    ctx.restore();
  }
  if (outline > 0) {
    ctx.lineWidth = outline;
    ctx.strokeStyle = background;
    ctx.stroke();
  }
}

/** A node's outline as a path (centre x, y, radius r). */
function nodePath(ctx, shape, x, y, r) {
  switch (shape) {
    case "square":
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "rounded":
    case "tile":
      ctx.roundRect(
        x - r,
        y - r,
        r * 2,
        r * 2,
        r * (shape === "tile" ? TILE_CORNER : ROUNDED_CORNER),
      );
      break;
    case "diamond":
      ctx.moveTo(x, y - r * 1.25);
      ctx.lineTo(x + r * 1.25, y);
      ctx.lineTo(x, y + r * 1.25);
      ctx.lineTo(x - r * 1.25, y);
      ctx.closePath();
      break;
    case "hexagon":
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        ctx.lineTo(x + Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 1.1);
      }
      ctx.closePath();
      break;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** The Canvas 2D painter: everything on the renderer's canvas. Also the reference the WebGL painter is checked against. */
export class CanvasPainter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ icons?: import("./icons.js").IconStore }} [options] where icons come from (default: the page's shared
   *   store)
   */
  constructor(canvas, { icons = iconStore() } = {}) {
    this.name = "canvas";
    this.ctx = canvas.getContext("2d");
    this.icons = icons;
    /** Set by the renderer: asks for a frame (an icon came in). */
    this.wake = null;
    this.unlisten = icons.onReady(() => this.wake?.());
  }

  resize() {}

  draw(scene) {
    drawScene(this.ctx, scene, this.icons);
  }

  dispose() {
    this.unlisten();
  }
}
