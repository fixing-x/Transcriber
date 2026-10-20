import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".cact", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

const server = createServer((request, response) => {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Permissions-Policy": "microphone=(self), on-device-speech-recognition=(self)",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", `http://${host}:${port}`).pathname);
  } catch {
    response.writeHead(400, headers).end("Invalid request path");
    return;
  }
  if (pathname.includes("\0")) {
    response.writeHead(400, headers).end("Invalid request path");
    return;
  }
  const requestedPath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const filePath = resolve(root, `.${requestedPath}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403, headers).end("Forbidden");
    return;
  }

  let stats;
  try { stats = statSync(filePath); } catch {
    response.writeHead(404, headers).end("Not found");
    return;
  }
  if (!stats.isFile()) {
    response.writeHead(404, headers).end("Not found");
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": stats.size, "Content-Type": types.get(extname(filePath)) || "application/octet-stream" });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Local Speech demo: http://${host}:${port}`);
});
