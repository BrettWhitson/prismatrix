/**
 * A point `f` of the way from (x0, y0) to (x1, y1) around a radial layout's centre: angle and radius each change
 * evenly (the angle the short way round), so nodes swing along their rings instead of cutting across the middle.
 * @param {{ cx?: number, cy?: number }} centre
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} f
 * @returns {[number, number]}
 */
export declare function alongRings(
  {
    cx,
    cy,
  }: {
    cx?: number;
    cy?: number;
  },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  f: number,
): [number, number];
/**
 * Progress of an animation that started at `start` and lasts `ms`, at `now`: `t` 0–1, and `f` eased by `easing`
 * (an EASINGS name). A frame stamped a little before the change that started it counts as its start.
 */
export declare function progress(
  now: any,
  start: any,
  ms: any,
  easing: any,
): {
  t: number;
  f: any;
};
/**
 * One morph frame: every node `f` of the way from where it started (`from`) to its home, round the rings in a radial
 * (`routing.kind`), except the `held` ones (under the pointer).
 * @param {import("./matrix.js").Matrix} m
 * @param {{ x: Float64Array, y: Float64Array }} from
 * @param {{ kind: string, cx?: number, cy?: number }} routing
 * @param {Set<number>} held
 */
export declare function morph(
  m: import("./matrix.js").Matrix,
  from: {
    x: Float64Array;
    y: Float64Array;
  },
  routing: {
    kind: string;
    cx?: number;
    cy?: number;
  },
  held: Set<number>,
  f: any,
): void;
/**
 * Where a new graph's nodes start. Nodes the previous graph had start where they were. New ones, by `enter`: "grow"
 * out of their nearest ancestor that was already there (or their root's new home), "fade" in where they land, or
 * ("none") just appear there; the first two start unseen (`appear` 0). One pass, parents before children: each new
 * node takes its parent's answer, so a long new chain costs no more than a short one.
 * @param {import("./graph.js").Graph} graph   the new working graph, homes in place
 * @param {import("./graph.js").Graph | null} previous
 * @param {Int32Array | null} was  per node, its index in `previous` (-1: new)
 * @param {string} enter
 * @param {Float32Array} appear     per node, how far faded in (set for new nodes)
 * @returns {boolean} whether any node starts unseen
 */
export declare function arrive(
  graph: import("./graph.js").Graph,
  previous: import("./graph.js").Graph | null,
  was: Int32Array | null,
  enter: string,
  appear: Float32Array,
): boolean;
/**
 * One step of the shading: each node's `shade` eases toward lit (1) or dimmed (0) over `hoverFade` ms (`lit`: a
 * flag per node to light, or null for all), and nodes still fading in (`appear` < 1) carry on over `transition` ms.
 * @param {Float32Array} shade
 * @param {Float32Array} appear
 * @param {Uint8Array | null} lit
 * @param {number} dt seconds
 * @param {{ hoverFade: number, transition: number }} anim
 * @returns {{ changing: boolean, arriving: boolean }} whether anything changed, and whether any node is still fading in
 */
export declare function fade(
  shade: Float32Array,
  appear: Float32Array,
  lit: Uint8Array | null,
  dt: number,
  {
    hoverFade,
    transition,
  }: {
    hoverFade: number;
    transition: number;
  },
): {
  changing: boolean;
  arriving: boolean;
};
