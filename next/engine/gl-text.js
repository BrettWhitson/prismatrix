// Labels for the WebGL renderer. Each distinct label is drawn once with the browser's own text rendering (exact
// fonts, any script) into a shared texture, an atlas; the GPU then draws every label as a quad cut from it.
//
// Text is rasterised at a scale matched to the zoom, in steps (bucketScale), so it stays crisp without being redrawn
// on every zoom. Only labels on or near the screen are drawn (culling): zoomed in, that's a handful; zoomed out,
// they're small. When the zoom crosses a step, or panning brings new labels near, they fill in over the next
// frames a few milliseconds at a time, while the previous atlas stands in, so labels never blink out.

import { labelAnchor } from "./boxes.js";

/** The atlas page size in texels. 2048 is safe on every WebGL2 device. */
const PAGE = 2048;
/** Spare texels around each label so filtering never bleeds a neighbour in. */
const PAD = 2;
/** At most this long per frame is spent drawing new labels into the atlas. */
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

/**
 * Where a label sits in the world: its left edge, its vertical middle (the middle of the em box, as Canvas 2D's
 * "middle" baseline), and its width, for a node at (x, y) of radius `r`, label direction `angle`, font size `size`
 * and text width `width` (world px). Matches the Canvas 2D renderer's placement.
 */
export function labelBox(x, y, r, angle, size, width) {
  const a = labelAnchor(angle, r);
  const left =
    a.align === "left"
      ? a.x
      : a.align === "right"
        ? a.x - width
        : a.x - width / 2;
  // "top" and "bottom" put the em box's top or bottom at the anchor: its middle is half a font size away.
  const middle =
    a.baseline === "top"
      ? a.y + size / 2
      : a.baseline === "bottom"
        ? a.y - size / 2
        : a.y;
  return { left: x + left, middle: y + middle, width };
}

/** One atlas: labels for one font size at one raster scale, packed in rows across pages. */
class Atlas {
  constructor(gl, fontSize, scale) {
    this.gl = gl;
    this.fontSize = fontSize;
    this.scale = scale;
    this.px = fontSize * scale; // font size in texels
    // A row is tall enough for ascenders and descenders around the middle line.
    this.rowHeight = Math.ceil(this.px * 1.4) + PAD * 2;
    this.entries = new Map(); // text → { page, x, y, w, h } (texels)
    this.pages = [];
    this.cursor = { x: 0, y: 0 };
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
    this.cursor = { x: 0, y: 0 };
    return page;
  }

  /** Draw `text` into the atlas. Returns false when the atlas is full. */
  add(text) {
    const font = `${this.px}px system-ui, sans-serif`;
    this.ctx.font = font;
    const w = Math.min(
      Math.ceil(this.ctx.measureText(text).width) + PAD * 2,
      PAGE,
    );
    const h = this.rowHeight;
    let page = this.pages.at(-1) ?? this.#newPage();
    if (page && this.cursor.x + w > PAGE) {
      this.cursor.x = 0;
      this.cursor.y += h;
    }
    if (page && this.cursor.y + h > PAGE) page = this.#newPage();
    if (!page) {
      this.full = true;
      return false;
    }
    // Rasterise into a scratch canvas the size of the cell, then copy it into the page.
    if (this.scratch.width < w || this.scratch.height < h) {
      this.scratch.width = Math.max(this.scratch.width, w);
      this.scratch.height = Math.max(this.scratch.height, h);
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, PAD, h / 2);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, page.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      this.cursor.x,
      this.cursor.y,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      ctx.getImageData(0, 0, w, h),
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.entries.set(text, {
      page,
      x: this.cursor.x,
      y: this.cursor.y,
      w,
      h,
    });
    this.cursor.x += w;
    return true;
  }

  dispose() {
    for (const page of this.pages) this.gl.deleteTexture(page.texture);
    this.pages = [];
    this.entries.clear();
  }
}

/** Floats per label: left, middle, world width and height of the quad; texel rect u0, v0, u1, v1; alpha. */
export const LABEL_STRIDE = 9;

/**
 * The quads of the labels on or near the screen, grouped by atlas page, drawing missing labels into the atlas as
 * the time budget allows. Labels not drawn yet at the current scale use the previous atlas, or wait a frame.
 */
export class LabelLayer {
  constructor(gl) {
    this.gl = gl;
    this.current = null;
    this.previous = null;
    this.data = new Float32Array(0);
    this.pending = false; // labels still waiting to be drawn into the atlas
  }

  /**
   * @returns {{ data: Float32Array, groups: { page: any, first: number, count: number }[], pending: boolean }}
   */
  build(scene, labelAlpha, reach) {
    const { graph, node, looks, camera, dpr, width, height } = scene;
    const scale = bucketScale(camera.k, dpr);
    if (
      !this.current ||
      this.current.scale !== scale ||
      this.current.fontSize !== node.labelSize ||
      // A full atlas starts again once (only what's near the screen goes in the new one); if even that fills
      // up, it stays as it is rather than restarting every frame.
      (this.current.full && !this.current.restarted)
    ) {
      // Keep the old atlas to stand in, if it's for the same font size. A full one can't be added to, so it's
      // replaced, but it can still stand in while the new one fills.
      const keep = this.current && this.current.fontSize === node.labelSize;
      this.previous?.dispose();
      this.previous = keep ? this.current : null;
      if (!keep) this.current?.dispose();
      const restarted = !!this.current?.full && this.current.scale === scale;
      this.current = new Atlas(this.gl, node.labelSize, scale);
      this.current.restarted = restarted;
    }
    const atlas = this.current;
    const size = node.labelSize;
    // Near the screen: the view plus half a view on every side, so a pan has labels ready before they show.
    const halfW = width / camera.k,
      halfH = height / camera.k;
    const near = (n) =>
      Math.abs(n.x - camera.x) < halfW && Math.abs(n.y - camera.y) < halfH;

    const started = performance.now();
    let outOfTime = false;
    const entryFor = (text) => {
      let entry = atlas.entries.get(text);
      if (!entry && !outOfTime && !atlas.full) {
        if (performance.now() - started > RASTER_BUDGET_MS) outOfTime = true;
        else if (atlas.add(text)) entry = atlas.entries.get(text);
      }
      if (entry) return { entry, scale: atlas.scale };
      const old = this.previous?.entries.get(text);
      return old ? { entry: old, scale: this.previous.scale } : null;
    };

    const byPage = new Map();
    let missing = false;
    for (const n of graph.nodes) {
      if (!n.label || !near(n)) continue;
      const alpha = labelAlpha(scene, n.index);
      if (alpha <= 0) continue;
      const found = entryFor(n.label);
      if (found?.entry && found.scale !== atlas.scale) missing = true;
      if (!found) {
        if (!(atlas.full && atlas.restarted)) missing = true;
        continue;
      }
      let list = byPage.get(found.entry.page);
      if (!list) byPage.set(found.entry.page, (list = []));
      list.push(n, found, alpha);
    }
    if (atlas.full && !atlas.restarted) missing = true; // start a fresh one next frame

    let count = 0;
    for (const list of byPage.values()) count += list.length / 3;
    if (this.data.length < count * LABEL_STRIDE)
      this.data = new Float32Array(Math.ceil(count * 1.5) * LABEL_STRIDE);
    const groups = [];
    let at = 0;
    for (const [page, list] of byPage) {
      const first = at;
      for (let i = 0; i < list.length; i += 3) {
        const n = list[i],
          { entry, scale: s } = list[i + 1],
          alpha = list[i + 2];
        const textWidth = (entry.w - PAD * 2) / s;
        const box = labelBox(
          n.x,
          n.y,
          looks.radius[n.index] * reach,
          n.labelAngle,
          size,
          textWidth,
        );
        const o = at++ * LABEL_STRIDE;
        // The quad covers the whole cell, padding included.
        this.data[o] = box.left - PAD / s;
        this.data[o + 1] = box.middle;
        this.data[o + 2] = entry.w / s;
        this.data[o + 3] = entry.h / s;
        this.data[o + 4] = entry.x / PAGE;
        this.data[o + 5] = entry.y / PAGE;
        this.data[o + 6] = (entry.x + entry.w) / PAGE;
        this.data[o + 7] = (entry.y + entry.h) / PAGE;
        this.data[o + 8] = alpha;
      }
      groups.push({ page, first, count: at - first });
    }
    // Everything is in the new atlas: the old one can go.
    if (!missing && this.previous) {
      this.previous.dispose();
      this.previous = null;
    }
    this.pending = missing;
    return { data: this.data, groups, count: at, pending: missing };
  }

  dispose() {
    this.current?.dispose();
    this.previous?.dispose();
    this.current = this.previous = null;
  }
}
