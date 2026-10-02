// The graph model under change: listeners that throw or change the model themselves, odd input (ids that aren't,
// deltas that aren't lists, values structuredClone keeps), data-only changes, options that are out of range or
// misspelt, and updates that cost what they change (checked against the model built from scratch).
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { GraphModel, equal } from "../../next/engine/model.js";
import { Graph } from "../../next/engine/graph.js";
import { closest, resolve } from "../../next/engine/schema.js";
import { NODE_OPTIONS } from "../../next/engine/style.js";
import {
  applyState,
  snapshotModel,
  takeSnapshot,
} from "../../next/engine/snapshot.js";

const chain = () => ({
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
});

/** Run `fn` with console.warn or console.error caught: returns what it was called with. */
function quietly(method, fn) {
  const spy = mock.method(console, method, () => {});
  try {
    fn();
  } finally {
    spy.mock.restore();
  }
  return spy.mock.calls.map((call) => call.arguments);
}

// ---- listeners -------------------------------------------------------------------------------------------------

test("a listener that throws doesn't stop the others, and the model stays committed", () => {
  const errors = [];
  const m = GraphModel.from(chain(), {
    onError: (error, change) => errors.push([error.message, change.version]),
  });
  const heard = [];
  m.onChange(() => {
    throw new Error("first listener broke");
  });
  m.onChange((change, model) => heard.push([change.version, model.size]));
  const change = m.update({ addNodes: [{ id: "d" }] });
  assert.equal(change.version, 2, "update still returns its change");
  assert.deepEqual(heard, [[2, 4]], "the second listener heard it");
  assert.deepEqual(errors, [["first listener broke", 2]]);
  assert.equal(m.node("d").id, "d");
  assert.equal(m.forest().order.length, 4, "views follow the committed model");

  // Without onError: the console, and still never thrown at the caller.
  m.onError = null;
  const logged = quietly("error", () =>
    m.update({ changeNodes: [{ id: "d", label: "D" }] }),
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0][1].message, /first listener broke/);
  assert.equal(m.node("d").label, "D");
});

test("an update from inside a listener waits until everyone has heard the current change, then is told in turn", () => {
  const m = GraphModel.from(chain());
  const log = [];
  let replied = "not yet";
  m.onChange((change, model) => {
    log.push(`A v${change.version} size ${model.size}`);
    if (change.nodesAdded.includes("d"))
      replied = model.update({
        addNodes: [{ id: "e" }],
        addEdges: [{ source: "d", target: "e" }],
      });
  });
  m.onChange((change, model) => {
    log.push(`B v${change.version} size ${model.size}`);
    if (change.nodesAdded.includes("e"))
      model.update({ changeNodes: [{ id: "e", label: "E" }] });
  });
  const first = m.update({
    addNodes: [{ id: "d" }],
    addEdges: [{ source: "c", target: "d" }],
  });
  assert.equal(replied, null, "a queued update returns null");
  assert.deepEqual(first.nodesAdded, ["d"]);
  assert.deepEqual(log, [
    "A v2 size 4",
    "B v2 size 4", // B hears the first change as it left the model: e isn't there yet
    "A v3 size 5",
    "B v3 size 5",
    "A v4 size 5",
    "B v4 size 5",
  ]);
  assert.equal(m.node("e").label, "E");
  assert.equal(m.version, 4);
  assert.deepEqual(m.ends, [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
});

test("listeners added or removed while a change is told: the removed one isn't called, the new one hears the next", () => {
  const m = GraphModel.from(chain());
  const log = [];
  let stopB = () => {};
  m.onChange(() => {
    log.push("A");
    stopB();
    m.onChange(() => log.push("C"));
  });
  stopB = m.onChange(() => log.push("B"));
  m.update({ addNodes: [{ id: "d" }] });
  assert.deepEqual(log, ["A"]);
});

test("a strict model's problem in a queued update is reported, and the queue carries on", () => {
  const errors = [];
  const m = GraphModel.from(chain(), {
    strict: true,
    onError: (error) => errors.push(error.message),
  });
  let once = true;
  m.onChange(() => {
    if (!once) return;
    once = false;
    m.update({ changeNodes: [{ id: "nope", label: "x" }] });
    m.update({ changeNodes: [{ id: "a", label: "A" }] });
  });
  m.update({ addNodes: [{ id: "d" }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no node "nope"/);
  assert.equal(m.node("a").label, "A");
  assert.throws(() => m.update({ removeNodes: ["zzz"] }), /no node "zzz"/);
  assert.equal(m.size, 4, "a strict throw leaves the model as it was");
});

// ---- ids and odd input -----------------------------------------------------------------------------------------

test("ids like __proto__ and constructor are ordinary ids, in the model and in snapshots", () => {
  const json = {
    nodes: [
      { id: "__proto__", label: "proto" },
      { id: "constructor" },
      { id: "toString" },
    ],
    edges: [
      { source: "__proto__", target: "constructor" },
      { source: "constructor", target: "toString" },
    ],
  };
  const m = GraphModel.from(json);
  assert.deepEqual(m.issues, []);
  assert.equal(m.node("__proto__").label, "proto");
  assert.equal(m.edge("__proto__>constructor").target, "constructor");
  assert.equal(m.node("hasOwnProperty"), undefined);

  const g = new Graph(m);
  g.nodes.forEach((n, i) => Object.assign(n, { x: i + 1, y: i + 2 }));
  const shot = takeSnapshot({
    graph: g,
    settings: {},
    camera: { x: 0, y: 0, k: 1 },
  });
  assert.equal(shot.state["__proto__"].x, 1);
  const json2 = JSON.parse(JSON.stringify(shot));
  assert.ok(Object.hasOwn(json2.state, "__proto__"), "JSON keeps the key");
  const back = new Graph(snapshotModel(json2));
  applyState(back, json2.state);
  assert.equal(back.byId.get("__proto__").x, 1);
  assert.equal(back.byId.get("toString").y, 4);

  // A state that doesn't mention "constructor" doesn't hand it Object's constructor.
  const partial = new Graph(m);
  partial.byId.get("constructor").x = 7;
  applyState(partial, { toString: { x: 9, y: 9 } });
  assert.equal(partial.byId.get("constructor").x, 7);

  // A style key named after Object's own properties is just an unknown style.
  const styled = GraphModel.from({
    nodes: [
      { id: "x", style: JSON.parse('{"__proto__": 1, "constructor": 2}') },
    ],
  });
  assert.deepEqual(
    styled.issues.map((i) => i.kind),
    ["bad-style", "bad-style"],
  );
  assert.deepEqual(styled.node("x").style, {});
});

test("nodes without a usable id are left out and reported, the same way everywhere", () => {
  const m = GraphModel.from({
    nodes: [
      { id: "a" },
      { label: "no id" },
      { id: "" },
      { id: null },
      { id: { nested: 1 } },
      "b",
      { id: 0 },
    ],
    edges: [{ source: "a", target: "0" }, { target: "a" }],
  });
  assert.deepEqual(
    m.nodes.map((n) => n.id),
    ["a", "0"],
    "a number id becomes a string",
  );
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    [
      "missing-id",
      "missing-id",
      "missing-id",
      "missing-id",
      "missing-id",
      "missing-endpoint",
    ],
  );
  const change = m.update({
    addNodes: [{ label: "still no id" }, { id: "c" }],
  });
  assert.deepEqual(change.nodesAdded, ["c"]);
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["missing-id"],
  );
  assert.equal(m.node(""), undefined);

  // An edge's id that can't be used is reported and one is made.
  m.update({ addEdges: [{ id: "", source: "a", target: "c" }] });
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["bad-id"],
  );
  assert.ok(m.edge("a>c"));
  assert.throws(
    () => GraphModel.from({ nodes: [{}] }, { strict: true }),
    /no id/,
  );
});

test("a delta's fields take one item or any list; anything else is reported and ignored, never thrown", () => {
  const m = GraphModel.from(chain());
  let change = m.update({
    addNodes: { id: "d" },
    addEdges: { source: "c", target: "d" },
  });
  assert.deepEqual(change.nodesAdded, ["d"]);
  assert.deepEqual(change.edgesAdded, ["c>d"]);
  change = m.update({ changeNodes: { id: "d", label: "D" } });
  assert.deepEqual(change.nodesChanged, ["d"]);
  change = m.update({ removeNodes: "d" });
  assert.deepEqual(change.nodesRemoved, ["d"]);
  change = m.update({ removeEdges: new Set(["b>c"]) });
  assert.deepEqual(change.edgesRemoved, ["b>c"]);

  assert.equal(m.update({ addNodes: 5, removeNodes: { id: "a" } }), null);
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["bad-input", "bad-input"],
  );
  assert.equal(m.update({ addNode: [{ id: "x" }] }), null);
  assert.match(m.issues[0].message, /did you mean "addNodes"/);
  assert.equal(m.update([{ id: "x" }]), null);
  assert.equal(m.issues[0].kind, "bad-input");
  assert.equal(m.update(null), null);
  assert.equal(m.update(), null);
  assert.equal(m.size, 3);
});

// ---- comparing values ------------------------------------------------------------------------------------------

test("equal() compares JSON-like data by value, anything else by identity", () => {
  assert.ok(equal(NaN, NaN));
  assert.ok(!equal(0, NaN));
  assert.ok(equal([1, [2, { x: 3 }]], [1, [2, { x: 3 }]]));
  assert.ok(!equal([1, 2], [1, 2, 3]));
  assert.ok(!equal([1], { 0: 1 }), "an array isn't an object with index keys");
  assert.ok(!equal({ a: undefined }, { b: undefined }), "keys matter");
  const d = new Date(2026, 0, 1);
  assert.ok(equal(d, d));
  assert.ok(!equal(d, new Date(d.getTime())), "a date is only itself");
  const loop = { name: "loop" };
  loop.self = loop;
  const copy = structuredClone(loop);
  assert.ok(equal(loop, copy), "cycles end");
});

test("nested data: a real change is seen, the same again is not", () => {
  const data = () => ({
    ratio: NaN,
    tiers: [1, 2, [3]],
    sellers: { tp: { price: 10 } },
  });
  const m = GraphModel.from({ nodes: [{ id: "a", data: data() }] });
  const record = m.node("a");
  assert.equal(
    m.update({ changeNodes: [{ id: "a", data: data() }] }),
    null,
    "equal data is no change (NaN and nesting too)",
  );
  assert.equal(m.node("a"), record, "and the record is kept");
  assert.equal(m.replace({ nodes: [{ id: "a", data: data() }] }), null);

  for (const [key, value] of [
    ["tiers", [1, 2, [4]]],
    ["sellers", { tp: { price: 11 } }],
  ]) {
    const change = m.update({
      changeNodes: [{ id: "a", data: { ...data(), [key]: value } }],
    });
    assert.ok(change, `a new ${key} is a change`);
    assert.equal(change.dataOnly, true);
    m.update({ changeNodes: [{ id: "a", data: data() }] });
  }
});

// ---- data-only changes -----------------------------------------------------------------------------------------

test("dataOnly: a change of data (or meta) alone draws nothing new; anything drawn clears it", () => {
  const m = GraphModel.from({
    meta: { name: "one" },
    nodes: [{ id: "a", data: { price: 1 } }, { id: "b" }],
    edges: [{ source: "a", target: "b", data: { count: 1 } }],
  });
  const heard = [];
  m.onChange((c) => heard.push(c));

  let c = m.update({
    changeNodes: [{ id: "a", data: { price: 2 } }],
    changeEdges: [{ id: "a>b", data: { count: 3 } }],
  });
  assert.equal(c.dataOnly, true);
  assert.equal(c.looks, false);
  assert.equal(c.sizes, false);
  assert.equal(c.structure, false);
  assert.deepEqual(c.nodesChanged, ["a"]);
  assert.deepEqual(c.edgesChanged, ["a>b"]);
  assert.deepEqual(c.nodesRestyled, []);
  assert.deepEqual(c.edgesRestyled, []);
  assert.equal(m.node("a").data.price, 2);

  c = m.update({
    changeNodes: [
      { id: "a", data: { price: 5 } },
      { id: "b", style: { color: "#ff0000" } },
    ],
  });
  assert.equal(c.dataOnly, false, "a colour is drawn");
  assert.equal(c.looks, true);
  assert.equal(c.sizes, false);
  assert.deepEqual(c.nodesChanged, ["a", "b"]);
  assert.deepEqual(c.nodesRestyled, ["b"]);

  c = m.update({ changeEdges: [{ id: "a>b", style: { width: 3 } }] });
  assert.deepEqual(c.edgesRestyled, ["a>b"]);
  assert.equal(c.dataOnly, false);

  c = m.update({ changeNodes: [{ id: "a", label: "A" }] });
  assert.equal(c.sizes, true, "a shown label takes room");
  assert.deepEqual(c.nodesRestyled, ["a"]);

  c = m.replace({ ...m.toJSON(), meta: { name: "two" } });
  assert.equal(c.dataOnly, true, "meta alone is data");
  assert.equal(m.meta.name, "two");

  c = m.update({ addNodes: [{ id: "c" }] });
  assert.equal(c.dataOnly, false);
  assert.equal(c.structure, true);
  assert.equal(heard.length, 6);
  assert.ok(heard.every((h) => "dataOnly" in h && "nodesRestyled" in h));
});

test("meta is the model's own copy: the caller's nested objects aren't frozen", () => {
  const meta = { source: { url: "x" } };
  const m = GraphModel.from({ meta, nodes: [] });
  assert.ok(!Object.isFrozen(meta.source));
  meta.source.url = "changed";
  assert.equal(m.meta.source.url, "x");
});

// ---- options ---------------------------------------------------------------------------------------------------

test("options: numbers out of range are clamped; misspelt keys and bad choices are reported with the closest", () => {
  const warnings = [];
  const out = resolve(
    NODE_OPTIONS,
    {
      size: 500,
      labelSize: -3,
      outline: Infinity,
      collisionRadius: NaN,
      shape: "cirlce",
      sise: 20,
      labelCollide: "yes",
    },
    (message) => warnings.push(message),
  );
  const spec = (key) => NODE_OPTIONS.find((o) => o.key === key);
  assert.equal(out.size, spec("size").max);
  assert.equal(out.labelSize, spec("labelSize").min);
  assert.equal(out.outline, spec("outline").max);
  assert.equal(out.collisionRadius, spec("collisionRadius").default);
  assert.equal(out.shape, "circle");
  assert.equal(out.labelCollide, spec("labelCollide").default);
  assert.ok(!("sise" in out));
  assert.deepEqual(
    warnings.map((m) => m.match(/"(\w+)"/)[1]),
    [
      "shape",
      "size",
      "outline",
      "labelSize",
      "collisionRadius",
      "labelCollide",
      "sise",
    ],
  );
  assert.match(warnings[0], /isn't valid .*did you mean "circle"/);
  assert.match(warnings[1], /is out of its range/);
  assert.match(warnings[4], /isn't valid/);
  assert.match(warnings.at(-1), /^unknown option .*did you mean "size"/);
  assert.equal(closest("labelsize", ["labelSize", "labels"]), "labelSize");
  assert.equal(closest("zzzzzz", ["size", "shape"]), undefined);

  // By default each message goes to the console once.
  const logged = quietly("warn", () => {
    resolve(NODE_OPTIONS, { colour: "#ffffff" });
    resolve(NODE_OPTIONS, { colour: "#000000" });
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /unknown option "colour".*did you mean "color"/);
  assert.deepEqual(resolve(NODE_OPTIONS, null), resolve(NODE_OPTIONS));
});

test("the model lists option problems as issues, once per model, and clamps", () => {
  const m = GraphModel.from(chain(), { node: { sise: 3, size: 1000 } });
  assert.deepEqual(
    m.issues.map((i) => i.kind),
    ["bad-option", "bad-option"],
  );
  assert.equal(m.opts.node.size, 60);
  const change = m.setOptions({ node: { size: 20, sise: 3 } });
  assert.equal(change.sizes, true);
  assert.deepEqual(change.issues, [], "already listed for this model");
  assert.equal(m.setOptions({ edge: { widht: 2 } }), null);
  assert.equal(m.issues[0].kind, "bad-option");
  assert.match(m.issues[0].message, /did you mean "width"/);
  assert.equal(m.setOptions(null), null);
});

// ---- incremental updates ---------------------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** Everything a model works out, checked against what's worked out naively and by a model built from scratch. */
function checkAgainstScratch(m, measure) {
  const nodes = m.nodes,
    edges = m.edges;
  assert.ok(Object.isFrozen(nodes) && Object.isFrozen(edges));
  assert.deepEqual(
    [...m.index],
    nodes.map((n, i) => [n.id, i]),
  );
  assert.deepEqual(
    [...m.edgeIndex].sort((a, b) => a[1] - b[1]),
    edges.map((e, i) => [e.id, i]),
  );
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const ends = edges.map((e) => [at.get(e.source), at.get(e.target)]);
  assert.deepEqual(m.ends, ends);
  const out = nodes.map(() => []),
    into = nodes.map(() => []);
  ends.forEach(([s, t], i) => {
    out[s].push(i);
    into[t].push(i);
  });
  assert.deepEqual(m.outgoing, out);
  assert.deepEqual(m.incoming, into);
  const adj = m.adjacency();
  assert.deepEqual(
    [...adj.source],
    ends.map((e) => e[0]),
  );
  const fresh = GraphModel.from(m.toJSON(), { measure });
  assert.deepEqual(m.forest(), fresh.forest());
  assert.deepEqual(m.dag(), fresh.dag());
  // (Issues are the latest change's: the model's own, not the fresh one's.)
  assert.deepEqual(
    { ...m.stats(), issues: 0 },
    { ...fresh.stats(), issues: 0 },
  );
  assert.deepEqual(m.labelWidths(), fresh.labelWidths());
}

test("random updates leave the model exactly as one built from scratch: ids, adjacency, views and widths", () => {
  const random = rng(7);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const measure = (text, size) => text.length * size;
  const m = GraphModel.from(
    {
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` })),
      edges: Array.from({ length: 29 }, (_, i) => ({
        source: `n${Math.floor(random() * (i + 1))}`,
        target: `n${i + 1}`,
      })),
    },
    { measure },
  );
  let made = 0;
  for (let step = 0; step < 300; step++) {
    const ids = m.nodes.map((n) => n.id);
    const edgeIds = m.edges.map((e) => e.id);
    const delta = {};
    const r = random();
    if (r < 0.3) {
      const fresh = Array.from(
        { length: 1 + Math.floor(random() * 3) },
        () => `x${made++}`,
      );
      delta.addNodes = fresh.map((id) => ({ id, label: `L${id}` }));
      delta.addEdges = fresh.map((id) => ({
        source: random() < 0.9 && ids.length ? pick(ids) : pick(fresh),
        target: id,
      }));
      if (random() < 0.3 && ids.length > 1)
        delta.addEdges.push({ source: pick(ids), target: pick(ids) });
    } else if (r < 0.5 && ids.length > 5) {
      delta.removeNodes = [pick(ids), ...(random() < 0.3 ? [pick(ids)] : [])];
      if (random() < 0.5) delta.addNodes = [{ id: delta.removeNodes[0] }]; // gone and back, at the end
    } else if (r < 0.6 && edgeIds.length) {
      delta.removeEdges = [pick(edgeIds)];
    } else {
      delta.changeNodes = Array.from({ length: (1 + random() * 3) | 0 }, () => {
        const id = pick(ids);
        const k = random();
        return k < 0.4
          ? { id, data: { price: Math.floor(random() * 5) } }
          : k < 0.7
            ? { id, label: `label ${Math.floor(random() * 4)}` }
            : { id, style: { color: random() < 0.5 ? "#ff0000" : "#00ff00" } };
      });
      if (edgeIds.length && random() < 0.5)
        delta.changeEdges = [
          { id: pick(edgeIds), data: { count: Math.floor(random() * 3) } },
        ];
    }
    // Views are read at random moments, so some updates find them worked out and some don't.
    if (random() < 0.3) m.adjacency();
    if (random() < 0.3) m.labelWidths();
    if (random() < 0.2) m.forest();
    const before = m.nodes;
    m.update(delta);
    assert.ok(
      before.every((n) => n),
      "lists handed out earlier don't change",
    );
    if (step % 10 === 0 || step > 290) checkAgainstScratch(m, measure);
  }
});

test("lists and adjacency handed out keep the structure they were read for", () => {
  const m = GraphModel.from(chain());
  const nodes = m.nodes,
    edges = m.edges,
    adj = m.adjacency(),
    outgoing = m.outgoing,
    widths = m.labelWidths();
  m.update({
    removeNodes: ["a"],
    addNodes: [{ id: "d", label: "a much longer label" }],
    addEdges: [{ source: "c", target: "d" }],
  });
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["a", "b", "c"],
  );
  assert.equal(edges.length, 2);
  assert.deepEqual([...adj.source], [0, 1]);
  assert.deepEqual(outgoing, [[0], [1], []]);
  assert.equal(widths.length, 3);
  assert.notEqual(m.nodes, nodes);
  assert.deepEqual(
    m.nodes.map((n) => n.id),
    ["b", "c", "d"],
  );
  assert.equal(m.nodes, m.nodes, "the same list until the next change");
});

test("updates don't work out views: stats, forest and adjacency wait until they're asked for", () => {
  const m = GraphModel.from(chain());
  m.stats();
  m.update({
    addNodes: [{ id: "d" }],
    addEdges: [{ source: "c", target: "d" }],
  });
  assert.equal(m.cache.size, 0, "nothing worked out on the update");
  assert.equal(m.stats().nodes, 4);
  assert.equal(m.stats().depth, 3);
  assert.ok(m.cache.has("stats"));
  m.update({ changeNodes: [{ id: "d", data: { x: 1 } }] });
  assert.ok(m.cache.has("stats"), "kept: the structure didn't change");
});

test("label widths: only new and relabelled nodes are measured again", () => {
  const measured = [];
  const measure = (text, size) => {
    measured.push(text);
    return text.length * size;
  };
  const m = GraphModel.from(chain(), { measure });
  const first = m.labelWidths();
  assert.equal(measured.length, 3);
  m.update({ changeNodes: [{ id: "b", label: "bee" }] });
  m.update({ addNodes: [{ id: "d", label: "dee" }] });
  m.update({ changeNodes: [{ id: "c", data: { price: 1 } }] });
  const second = m.labelWidths();
  assert.deepEqual(measured, ["a", "b", "c", "bee", "dee"]);
  assert.notEqual(second, first, "a new array: the old one may be in use");
  assert.deepEqual([...first], [11, 11, 11]);
  assert.deepEqual([...second], [11, 33, 11, 33]);
  m.update({ removeNodes: ["a"] });
  assert.deepEqual([...m.labelWidths()], [33, 11, 33]);
});

test("150k nodes: build, stats and one-node updates without a RangeError, and updates cost what they change", () => {
  const count = 150_000;
  const random = rng(3);
  const nodes = [{ id: "n0" }],
    edges = [];
  for (let i = 1; i < count; i++) {
    nodes.push({ id: `n${i}`, label: `item ${i}`, data: { price: i } });
    edges.push({
      source: `n${Math.floor(random() ** 1.3 * i)}`,
      target: `n${i}`,
    });
  }
  for (let k = 0; k < count / 10; k++) {
    const a = Math.floor(random() * count),
      b = Math.floor(random() * count);
    if (a !== b)
      edges.push({
        source: `n${Math.min(a, b)}`,
        target: `n${Math.max(a, b)}`,
      });
  }
  const m = new GraphModel({ nodes, edges });
  const stats = m.stats();
  assert.equal(stats.nodes, count);
  assert.equal(stats.roots, 1);
  assert.equal(stats.edges, edges.length);
  assert.equal(m.labelWidths().length, count);

  const time = (fn) => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      fn(i);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const data = time((i) =>
    m.update({ changeNodes: [{ id: "n5", data: { price: i } }] }),
  );
  const add = time((i) =>
    m.update({
      addNodes: [{ id: `y${i}` }],
      addEdges: [{ source: "n0", target: `y${i}` }],
    }),
  );
  // Before: about 200 ms and 570 ms. Generous bounds: tests share the machine.
  assert.ok(data < 20, `a data change took ${data.toFixed(1)} ms`);
  assert.ok(add < 20, `adding a node took ${add.toFixed(1)} ms`);
  assert.equal(m.stats().nodes, count + 5);
  assert.equal(m.forest().order.length, count + 5);
});
