import { isHorizontalDirection } from "./directions.js";

/**
 * Seed layouts that treat the graph as a tree: the tidy layered tree and the radial tree (radial layouts
 * and the force engine's first placement). Both write `graph.x` / `graph.y`.
 */

/**
 * The graph as a tree rooted at the root node: breadth-first, each node under the first parent that reaches it
 * (for DAGs; a tree already is one). Parts of the graph the root doesn't reach hang off the root as extra branches
 * (from their own top nodes), so they're placed like everything else instead of piling up where they were. Ghosts
 * (leaving) are left out.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 */
export function spanningTree(graph) {
  const root = graph.rootIndex;
  if (root < 0) return null;
  const childrenOfParent = new Map(),
    hasParent = new Uint8Array(graph.count);
  for (let e = 0; e < graph.sources.length; e++) {
    const parent = graph.sources[e];
    if (!childrenOfParent.has(parent)) childrenOfParent.set(parent, []);
    childrenOfParent.get(parent).push(graph.targets[e]);
    if (parent !== graph.targets[e]) hasParent[graph.targets[e]] = 1;
  }
  const children = new Map(),
    depthOf = new Map([[root, 0]]);
  const grow = (queue) => {
    for (let head = 0; head < queue.length;) {
      const i = queue[head++];
      const own = children.get(i) ?? [];
      for (const child of childrenOfParent.get(i) ?? []) {
        if (depthOf.has(child) || graph.ghost[child]) continue;
        depthOf.set(child, depthOf.get(i) + 1);
        own.push(child);
        queue.push(child);
      }
      children.set(i, own);
    }
  };
  grow([root]);
  // Unreached parts: tops (no parent at all) first, then whatever is left (cycles), in index order.
  for (const pass of [true, false])
    for (let i = 0; i < graph.count; i++) {
      if (depthOf.has(i) || graph.ghost[i] || (pass && hasParent[i])) continue;
      depthOf.set(i, 1);
      children.get(root).push(i);
      grow([i]);
    }
  const preOrder = [];
  for (const stack = [root]; stack.length;) {
    const i = stack.pop();
    preOrder.push(i);
    const own = children.get(i);
    for (let k = own.length - 1; k >= 0; k--) stack.push(own[k]);
  }
  return {
    root,
    preOrder,
    depthOf,
    childrenOf: (i) => children.get(i) ?? [],
  };
}

/** Post-order band widths: each subtree needs at least its own breadth + gap, or the sum of its children's bands. */
function computeBands({ preOrder, childrenOf }, breadthOf, siblingGap) {
  const band = new Map();
  for (let k = preOrder.length - 1; k >= 0; k--) {
    const i = preOrder[k];
    let childrenWidth = 0;
    for (const child of childrenOf(i)) childrenWidth += band.get(child);
    band.set(i, Math.max(breadthOf(i) + siblingGap, childrenWidth));
  }
  return band;
}

/**
 * Layered tree layout in O(n): each subtree gets a band as wide as its children need, parents centre over their
 * children, and every depth gets its own rank. Crossing
 * minimisation is pointless for trees (they have none), so this replaces the general layered layout for trees.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 * @returns {boolean} false when there's no root to lay out
 */
export function tidyTreeLayout(
  graph,
  {
    direction,
    siblingGap,
    levelGap,
    breadthLabelShare = 1,
    extentLabelShare = 1,
  },
) {
  const tree = spanningTree(graph);
  if (!tree) return false;
  const horizontal = isHorizontalDirection(direction);

  // Size of each node (with its share of the label) across the layout ("breadth") and along it ("extent").
  const breadth = new Float64Array(graph.count),
    extent = new Float64Array(graph.count);
  for (let i = 0; i < graph.count; i++) {
    const { w, h } = horizontal
      ? graph.footprint(i, extentLabelShare, breadthLabelShare)
      : graph.footprint(i, breadthLabelShare, extentLabelShare);
    breadth[i] = horizontal ? h : w;
    extent[i] = horizontal ? w : h;
  }

  const levelExtents = [];
  for (const i of tree.preOrder) {
    const depth = tree.depthOf.get(i);
    levelExtents[depth] = Math.max(levelExtents[depth] || 0, extent[i]);
  }
  const levelCenters = [];
  levelExtents.reduce((offset, size, level) => {
    levelCenters[level] = offset + size / 2;
    return offset + size + levelGap;
  }, 0);

  const band = computeBands(tree, (i) => breadth[i], siblingGap);

  // Pre-order: lay children out inside the parent's band; the parent sits over its children.
  for (const stack = [[tree.root, 0]]; stack.length;) {
    const [i, bandStart] = stack.pop();
    const children = tree.childrenOf(i);
    let childrenWidth = 0;
    for (const child of children) childrenWidth += band.get(child);
    let cursor = bandStart + (band.get(i) - childrenWidth) / 2;
    let first = 0,
      last = 0;
    children.forEach((child, k) => {
      const center = cursor + band.get(child) / 2;
      if (k === 0) first = center;
      last = center;
      stack.push([child, cursor]);
      cursor += band.get(child);
    });
    const across = !children.length
      ? bandStart + band.get(i) / 2
      : (first + last) / 2;
    const along = levelCenters[tree.depthOf.get(i)];
    placeAlong(graph, i, direction, along, across);
  }
  return true;
}

/** Put node `i` at `along` the flow and `across` it, for a direction naming the flow root → leaves. */
export function placeAlong(graph, i, direction, along, across) {
  if (direction === "BT") {
    graph.x[i] = across;
    graph.y[i] = -along;
  } else if (direction === "LR") {
    graph.x[i] = along;
    graph.y[i] = across;
  } else if (direction === "RL") {
    graph.x[i] = -along;
    graph.y[i] = across;
  } else {
    graph.x[i] = across;
    graph.y[i] = along;
  }
}

/**
 * Radial seed: the root in the centre, depth n on the ring at n × ringStep, and every subtree in an angular wedge
 * proportional to the band it needs (so big branches get more of the circle). The physics then resolves crowding on
 * busy rings by letting them bulge slightly.
 * @param {import('./layout-graph.js').LayoutGraph} graph
 * @returns {{ rootId: string, depthById: Map<string, number> } | null}
 */
export function radialTreeLayout(graph, { siblingGap, ringStep }) {
  const tree = spanningTree(graph);
  if (!tree) return null;
  const band = computeBands(
    tree,
    (i) => Math.max(graph.w[i], graph.h[i]),
    siblingGap,
  );
  const totalBand = band.get(tree.root);

  for (const stack = [[tree.root, 0]]; stack.length;) {
    const [i, start] = stack.pop();
    const children = tree.childrenOf(i);
    let childrenWidth = 0;
    for (const child of children) childrenWidth += band.get(child);
    let cursor = start + (band.get(i) - childrenWidth) / 2;
    for (const child of children) {
      stack.push([child, cursor]);
      cursor += band.get(child);
    }
    const center = start + band.get(i) / 2;
    const radius = tree.depthOf.get(i) * ringStep;
    const angle = (center / totalBand) * 2 * Math.PI - Math.PI / 2;
    graph.x[i] = radius * Math.cos(angle);
    graph.y[i] = radius * Math.sin(angle);
  }
  const depthById = new Map();
  for (const [i, depth] of tree.depthOf) depthById.set(graph.ids[i], depth);
  return { rootId: graph.ids[tree.root], depthById };
}
