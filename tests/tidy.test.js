// The tidy tree (Buchheim et al.'s linear-time Walker). Checked three ways: against a slow, obviously-correct
// reference on hundreds of random trees; by the properties a tidy drawing promises; and for linear time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tidy } from "../src/tidy.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A random tree (or forest) with random half-widths. Children are in index order. */
function randomTree(count, r, { forest = false } = {}) {
  const parent = [],
    left = [],
    right = [];
  for (let i = 0; i < count; i++) {
    if (i === 0 || (forest && r() < 0.03)) parent.push(-1);
    // Some hubs with many children, some long chains.
    else
      parent.push(
        r() < 0.2 ? Math.floor(r() * Math.min(i, 5)) : Math.floor(r() * i),
      );
    left.push(1 + Math.floor(r() * 30));
    right.push(1 + Math.floor(r() * 30));
  }
  return withLists({ parent, left, right });
}

/** Add children lists and roots, in index order. */
function withLists(tree) {
  const children = tree.parent.map(() => []);
  const roots = [];
  tree.parent.forEach((p, i) => (p < 0 ? roots : children[p]).push(i));
  return { ...tree, children, roots };
}

/**
 * Slow reference (by the tidy-tree research): Walker's rules with explicit per-level contours and every push
 * shared out immediately. Quadratic, but plainly right.
 */
function reference({ parent, left, right }, { sibling, cousin, root }) {
  const real = parent.length,
    V = real,
    n = real + 1;
  const kids = Array.from({ length: n }, () => []);
  for (let i = 0; i < real; i++) kids[parent[i] < 0 ? V : parent[i]].push(i);
  const L = [...left, 0],
    R = [...right, 0];
  const offset = new Float64Array(n);
  function build(v) {
    const ks = kids[v];
    if (!ks.length) return { lo: [-L[v]], hi: [R[v]] };
    const contours = ks.map((c) => build(c));
    const o = new Array(ks.length).fill(0);
    for (let k = 1; k < ks.length; k++) {
      const depth = Math.max(...contours.slice(0, k).map((c) => c.lo.length));
      const edge = new Array(depth).fill(-Infinity),
        owner = new Array(depth).fill(-1);
      for (let j = 0; j < k; j++)
        for (let d = 0; d < contours[j].hi.length; d++) {
          const e = o[j] + contours[j].hi[d];
          if (e > edge[d]) {
            edge[d] = e;
            owner[d] = j;
          }
        }
      let at = -Infinity;
      for (let d = 0; d < Math.min(depth, contours[k].lo.length); d++) {
        const gap = d === 0 ? (v === V ? root : sibling) : cousin;
        if (at === -Infinity) {
          at = o[k] = edge[d] + gap - contours[k].lo[d];
          continue;
        }
        const need = edge[d] + gap - (at + contours[k].lo[d]);
        if (need > 0) {
          const i = owner[d],
            span = k - i;
          for (let j = i + 1; j < k; j++) o[j] += (need * (j - i)) / span;
          at += need;
          o[k] = at;
        }
      }
    }
    const c = (o[0] + o[ks.length - 1]) / 2;
    ks.forEach((child, k) => (offset[child] = o[k] - c));
    const depth = Math.max(...contours.map((ct) => ct.lo.length));
    const lo = [-L[v]],
      hi = [R[v]];
    for (let d = 0; d < depth; d++) {
      let a = Infinity,
        b = -Infinity;
      contours.forEach((ct, k) => {
        if (d < ct.lo.length) {
          a = Math.min(a, o[k] - c + ct.lo[d]);
          b = Math.max(b, o[k] - c + ct.hi[d]);
        }
      });
      lo.push(a);
      hi.push(b);
    }
    return { lo, hi };
  }
  build(V);
  const x = new Float64Array(real);
  const stack = [[V, 0]];
  while (stack.length) {
    const [v, at] = stack.pop();
    if (v < real) x[v] = at;
    for (const c of kids[v]) stack.push([c, at + offset[c]]);
  }
  return x;
}

const depths = (parent) => {
  const d = new Int32Array(parent.length);
  for (let i = 0; i < parent.length; i++)
    d[i] = parent[i] < 0 ? 0 : d[parent[i]] + 1;
  return d;
};

test("matches the slow reference on 400 random trees and forests", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const count = 2 + Math.floor(r() * 80);
    const tree = randomTree(count, r, { forest: seed % 3 === 0 });
    const gaps = {
      sibling: 5 + Math.floor(r() * 10),
      cousin: 5 + Math.floor(r() * 30),
      root: 20,
    };
    const a = tidy(tree, gaps).x;
    const b = reference(tree, gaps);
    // The reference isn't centred on 0: compare relative to node 0.
    for (let i = 0; i < count; i++)
      assert.ok(
        Math.abs(a[i] - a[0] - (b[i] - b[0])) < 1e-6,
        `seed ${seed}, node ${i}`,
      );
  }
});

test("nothing on a level overlaps, checked pair by pair", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed * 7);
    const tree = randomTree(2 + Math.floor(r() * 120), r, {
      forest: seed % 2 === 0,
    });
    const { x } = tidy(tree, { sibling: 4, cousin: 9, root: 15 });
    const d = depths(tree.parent);
    const byLevel = new Map();
    x.forEach((_, i) => byLevel.set(d[i], [...(byLevel.get(d[i]) ?? []), i]));
    for (const level of byLevel.values()) {
      level.sort((a, b) => x[a] - x[b]);
      for (let i = 0; i < level.length; i++)
        for (let j = i + 1; j < level.length; j++) {
          const a = level[i],
            b = level[j];
          assert.ok(
            x[b] - x[a] >= tree.right[a] + tree.left[b] + 4 - 1e-6,
            `seed ${seed}`,
          );
        }
    }
  }
});

test("parents are centred over their children: between centres, or between outer edges", () => {
  const r = rng(99);
  const tree = randomTree(120, r);
  const centres = tidy(tree).x;
  const edges = tidy(tree, { parent: "edges" }).x;
  for (let v = 0; v < tree.parent.length; v++) {
    const kids = tree.children[v];
    if (!kids.length) continue;
    const a = kids[0],
      b = kids.at(-1);
    assert.ok(Math.abs(centres[v] - (centres[a] + centres[b]) / 2) < 1e-6);
    const span = (edges[a] - tree.left[a] + edges[b] + tree.right[b]) / 2;
    assert.ok(Math.abs(edges[v] - span) < 1e-6);
  }
});

test("a tree and its mirror image are drawn as reflections", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 13);
    const tree = randomTree(2 + Math.floor(r() * 70), r);
    const mirror = {
      ...tree,
      left: tree.right,
      right: tree.left,
      children: tree.children.map((c) => [...c].reverse()),
      roots: [...tree.roots].reverse(),
    };
    for (const parent of ["centres", "edges"]) {
      const a = tidy(tree, { parent }).x;
      const b = tidy(mirror, { parent }).x;
      for (let i = 0; i < a.length; i++)
        assert.ok(Math.abs(a[i] + b[i]) < 1e-6, `seed ${seed}, ${parent}`);
    }
  }
});

test("small subtrees between two big ones are spread evenly (Walker's fix for the bunching)", () => {
  // root → A (five leaves), three single leaves, B (five leaves)
  const parent = [-1];
  const add = (p) => parent.push(p) - 1;
  const a = add(0);
  const small = [add(0), add(0), add(0)];
  const b = add(0);
  for (let i = 0; i < 5; i++) add(a);
  for (let i = 0; i < 5; i++) add(b);
  const tree = withLists({
    parent,
    left: parent.map(() => 5),
    right: parent.map(() => 5),
  });
  const { x } = tidy(tree, { sibling: 10, cousin: 10 });
  const row = [a, ...small, b].map((i) => x[i]);
  const gaps = row.slice(1).map((v, i) => v - row[i]);
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 1e-9, `gaps ${gaps}`);
});

test("an identical subtree is drawn the same wherever it appears", () => {
  // The same little subtree (a node with three leaf children) in three different places.
  const parent = [-1];
  const add = (p) => parent.push(p) - 1;
  const copies = [];
  const plant = (p) => {
    const top = add(p);
    copies.push([top, add(top), add(top), add(top)]);
  };
  const wide = add(0);
  for (let i = 0; i < 6; i++) add(wide);
  plant(0);
  const deep = add(0);
  plant(add(deep));
  plant(0);
  const tree = withLists({
    parent,
    left: parent.map(() => 6),
    right: parent.map(() => 6),
  });
  const { x } = tidy(tree);
  const shapes = copies.map(([top, ...kids]) => kids.map((k) => x[k] - x[top]));
  for (const s of shapes)
    assert.deepEqual(
      s.map((v) => v.toFixed(6)),
      shapes[0].map((v) => v.toFixed(6)),
    );
});

test("separate trees keep the root gap; siblings and cousins keep theirs", () => {
  const tree = withLists({
    parent: [-1, -1, 0, 1],
    left: [5, 5, 5, 5],
    right: [5, 5, 5, 5],
  });
  const { x } = tidy(tree, { sibling: 2, cousin: 30, root: 100 });
  assert.equal(x[1] - x[0], 110, "roots: their halves plus the root gap");
  assert.ok(
    x[3] - x[2] >= 40 - 1e-9,
    "cousins on the next level keep the cousin gap",
  );
});

test("time is linear: contour steps stay a small multiple of the node count, and deep chains don't overflow", () => {
  for (const count of [1000, 10000, 100000]) {
    const r = rng(count);
    const tree = randomTree(count, r);
    const { steps } = tidy(tree);
    assert.ok(steps < 2 * count, `${steps} steps for ${count} nodes`);
  }
  const chain = withLists({
    parent: Array.from({ length: 200000 }, (_, i) => i - 1),
    left: new Array(200000).fill(1),
    right: new Array(200000).fill(1),
  });
  assert.ok(
    tidy(chain).x.every((v) => v === 0),
    "a chain is a straight line",
  );
});

test("degenerate input: one node, zero widths, empty forest", () => {
  assert.deepEqual(
    [...tidy(withLists({ parent: [-1], left: [3], right: [7] })).x],
    [-2],
  );
  const zero = withLists({
    parent: [-1, 0, 0],
    left: [0, 0, 0],
    right: [0, 0, 0],
  });
  const { x } = tidy(zero, { sibling: 10 });
  assert.equal(x[2] - x[1], 10);
  assert.equal(
    tidy(withLists({ parent: [], left: [], right: [] })).x.length,
    0,
  );
});
