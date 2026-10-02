// Gestures: what pointers and wheels mean. Every pressed pointer is tracked by its id (each finger has its own):
//
//   - the first one down drags the node under it, or pans;
//   - a second one turns the two into a pinch (the drag or pan ends): their spread zooms, their midpoint pans;
//   - any more are ignored until those lift; when one of a pinch's two lifts, the other pans on;
//   - a press that doesn't wander is a tap (two quick ones in the same place a double tap), or, held still long
//     enough, a long press;
//   - a pointer that isn't pressed (a mouse or pen) hovers;
//   - a wheel zooms, a trackpad's two-finger scroll pans, a trackpad pinch (ctrl+wheel) zooms.
//
// It works on its controller (controller.js): the camera, the working graph's matrix and the simulation's held
// nodes, through the controller's own methods and a few private hooks it hands over. No DOM: the renderer
// (renderer.js) turns DOM events into the controller calls that come here.

const MAX_THROW = 1800; // fastest throw or pan glide, in screen px/s
/** How far a press may wander, in CSS px, and still be a tap or a long press (a finger wobbles more than a mouse). */
const TAP_SLOP = { touch: 10, pen: 6, mouse: 5 };
const LONG_PRESS = 500; // ms held still before a press is a long press
const DOUBLE_TAP = { ms: 300, px: 24 }; // a second tap this soon and this close is a double tap
const LINE_PX = 33; // a wheel "line" (deltaMode 1, Firefox's mouse wheel) in px: three lines a notch, like Chrome's 100
const WHEEL_BURST = 150; // ms: wheel events closer than this are one gesture (one kind: zoom or pan)

/**
 * @typedef {object} PointerInput        a pointer event, in the controller's terms
 * @property {number} [id]               the pointer's id (each finger has its own)
 * @property {number} x                  CSS px from the canvas's left
 * @property {number} y
 * @property {number} [time]             ms, on the controller's clock
 * @property {string} [pointerType]      "mouse", "touch" or "pen"
 * @property {number} [button]           which button pressed (2, the secondary, is left to the page)
 * @property {boolean} [shiftKey]
 * @property {boolean} [ctrlKey]
 * @property {boolean} [metaKey]
 * @property {boolean} [altKey]
 *
 * @typedef {object} WheelInput
 * @property {number} x
 * @property {number} y
 * @property {number} [deltaX]
 * @property {number} [deltaY]
 * @property {number} [deltaMode]        0 px, 1 lines, 2 pages
 * @property {boolean} [ctrlKey]         a trackpad pinch (or ctrl held)
 * @property {number} [wheelDeltaY]      the legacy delta (Chrome, Safari), which tells a wheel from a trackpad
 * @property {number} [time]
 *
 * @typedef {object} Pointer             a pressed pointer, and what it's doing
 * @property {number} id
 * @property {"drag" | "pan" | "pinch" | "idle"} role  dragging a node, panning, one of a pinch's two, or ignored
 * @property {string} type               pointerType
 * @property {number} node               the node dragged (an index into the working graph), or -1
 * @property {string} [nodeId]           its id, so the drag survives a rebuild of the working graph
 * @property {number[]} [carried]        the nodes it carries (itself, and its subtree when static drags carry them)
 * @property {{ x: number, y: number }} [offset] from the pointer to the node, world px
 * @property {{ x: number, y: number }} screen   where it is
 * @property {{ x: number, y: number, time: number }} start where and when it was pressed
 * @property {number} t                  when it last moved
 * @property {number} vx                 smoothed speed, world px/s
 * @property {number} vy
 * @property {boolean} tap               still a tap (or a long press): hasn't wandered, wasn't part of a pinch
 * @property {boolean} long              a long press was reported
 * @property {boolean} started           a dragStart or panStart was reported
 * @property {boolean} additive          shift, ctrl or cmd was held (a tap adds to or removes from the selection)
 *
 * @typedef {object} GestureHost         the controller's private hooks
 * @property {(type: string, detail?: object) => void} emit
 * @property {() => void} changed        something needs a frame
 * @property {(p: { x: number, y: number }, references?: boolean) => { index: number, reference: boolean }} pick
 * @property {(index: number, reference: boolean) => void} hover
 * @property {(index: number) => number[]} carried   what dragging node `index` carries
 * @property {() => void} userCamera     the user took the camera (no framing, focusing or easing of its own)
 */

export class Gestures {
  /**
   * @param {import("./controller.js").GraphController} controller
   * @param {GestureHost} host
   */
  constructor(controller, host) {
    this.c = controller;
    this.host = host;
    /** @type {Map<number, Pointer>} pressed pointers by id */
    this.pointers = new Map();
    this.pinch = null; // two pointers zooming: { a, b, dist, k, anchor }
    this.lastTap = null; // { time, x, y, node }: the first half of a possible double tap
    this.wheelBurst = { time: -Infinity, zoom: true };
  }

  /** The pressed pointer that's dragging a node or panning (there's at most one), or null. */
  get primary() {
    for (const ptr of this.pointers.values())
      if (ptr.role === "drag" || ptr.role === "pan") return ptr;
    return null;
  }

  /** @param {PointerInput} input */
  down({
    id = 1,
    x,
    y,
    time = this.c.clock(),
    pointerType = "mouse",
    button = 0,
    shiftKey = false,
    ctrlKey = false,
    metaKey = false,
  }) {
    if (button === 2) return; // the secondary button is the page's (a context menu)
    if (this.pointers.has(id)) this.cancel({ id, time }); // its release was missed
    const { c } = this;
    /** @type {Pointer} */
    const ptr = {
      id,
      role: "idle",
      type: pointerType,
      node: -1,
      screen: { x, y },
      start: { x, y, time },
      t: time,
      vx: 0,
      vy: 0,
      tap: true,
      long: false,
      started: false,
      additive: shiftKey || ctrlKey || metaKey,
    };
    const first = this.pinch ? null : this.primary;
    this.pointers.set(id, ptr);
    c.cameraTween = null;
    c.glide = null;
    if (this.pinch)
      ptr.tap = false; // a third finger: ignored
    else if (first) {
      // A second finger: whatever the first was doing stops, and the two pinch.
      this.#end(first, { cancel: true });
      this.#startPinch(first, ptr);
    } else {
      const p = c.toWorld(x, y);
      const node = this.host.pick(p, false).index;
      if (node >= 0) {
        const m = c.graph.matrix;
        Object.assign(ptr, {
          role: "drag",
          node,
          nodeId: c.graph.nodes[node].id,
          offset: { x: m.x[node] - p.x, y: m.y[node] - p.y },
          carried: this.host.carried(node),
        });
        // Held from the press, so a node in motion stops under the finger; the drag starts once it moves.
        for (const i of ptr.carried) {
          c.sim.held.add(i);
          m.vx[i] = m.vy[i] = 0;
        }
      } else ptr.role = "pan";
    }
    this.host.changed();
  }

  /** @param {PointerInput} input */
  move({ id = 1, x, y, time = this.c.clock() }) {
    const { c } = this;
    const ptr = this.pointers.get(id);
    if (!ptr) {
      const { index, reference } = this.host.pick(c.toWorld(x, y));
      this.host.hover(index, reference);
      return;
    }
    const last = ptr.screen;
    ptr.screen = { x, y };
    if (
      ptr.tap &&
      Math.hypot(x - ptr.start.x, y - ptr.start.y) >
        (TAP_SLOP[ptr.type] ?? TAP_SLOP.mouse)
    )
      ptr.tap = false;
    if (ptr.role === "pinch") return this.#pinchMove();
    if (ptr.role === "pan") {
      const dx = -(x - last.x) / c.camera.k;
      const dy = -(y - last.y) / c.camera.k;
      this.host.userCamera();
      c.camera.x += dx;
      c.camera.y += dy;
      this.#track(ptr, dx, dy, time);
      if (!ptr.tap && !ptr.started) {
        ptr.started = true;
        this.host.emit("panStart", { x: ptr.start.x, y: ptr.start.y });
      }
      this.host.changed();
      return;
    }
    if (ptr.role !== "drag") return;
    const p = c.toWorld(x, y);
    const m = c.graph.matrix;
    const dx = p.x + ptr.offset.x - m.x[ptr.node],
      dy = p.y + ptr.offset.y - m.y[ptr.node];
    this.#track(ptr, dx, dy, time);
    c.version++;
    for (const i of ptr.carried) {
      m.x[i] += dx;
      m.y[i] += dy;
    }
    if (!ptr.tap && !ptr.started) {
      ptr.started = true;
      this.host.emit("dragStart", {
        node: ptr.nodeId,
        carried: ptr.carried.length,
      });
    }
    this.host.changed();
  }

  /** @param {Partial<PointerInput>} [input] */
  up({ id = 1, time = this.c.clock() } = {}) {
    const ptr = this.pointers.get(id);
    if (!ptr) return;
    this.longPresses(time);
    this.pointers.delete(id);
    if (ptr.role === "pinch") this.#endPinch();
    else {
      this.#end(ptr, { time });
      if (ptr.tap && !ptr.long) this.#tap(ptr, time);
    }
    this.host.changed();
  }

  /** @param {Partial<PointerInput>} [input] */
  cancel({ id = 1, time = this.c.clock() } = {}) {
    const ptr = this.pointers.get(id);
    if (!ptr) return;
    this.pointers.delete(id);
    if (ptr.role === "pinch") this.#endPinch();
    else this.#end(ptr, { cancel: true, time });
    this.host.changed();
  }

  /** A pointer left the canvas: no more hover (a press in progress carries on). */
  leave({ id } = {}) {
    if (this.pointers.has(id) || this.primary) return;
    this.host.hover(-1, false);
  }

  /** Let go of any node being dragged (Reset). */
  releaseDrags() {
    for (const ptr of this.pointers.values())
      if (ptr.role === "drag") this.#end(ptr, { cancel: true });
  }

  /**
   * The working graph was rebuilt: each drag holds its node at its new row (and its subtree as it is now). A drag
   * whose node is gone ends, and its pointer pans from there.
   */
  rebind() {
    const { c } = this;
    for (const ptr of this.pointers.values()) {
      if (ptr.role !== "drag") continue;
      const at = c.graph.byId.get(ptr.nodeId)?.index ?? -1;
      if (at >= 0) {
        ptr.node = at;
        ptr.carried = this.host.carried(at);
        for (const i of ptr.carried) c.sim.held.add(i);
        continue;
      }
      if (ptr.started)
        this.host.emit("dragEnd", {
          node: ptr.nodeId,
          thrown: false,
          screenSpeed: 0,
          cancelled: true,
        });
      Object.assign(ptr, {
        role: "pan",
        node: -1,
        nodeId: undefined,
        carried: undefined,
        started: false,
        vx: 0,
        vy: 0,
      });
    }
  }

  /** Forget every pointer (the controller is going away). */
  clear() {
    this.pointers.clear();
    this.pinch = null;
  }

  /** Smoothed pointer speed in world px/s, capped so a hard flick can't send anything off into the distance. */
  #track(ptr, dx, dy, time) {
    const dt = Math.max((time - ptr.t) / 1000, 1 / 240);
    ptr.vx += (dx / dt - ptr.vx) * 0.4;
    ptr.vy += (dy / dt - ptr.vy) * 0.4;
    const cap = MAX_THROW / this.c.camera.k;
    const speed = Math.hypot(ptr.vx, ptr.vy);
    if (speed > cap) {
      ptr.vx *= cap / speed;
      ptr.vy *= cap / speed;
    }
    ptr.t = time;
  }

  /**
   * End what a pointer was doing: let a dragged node go (thrown if it was still moving, unless `cancel`), or let a
   * pan glide on. Sends dragEnd or panEnd if it had started. The pointer is left idle.
   */
  #end(ptr, { cancel = false, time = this.c.clock() } = {}) {
    const { c } = this;
    const thrown = !cancel && time - ptr.t < 80; // a pointer that stopped before letting go throws nothing
    if (ptr.role === "drag") {
      const m = c.graph.matrix;
      c.sim.wake();
      for (const i of ptr.carried) {
        c.sim.held.delete(i);
        if (c.modeOpts.fling && thrown) {
          m.vx[i] = ptr.vx;
          m.vy[i] = ptr.vy;
        }
      }
    } else if (ptr.role === "pan" && thrown && ptr.started) {
      c.glide = { x: ptr.vx, y: ptr.vy };
    }
    if (ptr.started) {
      const speed = Math.round(Math.hypot(ptr.vx, ptr.vy) * c.camera.k);
      const drag = ptr.role === "drag";
      this.host.emit(drag ? "dragEnd" : "panEnd", {
        node: drag ? ptr.nodeId : undefined,
        thrown: thrown && (!drag || c.modeOpts.fling),
        screenSpeed: thrown ? speed : 0,
        ...(cancel && { cancelled: true }),
      });
    }
    Object.assign(ptr, {
      role: "idle",
      node: -1,
      carried: undefined,
      started: false,
    });
  }

  /** Two pointers down: from now on their midpoint pans and their spread zooms. */
  #startPinch(a, b) {
    const { c } = this;
    a.role = b.role = "pinch";
    a.tap = b.tap = false;
    const mid = {
      x: (a.screen.x + b.screen.x) / 2,
      y: (a.screen.y + b.screen.y) / 2,
    };
    this.host.userCamera();
    this.pinch = {
      a: a.id,
      b: b.id,
      dist: Math.max(
        Math.hypot(a.screen.x - b.screen.x, a.screen.y - b.screen.y),
        1,
      ),
      k: c.camera.k,
      // The world point under the fingers' midpoint stays under it.
      anchor: c.toWorld(mid.x, mid.y),
    };
    this.host.emit("pinchStart", { k: c.camera.k });
  }

  #pinchMove() {
    const { c } = this;
    const { a, b, dist, k, anchor } = this.pinch;
    const pa = this.pointers.get(a).screen,
      pb = this.pointers.get(b).screen;
    const { min, max } = c.zoomLimits();
    const spread = Math.max(Math.hypot(pa.x - pb.x, pa.y - pb.y), 1);
    const scale = Math.min(Math.max((k * spread) / dist, min), max);
    const mx = (pa.x + pb.x) / 2,
      my = (pa.y + pb.y) / 2;
    c.camera = {
      x: anchor.x - (mx - c.width / 2) / scale,
      y: anchor.y - (my - c.height / 2) / scale,
      k: scale,
    };
    this.host.changed();
  }

  /** One of a pinch's pointers lifted: the pinch ends, and the one still down pans from where it is. */
  #endPinch() {
    const { a, b } = this.pinch;
    this.pinch = null;
    for (const id of [a, b]) {
      const ptr = this.pointers.get(id);
      if (!ptr) continue;
      Object.assign(ptr, {
        role: "pan",
        start: { ...ptr.screen, time: ptr.t },
        vx: 0,
        vy: 0,
      });
    }
    this.host.emit("pinchEnd", { k: this.c.camera.k });
  }

  /** Long presses: a pointer held still for LONG_PRESS ms, reported once (and then its release isn't a tap). */
  longPresses(now) {
    for (const ptr of this.pointers.values()) {
      if (!ptr.tap || ptr.long || now - ptr.start.time < LONG_PRESS) continue;
      ptr.long = true;
      this.host.emit("longPress", this.#at(ptr.screen, ptr.type));
    }
  }

  /** What's at a canvas point, for tap and press events: the node (id, or null), and where, on screen and world. */
  #at({ x, y }, pointerType) {
    const world = this.c.toWorld(x, y);
    const { index, reference } = this.host.pick(world);
    return {
      node: index >= 0 ? this.c.graph.nodes[index].id : null,
      reference,
      x,
      y,
      world,
      pointerType,
    };
  }

  /**
   * A tap: sends "tap" (and "doubleTap" for the second of two quick ones in about the same place), selects what was
   * tapped (if the controller's `tapSelects`), and frames the graph on a double tap on empty space.
   */
  #tap(ptr, time) {
    const { c } = this;
    const detail = this.#at(ptr.screen, ptr.type);
    this.host.emit("tap", detail);
    const last = this.lastTap;
    if (
      last &&
      time - last.time <= DOUBLE_TAP.ms &&
      Math.hypot(detail.x - last.x, detail.y - last.y) <= DOUBLE_TAP.px &&
      last.node === detail.node
    ) {
      this.lastTap = null;
      this.host.emit("doubleTap", detail);
      if (detail.node === null) c.fit();
      return;
    }
    this.lastTap = { time, x: detail.x, y: detail.y, node: detail.node };
    if (!c.tapSelects) return;
    if (detail.node === null) {
      if (!ptr.additive) c.select(null);
    } else c.select(detail.node, { toggle: ptr.additive, add: ptr.additive });
  }

  /** @param {WheelInput} input */
  wheel({
    x,
    y,
    deltaX = 0,
    deltaY = 0,
    deltaMode = 0,
    ctrlKey = false,
    wheelDeltaY,
    time = this.c.clock(),
  }) {
    const { c } = this;
    const unit = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? c.height : 1;
    const dx = deltaX * unit,
      dy = deltaY * unit;
    let zoom = ctrlKey || c.wheelMode === "zoom";
    if (!ctrlKey && c.wheelMode === "auto") {
      // One gesture is one kind: decided by its first event (a trackpad's later events can look like a wheel's).
      if (time - this.wheelBurst.time > WHEEL_BURST)
        this.wheelBurst.zoom = !looksLikeTrackpad(
          dx,
          dy,
          deltaMode,
          wheelDeltaY,
        );
      this.wheelBurst.time = time;
      zoom = this.wheelBurst.zoom;
    }
    if (zoom) c.zoomBy(Math.exp(-dy * (ctrlKey ? 0.01 : 0.0015)), x, y);
    else {
      this.host.userCamera();
      c.camera.x += dx / c.camera.k;
      c.camera.y += dy / c.camera.k;
      this.host.changed();
    }
  }
}

/**
 * Whether a wheel event (deltas in px) looks like a trackpad's two-finger scroll rather than a mouse wheel's notch.
 * A sideways scroll is a trackpad's (or a tilt wheel's: panning suits both). Chrome and Safari give a mouse wheel's
 * legacy `wheelDeltaY` as multiples of 120, and a trackpad's as exactly -3 × deltaY; Firefox's mouse wheel scrolls
 * by lines. With nothing to tell by, it's a wheel (zoom, as before).
 */
export function looksLikeTrackpad(dx, dy, deltaMode, wheelDeltaY) {
  if (deltaMode !== 0) return false;
  if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) return true;
  if (wheelDeltaY) return Math.abs(wheelDeltaY + 3 * dy) < 1;
  return false;
}
