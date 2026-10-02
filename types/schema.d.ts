export type OptionSpec = {
  key: string;
  label: string;
  type: "range" | "select" | "bool" | "color";
  default: any;
  min?: number;
  max?: number;
  step?: number;
  choices?: {
    value: string;
    label: string;
  }[];
  hint?: string;
};
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
/** Whether `v` is a "#rrggbb" colour. */
export declare const isHex: (v: any) => boolean;
/** The default warning: once per message, on the console (development-friendly, never thrown). */
export declare function warnOnce(message: any): void;
/**
 * `values` checked against `schema`: every key of the schema, from `values` where usable, else the default.
 * Numbers outside their range are brought to the nearest end of it; anything else unusable (a wrong type, a choice
 * that isn't one) takes the default. Unknown keys are dropped. Each of those (not a missing value) is reported to
 * `warn`, by default once per message on the console, with the closest known key or choice when one is close (a
 * typo).
 * @template {Record<string, any>} [T=Record<string, any>] the resolved options' type (NodeOptions, say)
 * @param {readonly OptionSpec[]} schema
 * @param {object} [values]
 * @param {(message: string) => void} [warn] hears each problem, ready to show ("unknown option "sise" (ignored; did
 *   you mean "size"?)")
 * @returns {T}
 */
export declare function resolve<
  T extends Record<string, any> = Record<string, any>,
>(
  schema: readonly OptionSpec[],
  values?: object,
  warn?: (message: string) => void,
): T;
/**
 * The candidate closest to `word`, if one is close enough to be a typo of it: the same ignoring case, or a few edits
 * away (about one per three letters, at least two).
 * @param {string} word
 * @param {Iterable<string>} candidates
 * @returns {string | undefined}
 */
export declare function closest(
  word: string,
  candidates: Iterable<string>,
): string | undefined;
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
export declare const range: (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  hint?: string,
) => OptionSpec;
/**
 * @param {string} key
 * @param {string} label
 * @param {{ value: string, label: string }[]} choices
 * @param {string} value
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export declare const select: (
  key: string,
  label: string,
  choices: {
    value: string;
    label: string;
  }[],
  value: string,
  hint?: string,
) => OptionSpec;
/**
 * @param {string} key
 * @param {string} label
 * @param {boolean} value
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export declare const bool: (
  key: string,
  label: string,
  value: boolean,
  hint?: string,
) => OptionSpec;
/**
 * @param {string} key
 * @param {string} label
 * @param {string} value "#rrggbb"
 * @param {string} [hint]
 * @returns {OptionSpec}
 */
export declare const color: (
  key: string,
  label: string,
  value: string,
  hint?: string,
) => OptionSpec;
