/**
 * Tether's drag physics: the graph as an elastic net around where it rests. Grabbing a node doesn't re-run the
 * layout; the held node pulls on its links, those nodes pull on theirs, and the pull fades with every hop:
 *
 *  - every node rests where it was when the drag began (anchored there, lightly);
 *  - every link wants to keep the offset between its ends that it had then;
 *  - a node moves toward the average movement of its neighbours, less its anchor's hold, so a neighbour of the
 *    held node follows most of the way, its own neighbours less, and a busy hub (many neighbours, one moving)
 *    hardly at all.
 *
 * Only nodes that have been disturbed are simulated ("awake"); a node wakes its neighbours once it has moved
 * noticeably, and sleeps again when it has settled. Everything else stays exactly where it is, however big the
 * graph. Letting go keeps the shape you pulled the graph into: it becomes the new rest, and what was still moving
 * coasts to a stop.
 */

export class ElasticNetwork {
  /**
   * @param {{ ids: string[], x: ArrayLike<number>, y: ArrayLike<number>, sources: number[], targets: number[] }} graph
   *   positions now (they become the rest positions); links as index pairs
   * @param {{ stiffness?: number, anchor?: number, damping?: number, alongAxis?: "x" | "y" | null,
   *           alongHold?: number, wake?: number, rest?: number }} options
   *   stiffness: how firmly links keep their shape; anchor: how firmly nodes hold their rest positions (together they
   *   set how far a pull travels: per hop along a chain, roughly stiffness / (stiffness + anchor)); damping: 0..1,
   *   how much speed is lost per step; alongAxis / alongHold: layered layouts hold their levels this much more firmly;
   *   wake: how far (world units) a node must be displaced before it disturbs its neighbours; rest: below this speed
   *   and force a node has settled
   */
  constructor(
    { ids, x, y, sources, targets },
    {
      stiffness = 0.8,
      anchor = 0.15,
      damping = 0.35,
      alongAxis = null,
      alongHold = 2,
      wake = 0.05,
      rest = 0.01,
    } = {},
  ) {
    const count = (this.count = ids.length);
    this.ids = ids;
    this.indexById = new Map(ids.map((id, i) => [id, i]));
    this.restX = Float64Array.from(x);
    this.restY = Float64Array.from(y);
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    this.held = new Uint8Array(count);
    this.stiffness = stiffness;
    this.wake = wake;
    this.rest = rest;
    this.damping = damping;
    this.anchorX = anchor * (alongAxis === "x" ? alongHold : 1);
    this.anchorY = anchor * (alongAxis === "y" ? alongHold : 1);

    // Neighbours in compressed rows: node i's are neighbours[start[i] .. start[i + 1]).
    const degree = new Uint32Array(count);
    for (let e = 0; e < sources.length; e++) {
      degree[sources[e]]++;
      degree[targets[e]]++;
    }
    this.start = new Uint32Array(count + 1);
    for (let i = 0; i < count; i++)
      this.start[i + 1] = this.start[i] + degree[i];
    this.neighbours = new Uint32Array(this.start[count]);
    const fill = this.start.slice(0, count);
    for (let e = 0; e < sources.length; e++) {
      const s = sources[e],
        t = targets[e];
      this.neighbours[fill[s]++] = t;
      this.neighbours[fill[t]++] = s;
    }

    this.awake = new Uint8Array(count);
    /** Indices of the awake nodes (the ones step() moves). */
    this.active = [];
    /** The nodes the last step moved (settling ones included): what a renderer has to redraw. */
    this.changed = [];
    this.#forceX = new Float64Array(count);
    this.#forceY = new Float64Array(count);
  }

  #forceX;
  #forceY;

  /** Hold a node at a point (it's grabbed). */
  grab(id, point) {
    const i = this.indexById.get(id);
    if (i == null) return;
    this.held[i] = 1;
    this.move(id, point);
  }

  /** Move a held node. */
  move(id, point) {
    const i = this.indexById.get(id);
    if (i == null) return;
    this.x[i] = point.x;
    this.y[i] = point.y;
    this.vx[i] = this.vy[i] = 0;
    this.#wake(i);
    this.#wakeNeighbours(i);
  }

  /**
   * Let go: the graph keeps the shape it was pulled into (it becomes the new rest, so neighbours don't spring back),
   * and what's still moving coasts to a stop.
   */
  release(id) {
    const i = this.indexById.get(id);
    if (i == null) return;
    this.held[i] = 0;
    this.restX.set(this.x);
    this.restY.set(this.y);
    this.#wake(i);
  }

  /** Is anything still moving? (A node held still doesn't count: nothing needs stepping until it moves.) */
  get isActive() {
    return this.#woken.length > 0 || this.active.some((i) => !this.held[i]);
  }

  /**
   * One step for the awake nodes. Forces are all worked out from where things are before anything moves, so the
   * order nodes are visited in doesn't matter. Returns whether anything is still moving.
   */
  step() {
    // Nodes woken since the last step (a grab, a move, a release) take part in this one.
    for (const i of this.#woken) this.active.push(i);
    this.#woken.length = 0;
    const { x, y, restX, restY, start, neighbours, held, active } = this;
    const forceX = this.#forceX,
      forceY = this.#forceY;
    for (const i of active) {
      if (held[i]) continue;
      const ux = x[i] - restX[i],
        uy = y[i] - restY[i];
      let sumX = 0,
        sumY = 0;
      const from = start[i],
        to = start[i + 1];
      for (let k = from; k < to; k++) {
        const j = neighbours[k];
        sumX += x[j] - restX[j];
        sumY += y[j] - restY[j];
      }
      const n = to - from;
      // Toward the neighbours' average movement (links keep their shape), and back toward rest (the anchor).
      forceX[i] =
        (n ? this.stiffness * (sumX / n - ux) : 0) - this.anchorX * ux;
      forceY[i] =
        (n ? this.stiffness * (sumY / n - uy) : 0) - this.anchorY * uy;
    }
    const keep = 1 - this.damping;
    const stillActive = [];
    const changed = (this.changed = []);
    for (const i of active) {
      if (held[i]) {
        stillActive.push(i);
        continue;
      }
      this.vx[i] = this.vx[i] * keep + forceX[i];
      this.vy[i] = this.vy[i] * keep + forceY[i];
      x[i] += this.vx[i];
      y[i] += this.vy[i];
      changed.push(i);
      // A node that's out of place and still moving disturbs its neighbours; one at rest doesn't (it would wake them
      // every step for nothing, and the net would never go still).
      const speed = Math.abs(this.vx[i]) + Math.abs(this.vy[i]);
      if (
        speed > this.rest &&
        Math.hypot(x[i] - restX[i], y[i] - restY[i]) > this.wake
      )
        this.#wakeNeighbours(i);
      const settled =
        Math.abs(this.vx[i]) + Math.abs(this.vy[i]) < this.rest &&
        Math.abs(forceX[i]) + Math.abs(forceY[i]) < this.rest;
      if (settled) this.awake[i] = 0;
      else stillActive.push(i);
    }
    // Nodes woken during this step join the next one (they're still in #woken, and awake).
    this.active = stillActive;
    return this.isActive;
  }

  #woken = [];

  #wake(i) {
    if (this.awake[i]) return;
    this.awake[i] = 1;
    this.#woken.push(i);
  }

  #wakeNeighbours(i) {
    for (let k = this.start[i]; k < this.start[i + 1]; k++)
      this.#wake(this.neighbours[k]);
  }
}
