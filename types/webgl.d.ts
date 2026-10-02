import { LabelLayer } from "./gl-text.js";
import { IconAtlas } from "./gl-icons.js";
/**
 * Which nodes and edges to restyle in place since style version `from` (the restyle log the view keeps on its
 * scene: `restyles`, newest last, each `{ version, nodes, edges }`), or null when that can't be told (a restyle of
 * everything, or one the log no longer holds): then everything is built again.
 * @returns {{ nodes: Int32Array, edges: Int32Array } | null}
 */
export declare function restylesSince(
  restyles: any,
  from: any,
  to: any,
): {
  nodes: Int32Array;
  edges: Int32Array;
} | null;
/** True when this browser can give us a WebGL2 context. */
export declare function webglAvailable(): boolean;
/**
 * Instances of a unit quad (or, without `corners`, of `vertices` vertices the shader places itself), each with
 * attributes read from one buffer of floats.
 * @param {[location: number, size: number, offset: number][]} layout attribute location, floats, float offset
 */
declare class InstancedQuads {
  #private;
  gl: any;
  stride: any;
  layout: any;
  alphaLocation: number;
  mode: any;
  vertices: number;
  vao: any;
  buffer: any;
  capacity: number;
  alphaBuffer: any;
  alphaCapacity: number;
  /**
   * @param {number | null} [alphaLocation] a per-instance float read from a buffer of its own (uploadAlpha)
   * @param {{ mode?: number, vertices?: number }} [shape] how each instance is drawn (default: a 4-vertex strip)
   */
  constructor(
    gl: any,
    corners: any,
    stride: any,
    layout: any,
    alphaLocation?: number | null,
    shape?: {
      mode?: number;
      vertices?: number;
    },
  );
  /** The per-instance alpha, one float each. */
  uploadAlpha(data: any, count: any): void;
  upload(data: any, count: any): void;
  /** Just instances `runs` ([first, end) each) of `data`, into a buffer already holding the rest. */
  uploadRuns(data: any, runs: any): void;
  /** Draw instances [first, end), each of `vertices` vertices (default: as constructed). */
  draw(first: any, end: any, vertices?: number): void;
}
/**
 * The WebGL painter for a renderer's canvas: background, edges, nodes and text, drawn with WebGL2 on a canvas of its
 * own (glCanvas) beneath the renderer's, which stays on top to take the pointer.
 */
export declare class WebGLPainter {
  #private;
  name: string;
  /** Set by the renderer: asks for a frame (an icon came in). */
  wake: any;
  top: HTMLCanvasElement;
  topCtx: CanvasRenderingContext2D;
  glCanvas: HTMLCanvasElement;
  previousPosition: string;
  icons: import("./icons.js").IconStore;
  lost: boolean;
  edgeData: {
    segments: Float32Array;
    ends: Float32Array;
    segmentEdge: Int32Array;
    endEdge: Int32Array;
    segmentCount: number;
    endCount: number;
  };
  nodeData: any;
  scene: any;
  /** `{ edges, nodes, labels, total }` GPU milliseconds while `timing` is on (null until the first results). */
  gpuTimes: any;
  unlisten: () => boolean;
  iconsArrived: boolean;
  gl: WebGL2RenderingContext;
  nodeProgram: {
    program: any;
    uniforms: {};
  };
  haloProgram: {
    program: any;
    uniforms: {};
  };
  segmentProgram: {
    program: any;
    uniforms: {};
  };
  endProgram: {
    program: any;
    uniforms: {};
  };
  compositeProgram: {
    program: any;
    uniforms: {};
  };
  pieceProgram: {
    program: any;
    uniforms: {};
  };
  tipProgram: {
    program: any;
    uniforms: {};
  };
  bundleProgram: {
    program: any;
    uniforms: {};
  };
  bundleTipProgram: {
    program: any;
    uniforms: {};
  };
  iconAtlas: IconAtlas;
  nodes: InstancedQuads;
  halos: InstancedQuads;
  haloData: {
    data: any;
    count: number;
  };
  segments: InstancedQuads;
  ends: InstancedQuads;
  pieces: InstancedQuads;
  tips: InstancedQuads;
  spans: InstancedQuads;
  bundleTips: InstancedQuads;
  positions: {
    texture: WebGLTexture;
    rows: number;
    data: any;
  };
  gpu: {
    pieces: Float32Array;
    pieceEdge: Int32Array;
    pieceCount: number;
    shapedPieces: number;
    tips: Float32Array;
    tipEdge: Int32Array;
    tipCount: number;
    shapedTips: number;
    spans: Float32Array;
    spanEdge: Int32Array;
    spanCount: number;
    bundleTips: Float32Array;
    bundleTipEdge: Int32Array;
    bundleTipCount: number;
    shape: number;
    axis: number[];
    radial: boolean;
  };
  gpuAlpha: {};
  geometry: any;
  origin:
    | {
        x: number;
        y: number;
      }
    | {
        x: number;
        y: number;
      };
  labelProgram: {
    program: any;
    uniforms: {};
  };
  labels: InstancedQuads;
  glyphProgram: {
    program: any;
    uniforms: {};
  };
  glyphs: InstancedQuads;
  glyphData: {
    data: any;
    count: number;
  };
  labelLayer: LabelLayer;
  labelGroups:
    | any[]
    | {
        page: any;
        first: number;
        count: number;
      }[];
  labelKey: string;
  pending: boolean;
  emptyVao: WebGLVertexArrayObject;
  target: any;
  built: {
    version: any;
    shadeVersion: any;
    selectionVersion: any;
    styleVersion: any;
    base: any;
    nodes: any;
    edges: any;
  };
  perEdge: any;
  timer: {
    ext: any;
    pending: any[];
    frame: any;
  };
  cleared: boolean;
  states: any;
  brightness: any;
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ icons?: import("./icons.js").IconStore }} [options] where icons come from (default: the page's shared
   *   store)
   */
  constructor(
    canvas: HTMLCanvasElement,
    {
      icons,
    }?: {
      icons?: import("./icons.js").IconStore;
    },
  );
  resize(width: any, height: any, dpr: any): void;
  /**
   * Debugging: measure how long the GPU spends on each pass (edges, nodes, labels), where the browser offers
   * EXT_disjoint_timer_query_webgl2. In the sandbox's console: `renderer.painter.timing = true`, move something,
   * then read `renderer.painter.gpuTimes` (milliseconds, smoothed over frames). Off by default.
   */
  get timing(): boolean;
  set timing(on: boolean);
  draw(scene: any): void;
  dispose(): void;
}
export {};
