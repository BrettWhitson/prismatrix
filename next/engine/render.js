// Canvas 2D drawing. Deliberately plain for now: the look is what's being worked out, speed comes later.

import { labelAnchor, reach } from "./boxes.js";
import { edgePoints, fanJunctions, trim } from "./geometry.js";
import { PALETTE } from "./style.js";

/** Per-node radius and colour for a graph and node options. */
export function nodeLooks(graph, node) {
  const radius = new Float64Array(graph.nodes.length);
  const fill = new Array(graph.nodes.length);
  const branch = branches(graph);
  for (const n of graph.nodes) {
    let scale = 1;
    if (node.sizeBy === "descendants")
      scale = 1 + 0.35 * Math.log2(1 + n.descendants);
    else if (node.sizeBy === "depth") scale = Math.max(0.4, 1 - n.depth * 0.14);
    radius[n.index] = (node.size / 2) * scale;
    fill[n.index] =
      node.colorBy === "single"
        ? node.color
        : node.colorBy === "branch"
          ? n.depth === 0
            ? "#e6e9f2"
            : PALETTE[branch[n.index] % PALETTE.length]
          : PALETTE[n.depth % PALETTE.length];
  }
  return { radius, fill };
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

/** The node and everything above and below it in the forest. */
export function lineage(graph, index) {
  const set = new Set([index]);
  for (let p = graph.nodes[index].parent; p >= 0; p = graph.nodes[p].parent)
    set.add(p);
  const stack = [index];
  while (stack.length) {
    for (const c of graph.nodes[stack.pop()].children) {
      set.add(c);
      stack.push(c);
    }
  }
  return set;
}

/**
 * Draw one frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene
 */
export function drawScene(ctx, scene) {
  const {
    graph,
    routing,
    camera,
    node,
    edge,
    looks,
    focus,
    width,
    height,
    dpr,
    background,
  } = scene;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width * dpr, height * dpr);
  const k = camera.k * dpr;
  const world = [
    k,
    0,
    0,
    k,
    dpr * (width / 2 - camera.x * camera.k),
    dpr * (height / 2 - camera.y * camera.k),
  ];

  // Edges go onto their own layer at full strength, and the layer onto the scene at the edge opacity, so where
  // edges overlap (siblings sharing a trunk, the joints of a tapered edge) they don't add up to brighter lines.
  // Dimmed edges (outside the hovered lineage) get a pass of their own.
  const layer = edgeLayer(ctx.canvas);
  const junctions = edge.shape === "fan" ? fanJunctions(graph, routing) : null;
  const lit = (e) => !focus || (focus.has(e.source) && focus.has(e.target));
  const pass = (edges, strength) => {
    if (!edges.length) return;
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.setTransform(...world);
    layer.ctx.lineCap = "round";
    layer.ctx.lineJoin = "round";
    for (const e of edges)
      drawEdge(
        layer.ctx,
        routing,
        edge,
        looks,
        graph.nodes[e.source],
        graph.nodes[e.target],
        junctions && e.tree ? junctionAt(junctions, e.source) : null,
      );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = edge.opacity * strength;
    ctx.drawImage(layer.canvas, 0, 0);
  };
  pass(
    graph.edges.filter((e) => !lit(e)),
    0.15,
  );
  pass(graph.edges.filter(lit), 1);
  ctx.globalAlpha = 1;
  ctx.setTransform(...world);

  for (const n of graph.nodes) {
    ctx.globalAlpha = !focus || focus.has(n.index) ? 1 : 0.25;
    drawNode(
      ctx,
      node,
      n,
      looks.radius[n.index],
      looks.fill[n.index],
      background,
    );
  }

  const labelPx = node.labelSize * camera.k;
  // Labels with room kept for them (label collision) always show; otherwise they drop out when too small to read.
  if (node.labels !== "off" && (node.labelCollide || labelPx >= 6)) {
    ctx.font = `${node.labelSize}px system-ui, sans-serif`;
    ctx.fillStyle = "#d5d9e4";
    for (const n of graph.nodes) {
      ctx.globalAlpha = !focus || focus.has(n.index) ? 1 : 0.2;
      drawLabel(ctx, n, looks.radius[n.index] * reach(node.shape));
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
function edgeLayer(canvas) {
  let layer = layers.get(canvas);
  if (!layer) {
    const off = document.createElement("canvas");
    layer = { canvas: off, ctx: off.getContext("2d") };
    layers.set(canvas, layer);
  }
  if (layer.canvas.width !== canvas.width) layer.canvas.width = canvas.width;
  if (layer.canvas.height !== canvas.height)
    layer.canvas.height = canvas.height;
  return layer;
}

function drawEdge(ctx, routing, edge, looks, s, t, junction) {
  const end = edge.arrow === "none" ? 0 : edge.arrowSize * 0.9;
  const pts = trim(
    edgePoints(routing, edge.shape, s, t, junction),
    looks.radius[s.index],
    looks.radius[t.index] + end,
  );
  if (!pts) return;
  const colour = edge.colorBy === "target" ? looks.fill[t.index] : edge.color;
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
      ctx.lineWidth = edge.width * (2 - 1.7 * f);
      ctx.beginPath();
      ctx.moveTo(pts[i - 2], pts[i - 1]);
      ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = edge.width;
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

function drawNode(ctx, node, n, r, fill, background) {
  ctx.beginPath();
  const { x, y } = n;
  switch (node.shape) {
    case "square":
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "rounded":
      ctx.roundRect(x - r, y - r, r * 2, r * 2, r * 0.45);
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
  if (node.shape === "ring") {
    ctx.fillStyle = background;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.35);
    ctx.strokeStyle = fill;
    ctx.stroke();
    return;
  }
  ctx.fillStyle = fill;
  ctx.fill();
  if (node.outline > 0) {
    ctx.lineWidth = node.outline;
    ctx.strokeStyle = background;
    ctx.stroke();
  }
}

/** A label in the direction the view gave its node (`labelAngle`), which is also where its footprint is. */
function drawLabel(ctx, n, r) {
  const a = labelAnchor(n.labelAngle, r);
  ctx.textAlign = a.align;
  ctx.textBaseline = a.baseline;
  ctx.fillText(n.label, n.x + a.x, n.y + a.y);
}
