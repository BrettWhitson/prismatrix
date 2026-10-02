/** The columns, in order. */
export declare const COLUMNS: string[];
export declare class Matrix {
  count: number;
  /** @type {Float64Array} */ x: Float64Array;
  /** @type {Float64Array} */ y: Float64Array;
  /** @type {Float64Array} */ vx: Float64Array;
  /** @type {Float64Array} */ vy: Float64Array;
  /** @type {Float64Array} */ homeX: Float64Array;
  /** @type {Float64Array} */ homeY: Float64Array;
  /** @type {Float64Array} */ labelAngle: Float64Array;
  /** @type {Float64Array} */ radius: Float64Array;
  /** @type {Float64Array} */ boxX0: Float64Array;
  /** @type {Float64Array} */ boxY0: Float64Array;
  /** @type {Float64Array} */ boxX1: Float64Array;
  /** @type {Float64Array} */ boxY1: Float64Array;
  /** @param {number} count rows (nodes) */
  constructor(count: number);
  /** Copy row `from` of `other` into row `to` of this matrix. */
  copyRow(to: any, other: any, from: any): void;
}
