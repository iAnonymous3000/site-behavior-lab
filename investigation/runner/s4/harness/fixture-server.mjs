// Fixture origin for the S4 runs, on loopback only. Serves the pages in fixtures/ and a few generated
// resources. Nothing here reaches outside the container.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json" };

// 33 MiB of script, just over the recorder's 32 MiB source budget (WEB_RUNTIME_LIMITS.sourceBytes).
const BIG_SCRIPT_BYTES = 33 * 1024 * 1024;
function bigScript(res) {
  res.writeHead(200, { "content-type": "text/javascript" });
  const line = "function f(){return 1}\n";
  const chunk = Buffer.from(line.repeat(Math.floor(65536 / line.length)));
  let sent = 0;
  const pump = () => {
    while (sent < BIG_SCRIPT_BYTES) {
      sent += chunk.length;
      if (!res.write(chunk)) return res.once("drain", pump);
    }
    res.end("big();\nfunction big(){return 2}\n");
  };
  pump();
}

export function startFixtureServer({ port }) {
  const stats = { postBytes: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/big-script.js") return bigScript(res);
    if (url.pathname === "/post") {
      req.on("data", (d) => { stats.postBytes += d.length; });
      req.on("end", () => res.writeHead(204).end());
      return;
    }
    const rel = normalize(url.pathname).replace(/^\/+/, "");
    const file = join(FIXTURES, rel);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) return res.writeHead(404).end();
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats })));
}
