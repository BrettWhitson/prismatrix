// Text for the WebGL renderer: everything labels.js plans (node and edge labels, counts, badges, pinned labels).
// Each distinct piece of text is drawn once with the browser's own text rendering (exact fonts, any script) into a
// shared texture, an atlas; the GPU then draws every piece as a quad cut from it.
//
// The atlas keeps two coverages per texel: red, the glyphs; green, what goes under them (the halo, a stroke round
// the glyphs, or a badge's pill). The shader paints the green in the halo's colour and the red in the text's on
// top (LABEL_FRAGMENT), so one cell serves any colours.
//
// Text is rasterised at a scale matched to the zoom, in steps (bucketScale), so it stays crisp without being redrawn
// on every zoom; text pinned to a size on screen is rasterised at that size. Only text on or near the screen is
// drawn (culling): zoomed in, that's a handful; zoomed out, it's small. When the zoom crosses a step, or panning
// brings new text near, it fills in over the next frames a few milliseconds at a time, while the previous atlas
// stands in, so labels never blink out.

import { palette, room } from "./gl-pack.js";
import {
  PILL,
  TEXT_HALO,
  font,
  planText,
  textBox,
  textFitter,
  textVisibility,
} from "./labels.js";

/** The atlas page size in texels. 2048 is safe on every WebGL2 device. */
const PAGE = 2048;
/** Spare texels around each cell so filtering never bleeds a neighbour in. */
const PAD = 2;
/** At most this long per frame is spent drawing new text into the atlas. */
const RASTER_BUDGET_MS = 6;
/** An atlas past this many pages (16 MB each) starts again: only what's near the screen needs to be in it. */
const MAX_PAGES = 4;

/**
 * The raster scale for a zoom: device pixels per world pixel, rounded up to a power of two between ¼ and 8, so
 * text is never drawn smaller than it's shown (and at most twice as big).
 */
export function bucketScale(zoom, dpr) {
  const step = 2 ** Math.min(3, Math.max(-2, Math.ceil(Math.log2(zoom))));
  return step * dpr;
}

/** A cell's key in the atlas: the text, its size and units, and whether it's a badge. */
const keyOf = (item) =>
  `${item.pill ? "p" : "t"}${item.screen ? "s" : "w"}${item.size}|${item.text}`;

/** One atlas: text at one raster scale, packed in shelves (rows of cells about the same height) across pages. */
class Atlas {
  constructor(gl, scale) {
    this.gl = gl;
    this.scale = scale;
    this.entries = new Map(); // key → { page, x, y, w, h, pad, px, textW } (texels)
    this.pages = [];
    this.shelves = []; // on the newest page: { y, h, x }
    this.top = 0; // where the next shelf starts on the newest page
    this.full = false;
    this.scratch = document.createElement("canvas");
    this.ctx = this.scratch.getContext("2d", { willReadFrequently: true });
  }

  #newPage() {
    if (this.pages.length >= MAX_PAGES) return null;
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PAGE, PAGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const page = { texture, index: this.pages.length };
    this.pages.push(page);
    this.shelves = [];
    this.top = 0;
    return page;
  }

  /** Room for a cell `w` × `h`: on a shelf about its height, or a new shelf, or a new page. Null when full. */
  #place(w, h) {
    let page = this.pages.at(-1) ?? this.#newPage();
    if (!page) return null;
    let shelf = this.shelves.find(
      (s) => s.h >= h && s.h <= h * 1.3 + 2 && s.x + w <= PAGE,
    );
    if (!shelf) {
      if (this.top + h > PAGE) {
        page = this.#newPage();
        if (!page) return null;
      }
      shelf = { y: this.top, h, x: 0 };
      this.top += h;
      this.shelves.push(shelf);
    }
    const at = { page, x: shelf.x, y: shelf.y };
    shelf.x += w;
    return at;
  }

  /** Draw `item`'s text (and halo or pill) at `px` texels a font size, as `key`. False when the atlas is full. */
  add(key, item, px) {
    const ctx = this.ctx;
    ctx.font = font(px);
    let textW = ctx.measureText(item.text).width;
    const padFor = (size) =>
      PAD + Math.ceil(item.pill ? 1 : TEXT_HALO * size + 1);
    let pad = padFor(px);
    let w = Math.ceil(textW + (item.pill ? 2 * PILL.pad * px : 0)) + pad * 2;
    // Text wider than a page at this scale (a long name zoomed far in) is drawn at a smaller size that fits, rather
    // than cut off: a little softer, but whole.
    if (w > PAGE) {
      px *= (PAGE - 8) / w;
      ctx.font = font(px);
      textW = ctx.measureText(item.text).width;
      pad = padFor(px);
      w = Math.min(
        Math.ceil(textW + (item.pill ? 2 * PILL.pad * px : 0)) + pad * 2,
        PAGE,
      );
    }
    const h =
      Math.ceil(px * Math.max(1.4, item.pill ? PILL.height : 0)) + pad * 2;
    const at = this.#place(w, h);
    if (!at) {
      this.full = true;
      return false;
    }
    if (this.scratch.width < w || this.scratch.height < h) {
      this.scratch.width = Math.max(this.scratch.width, w);
      this.scratch.height = Math.max(this.scratch.height, h);
    }
    // Green: the halo (a stroke round the glyphs) or the pill. Red: the glyphs. Added, not painted over, so each
    // keeps its own coverage where they meet.
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.font = font(px);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const textX = pad + (item.pill ? PILL.pad * px : 0);
    if (item.pill) {
      const ph = PILL.height * px;
      ctx.fillStyle = "#00ff00";
      ctx.beginPath();
      ctx.roundRect(pad, h / 2 - ph / 2, w - pad * 2, ph, ph / 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = "#00ff00";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2 * TEXT_HALO * px;
      ctx.strokeText(item.text, textX, h / 2);
    }
    ctx.fillStyle = "#ff0000";
    ctx.fillText(item.text, textX, h / 2);
    ctx.globalCompositeOperation = "source-over";
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, at.page.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      at.x,
      at.y,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      ctx.getImageData(0, 0, w, h),
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.entries.set(key, { ...at, w, h, pad, px, textW });
    return true;
  }

  dispose() {
    for (const page of this.pages) this.gl.deleteTexture(page.texture);
    this.pages = [];
    this.entries.clear();
  }
}

/**
 * Floats per piece of text: anchor x, y (world, relative to the origin) and whether its units are screen px; box
 * left, middle, width, height (its units, from the anchor); texel rect u0, v0, u1, v1; alpha; text colour r, g, b;
 * halo or pill colour r, g, b.
 */
export const LABEL_STRIDE = 18;

/**
 * The quads of the text on or near the screen, in drawing order, in runs by atlas page, drawing missing text into
 * the atlas as the time budget allows. Text not drawn yet at the current scale uses the previous atlas, or waits a
 * frame.
 */
export class LabelLayer {
  constructor(gl) {
    this.gl = gl;
    this.current = null;
    this.previous = null;
    this.data = new Float32Array(0);
    const measuring = document.createElement("canvas").getContext("2d");
    const widths = new Map();
    this.fit = textFitter((text, size) => {
      const key = `${size}|${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        if (widths.size > 50000) widths.clear();
        measuring.font = font(size);
        w = measuring.measureText(text).width;
        widths.set(key, w);
      }
      return w;
    });
  }

  /**
   * @returns {{ data: Float32Array, groups: { page: any, first: number, count: number }[], count: number,
   *   pending: boolean }}
   */
  build(scene, origin = { x: 0, y: 0 }) {
    const { camera, dpr, width, height } = scene;
    const scale = bucketScale(camera.k, dpr);
    if (
      !this.current ||
      this.current.scale !== scale ||
      // A full atlas starts again once (only what's near the screen goes in the new one); if even that fills
      // up, it stays as it is rather than restarting every frame.
      (this.current.full && !this.current.restarted)
    ) {
      // Keep the old atlas to stand in while the new one fills (a full one can't be added to, but can stand in).
      this.previous?.dispose();
      this.previous = this.current;
      const restarted = !!this.current?.full && this.current.scale === scale;
      this.current = new Atlas(this.gl, scale);
      this.current.restarted = restarted;
    }
    const atlas = this.current;
    // Near the screen: the view plus half a view on every side, so a pan has text ready before it shows.
    const halfW = width / camera.k,
      halfH = height / camera.k;
    const near = {
      x0: camera.x - halfW,
      x1: camera.x + halfW,
      y0: camera.y - halfH,
      y1: camera.y + halfH,
    };
    const items = planText(scene, { fit: this.fit, near });

    const started = performance.now();
    let outOfTime = false;
    let missing = false;
    const entryFor = (item) => {
      const key = keyOf(item);
      let entry = atlas.entries.get(key);
      if (!entry && !outOfTime && !atlas.full) {
        if (performance.now() - started > RASTER_BUDGET_MS) outOfTime = true;
        else if (
          atlas.add(key, item, item.size * (item.screen ? dpr : atlas.scale))
        )
          entry = atlas.entries.get(key);
      }
      if (entry) return entry;
      const old = this.previous?.entries.get(key);
      if (old || !(atlas.full && atlas.restarted)) missing = true;
      return old ?? null;
    };

    const data = (this.data = room(this.data, items.length * LABEL_STRIDE));
    const rgb = palette();
    const groups = [];
    let at = 0;
    for (const item of items) {
      const entry = entryFor(item);
      if (!entry) continue;
      const last = groups.at(-1);
      if (last?.page === entry.page) last.count++;
      else groups.push({ page: entry.page, first: at, count: 1 });
      // Units (world or screen px) per texel: the cell was drawn at entry.px texels for `size` units.
      const u = item.size / entry.px;
      const box = textBox(item, entry.textW * u);
      const o = at++ * LABEL_STRIDE;
      data[o] = item.x - origin.x;
      data[o + 1] = item.y - origin.y;
      data[o + 2] = item.screen ? 1 : 0;
      // The quad covers the whole cell, padding included.
      data[o + 3] = box.left - entry.pad * u;
      data[o + 4] = box.middle;
      data[o + 5] = entry.w * u;
      data[o + 6] = entry.h * u;
      data[o + 7] = entry.x / PAGE;
      data[o + 8] = entry.y / PAGE;
      data[o + 9] = (entry.x + entry.w) / PAGE;
      data[o + 10] = (entry.y + entry.h) / PAGE;
      data[o + 11] = item.alpha;
      const [r, g, b] = rgb(item.colour);
      const [ur, ug, ub] = rgb(item.under);
      data[o + 12] = r;
      data[o + 13] = g;
      data[o + 14] = b;
      data[o + 15] = ur;
      data[o + 16] = ug;
      data[o + 17] = ub;
    }
    if (atlas.full && !atlas.restarted) missing = true; // start a fresh one next frame
    // Everything is in the new atlas: the old one can go.
    if (!missing && this.previous) {
      this.previous.dispose();
      this.previous = null;
    }
    return { data, groups, count: at, pending: missing };
  }

  dispose() {
    this.current?.dispose();
    this.previous?.dispose();
    this.current = this.previous = null;
  }
}

/**
 * What the text drawn depends on besides the scene's versions and where the camera is: what shows at this zoom
 * (textVisibility). The painter builds the text again when it changes.
 */
export function textKey(scene) {
  const v = textVisibility(scene);
  return `${+v.labels}${+v.edges}${+v.small}${+v.pinnedWorld}`;
}
