import { AtlasPacker } from "./icons.js";
export declare class IconAtlas {
  #private;
  gl: WebGL2RenderingContext;
  store: import("./icons.js").IconStore;
  packer: AtlasPacker;
  placed: Map<any, any>;
  texture: WebGLTexture;
  side: number;
  layers: number;
  version: number;
  moved: number;
  mipsDirty: boolean;
  full: boolean;
  scratch:
    | OffscreenCanvas
    | (HTMLCanvasElement & {
        width: number;
        height: number;
      });
  empty: WebGLTexture;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {import("./icons.js").IconStore} store
   */
  constructor(
    gl: WebGL2RenderingContext,
    store: import("./icons.js").IconStore,
  );
  /** Icons in the atlas. */
  get count(): number;
  /**
   * Where `source`'s icon is in the atlas (copying it in if it has just loaded), or null: no icon, still loading,
   * failed, or no room left.
   * @returns {{ u0: number, v0: number, u1: number, v1: number, layer: number, aspect: number } | null}
   */
  lookup(source: any): {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    layer: number;
    aspect: number;
  } | null;
  /** Bind the atlas to texture unit `unit`, its mipmaps brought up to date first. */
  bind(unit: any): void;
  dispose(): void;
}
