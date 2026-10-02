// Local static server for the demo. No dependencies.
//
// Serves the project root (so the sandbox reaches src/) with correct MIME types and
// `Cache-Control: no-store`, so edits show up on reload.
//
// POST /__log takes a page's rolling log (the sandbox's engine stats) and writes it to logs/engine-stats.log, so
// what the engine is doing can be read live from outside the browser. POST /__snapshot takes a view snapshot
// (prismatrix-snapshot JSON, see MODEL.md) and saves it in logs/snapshots/, keeping the newest 30, so a bug can
// be reproduced exactly: load it in a test, or restore it in the sandbox.
//
// Usage:  node tools/serve.mjs [port] [start]   (default port 8650; / redirects to start, default /sandbox/)
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const port = Number(process.argv[2] ?? process.env.PORT ?? 8650);
const start = process.argv[3] ?? "/sandbox/";
const LOG_FILE = path.join(ROOT, "logs", "engine-stats.log");
const LOG_LIMIT = 4 * 1024 * 1024;

const SNAPSHOTS = path.join(ROOT, "logs", "snapshots");
const SNAPSHOTS_KEPT = 30;

/** A request's body, or null (after answering 413) when it's over the limit. */
async function readBody(request, response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LOG_LIMIT) {
      response.writeHead(413).end();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Replace the log file with a page's buffer, stamped with when it arrived. */
async function receiveLog(request, response) {
  const body = await readBody(request, response);
  if (body === null) return;
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  const stamp = `# received ${new Date().toISOString()}\n`;
  await writeFile(LOG_FILE, stamp + body);
  response.writeHead(204).end();
}

/** Save a snapshot as logs/snapshots/<time>-<note>.json, keeping the newest few. */
async function receiveSnapshot(request, response) {
  const body = await readBody(request, response);
  if (body === null) return;
  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch {
    response.writeHead(400).end("not JSON");
    return;
  }
  if (snapshot?.format !== "prismatrix-snapshot") {
    response.writeHead(400).end("not a prismatrix-snapshot");
    return;
  }
  await mkdir(SNAPSHOTS, { recursive: true });
  const note = String(snapshot.note ?? "snapshot")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${note}.json`;
  await writeFile(
    path.join(SNAPSHOTS, name),
    JSON.stringify(snapshot, null, 1),
  );
  const files = (await readdir(SNAPSHOTS))
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - SNAPSHOTS_KEPT)))
    await rm(path.join(SNAPSHOTS, old));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ saved: `logs/snapshots/${name}` }));
}

/** The request's path, decoded, or null when it can't be read (a malformed URL or escape). */
function requestPath(requestUrl) {
  try {
    return decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null;
  }
}

/** Map a decoded request path to a file inside the project, refusing anything that escapes it. */
async function resolveFile(pathname) {
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
  try {
    const info = await stat(filePath);
    return info.isDirectory() ? path.join(filePath, "index.html") : filePath;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const pathname = requestPath(request.url);
  if (pathname === null) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }
  if (pathname === "/__snapshot" && request.method === "POST") {
    await receiveSnapshot(request, response).catch((error) => {
      console.error("snapshot write failed:", error.message);
      if (!response.headersSent) response.writeHead(500).end();
    });
    return;
  }
  if (pathname === "/__log" && request.method === "POST") {
    await receiveLog(request, response).catch((error) => {
      console.error("log write failed:", error.message);
      if (!response.headersSent) response.writeHead(500).end();
    });
    return;
  }
  if (pathname === "/") {
    response.writeHead(302, { Location: start, "Cache-Control": "no-store" });
    response.end();
    return;
  }
  const filePath = await resolveFile(pathname);
  const body = filePath && (await readFile(filePath).catch(() => null));
  if (!body) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type":
      MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(body);
}).listen(port, () =>
  console.log(`Prismatrix: http://localhost:${port}${start}`),
);
