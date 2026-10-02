// Canvas 2D drawing. Deliberately plain for now: the look is what's being worked out, speed comes later.

import {
  END_ROOM,
  endRooms,
  fanJunctions,
  pathLength,
  rounded,
  startTrims,
  trimmedRoute,
} from "./geometry.js";
import { TEXT_HALO, font, planText, textBox, textMeasurer } from "./labels.js";
import { LINK, linkGlyphs } from "./references.js";
import {
  ROUNDED_CORNER,
  TILE_CORNER,
  iconBox,
  iconShown,
  iconStore,
} from "./icons.js";
import { CARD, cardBox } from "./cards.js";
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
 * @property {any[]} badgeIcon         per node, its badge image: a URL or an image (null: none)
 * @property {Uint8Array} strokeStyle  per node, its border's dashes: 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
 * @property {Float64Array} opacity    per node, its fill's opacity, 0–1
 * @property {(string | null)[]} ring  per node, a ring's colour (null: none)
 * @property {(string | null)[]} aura  per node, a glow's colour (null: none)
 * @property {Uint8Array} stack        per node, 1 for a stacked copy behind it
 * @property {ReturnType<typeof cardBox> | null} card a card's box, when nodes are cards (the `look` node option)
 * @property {string[]} edgeColour     per edge
 * @property {Float64Array} edgeWidth  per edge, world px
 * @property {Uint8Array} edgeDash     per edge, 0 solid, 1 dashed, 2 dotted (STROKE_STYLES)
 * @property {Uint8Array} edgeGlow     per edge, 1 for a glow along it
 * @property {{ colour: string, width: number, byTarget: boolean, bySource: boolean, dash: number }} edgeDefault an
 *   edge's look without a style of its own
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
 * @property {boolean} [copy]    a reference drawn as a whole copy of its ingredient (a split)
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
    badgeIcon: new Array(count),
    strokeStyle: new Uint8Array(count),
    opacity: new Float64Array(count),
    ring: new Array(count),
    aura: new Array(count),
    stack: new Uint8Array(count),
    card: node.look === "card" ? cardBox(node) : null,
    edgeColour: new Array(graph.edges.length),
    edgeWidth: new Float64Array(graph.edges.length),
    edgeDash: new Uint8Array(graph.edges.length),
    edgeGlow: new Uint8Array(graph.edges.length),
    edgeDefault: {
      colour: edge.color === EDGE_COLOUR_DEFAULT ? theme.edge : edge.color,
      width: edge.width,
      byTarget: edge.colorBy === "target",
      bySource: edge.colorBy === "source",
      dash: STROKE_STYLES[edge.dash] ?? 0,
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
 * a few elements costs what they do, not the whole graph. Edges coloured by their child (or parent) follow it.
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
  if (looks.edgeDefault.bySource && graph.outgoing)
    for (const i of doneNodes)
      for (const e of graph.outgoing[i]) doneEdges.add(e);
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
  looks.radius[i] = looks.card
    ? looks.card.icon
    : style.size !== undefined
      ? style.size / 2
      : (node.size / 2) * scale;
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
  looks.badgeIcon[i] = style.badgeIcon ?? null;
  looks.strokeStyle[i] = STROKE_STYLES[style.strokeStyle] ?? 0;
  looks.opacity[i] = style.opacity ?? 1;
  looks.ring[i] = style.ring ?? null;
  looks.aura[i] = style.aura ?? null;
  looks.stack[i] = style.stack ? 1 : 0;
}

/** A border's dash styles, as the ids looks and the node shader use. */
export const STROKE_STYLES = { solid: 0, dashed: 1, dotted: 2 };

/**
 * The marks round a node, in proportion to its radius r (world px), with a floor so small nodes still show them:
 * the ring (gap outside the shape, and width), the aura's reach, the stacked copy's shift (right and up), the badge
 * image (its centre along the top-right diagonal, and radius), and the border's dashes (how many round the shape,
 * and the part of each that's drawn). The WebGL painter's shader reads the same numbers.
 */
export const MARKS = {
  ringGap: 0.22,
  ringGapMin: 2,
  ringWidth: 0.14,
  ringWidthMin: 1.5,
  auraReach: 0.7,
  auraReachMin: 6,
  stackShift: 0.3,
  badgeAt: 0.78,
  badgeRadius: 0.42,
  dashes: 12,
  dashOn: 0.55,
  dots: 24,
  dotOn: 0.4,
};

/** A ring's gap outside the shape and its width, for radius r. */
export const ringOf = (r) => [
  Math.max(MARKS.ringGapMin, r * MARKS.ringGap),
  Math.max(MARKS.ringWidthMin, r * MARKS.ringWidth),
];

/** How far an aura reaches past the shape, for radius r. */
export const auraOf = (r) => Math.max(MARKS.auraReachMin, r * MARKS.auraReach);

function edgeLook(looks, e, i, edge) {
  const d = looks.edgeDefault;
  looks.edgeColour[i] =
    e.style?.color ??
    (d.byTarget
      ? looks.fill[e.target]
      : d.bySource
        ? looks.fill[e.source]
        : d.colour);
  looks.edgeWidth[i] = e.style?.width ?? edge.width;
  looks.edgeDash[i] = STROKE_STYLES[e.style?.dash] ?? d.dash;
  looks.edgeGlow[i] = e.style?.glow ? 1 : 0;
}

/**
 * How edges are dashed and dotted: a dash's period (world px: at least dashMin, or dashPerWidth times the edge's
 * width) and the part of it that's drawn; a dot's spacing likewise. Both painters use these.
 */
export const EDGE_DASH = {
  dashMin: 6,
  dashPerWidth: 5,
  dashOn: 0.6,
  dotMin: 3,
  dotPerWidth: 2.5,
};

/** For an edge `width` wide (world px): its dash period and the part drawn, and its dot spacing. */
export function edgeDashes(width) {
  return {
    dashPeriod: Math.max(EDGE_DASH.dashMin, width * EDGE_DASH.dashPerWidth),
    dashOn: EDGE_DASH.dashOn,
    dotPeriod: Math.max(EDGE_DASH.dotMin, width * EDGE_DASH.dotPerWidth),
  };
}

/**
 * Pulses running along a lit lineage's edges (the `flow` animation option): one every `period` world px, `on` of
 * it long, moving at `speed` world px a second times the flowSpeed option; drawn `widen` times the edge's width,
 * `whiten` of the way to white.
 */
export const FLOW = {
  period: 48,
  on: 0.18,
  speed: 70,
  widen: 1.8,
  whiten: 0.55,
};

/** How far the flow's pattern has moved at `scene.time`, world px (within one period), and which way (1: to targets). */
export function flowShift(scene) {
  const anim = scene.anim;
  const sign = anim?.flow === "source" ? -1 : 1;
  const travelled =
    (((scene.time ?? 0) / 1000) * FLOW.speed * (anim?.flowSpeed ?? 1)) %
    FLOW.period;
  return { shift: travelled, sign };
}

/** The last edgeLineage worked out, and what for. */
let lineageMemo = null;

/**
 * What the lit lineage (`scene.lineage`) does to each edge of the display graph, or null when it does nothing: 1
 * coloured as going up (the theme's `ancestors`), 2 as going down (`descendants`), with the lineageColor animation
 * option; plus 4 when pulses run along it (`flow`). An edge is in the lineage when both its ends are; a reference
 * chip counts as its ingredient.
 * @returns {Uint8Array | null}
 */
export function edgeLineage(scene) {
  const { lineage, graph, anim } = scene;
  const tint = anim?.lineageColor === "direction";
  const flow = !!anim?.flow && anim.flow !== "off";
  if (!lineage || (!tint && !flow)) return null;
  const m = lineageMemo;
  if (
    m &&
    m.lineage === lineage &&
    m.edges === graph.edges &&
    m.tint === tint &&
    m.flow === flow
  )
    return m.out;
  const real = lineage.length;
  const realOf = (i) => {
    const r = graph.nodes[i]?.reference;
    return r !== undefined ? r : i < real ? i : -1;
  };
  const out = new Uint8Array(graph.edges.length);
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const e = graph.edges[ei];
    if (e.ghost) continue;
    const s = realOf(e.source),
      t = realOf(e.target);
    if (s < 0 || t < 0) continue;
    const a = lineage[s],
      b = lineage[t];
    if (!a || !b) continue;
    let code = flow ? 4 : 0;
    if (tint) code |= a & 2 && b & 2 ? 1 : a & 4 && b & 4 ? 2 : 0;
    out[ei] = code;
  }
  lineageMemo = { lineage, edges: graph.edges, tint, flow, out };
  return out;
}

/** How far an edge's glow reaches past its side, for an edge `width` wide (world px), and how strong it starts. */
export const glowReach = (width) => Math.max(2.5, width * 1.5);
export const GLOW_ALPHA = 0.45;

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
 * Draw one whole frame on one 2D canvas (the Canvas 2D painter's): background, edges, nodes, selection halos, the
 * reference chips' link glyphs, text.
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
/** How far apart, CSS px, halos round the same node sit (a highlight outside the selection's, a flash outside both). */
export const HALO_STEP = 4;
/** How far a pulse's ring spreads, CSS px. */
export const PULSE_REACH = 14;

/**
 * @typedef {object} Halo A ring round a node (haloList).
 * @property {number} index  the node
 * @property {string} colour "#rrggbb"
 * @property {number} alpha  0–1, before the node's own visibility
 * @property {number} gap    CSS px further out than a selection's halo
 */

/**
 * Every halo to draw, in order: the selection's (in each node's colour), the highlight's (the theme's `highlight`,
 * outside the selection's), flashes (the theme's `focus`, outside both, fading in and out) and pulses (the node's
 * colour, spreading out as they fade).
 * @returns {Halo[]}
 */
export function haloList(scene) {
  const { graph, looks, selected, highlighted, flashes, pulses } = scene;
  const theme = scene.theme ?? DEFAULT_THEME;
  const real = graph.nodes.length;
  const out = [];
  const each = (values, add) => {
    if (!values) return;
    const count = Math.min(values.length, real);
    for (let i = 0; i < count; i++) if (values[i]) add(i, values[i]);
  };
  each(selected, (i) =>
    out.push({ index: i, colour: looks.fill[i], alpha: 1, gap: 0 }),
  );
  each(highlighted, (i) =>
    out.push({
      index: i,
      colour: theme.highlight,
      alpha: 1,
      gap: selected?.[i] ? HALO_STEP : 0,
    }),
  );
  each(flashes, (i, f) =>
    out.push({ index: i, colour: theme.focus, alpha: f, gap: HALO_STEP * 2 }),
  );
  each(pulses, (i, t) =>
    out.push({
      index: i,
      colour: looks.fill[i],
      alpha: 1 - t,
      gap: t * PULSE_REACH,
    }),
  );
  return out;
}

/**
 * The halos (haloList): each the exact outline of its node's shape pushed out by its gap (so corners come out
 * round), stroked. The WebGL painter draws the same rings as distance fields (HALO_FRAGMENT).
 */
export function drawHalos(ctx, scene) {
  const halos = haloList(scene);
  if (!halos.length) return;
  const { graph, looks, camera } = scene;
  ctx.setTransform(...worldTransform(scene));
  ctx.lineWidth = HALO_WIDTH / camera.k;
  for (const h of halos) {
    const i = h.index;
    ctx.globalAlpha = nodeAlpha(scene, i) * h.alpha;
    if (!ctx.globalAlpha) continue;
    const n = graph.nodes[i];
    ctx.strokeStyle = h.colour;
    ctx.beginPath();
    const card = isCard(scene, i) ? looks.card : null;
    haloPath(
      ctx,
      card ? "card" : looks.shape[i],
      n.x,
      n.y,
      looks.radius[i],
      (HALO_GAP + h.gap + HALO_WIDTH / 2) / camera.k,
      card,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * The outline of a node's shape (centre x, y, radius r), pushed out by `o` (0: the shape itself). Shape "card" is
 * a card's box (`card`, from cardBox).
 */
function haloPath(ctx, shape, x, y, r, o, card = null) {
  if (shape === "card" && card)
    return ctx.roundRect(
      x + card.x - o,
      y + card.y - o,
      card.width + o * 2,
      card.height + o * 2,
      CARD.corner + o,
    );
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

/** How many of the scene's display nodes are real (the rest are references and ghosts). */
export const realCount = (scene) =>
  Math.min(scene.matrix?.count ?? Infinity, scene.graph.nodes.length);

/** Whether display node `i` is drawn as a card: cards on, and a real node or a copy of one (not a chip or ghost). */
export const isCard = (scene, i) =>
  !!scene.looks.card && (i < realCount(scene) || !!scene.graph.nodes[i]?.copy);

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
  return fade(scene, i, i, scene.dim ?? 0.75);
}

export function labelAlpha(scene, i) {
  return fade(scene, i, i, Math.min(1, ((scene.dim ?? 0.75) * 0.8) / 0.75));
}

export function edgeAlpha(scene, e) {
  const dim = Math.min(1, ((scene.dim ?? 0.75) * 0.85) / 0.75);
  return fade(scene, e.source, e.target, dim);
}

/** Between nodes `i` and `j` (the later to appear, the less lit), faded in, and `dim` of the way down when unlit. */
function fade({ appear, shade }, i, j, dim) {
  const a = appear ? Math.min(appear[i], appear[j]) : 1;
  const s = shade ? Math.min(shade[i], shade[j]) : 1;
  return a * (1 - dim * (1 - s));
}

/** Edge brightness is drawn in steps of this, so edges at the same step can share a layer. */
const ALPHA_STEPS = 16;

/**
 * Edges go onto their own layer at full strength, and the layer onto the scene at the edge's brightness, so where
 * edges overlap (siblings sharing a trunk, the joints of a tapered edge) they don't add up to brighter lines. Edges
 * at different brightnesses (dimmed by hover, fading in) get a layer pass per brightness step. Fully opaque edges at
 * full brightness skip the layer.
 */
function drawEdges(ctx, scene) {
  const { graph, routing, edge, looks } = scene;
  const world = worldTransform(scene);
  const junctions = edge.shape === "fan" ? fanJunctions(graph, routing) : null;
  const starts = startTrims(scene); // past each source's own label
  const lineage = edgeLineage(scene);
  const theme = scene.theme ?? DEFAULT_THEME;
  const flow = lineage ? flowShift(scene) : null;
  const draw = (target, ei) => {
    const code = lineage?.[ei] ?? 0;
    drawEdge(
      target,
      trimmedRoute(scene, ei, junctions, starts),
      edge,
      looks,
      ei,
      (code & 3) === 1
        ? theme.ancestors
        : (code & 3) === 2
          ? theme.descendants
          : null,
      code & 4 ? flow : null,
    );
  };
  const style = (target) => {
    target.setTransform(...world);
    target.lineCap = "round";
    target.lineJoin = "round";
  };
  const groups = new Map(); // edge indices by brightness step
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const step = Math.round(edgeAlpha(scene, graph.edges[ei]) * ALPHA_STEPS);
    if (!step) continue;
    const group = groups.get(step);
    if (group) group.push(ei);
    else groups.set(step, [ei]);
  }
  if (edge.opacity >= 1 && groups.size === 1 && groups.has(ALPHA_STEPS)) {
    style(ctx);
    for (let ei = 0; ei < graph.edges.length; ei++) draw(ctx, ei);
    return;
  }
  const layer = edgeLayer(ctx.canvas);
  for (const step of [...groups.keys()].sort((x, y) => x - y)) {
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    style(layer.ctx);
    for (const ei of groups.get(step)) draw(layer.ctx, ei);
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
    let badge = null,
      badgeShown = 0;
    if (looks.badgeIcon?.[i]) {
      badgeShown = iconShown(r * MARKS.badgeRadius, camera.k);
      const entry = badgeShown > 0 ? icons.get(looks.badgeIcon[i]) : null;
      if (entry?.state === "ready") badge = entry;
      else badgeShown = 0;
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
      strokeStyle: looks.strokeStyle?.[i] ?? 0,
      opacity: looks.opacity?.[i] ?? 1,
      ring: looks.ring?.[i] ?? null,
      aura: looks.aura?.[i] ?? null,
      stack: looks.stack?.[i] ?? 0,
      badge,
      badgeShown,
      card: isCard(scene, i) ? looks.card : null,
      theme: scene.theme ?? DEFAULT_THEME,
    };
    const marked = !!(
      look.ring ||
      look.aura ||
      look.stack ||
      look.card ||
      badgeShown > 0
    );
    const layered =
      alpha < 1 &&
      (marked ||
        (shape !== "ring" &&
          (shown > 0 ||
            (look.stroke && look.strokeWidth > 0) ||
            node.outline > 0)));
    if (!layered) {
      drawNode(ctx, look);
      continue;
    }
    // Drawn whole on a layer, and the layer onto the canvas at the node's alpha: a faded node's fill doesn't show
    // through its icon or border (as the WebGL painter blends them before fading).
    const layer = edgeLayer(ctx.canvas, nodeLayers);
    const [a, , , d, e, f] = worldTransform(scene);
    const reachPx = (nodeReach(look) + node.outline) * a + 2;
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

/** Each canvas's text measurement (and label fitting), kept with it. */
const fitters = new WeakMap();

/**
 * All the text (labels.js plans it: node and edge labels, counts, badges, pinned labels), each piece with its halo
 * (or pill) under it, for what's on or near the screen.
 */
function drawLabels(ctx, scene) {
  const { node, camera, width, height } = scene;
  let fitter = fitters.get(ctx);
  if (!fitter) fitters.set(ctx, (fitter = textMeasurer(ctx)));
  const k = camera.k;
  // The view, and room round it for text reaching in from nodes just outside.
  const margin = (node.labelMaxWidth || 400) + 40;
  const near = {
    x0: camera.x - width / 2 / k - margin,
    x1: camera.x + width / 2 / k + margin,
    y0: camera.y - height / 2 / k - margin,
    y1: camera.y + height / 2 / k + margin,
  };
  const items = planText(scene, {
    fit: fitter.fit,
    measure: fitter.measure,
    near,
  });
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
    ctx.font = font(size, item.bold);
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
function drawGlyphs(ctx, scene) {
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

/**
 * Edge `ei` along `pts` (trimmedRoute), dashed or dotted by its look, with its glow and its ends; in `colour` when
 * given (a lit lineage's), with the flow's pulses running along it when `flow` is (flowShift).
 */
function drawEdge(ctx, pts, edge, looks, ei, colour = null, flow = null) {
  if (!pts) return;
  colour ??= looks.edgeColour[ei];
  const width = looks.edgeWidth[ei];
  const dash = looks.edgeDash?.[ei] ?? 0;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  const dashes = edgeDashes(width);
  // A dot is a dash of no length with round caps; a dash has square ends.
  const pattern =
    dash === 1
      ? [
          dashes.dashPeriod * dashes.dashOn,
          dashes.dashPeriod * (1 - dashes.dashOn),
        ]
      : dash === 2
        ? [0, dashes.dotPeriod]
        : [];
  const line = (lineWidth, offset = 0) => {
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(pattern);
    ctx.lineDashOffset = -offset;
    ctx.lineCap = dash === 1 ? "butt" : "round";
  };

  if (looks.edgeGlow?.[ei]) {
    // A wide, faint stroke under the edge, in its colour.
    const reach = glowReach(width);
    ctx.save();
    ctx.globalAlpha *= GLOW_ALPHA / 2;
    ctx.lineWidth = width + reach * 2;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    const glow = rounded(pts, edge.corner);
    for (let i = 0; i < glow.length; i += 2) ctx.lineTo(glow[i], glow[i + 1]);
    ctx.stroke();
    ctx.restore();
  }

  if (edge.taper) {
    // Segment by segment, narrowing along the length; the dashes carry on from one segment to the next.
    const total = pathLength(pts);
    let walked = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const len = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      const f = (walked + len / 2) / total;
      line(width * (2 - 1.7 * f), walked);
      walked += len;
      ctx.beginPath();
      ctx.moveTo(pts[i - 2], pts[i - 1]);
      ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
  } else {
    line(width);
    ctx.beginPath();
    const path = rounded(pts, edge.corner);
    for (let i = 0; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.lineCap = "round";

  if (flow) {
    // The pulses: short, wide, whitened dashes moving along the edge.
    ctx.save();
    ctx.strokeStyle = mixHex(colour, "#ffffff", FLOW.whiten);
    ctx.lineWidth = width * FLOW.widen;
    ctx.lineCap = "butt";
    ctx.setLineDash([FLOW.period * FLOW.on, FLOW.period * (1 - FLOW.on)]);
    ctx.lineDashOffset = -flow.sign * flow.shift;
    ctx.beginPath();
    const path = rounded(pts, edge.corner);
    for (let i = 0; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
    ctx.stroke();
    ctx.restore();
  }

  const ends = endRooms(edge);
  const n = pts.length;
  if (ends.target > 0)
    drawEnd(ctx, edge, pts[n - 2], pts[n - 1], pts[n - 4], pts[n - 3]);
  if (ends.source > 0) drawEnd(ctx, edge, pts[0], pts[1], pts[2], pts[3]);
}

/** An edge's end (an arrow or a dot) at x, y, pointing away from px, py (the point before it on the edge). */
function drawEnd(ctx, edge, x, y, px, py) {
  const a = Math.atan2(y - py, x - px);
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
    const end = size * END_ROOM;
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

/** How far node `look` reaches from its centre, marks and all, world px. */
function nodeReach(look) {
  const { r, shape } = look;
  if (look.card) {
    const c = look.card;
    const far =
      Math.max(c.width + c.x, c.half) +
      Math.max(auraOf(c.half), c.half * MARKS.stackShift * 1.5);
    return far;
  }
  let reach = r * (shape === "diamond" ? 1.25 : shape === "hexagon" ? 1.1 : 1);
  if (shape === "ring") reach += Math.max(1.5, r * 0.35) / 2;
  let out = reach;
  if (look.aura) out = Math.max(out, reach + auraOf(r));
  if (look.ring) {
    const [gap, width] = ringOf(r);
    out = Math.max(out, reach + gap + width);
  }
  if (look.stack) out = Math.max(out, reach + r * MARKS.stackShift * 1.5);
  if (look.badgeShown > 0)
    out = Math.max(out, r * (MARKS.badgeAt + MARKS.badgeRadius) * Math.SQRT2);
  return out;
}

/** About how long a shape's outline is (for spacing a dashed border evenly round it). */
function perimeter(shape, r, card = null) {
  switch (shape) {
    case "card":
      return 2 * (card.width + card.height);
    case "square":
      return 8 * r;
    case "rounded":
    case "tile": {
      const c = r * (shape === "tile" ? TILE_CORNER : ROUNDED_CORNER);
      return 8 * (r - c) + 2 * Math.PI * c;
    }
    case "diamond":
      return 4 * Math.SQRT2 * r * 1.25;
    case "hexagon":
      return 6 * r * 1.1;
    default:
      return 2 * Math.PI * r;
  }
}

/** The Canvas 2D dash pattern for a border style (STROKE_STYLES) round a shape of radius r, or [] for solid. */
export function dashPattern(style, shape, r, card = null) {
  if (!style) return [];
  const on = style === 1 ? MARKS.dashOn : MARKS.dotOn;
  // A card's dashes keep a node's spacing (about), however long the card is.
  const count =
    (style === 1 ? MARKS.dashes : MARKS.dots) *
    (shape === "card" ? perimeter(shape, r, card) / (2 * Math.PI * r) : 1);
  const period = perimeter(shape, r, card) / Math.round(count);
  return [period * on, period * (1 - on)];
}

/** How many rings the Canvas 2D painter builds an aura from, and how strong an aura is at the shape's edge. */
export const AURA_RINGS = 10;
export const AURA_ALPHA = 0.6;

/**
 * One node, at `alpha`. In order: its aura, the stacked copy behind it, its ring; then its fill (at its `opacity`;
 * a tile's fades out as its icon fades in: the icon is the tile), its icon in its box (iconBox) clipped to the
 * shape, its border (`strokeWidth` inside the shape's edge, so the node takes no more room; dashed or dotted by
 * `strokeStyle`), the outline, and its badge image on top. A ring shape is a stroke round the background.
 */
function drawNode(ctx, look) {
  const { shape, outline, n, r, fill, background, alpha, icon, shown } = look;
  const { x, y } = n;
  const card = look.card;
  const outer = card ? "card" : shape === "ring" ? "circle" : shape;
  // A ring's stroke reaches past its circle: marks are measured from its outside.
  const pad = !card && shape === "ring" ? Math.max(1.5, r * 0.35) / 2 : 0;
  // A card's marks are sized by the card, not its icon.
  const mr = card ? card.half : r;
  if (look.aura) {
    // Rings of falling strength, outermost first: a glow that fades out as it reaches away.
    const reach = auraOf(mr);
    ctx.fillStyle = look.aura;
    ctx.globalAlpha = (alpha * AURA_ALPHA) / AURA_RINGS;
    for (let k = AURA_RINGS; k >= 1; k--) {
      ctx.beginPath();
      haloPath(ctx, outer, x, y, r, pad + (reach * k) / AURA_RINGS, card);
      ctx.fill();
    }
  }
  if (look.stack) {
    const shift = mr * MARKS.stackShift;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = mixHex(fill, background, STACK_FADE);
    ctx.beginPath();
    haloPath(ctx, outer, x + shift, y - shift, r, pad, card);
    ctx.fill();
  }
  if (look.ring) {
    const [gap, width] = ringOf(mr);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.strokeStyle = look.ring;
    ctx.beginPath();
    haloPath(ctx, outer, x, y, r, pad + gap + width / 2, card);
    ctx.stroke();
  }
  if (card) drawCard(ctx, look);
  ctx.beginPath();
  haloPath(ctx, shape === "ring" ? "circle" : shape, x, y, r, 0);
  if (shape === "ring") {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = background;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.35);
    ctx.strokeStyle = fill;
    ctx.setLineDash(dashPattern(look.strokeStyle, "circle", r));
    ctx.stroke();
    ctx.setLineDash([]);
    drawBadge(ctx, look);
    return;
  }
  const fillShown = (shape === "tile" && icon ? 1 - shown : 1) * look.opacity;
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
  // A card wears the border on its face (drawCard), not round its icon.
  if (look.stroke && look.strokeWidth > 0 && !card) {
    // Twice as wide, clipped to the shape: the inner half is the border.
    ctx.save();
    ctx.clip();
    ctx.lineWidth = look.strokeWidth * 2;
    ctx.strokeStyle = look.stroke;
    ctx.setLineDash(dashPattern(look.strokeStyle, shape, r));
    ctx.stroke();
    ctx.restore();
  }
  if (outline > 0) {
    ctx.lineWidth = outline;
    ctx.strokeStyle = background;
    ctx.stroke();
  }
  drawBadge(ctx, look);
}

/**
 * A card's face, under its icon: the theme's card colour (at the node's `opacity`), a stripe in the node's colour
 * down its left edge, and a border, dashed or dotted by the node's `strokeStyle` and in its `stroke` colour when
 * it has one (the theme's card border when not).
 */
function drawCard(ctx, look) {
  const { n, card, alpha, fill, theme } = look;
  const x = n.x + card.x,
    y = n.y + card.y;
  ctx.globalAlpha = alpha * look.opacity;
  ctx.fillStyle = theme.card;
  ctx.beginPath();
  ctx.roundRect(x, y, card.width, card.height, CARD.corner);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, CARD.stripe, card.height);
  ctx.restore();
  ctx.globalAlpha = alpha;
  const stroke = look.stroke && look.strokeWidth > 0;
  ctx.lineWidth = stroke ? look.strokeWidth : CARD.border;
  ctx.strokeStyle = stroke ? look.stroke : theme.cardBorder;
  ctx.setLineDash(dashPattern(look.strokeStyle, "card", card.half, card));
  ctx.beginPath();
  ctx.roundRect(x, y, card.width, card.height, CARD.corner);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** How far a stacked copy's fill goes toward the background (so it reads as behind). */
export const STACK_FADE = 0.45;

/** A node's badge image: a disc of the background on its top-right diagonal, the image clipped round inside it. */
function drawBadge(ctx, look) {
  const { badge, badgeShown, n, r, alpha, background } = look;
  if (!badge || !(badgeShown > 0)) return;
  const at = r * MARKS.badgeAt,
    br = r * MARKS.badgeRadius;
  const cx = n.x + at,
    cy = n.y - at;
  ctx.globalAlpha = alpha * badgeShown;
  ctx.beginPath();
  ctx.arc(cx, cy, br, 0, Math.PI * 2);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const a = badge.width / badge.height;
  const [hx, hy] = a >= 1 ? [br * a, br] : [br, br / a];
  ctx.drawImage(badge.image, cx - hx, cy - hy, hx * 2, hy * 2);
  ctx.restore();
}

/** "#rrggbb" `a` mixed toward `b` by `t` (0: a, 1: b). */
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16),
    pb = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (pa >> shift) & 255,
      cb = (pb >> shift) & 255;
    out |= Math.round(ca + (cb - ca) * t) << shift;
  }
  return "#" + out.toString(16).padStart(6, "0");
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
