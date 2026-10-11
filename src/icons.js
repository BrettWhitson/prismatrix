// Node icons: an image drawn inside a node (a node style's `icon`: a URL, or an image already in hand). An IconStore
// loads each icon once and keeps it, by URL (or by the image object itself), for every painter; painters ask it for
// a node's icon whenever they draw or pack the node, show the node as it would be without one (its fill: the
// placeholder) until the icon is in, and are told when one arrives so they can draw again.
//
// The WebGL painter copies icons into an atlas (gl-icons.js): fixed-size cells on square pages that grow, then more
// pages, with mipmaps for zoomed-out views. The Canvas 2D painter draws them straight from the store.
//
// Icons are clipped to their node's shape, and left out where a node is too small on screen to show one.
//
// Pure apart from the default loader (an Image element).

import { reach } from "./boxes.js";
import { warnOnce } from "./schema.js";

/** Nodes smaller than this across on screen (CSS px) show no icon... */
export const ICON_MIN_PX = 8;
/** ...and fade their icon in over this many px more. */
export const ICON_FADE_PX = 4;

/** How much of a node's icon shows at this zoom, 0–1, by its size on screen (ICON_MIN_PX, ICON_FADE_PX). */
export function iconShown(radius, zoom) {
  const t = (2 * radius * zoom - ICON_MIN_PX) / ICON_FADE_PX;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * The box an icon is drawn in, centred on its node: half its width and height in world px. "cover" fills the
 * shape's bounding square (the shape clips what's outside it); "contain" keeps the whole icon inside the shape, and
 * inside its border (`strokeWidth`). `aspect` is the icon's width over its height.
 * @returns {[number, number]}
 */
export function iconBox(shape, fit, aspect, radius, strokeWidth = 0) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (fit !== "contain") {
    const r = radius * reach(shape);
    return a >= 1 ? [r * a, r] : [r, r / a];
  }
  const r = Math.max(0, radius - strokeWidth);
  // The biggest box of this aspect inside the shape (unit radius): its half height, then its half width is a times it.
  let h;
  switch (shape) {
    case "square":
      h = Math.min(1, 1 / a);
      break;
    case "rounded":
    case "tile": {
      // Inside a rounded square of half side 1 and corner radius c: square within the straight sides, and the box's
      // corner no further out than the corner's arc (centred at i, i, i = 1 - c): where it's past it, the box's
      // corner on the arc, the larger root of (a·h - i)² + (h - i)² = c².
      const c = shape === "tile" ? TILE_CORNER : ROUNDED_CORNER;
      const i = 1 - c;
      h = Math.min(1, 1 / a);
      if (Math.hypot(Math.max(0, a * h - i), Math.max(0, h - i)) > c + 1e-12)
        h =
          (i * (a + 1) +
            Math.sqrt(
              Math.max(0, c * c * (a * a + 1) - i * i * (a - 1) ** 2),
            )) /
          (a * a + 1);
      break;
    }
    case "diamond":
      // |x| + |y| <= 1.25
      h = 1.25 / (1 + a);
      break;
    case "hexagon":
      // Points at top and bottom, 1.1 from the centre: |x| <= 1.1·√3/2 and |x|/√3 + |y| <= 1.1.
      h = Math.min(1.1 / (1 + a / Math.sqrt(3)), (1.1 * Math.sqrt(3)) / 2 / a);
      break;
    default:
      // A circle (and a ring's disc): the box's corner on the circle.
      h = 1 / Math.sqrt(1 + a * a);
  }
  return [a * h * r, h * r];
}

/** Corner radii as a share of the node's radius: "rounded" and "tile" (the shaders' NODE_SHAPES use the same). */
export const ROUNDED_CORNER = 0.45;
export const TILE_CORNER = 0.2;

/**
 * @typedef {object} IconEntry
 * @property {number} id       small and unique in its store (atlases key on it)
 * @property {"loading" | "ready" | "failed"} state
 * @property {any} source      the URL or image it was asked for by
 * @property {any} image       something a canvas can draw (once ready)
 * @property {number} width    natural size, px (once ready)
 * @property {number} height
 */

/** Load an image by URL, for drawing on canvases and into textures (so it's asked for with CORS). */
function loadImage(url) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = url;
  return image.decode().then(() => image);
}

/** An image's natural size, whatever kind of image it is. */
function sizeOf(image) {
  return {
    width: image.naturalWidth || image.videoWidth || image.width || 0,
    height: image.naturalHeight || image.videoHeight || image.height || 0,
  };
}

/** Icons by URL (or image object), each loaded once, at most `concurrency` at a time; listeners hear each arrive. */
export class IconStore {
  /**
   * @param {{ load?: (url: string) => Promise<any>, concurrency?: number }} [options] how a URL becomes an image
   *   (default: an Image element, with CORS)
   */
  constructor({ load = loadImage, concurrency = 8 } = {}) {
    this.load = load;
    this.concurrency = concurrency;
    this.byUrl = new Map();
    this.byObject = new WeakMap();
    this.queue = [];
    this.active = 0;
    this.listeners = new Set();
    this.count = 0;
    this.failures = 0;
  }

  /**
   * The entry for an icon (a URL or an image), starting to load it the first time it's asked for; null for no
   * icon.
   * @returns {IconEntry | null}
   */
  get(source) {
    if (source === null || source === undefined || source === "") return null;
    const byUrl = typeof source === "string";
    if (!byUrl && typeof source !== "object") return null;
    const known = byUrl ? this.byUrl.get(source) : this.byObject.get(source);
    if (known) return known;
    /** @type {IconEntry} */
    const entry = {
      id: this.count++,
      state: "loading",
      source,
      image: null,
      width: 0,
      height: 0,
    };
    if (byUrl) {
      this.byUrl.set(source, entry);
      this.queue.push(entry);
      this.#next();
    } else {
      this.byObject.set(source, entry);
      // An image element still loading is waited for; anything else (a bitmap, a canvas) is ready as it is.
      if (source.complete === false && typeof source.decode === "function")
        source.decode().then(
          () => this.#ready(entry, source),
          () => this.#failed(entry),
        );
      else this.#ready(entry, source, false);
    }
    return entry;
  }

  /** Call `listener(entry)` whenever an icon finishes loading (or fails). Returns a function that stops it. */
  onReady(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #next() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      this.active++;
      let promise;
      try {
        promise = Promise.resolve(this.load(entry.source));
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (image) => {
          this.active--;
          this.#ready(entry, image);
          this.#next();
        },
        () => {
          this.active--;
          this.#failed(entry);
          this.#next();
        },
      );
    }
  }

  #ready(entry, image, tell = true) {
    const { width, height } = sizeOf(image);
    if (!(width > 0 && height > 0)) return this.#failed(entry);
    Object.assign(entry, { state: "ready", image, width, height });
    if (tell) this.#tell(entry);
  }

  #failed(entry) {
    entry.state = "failed";
    if (this.failures++ === 0)
      warnOnce(
        `an icon couldn't be loaded (${typeof entry.source === "string" ? entry.source : "an image"}); nodes without their icon show their fill`,
      );
    this.#tell(entry);
  }

  #tell(entry) {
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch (error) {
        console.error("Prismatrix: an icon listener threw", error);
      }
    }
  }
}

let shared = null;

/** The store painters share unless they're given their own: an icon is loaded once for every view on the page. */
export function iconStore() {
  return (shared ??= new IconStore());
}

// ---- atlas packing (pure: the GL side is gl-icons.js) ----------------------------------------------------------------

/** Pixels an icon is kept at in an atlas (each way), and the border of repeated edge pixels around it. */
const ICON_CELL = 64;
export const ICON_GUTTER = 4;
/** A cell with its border. */
export const ICON_SLOT = ICON_CELL + 2 * ICON_GUTTER;

/** The n-th cell of a page in Z order: the first s² cells fill an s × s corner, so a page can double and keep them. */
export function zOrder(n) {
  const compact = (v) => {
    v &= 0x55555555;
    v = (v | (v >> 1)) & 0x33333333;
    v = (v | (v >> 2)) & 0x0f0f0f0f;
    v = (v | (v >> 4)) & 0x00ff00ff;
    v = (v | (v >> 8)) & 0x0000ffff;
    return v;
  };
  return [compact(n), compact(n >> 1)];
}

/**
 * Where icons go in an atlas of square pages of `side` × `side` cells: a page fills in Z order, then doubles (its
 * cells keep their places) up to `maxSide`, then another page is added, up to `maxLayers`.
 */
export class AtlasPacker {
  constructor({ side = 4, maxSide = 16, maxLayers = 32 } = {}) {
    this.maxSide = Math.max(1, maxSide);
    this.side = Math.min(Math.max(1, side), this.maxSide);
    this.maxLayers = Math.max(1, maxLayers);
    this.layers = 1;
    this.used = 0; // cells used on the last page
  }

  /**
   * The next free cell: its page (`layer`) and column and row, the page doubling or a page added first when the
   * last is full. Null when the atlas is full.
   * @returns {{ layer: number, x: number, y: number } | null}
   */
  place() {
    if (this.used >= this.side * this.side) {
      if (this.side < this.maxSide) this.side *= 2;
      else if (this.layers < this.maxLayers) {
        this.layers++;
        this.used = 0;
      } else return null;
    }
    const [x, y] = zOrder(this.used++);
    return { layer: this.layers - 1, x, y };
  }
}

/**
 * Where an icon of `width` × `height` sits in its cell: fitted inside it (whole, centred), in px from the cell's
 * top left (inside the gutter).
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function cellFit(width, height, cell = ICON_CELL) {
  const a = width / height;
  const w = a >= 1 ? cell : cell * a,
    h = a >= 1 ? cell / a : cell;
  return { x: (cell - w) / 2, y: (cell - h) / 2, w, h };
}
