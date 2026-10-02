// Themes: the colours the engine itself picks (the background, label text, default node and edge colours, the
// depth palette). A graph's own colours (node and edge `color`, `stroke`) are the app's and never change with the
// theme; option colours left at their defaults follow it.
//
//   new GraphController(model, renderer, { theme: "light" });
//   controller.setTheme({ base: "dark", background: "#000000" }); // a preset with some tokens replaced
//
// Pure: no DOM.

import { EDGE_OPTIONS, NODE_OPTIONS } from "./style.js";
import { isHex, warnOnce } from "./schema.js";

/**
 * @typedef {object} Theme
 * @property {string} name        "dark", "light" or "custom"
 * @property {string} background  behind everything; also inside rings and in node outlines
 * @property {string} text        label text
 * @property {string} textHalo    a halo behind label text, for painters that draw one (usually the background)
 * @property {string} edge        edges, when the edge `color` option is left at its default
 * @property {string} node        nodes coloured by one colour, when the node `color` option is left at its default
 * @property {string} root        a root's colour when colouring by branch
 * @property {readonly string[]} palette colours by depth or branch, then wrapping
 *
 * @typedef {"dark" | "light" | (Partial<Omit<Theme, "name">> & { base?: "dark" | "light" })} ThemeInput A preset's
 *   name, or colours over a preset (`base`, "dark" by default)
 */

/**
 * The theme presets. Every palette colour has at least 4:1 contrast (WCAG 2) with its background.
 * @type {Readonly<{ dark: Readonly<Theme>, light: Readonly<Theme> }>}
 */
export const THEMES = Object.freeze({
  dark: Object.freeze({
    name: "dark",
    background: "#0e1016",
    text: "#d5d9e4",
    textHalo: "#0e1016",
    edge: "#5b6478",
    node: "#7aa2f7",
    root: "#e6e9f2",
    // Colours by depth, then wrapping. Picked to read on the dark background.
    palette: Object.freeze([
      "#f6c177",
      "#7aa2f7",
      "#9ece6a",
      "#e27e8d",
      "#bb9af7",
      "#5ccfe6",
      "#ff9e64",
      "#c0caf5",
    ]),
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

/**
 * The theme used when none is given.
 * @type {Readonly<Theme>}
 */
export const DEFAULT_THEME = THEMES.dark;

/** The edge and node `color` options' defaults: left at these, the theme's `edge` and `node` colours are used. */
export const EDGE_COLOUR_DEFAULT = EDGE_OPTIONS.find(
  (o) => o.key === "color",
).default;
export const NODE_COLOUR_DEFAULT = NODE_OPTIONS.find(
  (o) => o.key === "color",
).default;

const TOKENS = ["background", "text", "textHalo", "edge", "node", "root"];

/**
 * A complete theme from a preset name or an object of tokens over a preset (`base`, "dark" by default). Unknown
 * names, unknown tokens and colours that aren't "#rrggbb" are reported to `warn` and left out.
 * @param {ThemeInput | null | undefined} theme
 * @param {(message: string) => void} [warn]
 * @returns {Readonly<Theme>}
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
      if (Array.isArray(value) && value.length && value.every(isHex))
        out.palette = Object.freeze([...value]);
      else warn(`theme palette: a list of "#rrggbb" colours (ignored)`);
    } else if (!TOKENS.includes(key)) warn(`unknown theme colour "${key}"`);
    else if (!isHex(value))
      warn(`theme ${key}: ${JSON.stringify(value)} isn't "#rrggbb"`);
    else out[key] = value;
  }
  return Object.freeze(out);
}
