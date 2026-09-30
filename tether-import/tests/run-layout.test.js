// The entry point: tidy tree or layered seed, radial, and the physics after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutGraph } from "../src/layout-graph.js";
import { runLayout } from "../src/run-layout.js";

const SETTINGS = {
  direction: "BT",
  centerForce: 0.2,
  repelForce: 8,
  linkForce: 0.5,
  linkDistance: 120,
};

/** A small tree plus, with `shared`, an edge that makes "e" a child of two parents. */
function graph({ shared = false } = {}) {
  const ids = ["root", "a", "b", "c", "d", "e"];
  const edges = ["root>a", "root>b", "a>c", "a>d", "b>e"];
  if (shared) edges.push("a>e");
  return new LayoutGraph(
    ids.map((id, i) => ({ id, w: 40, h: 40, root: i === 0 })),
    edges.map((edge) => {
      const [source, target] = edge.split(">");
      return { source, target };
    }),
  );
}

test("directional layouts put every child on the far side of its parent (BT: children below)", () => {
  for (const layered of [false, true])
    for (const shared of [false, true]) {
      const g = graph({ shared });
      runLayout(g, { ...SETTINGS, layered });
      const y = (id) => g.positionOf(id).y;
      for (let e = 0; e < g.sources.length; e++) {
        const parent = g.ids[g.sources[e]],
          child = g.ids[g.targets[e]];
        assert.ok(y(child) > y(parent) + 20, `${parent} > ${child}`);
      }
    }
});

test("the same graph and settings always give the same layout", () => {
  const a = graph({ shared: true }),
    b = graph({ shared: true });
  runLayout(a, { ...SETTINGS, layered: true });
  runLayout(b, { ...SETTINGS, layered: true });
  assert.deepEqual([...a.x], [...b.x]);
  assert.deepEqual([...a.y], [...b.y]);
});

test("radial: the root sits in the middle, its children on a ring around it", () => {
  const g = graph();
  runLayout(g, { ...SETTINGS, direction: "radial" });
  const root = g.positionOf("root");
  const distance = (id) => {
    const p = g.positionOf(id);
    return Math.hypot(p.x - root.x, p.y - root.y);
  };
  const [a, b] = [distance("a"), distance("b")];
  assert.ok(a > 40 && b > 40);
  assert.ok(Math.abs(a - b) < 0.35 * Math.max(a, b), `${a} vs ${b}`);
  assert.ok(distance("c") > a * 1.2, "grandchildren sit further out");
});
