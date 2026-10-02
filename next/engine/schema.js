// Every tunable thing in the engine is described by a small schema entry, so a UI (the sandbox) can build its
// controls from it and the engine can fill defaults and clamp values from the same source.

/**
 * @typedef {object} OptionSpec
 * @property {string} key
 * @property {string} label
 * @property {"range" | "select" | "bool" | "color"} type
 * @property {any} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {{ value: string, label: string }[]} [choices]
 * @property {string} [hint]
 *
 * @typedef {object} OptionWarning
 * @property {"unknown" | "invalid" | "clamped"} kind  an unknown key, a value that can't be used (the default is
 *   used instead), or a number outside its range (brought to the nearest end)
 * @property {string} key
 * @property {string} [suggestion] for an unknown key or a bad choice: the closest known one, if any is close
 *
 * @callback WarnOption
 * @param {string} message  ready to show ("unknown option "sise" (ignored; did you mean "size"?)")
 * @param {OptionWarning} warning
 */

/**
 * The defaults of a schema as a plain object.
 * @param {readonly OptionSpec[]} schema
 * @returns {Record<string, any>}
 */
export function defaultsOf(schema) {
  return Object.fromEntries(schema.map((o) => [o.key, o.default]));
}

/** Messages already shown by the default warning: each is shown once, however often the same mistake is made. */
const shown = new Set();

/** The default warning: once per message, on the console (development-friendly, never thrown). */
export function warnOnce(message) {
  if (shown.has(message)) return;
  shown.add(message);
  console.warn(`Prismatrix: ${message}`);
}

/**
 * `values` checked against `schema`: every key of the schema, from `values` where usable, else the default.
 * Numbers outside their range are brought to the nearest end of it; anything else unusable (a wrong type, a choice
 * that isn't one) takes the default. Unknown keys are dropped. Each of those (not a missing value) is reported to
 * `warn`, by default once per message on the console, with the closest known key or choice when one is close (a
 * typo).
 * @template {Record<string, any>} [T=Record<string, any>] the resolved options' type (NodeOptions, say)
 * @param {readonly OptionSpec[]} schema
 * @param {object} [values]
 * @param {WarnOption} [warn]
 * @returns {T}
 */
export function resolve(schema, values = {}, warn = warnOnce) {
  const given =
    values !== null && typeof values === "object" ? values : undefined;
  const out = {};
  for (const o of schema) {
    const v = given && Object.hasOwn(given, o.key) ? given[o.key] : undefined;
    out[o.key] = check(o, v, warn);
  }
  if (given)
    for (const key of Object.keys(given)) {
      if (Object.hasOwn(out, key)) continue;
      const suggestion = closest(
        key,
        schema.map((o) => o.key),
      );
      warn(`unknown option "${key}" (ignored${didYouMean(suggestion)})`, {
        kind: "unknown",
        key,
        ...(suggestion && { suggestion }),
      });
    }
  return /** @type {T} */ (out);
}

/** One option's value: `v` when it's usable, a number clamped into range, or the default. */
function check(o, v, warn) {
  if (v === undefined || v === null) return o.default;
  const invalid = (suggestion) => {
    warn(
      `option "${o.key}": ${show(v)} isn't valid (the default ${show(o.default)} is used${didYouMean(suggestion)})`,
      { kind: "invalid", key: o.key, ...(suggestion && { suggestion }) },
    );
    return o.default;
  };
  switch (o.type) {
    case "range": {
      if (typeof v !== "number" || Number.isNaN(v)) return invalid();
      if (v >= o.min && v <= o.max) return v;
      warn(
        `option "${o.key}" is out of its range ${o.min} to ${o.max} (clamped)`,
        { kind: "clamped", key: o.key },
      );
      return v < o.min ? o.min : o.max;
    }
    case "select":
      if (o.choices.some((c) => c.value === v)) return v;
      return invalid(
        typeof v === "string"
          ? closest(
              v,
              o.choices.map((c) => c.value),
            )
          : undefined,
      );
    case "bool":
      return typeof v === "boolean" ? v : invalid();
    case "color":
      return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : invalid();
    default:
      return o.default;
  }
}

const show = (v) => (typeof v === "string" ? `"${v}"` : String(v));
const didYouMean = (suggestion) =>
  suggestion ? `; did you mean "${suggestion}"?` : "";

/**
 * The candidate closest to `word`, if one is close enough to be a typo of it: the same ignoring case, or a few edits
 * away (about one per three letters, at least two).
 * @param {string} word
 * @param {Iterable<string>} candidates
 * @returns {string | undefined}
 */
export function closest(word, candidates) {
  const lower = word.toLowerCase();
  let best,
    bestDistance = Infinity;
  for (const c of candidates) {
    if (c.toLowerCase() === lower) return c;
    const d = distance(lower, c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  const allowed = Math.max(2, Math.floor(Math.min(word.length, 30) / 3));
  return bestDistance <= allowed ? best : undefined;
}

/** Edit distance (insertions, deletions, substitutions, and swaps of neighbours), for short keys. */
function distance(a, b) {
  if (a.length > 64 || b.length > 64) return Infinity;
  const rows = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
    }
  return rows[a.length][b.length];
}

/**
 * Shorthands for writing schemas.
 * @param {string} key
 * @param {string} label
 * @param {number} min
 * @param {number} max
 * @param {number} step
 * @param {number} value
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export const range = (key, label, min, max, step, value, hint) => ({
  key,
  label,
  type: "range",
  min,
  max,
  step,
  default: value,
  hint,
});
/**
 * @param {string} key
 * @param {string} label
 * @param {(string | { value: string, label: string })[]} choices
 * @param {string} value
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export const select = (key, label, choices, value, hint) => ({
  key,
  label,
  type: "select",
  choices: choices.map((c) =>
    typeof c === "string" ? { value: c, label: c } : c,
  ),
  default: value,
  hint,
});
/**
 * @param {string} key
 * @param {string} label
 * @param {boolean} value
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export const bool = (key, label, value, hint) => ({
  key,
  label,
  type: "bool",
  default: value,
  hint,
});
/**
 * @param {string} key
 * @param {string} label
 * @param {string} value "#rrggbb"
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export const color = (key, label, value, hint) => ({
  key,
  label,
  type: "color",
  default: value,
  hint,
});
