const fs = require("fs");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");

const rootDir = path.resolve(__dirname, "..", "src");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const rpcTarget = process.env.RPC_URL || "http://127.0.0.1:8545";
const checkOnly = process.argv.includes("--check");

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"]
]);

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(body);
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const rawPath = url.pathname;

  if (/[\u0000-\u001F\u007F]/u.test(rawPath)) {
    return null;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, filePath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  return filePath;
}

function proxyRpc(request, response) {
  const chunks = [];

  request.on("data", (chunk) => {
    chunks.push(chunk);
  });

  request.on("end", async () => {
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      const upstream = await fetch(rpcTarget, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      const text = await upstream.text();

      response.writeHead(upstream.status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(text);
    } catch (error) {
      send(response, 502, JSON.stringify({ error: error.message }));
    }
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);

  if (url.pathname === "/rpc") {
    if (request.method !== "POST") {
      send(response, 405, "Method Not Allowed", { Allow: "POST" });
      return;
    }

    proxyRpc(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed", { Allow: "GET, HEAD, POST" });
    return;
  }

  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    send(response, 400, "Bad Request");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      send(response, 404, "Not Found");
      return;
    }

    const contentType = mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-store"
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(port, host, () => {
  console.log(`Frontend server running at http://${host}:${port}/`);
  console.log(`Serving ${pathToFileURL(rootDir).href}`);

  if (checkOnly) {
    server.close(() => {
      console.log("Frontend server check passed.");
    });
  }
});
