export type PointerInput = {
  /**
   * the pointer's id (each finger has its own)
   */
  id?: number;
  /**
   * CSS px from the canvas's left
   */
  x: number;
  y: number;
  /**
   * ms, on the controller's clock
   */
  time?: number;
  /**
   * "mouse", "touch" or "pen"
   */
  pointerType?: string;
  /**
   * which button pressed (2, the secondary, is left to the page)
   */
  button?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};
export type WheelInput = {
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  /**
   * 0 px, 1 lines, 2 pages
   */
  deltaMode?: number;
  /**
   * a trackpad pinch (or ctrl held)
   */
  ctrlKey?: boolean;
  /**
   * the legacy delta (Chrome, Safari), which tells a wheel from a trackpad
   */
  wheelDeltaY?: number;
  time?: number;
};
export type Pointer = {
  id: number;
  /**
   * dragging a node, panning, one of a pinch's two, or ignored
   */
  role: "drag" | "pan" | "pinch" | "idle";
  /**
   * pointerType
   */
  type: string;
  /**
   * the node dragged (an index into the working graph), or -1
   */
  node: number;
  /**
   * its id, so the drag survives a rebuild of the working graph
   */
  nodeId?: string;
  /**
   * the nodes it carries (itself, and its subtree when static drags carry them)
   */
  carried?: number[];
  /**
   * from the pointer to the node, world px
   */
  offset?: {
    x: number;
    y: number;
  };
  /**
   * where it is
   */
  screen: {
    x: number;
    y: number;
  };
  /**
   * where and when it was pressed
   */
  start: {
    x: number;
    y: number;
    time: number;
  };
  /**
   * when it last moved
   */
  t: number;
  /**
   * smoothed speed, world px/s
   */
  vx: number;
  vy: number;
  /**
   * still a tap (or a long press): hasn't wandered, wasn't part of a pinch
   */
  tap: boolean;
  /**
   * a long press was reported
   */
  long: boolean;
  /**
   * a dragStart or panStart was reported
   */
  started: boolean;
  /**
   * shift, ctrl or cmd was held (a tap adds to or removes from the selection)
   */
  additive: boolean;
};
export type GestureHost = {
  emit: (type: string, detail?: object) => void;
  /**
   * something needs a frame
   */
  changed: () => void;
  pick: (
    p: {
      x: number;
      y: number;
    },
    references?: boolean,
  ) => {
    index: number;
    reference: boolean;
  };
  hover: (index: number, reference: boolean) => void;
  /**
   * what dragging node `index` carries
   */
  carried: (index: number) => number[];
  /**
   * the user took the camera (no framing, focusing or easing of its own)
   */
  userCamera: () => void;
};
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
export declare class Gestures {
  #private;
  c: import("./controller.js").GraphController;
  host: GestureHost;
  /** @type {Map<number, Pointer>} pressed pointers by id */
  pointers: Map<number, Pointer>;
  pinch: {
    a: any;
    b: any;
    dist: number;
    k: number;
    anchor: {
      x: number;
      y: number;
    };
  };
  lastTap: {
    time: any;
    x: any;
    y: any;
    node: any;
  };
  wheelBurst: {
    time: number;
    zoom: boolean;
  };
  /**
   * @param {import("./controller.js").GraphController} controller
   * @param {GestureHost} host
   */
  constructor(
    controller: import("./controller.js").GraphController,
    host: GestureHost,
  );
  /** The pressed pointer that's dragging a node or panning (there's at most one), or null. */
  get primary(): Pointer;
  /** @param {PointerInput} input */
  down({
    id,
    x,
    y,
    time,
    pointerType,
    button,
    shiftKey,
    ctrlKey,
    metaKey,
  }: PointerInput): void;
  /** @param {PointerInput} input */
  move({ id, x, y, time }: PointerInput): void;
  /** @param {Partial<PointerInput>} [input] */
  up({ id, time }?: Partial<PointerInput>): void;
  /** @param {Partial<PointerInput>} [input] */
  cancel({ id, time }?: Partial<PointerInput>): void;
  /**
   * A pointer left the canvas: no more hover (a press in progress carries on).
   * @param {Partial<PointerInput>} [input]
   */
  leave({ id }?: Partial<PointerInput>): void;
  /** Let go of any node being dragged (Reset). */
  releaseDrags(): void;
  /**
   * The working graph was rebuilt: each drag holds its node at its new row (and its subtree as it is now). A drag
   * whose node is gone ends, and its pointer pans from there.
   */
  rebind(): void;
  /** Forget every pointer (the controller is going away). */
  clear(): void;
  /** Long presses: a pointer held still for LONG_PRESS ms, reported once (and then its release isn't a tap). */
  longPresses(now: any): void;
  /** @param {WheelInput} input */
  wheel({
    x,
    y,
    deltaX,
    deltaY,
    deltaMode,
    ctrlKey,
    wheelDeltaY,
    time,
  }: WheelInput): void;
}
/**
 * Whether a wheel event (deltas in px) looks like a trackpad's two-finger scroll rather than a mouse wheel's notch.
 * A sideways scroll is a trackpad's (or a tilt wheel's: panning suits both). Chrome and Safari give a mouse wheel's
 * legacy `wheelDeltaY` as multiples of 120, and a trackpad's as exactly -3 × deltaY; Firefox's mouse wheel scrolls
 * by lines. With nothing to tell by, it's a wheel (zoom, as before).
 */
export declare function looksLikeTrackpad(
  dx: any,
  dy: any,
  deltaMode: any,
  wheelDeltaY: any,
): boolean;
