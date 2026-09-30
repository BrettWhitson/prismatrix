/**
 * The renderer's extension points: node shapes, arrowheads, edge routings and animation feels, by name. Registries
 * are global (every renderer on the page sees them) and versioned, so a renderer that's already drawing picks up a
 * new shape on its next frame (recompiling its node shader).
 *
 *   registerNodeShape("star", { polygon: starPoints(5, 0.45) });  // no GLSL needed
 *   registerNodeShape("pill", { glsl: "vec2 d = abs(p) - h + min(h.x, h.y); return length(max(d, 0.0)) - min(h.x, h.y);" });
 *   registerArrowShape("diamond", { triangles: [[0, 0], [0.5, -0.4], [1, 0], [0, 0], [1, 0], [0.5, 0.4]], inset: 1 });
 *   registerEdgeRouting("zigzag", (source, target) => [...points]);
 *   registerEasing("lazy", { speed: 4, damping: 1 });
 *
 * Pure: no DOM, no GL (the renderer compiles what's registered here).
 */

// ---------------------------------------------------------------- node shapes

/** Built-in shapes and their ids in the node shader. */
const BUILT_IN_SHAPES = {
  rectangle: 0,
  "round-rectangle": 1,
  ellipse: 2,
  hexagon: 3,
  octagon: 4,
  "round-diamond": 5,
  diamond: 5,
};
const FIRST_CUSTOM_SHAPE = 6;
/** How many vertices a polygon shape may have (a fixed-size array in the shader). */
export const MAX_POLYGON_VERTICES = 64;

/** @type {Map<string, { id: number, glsl: string, broken?: boolean }>} */
const customShapes = new Map();
let version = 0;

const warned = new Set();
/**
 * A name nothing is registered under, used somewhere: warn once per kind and name (it may be registered later, so it
 * isn't an error; until then the fallback is drawn).
 */
function warnUnknown(kind, name, fallback) {
  const key = `${kind}\u0000${name}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `Prismatrix: unknown ${kind} ${JSON.stringify(name)} (not registered); drawing ${fallback}`,
  );
}

/** Changes whenever anything is registered: renderers compare it to what they last built. */
export function pluginVersion() {
  return version;
}

/**
 * Add a node shape (or replace a custom one), usable as `nodeShape` or a style's `shape`.
 *
 * - `{ polygon: [[x, y], …], rounding? }`: an outline in a unit box (-1..1 on both axes, y down), 3 to 64 points, in
 *   order, convex or not. It's stretched to the node's box. `rounding` (0..1) rounds its corners.
 * - `{ glsl: "…" }`: the body of `float shape(vec2 p, vec2 h)`, returning the signed distance (negative inside) from
 *   `p` (relative to the node's centre, y down) to a shape filling the half-size box `h`. For curves and anything a
 *   polygon can't do. If it doesn't compile, the renderer warns and draws the default shape instead.
 * @param {string} name
 * @param {{ polygon: [number, number][], rounding?: number } | { glsl: string }} definition
 */
export function registerNodeShape(name, definition) {
  if (typeof name !== "string" || !name)
    throw new TypeError(
      "registerNodeShape: the name must be a non-empty string",
    );
  if (name in BUILT_IN_SHAPES)
    throw new TypeError(`registerNodeShape: "${name}" is a built-in shape`);
  const id =
    customShapes.get(name)?.id ?? FIRST_CUSTOM_SHAPE + customShapes.size;
  const shape = /** @type {any} */ (definition);
  let glsl;
  if (shape?.polygon) glsl = polygonGlsl(name, shape);
  else if (typeof shape?.glsl === "string" && shape.glsl.trim())
    glsl = shape.glsl;
  else
    throw new TypeError(
      `registerNodeShape("${name}"): give a polygon ([[x, y], …]) or a glsl function body`,
    );
  customShapes.set(name, { id, glsl });
  warned.delete(`node shape\u0000${name}`);
  version++;
}

function polygonGlsl(name, { polygon, rounding = 0 }) {
  if (
    !Array.isArray(polygon) ||
    polygon.length < 3 ||
    polygon.length > MAX_POLYGON_VERTICES ||
    !polygon.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    )
  )
    throw new TypeError(
      `registerNodeShape("${name}"): a polygon is 3 to ${MAX_POLYGON_VERTICES} [x, y] points, each within -1..1`,
    );
  const r = Math.min(1, Math.max(0, Number(rounding) || 0));
  const n = polygon.length;
  const vertices = polygon
    .map(([x, y]) => `vec2(${glslFloat(x)}, ${glslFloat(y)})`)
    .join(", ");
  // Exact signed distance to a polygon (after Inigo Quilez), in the node's own units: the outline is stretched to the
  // box first, shrunk by the rounding radius, and the radius added back.
  return `
  float r = min(h.x, h.y) * ${glslFloat(r * 0.5)};
  vec2 k = max(h - vec2(r), vec2(0.001));
  vec2 v[${n}] = vec2[${n}](${vertices});
  float d = dot(p - v[0] * k, p - v[0] * k);
  float s = 1.0;
  for (int i = 0, j = ${n - 1}; i < ${n}; j = i, i++) {
    vec2 vi = v[i] * k, vj = v[j] * k;
    vec2 e = vj - vi, w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d) - r;`;
}

function glslFloat(value) {
  const text = String(Number(value));
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/** The shader id of a shape name (unknown names: the round rectangle, with a warning). */
export function shapeId(name) {
  const id = BUILT_IN_SHAPES[name] ?? customShapes.get(name)?.id;
  if (id != null) return id;
  if (name != null && name !== "")
    warnUnknown("node shape", name, "round-rectangle");
  return 1;
}

/** Every shape name that draws: built-in, and custom ones that compiled (or haven't been tried yet). */
export function nodeShapeNames() {
  return [
    ...Object.keys(BUILT_IN_SHAPES),
    ...[...customShapes]
      .filter(([, shape]) => !shape.broken)
      .map(([name]) => name),
  ];
}

/**
 * A custom shape didn't compile (the renderer found out): leave it out of every shader from now on, so the failure
 * is reported once, not on every recompile. It's drawn as the default shape until it's registered again.
 */
export function disableShape(name) {
  const shape = customShapes.get(name);
  if (shape) shape.broken = true;
}

/**
 * The custom shapes as GLSL: their functions, and the dispatch for shapeDistance (see shaders.js). `skip`: names to
 * leave out (they failed to compile).
 */
export function customShapeGlsl(skip = new Set()) {
  let functions = "",
    dispatch = "";
  for (const [name, { id, glsl, broken }] of customShapes) {
    if (broken || skip.has(name)) continue;
    functions += `float customShape${id}(vec2 p, vec2 h) {\n${glsl}\n}\n`;
    dispatch += `  if (abs(id - ${id}.0) < 0.5) return customShape${id}(q, h);\n`;
  }
  return { functions, dispatch };
}

/** The custom shapes still in the shader (the ones that might not compile). */
export function glslShapeNames() {
  return [...customShapes]
    .filter(([, shape]) => !shape.broken)
    .map(([name]) => name);
}

// ---------------------------------------------------------------- arrowheads

/** @type {Map<string, { triangles: [number, number][], inset: number }>} */
const arrowShapes = new Map();

/**
 * Add an arrowhead (or replace one, built-ins included), usable as `arrowShape`. `triangles`: a flat list of
 * triangle corners [back, side] in arrow sizes, with the tip at [0, 0] and `back` running back along the edge;
 * `inset`: how far back the line stops so it doesn't poke through the tip.
 * @param {string} name
 * @param {{ triangles: [number, number][], inset?: number }} definition
 */
export function registerArrowShape(
  name,
  { triangles, inset = 0.9 } = /** @type {any} */ ({}),
) {
  if (typeof name !== "string" || !name)
    throw new TypeError(
      "registerArrowShape: the name must be a non-empty string",
    );
  if (
    !Array.isArray(triangles) ||
    !triangles.length ||
    triangles.length % 3 ||
    !triangles.every(
      (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
    )
  )
    throw new TypeError(
      `registerArrowShape("${name}"): triangles is a list of [back, side] points, three per triangle`,
    );
  arrowShapes.set(name, {
    triangles: triangles.map(([a, b]) => [a, b]),
    inset: Number.isFinite(inset) ? inset : 0.9,
  });
  version++;
}

/** A registered arrowhead, or undefined (then the built-ins apply). */
export function customArrow(name) {
  return arrowShapes.get(name);
}

const BUILT_IN_ARROWS = new Set([
  "triangle",
  "vee",
  "chevron",
  "triangle-backcurve",
  "circle",
  "square",
  "tee",
]);

/** An arrowhead name neither built in nor registered: warn once (the triangle is drawn). */
export function checkArrowName(name) {
  if (name && !BUILT_IN_ARROWS.has(name) && !arrowShapes.has(name))
    warnUnknown("arrowhead", name, "triangle");
}

// ---------------------------------------------------------------- edge routings

/**
 * @typedef {(source: { x: number, y: number, hw: number, hh: number },
 *            target: { x: number, y: number, hw: number, hh: number },
 *            context: { flowAxis: string, cornerRadius: number, curvature: number }) =>
 *            { x: number, y: number }[]} EdgeRouter
 */

/** @type {Map<string, EdgeRouter>} */
const routers = new Map();

/**
 * Add an edge routing (or replace one), usable as `edgeRouting`. The router gets both ends (centre and half-size)
 * and returns the edge as a polyline, at least two points, from the source's border to the target's.
 * @param {string} name
 * @param {EdgeRouter} route
 */
export function registerEdgeRouting(name, route) {
  if (typeof name !== "string" || !name)
    throw new TypeError(
      "registerEdgeRouting: the name must be a non-empty string",
    );
  if (typeof route !== "function")
    throw new TypeError(
      `registerEdgeRouting("${name}"): the router must be a function`,
    );
  routers.set(name, route);
  version++;
}

/** @returns {EdgeRouter | undefined} */
export function customRouter(name) {
  return routers.get(name);
}

export function edgeRoutingNames() {
  return [...routers.keys()];
}

const BUILT_IN_ROUTINGS = new Set([
  "straight",
  "taxi",
  "round-taxi",
  "s-curve",
  "arc",
]);

/** A routing neither built in nor registered: warn once (a straight line is drawn). */
export function checkRoutingName(name) {
  if (name && !BUILT_IN_ROUTINGS.has(name) && !routers.has(name))
    warnUnknown("edge routing", name, "straight lines");
}

// ---------------------------------------------------------------- animation feels

/** Spring shapes: omega = speed / seconds, zeta = damping (1: no overshoot; below 1 bounces; above 1 glides). */
const easings = new Map([
  ["smooth", { speed: 6.6, damping: 1 }],
  ["snappy", { speed: 9, damping: 1 }],
  ["bouncy", { speed: 7, damping: 0.5 }],
  ["linear", { speed: 9, damping: 1.6 }],
]);

/**
 * Add an animation feel (or replace one), usable as `animationEasing`. Every motion is a spring that settles in
 * about the animation duration: `speed` sets how quickly it gets going (higher is snappier), `damping` whether it
 * overshoots (1 doesn't; 0.3 wobbles; 1.5 glides in).
 * @param {string} name
 * @param {{ speed: number, damping: number }} feel
 */
export function registerEasing(
  name,
  { speed, damping } = /** @type {any} */ ({}),
) {
  if (typeof name !== "string" || !name)
    throw new TypeError("registerEasing: the name must be a non-empty string");
  if (!(speed > 0) || !(damping > 0))
    throw new TypeError(
      `registerEasing("${name}"): speed and damping must be positive numbers`,
    );
  easings.set(name, { speed, damping });
  version++;
}

/** @returns {{ speed: number, damping: number }} (unknown names: smooth, with a warning) */
export function easing(name) {
  const feel = easings.get(name);
  if (feel) return feel;
  if (name != null && name !== "") warnUnknown("easing", name, "smooth");
  return easings.get("smooth");
}

export function easingNames() {
  return [...easings.keys()];
}
