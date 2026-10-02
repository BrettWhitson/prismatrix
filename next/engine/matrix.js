// The matrix: every node's live state, one column per quantity (struct of arrays). Row i is node i of the working
// graph. Physics, morphs and renderers run straight down these columns; everything else can read a node's row
// through its view (graph.js: `node.x` is `matrix.x[node.index]`).
//
// Columns are 64-bit: big graphs are hundreds of thousands of world px wide, where 32-bit floats can only land on
// steps of a sixteenth of a pixel (renderers convert to 32-bit relative to the camera, where that doesn't matter).

export class Matrix {
  /** @param {number} count rows (nodes) */
  constructor(count) {
    this.count = count;
    // Where the node is, and how fast it's moving (world px/s).
    /** @type {Float64Array} */ this.x = new Float64Array(count);
    /** @type {Float64Array} */ this.y = new Float64Array(count);
    /** @type {Float64Array} */ this.vx = new Float64Array(count);
    /** @type {Float64Array} */ this.vy = new Float64Array(count);
    // Where its layout wants it.
    /** @type {Float64Array} */ this.homeX = new Float64Array(count);
    /** @type {Float64Array} */ this.homeY = new Float64Array(count);
    // Which way its label points (radians), and how far its shape reaches from its centre.
    /** @type {Float64Array} */ this.labelAngle = new Float64Array(count);
    /** @type {Float64Array} */ this.radius = new Float64Array(count);
    // Its footprint (shape and label) relative to its centre.
    /** @type {Float64Array} */ this.boxX0 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxY0 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxX1 = new Float64Array(count);
    /** @type {Float64Array} */ this.boxY1 = new Float64Array(count);
  }
}
