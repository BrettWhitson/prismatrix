// Themes: the colours the engine itself picks (the background, label text, default node and edge colours, the
// depth palette). A graph's own colours (node and edge `color`, `stroke`) are the app's and never change with the
// theme; option colours left at their defaults follow it.
//
//   new GraphController(model, renderer, { theme: "light" });
//   controller.setTheme({ base: "dark", background: "#000000" }); // a preset with some tokens replaced
//
// Pure: no DOM.

import { EDGE_OPTIONS, NODE_OPTIONS, PALETTE } from "./style.js";
import { warnOnce } from "./schema.js";

/**
 * @typedef {object} Theme
 * @property {string} name        "dark", "light" or "custom"
 * @property {string} background  behind everything; also inside rings and in node outlines
 * @property {string} text        label text
 * @property {string} textHalo    a halo behind label text, for painters that draw one (usually the background)
 * @property {string} edge        edges, when the edge `color` option is left at its default
 * @property {string} node        nodes coloured by one colour, when the node `color` option is left at its default
 * @property {string} root        a root's colour when colouring by branch
 * @property {string[]} palette   colours by depth or branch, then wrapping
 */

/** The theme presets. Every palette colour has at least 4:1 contrast with its background (see contrast). */
export const THEMES = Object.freeze({
  dark: Object.freeze({
    name: "dark",
    background: "#0e1016",
    text: "#d5d9e4",
    textHalo: "#0e1016",
    edge: "#5b6478",
    node: "#7aa2f7",
    root: "#e6e9f2",
    palette: Object.freeze([...PALETTE]),
  }),
  light: Object.freeze({
    name: "light",
    background: "#f6f7f9",
    text: "#1f2430",
    textHalo: "#f6f7f9",
    edge: "#808899",
    node: "#2f5fd0",
    root: "#1f2430",
    // The dark palette's hues, deep enough to read on a light background.
    palette: Object.freeze([
      "#b5650d",
      "#2f5fd0",
      "#3f7d20",
      "#c2364f",
      "#7a4fd6",
      "#0b7a91",
      "#c4520f",
      "#5a6378",
    ]),
  }),
});

/** The theme used when none is given. */
export const DEFAULT_THEME = THEMES.dark;

/** The edge and node `color` options' defaults: left at these, the theme's `edge` and `node` colours are used. */
export const EDGE_COLOUR_DEFAULT = EDGE_OPTIONS.find(
  (o) => o.key === "color",
).default;
export const NODE_COLOUR_DEFAULT = NODE_OPTIONS.find(
  (o) => o.key === "color",
).default;

const hex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const TOKENS = ["background", "text", "textHalo", "edge", "node", "root"];

/**
 * A complete theme from a preset name or an object of tokens over a preset (`base`, "dark" by default). Unknown
 * names, unknown tokens and colours that aren't "#rrggbb" are reported to `warn` and left out.
 * @param {"dark" | "light" | Partial<Theme> & { base?: "dark" | "light" } | null | undefined} theme
 * @param {(message: string) => void} [warn]
 * @returns {Theme}
 */
export function resolveTheme(theme, warn = warnOnce) {
  if (theme === undefined || theme === null) return DEFAULT_THEME;
  if (typeof theme === "string") {
    if (Object.hasOwn(THEMES, theme)) return THEMES[theme];
    warn(`unknown theme "${theme}" (the dark theme is used)`);
    return DEFAULT_THEME;
  }
  if (typeof theme !== "object") {
    warn(`a theme is "dark", "light" or an object of colours`);
    return DEFAULT_THEME;
  }
  let base = DEFAULT_THEME;
  if (theme.base !== undefined) {
    if (Object.hasOwn(THEMES, theme.base)) base = THEMES[theme.base];
    else warn(`unknown base theme "${theme.base}" (dark is used)`);
  }
  const out = { ...base, name: "custom" };
  for (const [key, value] of Object.entries(theme)) {
    if (key === "base" || key === "name") continue;
    if (key === "palette") {
      if (Array.isArray(value) && value.length && value.every(hex))
        out.palette = Object.freeze([...value]);
      else warn(`theme palette: a list of "#rrggbb" colours (ignored)`);
    } else if (!TOKENS.includes(key)) warn(`unknown theme colour "${key}"`);
    else if (!hex(value))
      warn(`theme ${key}: ${JSON.stringify(value)} isn't "#rrggbb"`);
    else out[key] = value;
  }
  return Object.freeze(out);
}

/** A colour's relative luminance (WCAG 2), 0 for black to 1 for white. */
export function luminance(colour) {
  const n = parseInt(colour.slice(1), 16);
  const linear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear((n >> 16) & 255) +
    0.7152 * linear((n >> 8) & 255) +
    0.0722 * linear(n & 255)
  );
}

/** The contrast ratio between two colours (WCAG 2): 1 for the same, 21 for black on white. */
export function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
