// The matrix: every node's live state, one column per quantity (struct of arrays). Row i is node i of the working
// graph. Physics, morphs and renderers run straight down these columns; everything else can read a node's row
// through its view (graph.js: `node.x` is `matrix.x[node.index]`).
//
// Columns are 64-bit: big graphs are hundreds of thousands of world px wide, where 32-bit floats can only land on
// steps of a sixteenth of a pixel (renderers convert to 32-bit relative to the camera, where that doesn't matter).

/** The columns, in order. */
export const COLUMNS = [
  "x", // where the node is
  "y",
  "vx", // how fast it's moving, world px/s
  "vy",
  "homeX", // where its layout wants it
  "homeY",
  "labelAngle", // which way its label points (radians)
  "radius", // how far its shape reaches from its centre
  "boxX0", // its footprint (shape and label) relative to its centre
  "boxY0",
  "boxX1",
  "boxY1",
];

export class Matrix {
  /** @param {number} count rows (nodes) */
  constructor(count) {
    this.count = count;
    /** @type {Float64Array} */ this.x = new Float64Array(count);
    /** @type {Float64Array} */ this.y = new Float64Array(count);
    /** @type {Float64Array} */ this.vx = new Float64Array(count);
    /** @type {Float64Array} */ this.vy = new Float64Array(count);
    /** @type {Float64Array} */ this.homeX = new Float64Array(count);
    /** @type {Float64Array} */ this.homeY = new Float64Array(count);
    /** @type {Float64Array} */ this.labelAngle = new Float64Array(count);
    /** @type {Float64Array} */ this.radius = new Float64Array(count);
    /** @type {Float64Array} */ this.boxX0 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxY0 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxX1 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxY1 = new Float64Array(count);
  }

  /** Copy row `from` of `other` into row `to` of this matrix. */
  copyRow(to, other, from) {
    for (const c of COLUMNS) this[c][to] = other[c][from];
  }
}
