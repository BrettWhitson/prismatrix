// Local static server for the demo. No dependencies.
//
// Serves the project root (so the demo reaches src/ and node_modules/tether) with correct MIME types and
// `Cache-Control: no-store`, so edits show up on reload.
//
// Usage:  node tools/serve.mjs [port]      (default port 8650; open http://localhost:8650/demo/)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
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
  if (pathname === "/") {
    response.writeHead(302, { Location: "/demo/" });
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
  console.log(`Prismatrix demo: http://localhost:${port}/demo/`),
);
