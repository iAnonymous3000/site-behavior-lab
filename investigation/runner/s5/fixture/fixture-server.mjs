// The fixture origin for fixture mode, on loopback inside the container. The scanner visits reserved
// names, and its own proxy hands every connection it allows to this server
// (connectProxyUpstreamForTests, as lib/investigation-seam-setting.test.ts does), which answers by the
// Host header. The pages are S3's, S4's control page and the S5c pages in pages/. Nothing here
// reaches outside the container, and the container has no network.
import http from "node:http";
import { readFileSync } from "node:fs";

const PAGES = new URL("./pages/", import.meta.url).pathname;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SLOW_SCRIPT_MS = 3_000;

/** Host and path to page file, for the hosts the S3 page and its frames name. */
const ROUTES = {
  "www.example.com": {
    "/page": "page.html",
    "/reads-seam": "reads-seam.html",
    "/control.html": "control.html",
    "/post-budget": "post-budget.html",
    "/standin-host": "standin-host.html",
    "/banner": "banner.html",
    "/slow": "slow.html",
    "/slow.js": "slow.js"
  },
  "frame.example.net": { "/inner": "inner.html" },
  "deep.example.org": { "/deep": "deep.html" },
  "cdn.example.org": { "/lib.js": "lib.js" }
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export function startFixtureServer({ port, standInPort }) {
  const stats = { requests: 0, postBytes: 0 };
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const host = String(req.headers.host ?? "").split(":")[0];
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (host === "www.example.com" && path === "/post") {
      req.on("data", (d) => { stats.postBytes += d.length; });
      req.on("end", () => res.writeHead(204).end());
      return;
    }
    const file = ROUTES[host]?.[path];
    if (!file) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    const send = () => {
      const text = readFileSync(`${PAGES}${file}`, "utf8").replaceAll("{{STANDIN_PORT}}", String(standInPort));
      res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      res.end(text);
    };
    if (file === "slow.js") setTimeout(send, SLOW_SCRIPT_MS);
    else send();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats })));
}
