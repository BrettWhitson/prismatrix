/** Nodes smaller than this across on screen (CSS px) show no icon... */
export declare const ICON_MIN_PX = 8;
/** ...and fade their icon in over this many px more. */
export declare const ICON_FADE_PX = 4;
/** How much of a node's icon shows at this zoom, 0–1, by its size on screen (ICON_MIN_PX, ICON_FADE_PX). */
export declare function iconShown(radius: any, zoom: any): number;
/**
 * The box an icon is drawn in, centred on its node: half its width and height in world px. "cover" fills the
 * shape's bounding square (the shape clips what's outside it); "contain" keeps the whole icon inside the shape, and
 * inside its border (`strokeWidth`). `aspect` is the icon's width over its height.
 * @returns {[number, number]}
 */
export declare function iconBox(
  shape: any,
  fit: any,
  aspect: any,
  radius: any,
  strokeWidth?: number,
): [number, number];
/** Corner radii as a share of the node's radius: "rounded" and "tile" (the shaders' NODE_SHAPES use the same). */
export declare const ROUNDED_CORNER = 0.45;
export declare const TILE_CORNER = 0.2;
export type IconEntry = {
  /**
   * small and unique in its store (atlases key on it)
   */
  id: number;
  state: "loading" | "ready" | "failed";
  /**
   * the URL or image it was asked for by
   */
  source: any;
  /**
   * something a canvas can draw (once ready)
   */
  image: any;
  /**
   * natural size, px (once ready)
   */
  width: number;
  height: number;
};
/** Icons by URL (or image object), each loaded once, at most `concurrency` at a time; listeners hear each arrive. */
export declare class IconStore {
  #private;
  load: (url: string) => Promise<any>;
  concurrency: number;
  byUrl: Map<any, any>;
  byObject: WeakMap<WeakKey, any>;
  queue: any[];
  active: number;
  listeners: Set<any>;
  count: number;
  failures: number;
  /**
   * @param {{ load?: (url: string) => Promise<any>, concurrency?: number }} [options] how a URL becomes an image
   *   (default: an Image element, with CORS)
   */
  constructor({
    load,
    concurrency,
  }?: {
    load?: (url: string) => Promise<any>;
    concurrency?: number;
  });
  /**
   * The entry for an icon (a URL or an image), starting to load it the first time it's asked for; null for no
   * icon.
   * @returns {IconEntry | null}
   */
  get(source: any): IconEntry | null;
  /** Call `listener(entry)` whenever an icon finishes loading (or fails). Returns a function that stops it. */
  onReady(listener: any): () => boolean;
}
/** The store painters share unless they're given their own: an icon is loaded once for every view on the page. */
export declare function iconStore(): any;
export declare const ICON_GUTTER = 4;
/** A cell with its border. */
export declare const ICON_SLOT: number;
/** The n-th cell of a page in Z order: the first s² cells fill an s × s corner, so a page can double and keep them. */
export declare function zOrder(n: any): any[];
/**
 * Where icons go in an atlas of square pages of `side` × `side` cells: a page fills in Z order, then doubles (its
 * cells keep their places) up to `maxSide`, then another page is added, up to `maxLayers`.
 */
export declare class AtlasPacker {
  maxSide: number;
  side: number;
  maxLayers: number;
  layers: number;
  used: number;
  constructor({
    side,
    maxSide,
    maxLayers,
  }?: {
    maxLayers?: number;
    maxSide?: number;
    side?: number;
  });
  /**
   * The next free cell: its page (`layer`) and column and row, the page doubling or a page added first when the
   * last is full. Null when the atlas is full.
   * @returns {{ layer: number, x: number, y: number } | null}
   */
  place(): {
    layer: number;
    x: number;
    y: number;
  } | null;
}
/**
 * Where an icon of `width` × `height` sits in its cell: fitted inside it (whole, centred), in px from the cell's
 * top left (inside the gutter).
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export declare function cellFit(
  width: any,
  height: any,
  cell?: number,
): {
  x: number;
  y: number;
  w: number;
  h: number;
};
