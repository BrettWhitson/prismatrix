/**
 * Option schemas: every setting described once (type, range, default, label, hint), so defaults, validation, docs
 * and developer-tool controls all come from the same place. Used by Tether's settings and tuning, and by Prism's
 * options and theme.
 *
 * Invalid values never stop the engine: they're clamped into range or replaced by the default, with one
 * console.warn per key and problem. Pass `strict: true` to throw instead (tests, development).
 */

/**
 * @typedef {object} Field
 * @property {"number" | "integer" | "boolean" | "string" | "enum" | "color" | "function" | "array" | "object" | "any"} type
 * @property {*} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]  for controls
 * @property {readonly string[]} [values]  enum: the allowed values
 * @property {boolean} [open]  enum: other values are allowed too (registered plugins)
 * @property {boolean} [nullable]  null is a valid value
 * @property {string} [label]
 * @property {string} [group]
 * @property {string} [hint]
 * @typedef {Record<string, Field>} Schema
 */

/**
 * @typedef {object} ResolveOptions
 * @property {boolean} [strict]  throw a TypeError instead of warning
 * @property {(message: string) => void} [warn]  where warnings go (default console.warn, once per message)
 * @property {string} [scope]  prefix for messages, e.g. "Tether settings"
 * @property {boolean} [allowUnknown]  keep keys the schema doesn't know, silently
 */

const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * The defaults of a schema, as a plain object.
 * @returns {any}
 */
export function defaultsOf(schema) {
  const out = {};
  for (const [key, field] of Object.entries(schema)) out[key] = field.default;
  return out;
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(rgba?|hsla?)\(([^()]*)\)$/i;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** A plain number, or NaN. */
function numberOf(text) {
  return NUMBER.test(text) ? parseFloat(text) : NaN;
}

/** A number or a percentage within range: `max` for plain numbers, 0..100 for percentages. */
function inRange(text, max, { percent = true, plain = true } = {}) {
  if (text.endsWith("%"))
    return (
      percent &&
      numberOf(text.slice(0, -1)) >= 0 &&
      numberOf(text.slice(0, -1)) <= 100
    );
  const value = numberOf(text);
  return plain && value >= 0 && value <= max;
}

/**
 * rgb()/rgba()/hsl()/hsla() with the right number of parts, each in range: three (comma- or space-separated), plus an
 * optional alpha (after a comma, or a slash). rgb parts are 0..255 or 0..100%; hsl's hue is any angle (deg optional),
 * saturation and lightness 0..100(%); alpha is 0..1 or 0..100%.
 */
function isFunctionalColor(value) {
  const match = FUNCTIONAL.exec(value.trim());
  if (!match) return false;
  const kind = match[1].toLowerCase().slice(0, 3);
  const body = match[2].trim();
  let parts,
    alpha = null;
  if (body.includes(",")) {
    parts = body.split(",").map((part) => part.trim());
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const pieces = body.split("/");
    if (pieces.length > 2) return false;
    parts = pieces[0].trim().split(/\s+/);
    if (pieces.length === 2) alpha = pieces[1].trim();
  }
  if (parts.length !== 3) return false;
  if (alpha !== null && !inRange(alpha, 1)) return false;
  if (kind === "rgb") return parts.every((part) => inRange(part, 255));
  const hue = parts[0].replace(/deg$/i, "");
  return (
    Number.isFinite(numberOf(hue)) &&
    inRange(parts[1], 100) &&
    inRange(parts[2], 100)
  );
}

/**
 * A colour the renderer can parse: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba()/hsl()/hsla() with the right number of
 * parts, each in range, or "transparent".
 */
export function isColor(value) {
  return (
    typeof value === "string" &&
    (HEX.test(value) || value === "transparent" || isFunctionalColor(value))
  );
}

/**
 * Check one value against its field. Returns `{ value }` (possibly clamped), or `{ value, problem }` with the value
 * to use instead.
 */
export function checkField(field, value) {
  if (value === undefined) return { value: field.default };
  if (value === null)
    return field.nullable || field.default === null
      ? { value: null }
      : { value: field.default, problem: "can't be null" };
  switch (field.type) {
    case "number":
    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value))
        return { value: field.default, problem: `expected a number` };
      if (field.type === "integer" && !Number.isInteger(value))
        return {
          value: checkField(field, Math.round(value)).value,
          problem: "expected a whole number",
        };
      const low = field.min ?? -Infinity,
        high = field.max ?? Infinity;
      if (value >= low && value <= high) return { value };
      return {
        value: Math.min(high, Math.max(low, value)),
        problem: `out of range [${field.min ?? "-∞"}, ${field.max ?? "∞"}]`,
      };
    }
    case "boolean":
      return typeof value === "boolean"
        ? { value }
        : { value: field.default, problem: "expected true or false" };
    case "string":
      return typeof value === "string"
        ? { value }
        : { value: field.default, problem: "expected a string" };
    case "enum":
      if (
        field.values.includes(value) ||
        (field.open && typeof value === "string")
      )
        return { value };
      return {
        value: field.default,
        problem: `expected one of ${field.values.map((v) => JSON.stringify(v)).join(", ")}`,
      };
    case "color":
      return isColor(value)
        ? { value }
        : {
            value: field.default,
            problem: "expected a CSS colour (#hex, rgb(), hsl())",
          };
    case "function":
      return typeof value === "function"
        ? { value }
        : { value: field.default, problem: "expected a function" };
    case "array":
      return Array.isArray(value)
        ? { value }
        : { value: field.default, problem: "expected an array" };
    case "object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? { value }
        : { value: field.default, problem: "expected an object" };
    default:
      return { value };
  }
}

/**
 * `input` checked against `schema`, on top of `base` (default: the schema's defaults). Only the keys in `input`
 * are checked; every schema key is in the result.
 * @template T
 * @param {Schema} schema
 * @param {Partial<T> | undefined} input
 * @param {ResolveOptions & { base?: T }} [options]
 * @returns {T}
 */
export function resolve(schema, input, options = {}) {
  /** @type {any} */
  const out = { ...(options.base ?? defaultsOf(schema)) };
  if (input == null) return out;
  const problems = validate(schema, input, options);
  for (const [key, value] of Object.entries(input)) {
    const field = schema[key];
    if (!field) {
      if (options.allowUnknown) out[key] = value;
      continue;
    }
    out[key] = problems.fixed.has(key) ? problems.fixed.get(key) : value;
  }
  return out;
}

/**
 * Report what's wrong with `input` (warns or throws as `options` say). Returns the fixes: key → value to use.
 * @param {Schema} schema
 * @param {object} input
 * @param {ResolveOptions} [options]
 * @returns {{ problems: string[], fixed: Map<string, *> }}
 */
export function validate(schema, input, options = {}) {
  const scope = options.scope ? `${options.scope}: ` : "";
  const problems = [];
  const fixed = new Map();
  for (const [key, value] of Object.entries(input ?? {})) {
    const field = schema[key];
    if (!field) {
      if (!options.allowUnknown) {
        const near = suggest(key, Object.keys(schema));
        problems.push(
          `${scope}unknown option "${key}"${near ? ` (did you mean "${near}"?)` : ""}`,
        );
      }
      continue;
    }
    if (value === undefined) {
      fixed.set(key, field.default);
      continue;
    }
    const checked = checkField(field, value);
    if (checked.problem) {
      problems.push(
        `${scope}"${key}" ${checked.problem}; got ${describe(value)}, using ${describe(checked.value)}`,
      );
      fixed.set(key, checked.value);
    }
  }
  if (problems.length) {
    if (options.strict) throw new TypeError(problems.join("\n"));
    for (const problem of problems) (options.warn ?? warnOnce)(problem);
  }
  return { problems, fixed };
}

function describe(value) {
  if (typeof value === "function") return "a function";
  try {
    const text = JSON.stringify(value);
    return text && text.length > 40 ? `${text.slice(0, 37)}…` : String(text);
  } catch {
    return String(value);
  }
}

/** The closest known key, for typos (edit distance ≤ 3), or null. */
function suggest(key, keys) {
  let best = null,
    bestDistance = 4;
  const lower = key.toLowerCase();
  for (const candidate of keys) {
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

/**
 * Controls for developer tools and settings UIs: the schema as a list, in declaration order, with its key.
 * @param {Schema} schema
 * @returns {(Field & { key: string })[]}
 */
export function describeSchema(schema) {
  return Object.entries(schema).map(([key, field]) => ({ key, ...field }));
}
