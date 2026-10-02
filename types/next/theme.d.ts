export type Theme = {
  /**
   * "dark", "light" or "custom"
   */
  name: string;
  /**
   * behind everything; also inside rings and in node outlines
   */
  background: string;
  /**
   * label text
   */
  text: string;
  /**
   * a halo behind label text, for painters that draw one (usually the background)
   */
  textHalo: string;
  /**
   * edges, when the edge `color` option is left at its default
   */
  edge: string;
  /**
   * nodes coloured by one colour, when the node `color` option is left at its default
   */
  node: string;
  /**
   * a root's colour when colouring by branch
   */
  root: string;
  /**
   * colours by depth or branch, then wrapping
   */
  palette: readonly string[];
};
export type ThemeInput =
  | "dark"
  | "light"
  | (Partial<Omit<Theme, "name">> & {
      base?: "dark" | "light";
    });
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
export declare const THEMES: Readonly<{
  dark: Readonly<Theme>;
  light: Readonly<Theme>;
}>;
/**
 * The theme used when none is given.
 * @type {Readonly<Theme>}
 */
export declare const DEFAULT_THEME: Readonly<Theme>;
/** The edge and node `color` options' defaults: left at these, the theme's `edge` and `node` colours are used. */
export declare const EDGE_COLOUR_DEFAULT: any;
export declare const NODE_COLOUR_DEFAULT: any;
/**
 * A complete theme from a preset name or an object of tokens over a preset (`base`, "dark" by default). Unknown
 * names, unknown tokens and colours that aren't "#rrggbb" are reported to `warn` and left out.
 * @param {ThemeInput | null | undefined} theme
 * @param {(message: string) => void} [warn]
 * @returns {Readonly<Theme>}
 */
export declare function resolveTheme(
  theme: ThemeInput | null | undefined,
  warn?: (message: string) => void,
): Readonly<Theme>;
