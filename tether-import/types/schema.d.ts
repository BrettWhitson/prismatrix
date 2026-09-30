/**
 * Option schemas: every setting described once (type, range, default, label, hint), so defaults, validation, docs
 * and developer-tool controls all come from the same place. Used by Tether's settings and tuning, and by Prism's
 * options and theme.
 *
 * Invalid values never stop the engine: they're clamped into range or replaced by the default, with one
 * console.warn per key and problem. Pass `strict: true` to throw instead (tests, development).
 */
export type Field = {
  type:
    | "number"
    | "integer"
    | "boolean"
    | "string"
    | "enum"
    | "color"
    | "function"
    | "array"
    | "object"
    | "any";
  default: any;
  min?: number;
  max?: number;
  /**
   * for controls
   */
  step?: number;
  /**
   * enum: the allowed values
   */
  values?: readonly string[];
  /**
   * enum: other values are allowed too (registered plugins)
   */
  open?: boolean;
  /**
   * null is a valid value
   */
  nullable?: boolean;
  label?: string;
  group?: string;
  hint?: string;
};
export type Schema = Record<string, Field>;
export type ResolveOptions = {
  /**
   * throw a TypeError instead of warning
   */
  strict?: boolean;
  /**
   * where warnings go (default console.warn, once per message)
   */
  warn?: (message: string) => void;
  /**
   * prefix for messages, e.g. "Tether settings"
   */
  scope?: string;
  /**
   * keep keys the schema doesn't know, silently
   */
  allowUnknown?: boolean;
};
/**
 * The defaults of a schema, as a plain object.
 * @returns {any}
 */
export declare function defaultsOf(schema: any): any;
/**
 * A colour the renderer can parse: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba()/hsl()/hsla() with the right number of
 * parts, each in range, or "transparent".
 */
export declare function isColor(value: any): any;
/**
 * Check one value against its field. Returns `{ value }` (possibly clamped), or `{ value, problem }` with the value
 * to use instead.
 */
export declare function checkField(field: any, value: any): any;
/**
 * `input` checked against `schema`, on top of `base` (default: the schema's defaults). Only the keys in `input`
 * are checked; every schema key is in the result.
 * @template T
 * @param {Schema} schema
 * @param {Partial<T> | undefined} input
 * @param {ResolveOptions & { base?: T }} [options]
 * @returns {T}
 */
export declare function resolve<T>(
  schema: Schema,
  input: Partial<T> | undefined,
  options?: ResolveOptions & {
    base?: T;
  },
): T;
/**
 * Report what's wrong with `input` (warns or throws as `options` say). Returns the fixes: key → value to use.
 * @param {Schema} schema
 * @param {object} input
 * @param {ResolveOptions} [options]
 * @returns {{ problems: string[], fixed: Map<string, *> }}
 */
export declare function validate(
  schema: Schema,
  input: object,
  options?: ResolveOptions,
): {
  problems: string[];
  fixed: Map<string, any>;
};
/**
 * Controls for developer tools and settings UIs: the schema as a list, in declaration order, with its key.
 * @param {Schema} schema
 * @returns {(Field & { key: string })[]}
 */
export declare function describeSchema(schema: Schema): (Field & {
  key: string;
})[];
