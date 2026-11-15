// Allow-list guard proxy for the S4 fixture runs. The scanner's own guard
// (lib/public-scan-proxy.ts) refuses loopback and private addresses by design, so
// it cannot serve a loopback fixture origin; this one allows exactly the listed
// loopback origins (the fixture origin, and the browser's CDP port in case the
// recorder's discovery request honours the proxy variables) and refuses
// everything else, recording every attempt. The container has
// no network of its own, so this proxy is the record, not the boundary.
import http from "node:http";
import { appendFileSync } from "node:fs";

const MAX_LOG_LINES = 10_000;

export function startGuardProxy({ port, allowedOrigins, logPath, onRefusal }) {
  let lines = 0;
  const allowed = new Map(allowedOrigins.map((o) => { const u = new URL(o); return [u.host, u]; }));
  const record = (entry) => {
    if (lines >= MAX_LOG_LINES) return;
    lines += 1;
    appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  };

  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      record({ method: req.method, target: String(req.url).slice(0, 512), allowed: false, reason: "not-absolute" });
      onRefusal({ method: req.method, target: String(req.url).slice(0, 512) });
      res.writeHead(400).end();
      return;
    }
    const upstreamOrigin = target.protocol === "http:" ? allowed.get(target.host) : undefined;
    const ok = upstreamOrigin !== undefined;
    record({ method: req.method, target: target.href.slice(0, 512), allowed: ok });
    if (!ok) {
      onRefusal({ method: req.method, target: target.href.slice(0, 512) });
      res.writeHead(403, { "content-type": "text/plain" }).end("refused by the S4 guard proxy\n");
      return;
    }
    const upstream = http.request(
      { host: upstreamOrigin.hostname, port: upstreamOrigin.port, method: req.method, path: target.pathname + target.search, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  // HTTPS through the proxy arrives as CONNECT. Nothing in the fixtures uses it.
  server.on("connect", (req, socket) => {
    record({ method: "CONNECT", target: String(req.url).slice(0, 512), allowed: false });
    onRefusal({ method: "CONNECT", target: String(req.url).slice(0, 512) });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    record({ method: "UPGRADE", target: String(req.url).slice(0, 512), allowed: false });
    onRefusal({ method: "UPGRADE", target: String(req.url).slice(0, 512) });
    socket.destroy();
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
