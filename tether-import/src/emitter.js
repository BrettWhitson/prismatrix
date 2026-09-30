/**
 * A small event emitter. `on` returns its own unsubscribe function, which suits component lifecycles:
 *
 *   const off = physics.on("settle", () => save());
 *   onDestroy(off);
 *
 * A listener that throws doesn't stop the others; the error is reported with console.error.
 * @template {Record<string, any[]>} Events  event name → listener arguments
 */
export class Emitter {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /**
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(type, listener) {
    if (typeof listener !== "function")
      throw new TypeError(`on("${type}"): the listener must be a function`);
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => this.off(type, listener);
  }

  /**
   * Listen for the next `type` only.
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   * @returns {() => void} unsubscribe
   */
  once(type, listener) {
    const off = this.on(type, (...args) => {
      off();
      listener(...args);
    });
    return off;
  }

  /**
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(...args: Events[K]) => void} listener
   */
  off(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  /**
   * Does anything listen for `type`? (skip building costly event payloads when nothing does)
   * @param {keyof Events & string} type
   */
  hasListeners(type) {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }

  /**
   * @protected
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {Events[K]} args
   */
  emit(type, ...args) {
    const set = this.#listeners.get(type);
    if (!set?.size) return;
    for (const listener of [...set])
      try {
        listener(...args);
      } catch (error) {
        console.error(`Error in a "${type}" listener:`, error);
      }
  }

  /**
   * Remove every listener (or every listener for `type`).
   * @param {keyof Events & string} [type]
   */
  removeAllListeners(type) {
    if (type == null) this.#listeners.clear();
    else this.#listeners.delete(type);
  }
}
