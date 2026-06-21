import dns from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { type Duplex } from "node:stream";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";
import { assertPublicHttpUrlShape } from "./url-safety";

export type ResolvedHostAddress = {
  address: string;
  family: number;
};

export type ResolvePublicHost = (hostname: string) => Promise<ResolvedHostAddress[]>;

export type BlockedProxyTarget = {
  target: string;
  reason: "invalid-target" | "non-public-address" | "upstream-failed";
};

export type PublicScanProxy = {
  server: string;
  blockedTargets: BlockedProxyTarget[];
  close: () => Promise<void>;
};

type PinnedTarget = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  address: string;
  family: number;
};

type StartPublicScanProxyOptions = {
  allowNonStandardPortsForTests?: boolean;
  resolveHost?: ResolvePublicHost;
};

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

export async function startPublicScanProxy(options: StartPublicScanProxyOptions = {}): Promise<PublicScanProxy> {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const blockedTargets: BlockedProxyTarget[] = [];
  const pinnedTargets = new Map<string, Promise<PinnedTarget>>();
  const sockets = new Set<Duplex>();

  const server = http.createServer((request, response) => {
    handleHttpProxyRequest(request, response, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets
    }).catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });

  server.on("connect", (request, socket, head) => {
    handleHttpsConnect(request, socket, head, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets
    }).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  });

  server.on("upgrade", (request, socket) => {
    handleUpgradeRequest(request, socket, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets
    });
  });

  server.on("connection", (socket) => trackSocket(socket, sockets));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Public scan proxy did not bind a TCP port.");
  }

  return {
    server: `http://127.0.0.1:${address.port}`,
    blockedTargets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function handleHttpProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ProxyState
): Promise<void> {
  const targetUrl = parseHttpProxyUrl(request);
  if (!targetUrl || targetUrl.protocol !== "http:") {
    recordBlockedTarget(state.blockedTargets, request.url ?? "unknown", "invalid-target");
    response.destroy();
    return;
  }

  let target: PinnedTarget;
  try {
    target = await getPinnedTarget(targetUrl, state);
  } catch {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "non-public-address");
    response.destroy();
    return;
  }

  const upstream = http.request(
    {
      host: target.address,
      port: target.port,
      family: target.family,
      method: request.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: proxyRequestHeaders(request.headers, targetUrl.host)
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );

  upstream.on("error", () => {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "upstream-failed");
    if (!response.destroyed) response.destroy();
  });

  request.pipe(upstream);
}

async function handleHttpsConnect(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  state: ProxyState
): Promise<void> {
  const targetUrl = parseConnectUrl(request.url ?? "");
  if (!targetUrl) {
    recordBlockedTarget(state.blockedTargets, request.url ?? "unknown", "invalid-target");
    closeTunnel(clientSocket, 400);
    return;
  }

  let target: PinnedTarget;
  try {
    target = await getPinnedTarget(targetUrl, state);
  } catch {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "non-public-address");
    closeTunnel(clientSocket, 403);
    return;
  }

  const upstream = net.connect({
    host: target.address,
    port: target.port,
    family: target.family
  });

  upstream.once("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.once("error", () => {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "upstream-failed");
    closeTunnel(clientSocket, 502);
  });

  clientSocket.once("error", () => upstream.destroy());
}

function handleUpgradeRequest(request: IncomingMessage, socket: Duplex, state: ProxyState): void {
  const targetUrl = parseUpgradeProxyUrl(request);
  recordBlockedTarget(state.blockedTargets, targetUrl ? safeTargetLabel(targetUrl) : request.url ?? "unknown", "invalid-target");
  closeTunnel(socket, 400);
}

type ProxyState = {
  allowNonStandardPorts: boolean;
  resolveHost: ResolvePublicHost;
  blockedTargets: BlockedProxyTarget[];
  pinnedTargets: Map<string, Promise<PinnedTarget>>;
};

async function getPinnedTarget(targetUrl: URL, state: ProxyState): Promise<PinnedTarget> {
  const hostname = normalizeHostname(targetUrl.hostname);
  const port = targetUrl.port ? Number(targetUrl.port) : defaultPort(targetUrl.protocol);
  const cacheKey = `${targetUrl.protocol}//${hostname}:${port}`;
  let pinnedTarget = state.pinnedTargets.get(cacheKey);

  if (!pinnedTarget) {
    const pendingTarget = resolvePinnedTarget(targetUrl, hostname, port, state);
    pinnedTarget = pendingTarget.catch((error) => {
      if (state.pinnedTargets.get(cacheKey) === pinnedTarget) {
        state.pinnedTargets.delete(cacheKey);
      }
      throw error;
    });
    state.pinnedTargets.set(cacheKey, pinnedTarget);
  }

  return pinnedTarget;
}

async function resolvePinnedTarget(
  targetUrl: URL,
  hostname: string,
  port: number,
  state: ProxyState
): Promise<PinnedTarget> {
  assertPublicHttpUrlShape(state.allowNonStandardPorts ? urlWithoutPort(targetUrl.protocol, hostname) : targetUrl);

  const addresses = isIpAddress(hostname)
    ? [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }]
    : await state.resolveHost(hostname);

  if (addresses.length === 0) {
    throw new Error("No DNS addresses returned.");
  }

  if (!addresses.every(({ address }) => isPublicIpAddress(address))) {
    throw new Error("Host resolved to a non-public address.");
  }

  const selected = addresses[0];
  return {
    protocol: targetUrl.protocol as "http:" | "https:",
    hostname,
    port,
    address: selected.address,
    family: selected.family
  };
}

function urlWithoutPort(protocol: string, hostname: string): URL {
  return new URL(`${protocol}//${hostForUrl(hostname)}/`);
}

function hostForUrl(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function parseHttpProxyUrl(request: IncomingMessage): URL | null {
  if (!request.url) return null;

  try {
    if (/^https?:\/\//i.test(request.url)) {
      return new URL(request.url);
    }

    const host = request.headers.host;
    if (!host) return null;
    return new URL(`http://${host}${request.url}`);
  } catch {
    return null;
  }
}

function parseConnectUrl(value: string): URL | null {
  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.port && parsed.port !== String(DEFAULT_HTTPS_PORT)) {
      return parsed;
    }
    return new URL(`https://${parsed.hostname}/`);
  } catch {
    return null;
  }
}

function parseUpgradeProxyUrl(request: IncomingMessage): URL | null {
  if (!request.url) return null;

  try {
    if (/^wss?:\/\//i.test(request.url)) {
      return new URL(request.url);
    }

    const host = request.headers.host;
    if (!host) return null;
    return new URL(`ws://${host}${request.url}`);
  } catch {
    return null;
  }
}

function proxyRequestHeaders(headers: IncomingMessage["headers"], host: string): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = { ...headers, host };
  delete forwarded["proxy-authorization"];
  delete forwarded["proxy-connection"];
  return forwarded;
}

function closeTunnel(socket: Duplex, status: 400 | 403 | 502): void {
  if (socket.destroyed) return;
  const message = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway";
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

function recordBlockedTarget(
  blockedTargets: BlockedProxyTarget[],
  target: string,
  reason: BlockedProxyTarget["reason"]
): void {
  blockedTargets.push({ target, reason });
}

function safeTargetLabel(url: URL): string {
  return `${url.protocol}//${url.host}/`;
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
}

async function defaultResolveHost(hostname: string): Promise<ResolvedHostAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function trackSocket(socket: Duplex, sockets: Set<Duplex>): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}
