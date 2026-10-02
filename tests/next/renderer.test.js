// The renderer's side of input: DOM events on its canvas become controller calls (every pointer by its id), the
// canvas takes touches for itself, and letting go of the canvas leaves it as it was. A stand-in DOM and painter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Renderer } from "../../next/engine/renderer.js";
import { GraphController } from "../../next/engine/controller.js";
import { GraphModel } from "../../next/engine/model.js";

/** Just enough DOM for a renderer: a canvas that keeps its listeners, frames on demand. */
function stubDom() {
  const frames = [];
  globalThis.document = {
    hidden: false,
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText: (t) => ({ width: t.length * 6 }),
      }),
    }),
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const canvas = {
    style: { touchAction: "pan-y" },
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 800,
      height: 600,
    }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) =>
      listeners.get(type) === fn && listeners.delete(type),
    setPointerCapture() {},
  };
  const painter = { name: "fake", draw() {}, resize() {}, dispose() {} };
  /** Fire a DOM event at the canvas; returns whether its default was prevented. */
  const fire = (type, init = {}) => {
    let prevented = false;
    listeners.get(type)?.({
      timeStamp: 0,
      pointerType: "touch",
      button: 0,
      ...init,
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  const restore = () => {
    for (const key of [
      "document",
      "window",
      "ResizeObserver",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ])
      delete globalThis[key];
  };
  return { canvas, painter, listeners, fire, frames, restore };
}

test("a renderer takes touches on its canvas for itself, and gives the canvas back as it was", () => {
  const dom = stubDom();
  try {
    const renderer = new Renderer(dom.canvas, dom.painter);
    const c = new GraphController(
      new GraphModel({ nodes: [{ id: "a" }] }),
      renderer,
    );
    assert.equal(dom.canvas.style.touchAction, "none");
    assert.ok(dom.listeners.has("pointercancel"));
    c.setRenderer(null);
    assert.equal(dom.canvas.style.touchAction, "pan-y");
    assert.equal(dom.listeners.size, 0, "every listener removed");
  } finally {
    dom.restore();
  }
});

test("two fingers on the canvas pinch; a cancelled pointer lets go; wheels pass their mode and are kept from the page", () => {
  const dom = stubDom();
  try {
    let time = 0;
    const renderer = new Renderer(dom.canvas, dom.painter);
    const c = new GraphController(
      new GraphModel({
        nodes: [{ id: "a" }, { id: "b" }],
        edges: [{ source: "a", target: "b" }],
      }),
      renderer,
      { clock: () => time },
    );
    assert.equal(c.width, 800);
    for (let i = 0; i < 120; i++) c.tick((time += 16));
    const k = c.camera.k;
    // Client coordinates: the canvas starts at (10, 20).
    const at = (id, x, y) => ({
      pointerId: id,
      clientX: x + 10,
      clientY: y + 20,
    });
    dom.fire("pointerdown", at(1, 300, 300));
    dom.fire("pointerdown", at(2, 500, 300));
    assert.ok(c.pinch);
    assert.equal(
      dom.fire("contextmenu"),
      true,
      "a long touch doesn't open a menu",
    );
    dom.fire("pointermove", at(2, 700, 300));
    assert.ok(Math.abs(c.camera.k - k * 2) < 1e-9);
    dom.fire("pointercancel", at(1, 300, 300));
    dom.fire("pointerup", at(2, 700, 300));
    assert.equal(c.pointers.size, 0);
    assert.equal(c.pinch, null);

    const before = c.camera.k;
    const prevented = dom.fire("wheel", {
      ...at(undefined, 400, 300),
      deltaY: 3,
      deltaMode: 1,
      pointerType: undefined,
    });
    assert.ok(prevented);
    assert.ok(Math.abs(c.camera.k / before - Math.exp(-99 * 0.0015)) < 1e-9);
    // Safari's trackpad pinch.
    const k2 = c.camera.k;
    dom.fire("gesturestart", { scale: 1, clientX: 410, clientY: 320 });
    dom.fire("gesturechange", { scale: 1.5, clientX: 410, clientY: 320 });
    assert.ok(Math.abs(c.camera.k - k2 * 1.5) < 1e-9);
    assert.equal(
      dom.fire("pointerdown", {
        ...at(9, 1, 1),
        pointerType: "mouse",
        button: 2,
      }),
      false,
    );
    assert.equal(c.pointers.size, 0, "the secondary button is the page's");
    assert.equal(dom.fire("contextmenu"), false);
  } finally {
    dom.restore();
  }
});
