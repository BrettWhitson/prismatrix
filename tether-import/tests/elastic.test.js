// Tether's drag physics: a held node pulls its links, they pull theirs, and it fades hop by hop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ElasticNetwork } from "../src/elastic.js";

/** A chain n0 — n1 — … — n(count-1), 100 apart, plus a separate pair far away. */
function chain(count = 12) {
  const ids = [...Array(count).keys()]
    .map((i) => `n${i}`)
    .concat(["far1", "far2"]);
  const x = ids.map((_, i) => (i < count ? i * 100 : 5000 + i));
  const y = ids.map(() => 0);
  const sources = [],
    targets = [];
  for (let i = 1; i < count; i++) {
    sources.push(i - 1);
    targets.push(i);
  }
  sources.push(count);
  targets.push(count + 1);
  return { ids, x, y, sources, targets };
}

const moved = (net, id) => {
  const i = net.indexById.get(id);
  return Math.hypot(net.x[i] - net.restX[i], net.y[i] - net.restY[i]);
};

function settle(net, steps = 400) {
  for (let k = 0; k < steps && net.step(); k++);
}

test("elastic: a held node's pull fades hop by hop, and never reaches what isn't connected", () => {
  const net = new ElasticNetwork(chain());
  net.grab("n5", { x: 500, y: 200 }); // pull the middle of the chain 200 down
  settle(net, 300);
  const pulls = [4, 3, 2, 1, 0].map((i) => moved(net, `n${i}`));
  for (let k = 1; k < pulls.length; k++)
    assert.ok(
      pulls[k] < pulls[k - 1],
      `fades with each hop (${pulls.map(Math.round)})`,
    );
  assert.ok(pulls[0] > 40, "the neighbour follows a good part of the way");
  // The neighbours follow the pull (down), not somewhere else.
  const n4 = net.indexById.get("n4");
  assert.ok(net.y[n4] > 0 && Math.abs(net.x[n4] - 400) < 1);
  assert.equal(
    moved(net, "far1"),
    0,
    "an unconnected node doesn't move at all",
  );
  assert.equal(moved(net, "far2"), 0);
});

test("elastic: a small nudge stays local — far nodes aren't even woken", () => {
  const net = new ElasticNetwork(chain(40));
  net.grab("n20", { x: 2008, y: 0 }); // 8 units
  settle(net);
  assert.equal(moved(net, "n0"), 0);
  assert.equal(moved(net, "n39"), 0);
  assert.ok(moved(net, "n21") > 1);
});

test("elastic: a busy hub gives only a little when one of its many neighbours is pulled", () => {
  // A hub with 10 spokes; pull one spoke.
  const ids = ["hub", ...[...Array(10).keys()].map((i) => `s${i}`)];
  const x = [0, ...[...Array(10).keys()].map((i) => Math.cos(i) * 100)];
  const y = [0, ...[...Array(10).keys()].map((i) => Math.sin(i) * 100)];
  const net = new ElasticNetwork({
    ids,
    x,
    y,
    sources: Array(10).fill(0),
    targets: [...Array(10).keys()].map((i) => i + 1),
  });
  const s0 = net.indexById.get("s0");
  net.grab("s0", { x: x[s0] + 300, y: y[s0] });
  settle(net, 300);
  const hub = moved(net, "hub");
  assert.ok(hub < 300 * 0.3, `the hub gives a little (${Math.round(hub)})`);
  assert.ok(moved(net, "s5") < hub, "its other spokes follow it, less again");
});

test("elastic: letting go keeps the shape it was pulled into, and everything comes to rest", () => {
  const net = new ElasticNetwork(chain());
  net.grab("n5", { x: 500, y: 150 });
  settle(net, 300);
  const n4 = net.indexById.get("n4"),
    n5 = net.indexById.get("n5");
  const pulled = net.y[n4];
  net.release("n5");
  settle(net, 2000);
  assert.equal(net.isActive, false, "it settles");
  assert.ok(
    Math.abs(net.y[n5] - 150) < 1,
    `stays where dropped (${net.y[n5]})`,
  );
  assert.ok(
    Math.abs(net.y[n4] - pulled) < 1,
    `its neighbour doesn't spring back (${pulled} → ${net.y[n4]})`,
  );
  // Settled means balanced: stepping again changes nothing.
  const before = Float64Array.from(net.y);
  net.step();
  assert.deepEqual(net.y, before);
});

test("elastic: a node held still lets the net go quiet (nothing to step until it moves again)", () => {
  const net = new ElasticNetwork(chain(20));
  net.grab("n10", { x: 1000, y: 120 });
  let steps = 0;
  while (net.step() && steps < 2000) steps++;
  assert.ok(steps < 2000, "it goes still while the node is held");
  assert.equal(net.isActive, false);
  net.move("n10", { x: 1000, y: 160 });
  assert.equal(net.isActive, true, "moving it again wakes the net");
});
