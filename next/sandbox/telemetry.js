// A rolling 30-second log of what the engine is doing, kept in the page and sent to the dev server every second
// (tools/serve.mjs writes it to logs/engine-stats.log). If the page hangs, the file stops updating: its
// "received" stamp goes stale, and its last lines show what led up to it.
//
// Four samples a second summarise the frames since the last one; events (settings changes, drags, errors, slow
// frames) are logged as they happen. `window.engineLog.text()` gives the same text in the console.

const WINDOW_MS = 30_000;
const SAMPLE_MS = 250;
const FLUSH_MS = 1000;
const SLOW_FRAME_MS = 50;

export function startTelemetry(getView) {
  const started = performance.now();
  /** @type {{ t: number, line: string }[]} */
  const entries = [];
  let acc = fresh();

  function fresh() {
    return {
      frames: 0,
      worst: 0,
      simSum: 0,
      simMax: 0,
      drawSum: 0,
      drawMax: 0,
      state: "",
      energy: 0,
    };
  }

  const stamp = (t) => `+${((t - started) / 1000).toFixed(2).padStart(7)}s`;

  function push(line) {
    const t = performance.now();
    entries.push({ t, line: `${stamp(t)} ${line}` });
    while (entries.length && entries[0].t < t - WINDOW_MS) entries.shift();
  }

  function event(type, detail) {
    const body =
      detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : "";
    push(`EVENT ${type}${body}`);
  }

  function frame(stats) {
    acc.frames++;
    acc.simSum += stats.simMs;
    acc.simMax = Math.max(acc.simMax, stats.simMs);
    acc.drawSum += stats.drawMs;
    acc.drawMax = Math.max(acc.drawMax, stats.drawMs);
    acc.worst = Math.max(acc.worst, stats.dt * 1000);
    acc.state = stats.state;
    acc.energy = stats.energy;
    if (stats.dt * 1000 > SLOW_FRAME_MS)
      event("slowFrame", {
        gapMs: Math.round(stats.dt * 1000),
        simMs: round(stats.simMs),
        drawMs: round(stats.drawMs),
        state: stats.state,
      });
  }

  /** Health of the graph right now: anything non-finite, how fast the fastest node is, how big it all is. */
  function health(view) {
    let nan = 0,
      fastest = 0,
      minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of view.graph.nodes) {
      if (!Number.isFinite(n.x + n.y + n.vx + n.vy)) {
        nan++;
        continue;
      }
      fastest = Math.max(fastest, Math.hypot(n.vx, n.vy));
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const size = Number.isFinite(minX)
      ? `${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`
      : "-";
    return `nan=${nan} fastest=${Math.round(fastest)} held=${view.sim.held.size} size=${size} zoom=${round(view.camera.k)}`;
  }

  function sample() {
    const view = getView();
    if (!view) return;
    const a = acc;
    acc = fresh();
    const where = `${view.renderer?.name}:${view.layout}/${view.mode} n=${view.graph.nodes.length}`;
    if (!a.frames) {
      push(`idle   ${where} ${health(view)}`);
      return;
    }
    const fps = Math.round((a.frames * 1000) / SAMPLE_MS);
    push(
      `sample ${where} frames=${a.frames} (~${fps}fps) worstGap=${Math.round(a.worst)}ms ` +
        `sim=${round(a.simSum / a.frames)}/${round(a.simMax)}ms draw=${round(a.drawSum / a.frames)}/${round(a.drawMax)}ms ` +
        `state="${a.state}" energy=${round(a.energy)} ${health(view)}`,
    );
  }

  function text() {
    const head =
      `# Prismatrix engine log: last ${WINDOW_MS / 1000}s, sampled every ${SAMPLE_MS}ms ` +
      `(sim/draw = mean/max per frame; worstGap = longest time between frames)\n` +
      `# page time ${new Date().toISOString()}\n`;
    return head + entries.map((e) => e.line).join("\n") + "\n";
  }

  async function flush() {
    try {
      await fetch("/__log", { method: "POST", body: text(), keepalive: true });
    } catch {
      // No log server (e.g. a static host): the in-page buffer still works.
    }
  }

  addEventListener("error", (e) =>
    event("error", { message: e.message, at: `${e.filename}:${e.lineno}` }),
  );
  addEventListener("unhandledrejection", (e) =>
    event("error", { message: String(e.reason?.message ?? e.reason) }),
  );
  addEventListener("pagehide", flush);
  setInterval(sample, SAMPLE_MS);
  setInterval(flush, FLUSH_MS);
  event("start", {
    url: location.pathname,
    size: `${innerWidth}x${innerHeight}`,
  });

  const log = { frame, event, text, flush };
  window.engineLog = log;
  return log;
}

const round = (v) => Math.round(v * 10) / 10;
