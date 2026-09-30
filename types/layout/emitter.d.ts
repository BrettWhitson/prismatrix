/**
 * A small event emitter. `on` returns its own unsubscribe function, which suits component lifecycles:
 *
 *   const off = physics.on("settle", () => save());
 *   onDestroy(off);
 *
 * A listener that throws doesn't stop the others; the error is reported with console.error.
 * @template {Record<string, any[]>} Events  event name → listener arguments
 */
export declare class Emitter<Events extends Record<string, any[]>> {
  #private;
  /**
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   * @returns {() => void} unsubscribe
   */
  on<K extends keyof Events & string>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): () => void;
  /**
   * Listen for the next `type` only.
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   * @returns {() => void} unsubscribe
   */
  once<K extends keyof Events & string>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): () => void;
  /**
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   */
  off<K extends keyof Events & string>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): void;
  /**
   * Does anything listen for `type`? (skip building costly event payloads when nothing does)
   * @param {keyof Events & string} type
   */
  hasListeners(type: keyof Events & string): boolean;
  /**
   * @protected
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {Events[K]} args
   */
  protected emit<K extends keyof Events & string>(
    type: K,
    ...args: Events[K]
  ): void;
  /**
   * Remove every listener (or every listener for `type`).
   * @param {keyof Events & string} [type]
   */
  removeAllListeners(type?: keyof Events & string): void;
}
