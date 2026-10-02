// Tidy tree drawing in linear time: Walker's algorithm (1990) as made linear by Buchheim, Jünger & Leipert (2002),
// generalised to nodes of any width.
//
// It places every node along its level (the "breadth" axis; depth is the layout's business) so that:
//   - nothing overlaps: neighbours on a level keep their footprints plus a gap apart;
//   - a parent sits centred over its children;
//   - a tree and its mirror image are drawn as reflections, and identical subtrees are drawn identically
//     (Reingold & Tilford 1981);
//   - small subtrees between two big ones are spread out evenly, rather than piling against one side (Walker).
//
// How, in short (Buchheim et al. §3–4): a postorder walk places each subtree as a rigid unit next to its left
// siblings, as close as their contours allow. Contours are walked with threads (a leaf points to the next node on
// its subtree's outline), and a whole subtree moves by changing one number (`mod`, summed in a second walk).
// When a subtree is pushed right, the push is shared out over the smaller subtrees between it and the one it hit,
// recorded as `shift` and `change` and applied in one pass per parent (executeShifts). `ancestor` pointers find
// which sibling a contour node belongs to in constant time.
//
// Pure: plain arrays in, numbers out. Separate trees (a forest) hang off an invisible root.

/**
 * @param {object} tree
 * @param {Int32Array | number[]} tree.parent  parent index per node, -1 for a root
 * @param {number[][]} tree.children           children per node, in the order they're drawn
 * @param {number[]} tree.roots                roots in the order they're drawn
 * @param {ArrayLike<number>} tree.left        how far each node reaches before its centre, along the level (≥ 0)
 * @param {ArrayLike<number>} tree.right       how far it reaches after its centre (≥ 0)
 * @param {object} [gaps]
 * @param {number} [gaps.sibling]  between neighbours with the same parent
 * @param {number} [gaps.cousin]   between neighbours with different parents
 * @param {number} [gaps.root]     between separate trees
 * @param {"centres" | "edges"} [gaps.parent] centre a parent between its first and last child's centres (the
 *   classic rule), or between their outer edges (the whole span the children take up)
 * @returns {{ x: Float64Array, steps: number }} each node's centre along the level, with the trees centred on 0;
 *   `steps` counts contour comparisons, for checking the time is linear
 */
export function tidy(
  { parent, children, roots, left, right },
  { sibling = 10, cousin = 10, root = 20, parent: centring = "centres" } = {},
) {
  const real = parent.length;
  const n = real + 1;
  const V = real; // the invisible root
  const par = new Int32Array(n);
  for (let i = 0; i < real; i++) par[i] = parent[i] < 0 ? V : parent[i];
  par[V] = -1;
  const L = new Float64Array(n),
    R = new Float64Array(n);
  for (let i = 0; i < real; i++) {
    L[i] = left[i];
    R[i] = right[i];
  }

  // Children as one flat array with a start and a count per node; `num` is a node's place among its siblings.
  const count = new Int32Array(n),
    start = new Int32Array(n + 1),
    num = new Int32Array(n),
    kids = new Int32Array(n);
  const listOf = (v) => (v === V ? roots : children[v]);
  for (let v = 0; v < n; v++) count[v] = listOf(v).length;
  for (let v = 0; v < n; v++) start[v + 1] = start[v] + count[v];
  for (let v = 0; v < n; v++) {
    const list = listOf(v);
    for (let k = 0; k < list.length; k++) {
      kids[start[v] + k] = list[k];
      num[list[k]] = k;
    }
  }
  const first = (v) => kids[start[v]];
  const last = (v) => kids[start[v] + count[v] - 1];

  /** How far apart the centres of left neighbour `a` and right neighbour `b` must be. */
  const separation = (a, b) =>
    R[a] + L[b] + (par[a] !== par[b] ? cousin : par[a] === V ? root : sibling);

  const prelim = new Float64Array(n),
    mod = new Float64Array(n),
    shift = new Float64Array(n),
    change = new Float64Array(n),
    thread = new Int32Array(n).fill(-1),
    ancestor = new Int32Array(n),
    defaultAncestor = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) ancestor[i] = i;
  let steps = 0;

  // The next node down a subtree's left (or right) contour: its first (last) child, or the thread from a leaf.
  const nextLeft = (v) => (count[v] ? first(v) : thread[v]);
  const nextRight = (v) => (count[v] ? last(v) : thread[v]);

  /** Push subtree `right` (and everything after it) by s, sharing the push over the subtrees since `left`. */
  const moveSubtree = (left, right, s) => {
    const share = s / (num[right] - num[left]);
    change[right] -= share;
    shift[right] += s;
    change[left] += share;
    prelim[right] += s;
    mod[right] += s;
  };

  /** Apply the shared-out pushes to v's children, right to left, in one pass. */
  const executeShifts = (v) => {
    let s = 0,
      c = 0;
    for (let j = start[v] + count[v] - 1; j >= start[v]; j--) {
      const w = kids[j];
      prelim[w] += s;
      mod[w] += s;
      c += change[w];
      s += shift[w] + c;
    }
  };

  /**
   * Fit subtree v against everything to its left (siblings before it), walking down both contours together: the
   * inner left contour of v ("vip"), the inner right contour of the forest to its left ("vim"), and the two outer
   * contours ("vop", "vom"), which get the threads when one side runs out. Returns the new default ancestor.
   */
  const apportion = (v, w, defaultA) => {
    if (w < 0) return defaultA;
    let vip = v,
      vop = v,
      vim = w,
      vom = first(par[v]);
    let sip = mod[vip],
      sop = mod[vop],
      sim = mod[vim],
      som = mod[vom];
    for (;;) {
      vim = nextRight(vim);
      vip = nextLeft(vip);
      if (vim < 0 || vip < 0) break;
      steps++;
      vom = nextLeft(vom);
      vop = nextRight(vop);
      ancestor[vop] = v;
      const s = prelim[vim] + sim - (prelim[vip] + sip) + separation(vim, vip);
      if (s > 0) {
        // The sibling that owns vim: its ancestor pointer if that's one of v's siblings, else the default.
        const a = par[ancestor[vim]] === par[v] ? ancestor[vim] : defaultA;
        moveSubtree(a, v, s);
        sip += s;
        sop += s;
      }
      sim += mod[vim];
      sip += mod[vip];
      som += mod[vom];
      sop += mod[vop];
    }
    // One side is deeper than the other: thread the shorter side's outer contour on into the deeper one.
    if (vim >= 0 && nextRight(vop) < 0) {
      thread[vop] = vim;
      mod[vop] += sim - sop;
    }
    if (vip >= 0 && nextLeft(vom) < 0) {
      thread[vom] = vip;
      mod[vom] += sip - som;
      defaultA = v;
    }
    return defaultA;
  };

  // Postorder (children before parents), without recursion so deep trees can't overflow the stack.
  const order = new Int32Array(n);
  {
    let m = 0;
    const stack = [V],
      next = new Int32Array(n);
    while (stack.length) {
      const v = stack[stack.length - 1];
      if (next[v] < count[v]) stack.push(kids[start[v] + next[v]++]);
      else {
        stack.pop();
        order[m++] = v;
      }
    }
  }

  const middle =
    centring === "edges"
      ? (v) =>
          (prelim[first(v)] - L[first(v)] + prelim[last(v)] + R[last(v)]) / 2
      : (v) => (prelim[first(v)] + prelim[last(v)]) / 2;

  for (let t = 0; t < n; t++) {
    const v = order[t],
      p = par[v];
    const w = p >= 0 && num[v] > 0 ? kids[start[p] + num[v] - 1] : -1; // left sibling
    if (count[v]) {
      executeShifts(v);
      const mid = middle(v);
      if (w >= 0) {
        prelim[v] = prelim[w] + separation(w, v);
        mod[v] = prelim[v] - mid;
      } else prelim[v] = mid;
    } else if (w >= 0) prelim[v] = prelim[w] + separation(w, v);
    if (p >= 0)
      defaultAncestor[p] = apportion(
        v,
        w,
        defaultAncestor[p] >= 0 ? defaultAncestor[p] : first(p),
      );
  }

  // Second walk: parents before children (reverse postorder), summing the modifiers down each path.
  const x = new Float64Array(n),
    sum = new Float64Array(n);
  x[V] = prelim[V];
  sum[V] = mod[V];
  for (let t = n - 2; t >= 0; t--) {
    const v = order[t];
    x[v] = prelim[v] + sum[par[v]];
    sum[v] = sum[par[v]] + mod[v];
  }
  // Centre the drawing on 0: the middle of its overall extent.
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < real; i++) {
    lo = Math.min(lo, x[i] - L[i]);
    hi = Math.max(hi, x[i] + R[i]);
  }
  const centre = real ? (lo + hi) / 2 : 0;
  const out = new Float64Array(real);
  for (let i = 0; i < real; i++) out[i] = x[i] - centre;
  return { x: out, steps };
}
