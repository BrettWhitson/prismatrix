// The WebGL painter's icon atlas: every icon a node shows, copied once into a texture array (one layer per page) at
// ICON_CELL px, with a border of its own edge pixels (ICON_GUTTER) so filtering, and the smaller mipmap levels, never
// pick up a neighbour. Pages start small and double (their icons keep their places, see AtlasPacker), then more pages
// are added. Mipmaps keep icons smooth when nodes are small; below ICON_MIN_PX on screen they aren't drawn at all.
//
// Icons are loaded by the IconStore (icons.js), which the Canvas 2D painter shares; the atlas copies each in the
// first time a node asks for it once it's loaded. `version` changes whenever a node's icon may have moved or come
// in, so the painter packs its nodes again then.

import { AtlasPacker, ICON_GUTTER, ICON_SLOT, cellFit } from "./icons.js";

/** Mipmap levels below the full size: the gutter still covers a cell's edge at the smallest (4 px at 1/8 is ½). */
const LEVELS = 4;
/** Cells per page side: the first page holds 4 × 4, pages double up to 16 × 16 (1,152 px), then more are added. */
const FIRST_SIDE = 4;
const MAX_SIDE = 16;
const MAX_LAYERS = 64;

export class IconAtlas {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {import("./icons.js").IconStore} store
   */
  constructor(gl, store) {
    this.gl = gl;
    this.store = store;
    const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const maxLayers =
      Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || MAX_LAYERS;
    this.packer = new AtlasPacker({
      side: FIRST_SIDE,
      maxSide: Math.min(MAX_SIDE, Math.floor(maxTexture / ICON_SLOT)),
      maxLayers: Math.min(MAX_LAYERS, maxLayers),
    });
    this.placed = new Map(); // store entry id → { layer, x, y, fit: { x, y, w, h }, aspect }
    this.texture = null;
    this.side = 0; // cells per page side the texture has room for
    this.layers = 0;
    this.version = 0; // bumped by every change: an icon in, more room
    this.moved = 0; // bumped when icons already in moved (bigger pages): every node's icon rectangle changed
    this.mipsDirty = false;
    this.full = false;
    this.scratch = null;
    // Until the first icon, the sampler still needs a complete texture.
    this.empty = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.empty);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /** Icons in the atlas. */
  get count() {
    return this.placed.size;
  }

  /**
   * Where `source`'s icon is in the atlas (copying it in if it has just loaded), or null: no icon, still loading,
   * failed, or no room left.
   * @returns {{ u0: number, v0: number, u1: number, v1: number, layer: number, aspect: number } | null}
   */
  lookup(source) {
    const entry = this.store.get(source);
    if (!entry || entry.state !== "ready") return null;
    let at = this.placed.get(entry.id);
    if (!at) {
      at = this.#add(entry);
      if (!at) return null;
    }
    const page = this.side * ICON_SLOT;
    const left = at.x * ICON_SLOT + ICON_GUTTER + at.fit.x,
      top = at.y * ICON_SLOT + ICON_GUTTER + at.fit.y;
    return {
      u0: left / page,
      v0: top / page,
      u1: (left + at.fit.w) / page,
      v1: (top + at.fit.h) / page,
      layer: at.layer,
      aspect: at.aspect,
    };
  }

  #add(entry) {
    if (this.full) return null;
    const spot = this.packer.place();
    if (!spot) {
      this.full = true;
      console.warn(
        `Prismatrix: the icon atlas is full (${this.placed.size} icons); more show their nodes' fill`,
      );
      return null;
    }
    if (this.packer.side !== this.side || this.packer.layers > this.layers)
      this.#grow(this.packer.side, this.packer.layers);
    const fit = cellFit(entry.width, entry.height);
    const at = {
      layer: spot.layer,
      x: spot.x,
      y: spot.y,
      fit,
      aspect: entry.width / entry.height,
    };
    this.#upload(entry.image, at);
    this.placed.set(entry.id, at);
    this.version++;
    return at;
  }

  /**
   * A texture with room for `side` × `side` cells on each of `layers` pages, with what the old one held copied
   * across (its cells keep their places). Layers are added a few at a time, so adding pages isn't a copy each.
   */
  #grow(side, layers) {
    const { gl } = this;
    const px = side * ICON_SLOT;
    const hadIcons = this.placed.size > 0 && side !== this.side;
    const room =
      side === this.side && this.layers
        ? Math.max(layers, this.layers * 2)
        : layers;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, LEVELS, gl.RGBA8, px, px, room);
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, LEVELS - 1);
    if (this.texture) {
      // Copy the old pages in, on the GPU: each old layer read through a framebuffer.
      const old = this.side * ICON_SLOT;
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      for (let layer = 0; layer < this.layers; layer++) {
        gl.framebufferTextureLayer(
          gl.READ_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          this.texture,
          0,
          layer,
        );
        gl.copyTexSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          layer,
          0,
          0,
          old,
          old,
        );
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(this.texture);
      this.mipsDirty = true;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.texture = texture;
    this.side = side;
    this.layers = room;
    // Every icon's place on its page, as a share of the page, has changed (when the pages grew).
    if (hadIcons) this.moved++;
    this.version++;
  }

  /** Draw an icon into its cell: fitted whole, and stretched to the cell's border underneath for the gutter. */
  #upload(image, at) {
    const { gl } = this;
    if (!this.scratch) {
      this.scratch =
        typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(ICON_SLOT, ICON_SLOT)
          : Object.assign(document.createElement("canvas"), {
              width: ICON_SLOT,
              height: ICON_SLOT,
            });
      this.ctx = this.scratch.getContext("2d");
    }
    const ctx = this.ctx;
    const { fit } = at;
    ctx.clearRect(0, 0, ICON_SLOT, ICON_SLOT);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, ICON_SLOT, ICON_SLOT);
    ctx.clearRect(ICON_GUTTER + fit.x, ICON_GUTTER + fit.y, fit.w, fit.h);
    ctx.drawImage(
      image,
      ICON_GUTTER + fit.x,
      ICON_GUTTER + fit.y,
      fit.w,
      fit.h,
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      at.x * ICON_SLOT,
      at.y * ICON_SLOT,
      at.layer,
      ICON_SLOT,
      ICON_SLOT,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.scratch,
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.mipsDirty = true;
  }

  /** Bind the atlas to texture unit `unit`, its mipmaps brought up to date first. */
  bind(unit) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture ?? this.empty);
    if (this.mipsDirty && this.texture) {
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      this.mipsDirty = false;
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    const { gl } = this;
    if (this.texture) gl.deleteTexture(this.texture);
    gl.deleteTexture(this.empty);
    this.texture = null;
    this.placed.clear();
  }
}
