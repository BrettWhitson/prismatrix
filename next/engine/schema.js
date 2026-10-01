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
 */

/** The defaults of a schema as a plain object. */
export function defaultsOf(schema) {
  return Object.fromEntries(schema.map((o) => [o.key, o.default]));
}

/** `values` checked against `schema`: unknown keys dropped, missing or bad ones replaced by the default. */
export function resolve(schema, values = {}) {
  const out = {};
  for (const o of schema) {
    const v = values[o.key];
    out[o.key] = valid(o, v) ? v : o.default;
  }
  return out;
}

function valid(o, v) {
  switch (o.type) {
    case "range":
      return (
        typeof v === "number" && Number.isFinite(v) && v >= o.min && v <= o.max
      );
    case "select":
      return o.choices.some((c) => c.value === v);
    case "bool":
      return typeof v === "boolean";
    case "color":
      return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
    default:
      return false;
  }
}

/** Shorthands for writing schemas. */
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
export const bool = (key, label, value, hint) => ({
  key,
  label,
  type: "bool",
  default: value,
  hint,
});
export const color = (key, label, value, hint) => ({
  key,
  label,
  type: "color",
  default: value,
  hint,
});
