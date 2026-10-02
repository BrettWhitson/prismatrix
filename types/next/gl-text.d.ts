/**
 * The raster scale for a zoom: device pixels per world pixel, rounded up to a power of two between ¼ and 8, so
 * text is never drawn smaller than it's shown (and at most twice as big).
 */
export declare function bucketScale(zoom: any, dpr: any): number;
/**
 * Floats per piece of text: anchor x, y (world, relative to the origin) and whether its units are screen px; box
 * left, middle, width, height (its units, from the anchor); texel rect u0, v0, u1, v1; alpha; text colour r, g, b;
 * halo or pill colour r, g, b.
 */
export declare const LABEL_STRIDE = 18;
/**
 * The quads of the text on or near the screen, in drawing order, in runs by atlas page, drawing missing text into
 * the atlas as the time budget allows. Text not drawn yet at the current scale uses the previous atlas, or waits a
 * frame.
 */
export declare class LabelLayer {
  gl: any;
  current: any;
  previous: any;
  data: Float32Array<ArrayBuffer>;
  fit: (text: string, size: number, max: number) => string;
  constructor(gl: any);
  /**
   * @returns {{ data: Float32Array, groups: { page: any, first: number, count: number }[], count: number,
   *   pending: boolean }}
   */
  build(
    scene: any,
    origin?: {
      x: number;
      y: number;
    },
  ): {
    data: Float32Array;
    groups: {
      page: any;
      first: number;
      count: number;
    }[];
    count: number;
    pending: boolean;
  };
  dispose(): void;
}
/**
 * What the text drawn depends on besides the scene's versions and where the camera is: what shows at this zoom
 * (textVisibility). The painter builds the text again when it changes.
 */
export declare function textKey(scene: any): string;
