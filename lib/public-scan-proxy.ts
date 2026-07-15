import dns from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { type Duplex, type Readable, type Writable } from "node:stream";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";
import { assertPublicHttpUrlShape } from "./url-safety";

export type ResolvedHostAddress = {
  address: string;
  family: number;
};

export type ResolvePublicHost = (hostname: string) => Promise<ResolvedHostAddress[]>;

export type BlockedProxyTarget = {
  target: string;
  /**
   * Why the proxy refused or failed the connection. Consumers word user-facing
   * copy from this: only "non-public-address" is a private/local-network guard
   * block. "resolution-failed" is a DNS failure, "upstream-failed" a TCP
   * connect failure (the host may simply be down), "blocked-port" the
   * standard-ports policy, "upgrade-blocked" the WebSocket-proxying refusal,
   * "resource-limit" the independent proxy traffic bound, and
   * "invalid-target" a malformed proxy request. None of those prove a
   * private-network target and must never be described as one.
   */
  reason:
    | "invalid-target"
    | "non-public-address"
    | "resolution-failed"
    | "blocked-port"
    | "upgrade-blocked"
    | "upstream-failed"
    | "resource-limit";
};

export type PublicScanProxy = {
  server: string;
  blockedTargets: BlockedProxyTarget[];
  /**
   * Target-free snapshots of the independent downstream and upload budgets.
   * They are deliberately shaped so the measurement kernel can turn each
   * `captureLoss` into request-family quality facts without persisting URLs.
   */
  getDiagnostics: () => PublicScanProxyDiagnostics;
  close: () => Promise<void>;
};

export const PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME = "request-capture" as const;
export const DEFAULT_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT = 64 * 1024 * 1024;
export const MAX_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT = 128 * 1024 * 1024;
export const PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME = "request-upload" as const;
export const DEFAULT_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT = 16 * 1024 * 1024;
export const MAX_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT = 128 * 1024 * 1024;
export const PUBLIC_SCAN_PROXY_TRAFFIC_BUDGET_NAME = "proxy-traffic" as const;
export const DEFAULT_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT = 2_000;
export const MAX_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT = 4_000;
export const DEFAULT_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT = 256;
export const MAX_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT = 1_000;
export const MAX_RECORDED_PROXY_BLOCKS = 100;

type PublicScanProxyByteBudgetName =
  | typeof PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME
  | typeof PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME;

export type PublicScanProxyCaptureLoss<Name extends PublicScanProxyByteBudgetName = PublicScanProxyByteBudgetName> = {
  family: "requests";
  phaseId: null;
  kind: "cap";
  /** Number of streams refused or truncated after this shared cap. */
  count: number;
  detail: Name;
};

export type PublicScanProxyDiagnostics = {
  trafficBudget: {
    name: typeof PUBLIC_SCAN_PROXY_TRAFFIC_BUDGET_NAME;
    family: "requests";
    transactionLimit: number;
    transactionsSeen: number;
    uniqueTargetLimit: number;
    uniqueTargetsSeen: number;
    captureLoss: {
      family: "requests";
      phaseId: null;
      kind: "cap";
      count: number;
      detail: typeof PUBLIC_SCAN_PROXY_TRAFFIC_BUDGET_NAME;
    } | null;
  };
  responseByteBudget: {
    name: typeof PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME;
    family: "requests";
    limitBytes: number;
    /** HTTP response-body bytes plus raw upstream CONNECT tunnel bytes. */
    forwardedBytes: number;
    remainingBytes: number;
    /** The cap was reached; capture loss exists only when a stream was cut. */
    limitReached: boolean;
    captureLoss: PublicScanProxyCaptureLoss<typeof PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME> | null;
  };
  uploadByteBudget: {
    name: typeof PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME;
    family: "requests";
    limitBytes: number;
    /** Plain HTTP request-body bytes plus raw client-to-upstream CONNECT bytes. */
    forwardedBytes: number;
    remainingBytes: number;
    /** The cap was reached; capture loss exists only when a stream was cut. */
    limitReached: boolean;
    captureLoss: PublicScanProxyCaptureLoss<typeof PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME> | null;
  };
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
  /**
   * Production callers should use the fixed default. A bounded override keeps
   * socket tests small and permits a lower deployment cap without allowing a
   * caller to disable the resource bound.
   */
  responseByteLimitBytes?: number;
  /** Test/deployment override with the same non-disableable bound as responses. */
  uploadByteLimitBytes?: number;
  /**
   * Bounds proxy transactions, including traffic Playwright routing misses.
   * Plain HTTP requests count individually; an HTTPS CONNECT tunnel counts as
   * one transaction because its encrypted logical requests are not visible to
   * this proxy. Aggregate byte limits still bound every tunnel.
   */
  transactionLimit?: number;
  /** Bounds DNS/connect fan-out and the successful target cache. */
  uniqueTargetLimit?: number;
  resolveHost?: ResolvePublicHost;
  /** Routes an already validated, pinned target in deterministic socket tests. */
  connectUpstreamForTests?: (target: Readonly<PinnedTarget>) => net.Socket;
};

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

export async function startPublicScanProxy(options: StartPublicScanProxyOptions = {}): Promise<PublicScanProxy> {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const blockedTargets: BlockedProxyTarget[] = [];
  const pinnedTargets = new Map<string, Promise<PinnedTarget>>();
  const sockets = new Set<Duplex>();
  const responseByteBudget = new AggregateByteBudget(
    PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME,
    normalizeResponseByteLimit(options.responseByteLimitBytes)
  );
  const uploadByteBudget = new AggregateByteBudget(
    PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME,
    normalizeUploadByteLimit(options.uploadByteLimitBytes)
  );
  const trafficBudget = new ProxyTrafficBudget(
    normalizeTransactionLimit(options.transactionLimit),
    normalizeUniqueTargetLimit(options.uniqueTargetLimit)
  );
  const connectUpstream = options.connectUpstreamForTests ?? defaultConnectUpstream;

  const server = http.createServer((request, response) => {
    handleHttpProxyRequest(request, response, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets,
      trafficBudget,
      responseByteBudget,
      uploadByteBudget,
      connectUpstream
    }).catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });

  server.on("connect", (request, socket, head) => {
    handleHttpsConnect(request, socket, head, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets,
      trafficBudget,
      responseByteBudget,
      uploadByteBudget,
      connectUpstream
    }).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  });

  server.on("upgrade", (request, socket) => {
    handleUpgradeRequest(request, socket, {
      allowNonStandardPorts: options.allowNonStandardPortsForTests === true,
      resolveHost,
      blockedTargets,
      pinnedTargets,
      trafficBudget,
      responseByteBudget,
      uploadByteBudget,
      connectUpstream
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
    getDiagnostics: () => ({
      trafficBudget: trafficBudget.snapshot(),
      responseByteBudget: responseByteBudget.snapshot(),
      uploadByteBudget: uploadByteBudget.snapshot()
    }),
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
  if (!state.trafficBudget.claim(targetUrl)) {
    recordBlockedTarget(state.blockedTargets, targetUrl ? safeTargetLabel(targetUrl) : "unknown", "resource-limit");
    response.destroy();
    return;
  }
  if (!targetUrl || targetUrl.protocol !== "http:") {
    recordBlockedTarget(state.blockedTargets, request.url ?? "unknown", "invalid-target");
    response.destroy();
    return;
  }

  if (!state.responseByteBudget.hasCapacity()) {
    state.responseByteBudget.recordCaptureLoss();
    response.destroy();
    return;
  }

  let target: PinnedTarget;
  try {
    target = await getPinnedTarget(targetUrl, state);
  } catch (error) {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), blockedReasonFromError(error));
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
      headers: proxyRequestHeaders(request.headers, targetUrl.host),
      createConnection: () => state.connectUpstream(target)
    },
    (upstreamResponse) => {
      if (!state.responseByteBudget.hasCapacity()) {
        state.responseByteBudget.recordCaptureLoss();
        upstreamResponse.destroy();
        response.destroy();
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      pipeWithinResponseByteBudget(upstreamResponse, response, state.responseByteBudget);
    }
  );

  let uploadCapped = false;
  upstream.on("error", () => {
    if (!uploadCapped) recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "upstream-failed");
    if (!response.destroyed) response.destroy();
  });

  pipeWithinByteBudget(request, upstream, state.uploadByteBudget, undefined, () => {
    uploadCapped = true;
  });
}

async function handleHttpsConnect(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  state: ProxyState
): Promise<void> {
  const targetUrl = parseConnectUrl(request.url ?? "");
  if (!state.trafficBudget.claim(targetUrl)) {
    recordBlockedTarget(state.blockedTargets, targetUrl ? safeTargetLabel(targetUrl) : request.url ?? "unknown", "resource-limit");
    closeTunnel(clientSocket, 509);
    return;
  }
  if (!targetUrl) {
    recordBlockedTarget(state.blockedTargets, request.url ?? "unknown", "invalid-target");
    closeTunnel(clientSocket, 400);
    return;
  }

  if (!state.responseByteBudget.hasCapacity()) {
    state.responseByteBudget.recordCaptureLoss();
    closeTunnel(clientSocket, 509);
    return;
  }

  let target: PinnedTarget;
  try {
    target = await getPinnedTarget(targetUrl, state);
  } catch (error) {
    recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), blockedReasonFromError(error));
    closeTunnel(clientSocket, 403);
    return;
  }

  const upstream = state.connectUpstream(target);
  let uploadCapped = false;

  upstream.once("connect", () => {
    if (!state.responseByteBudget.hasCapacity()) {
      state.responseByteBudget.recordCaptureLoss();
      upstream.destroy();
      closeTunnel(clientSocket, 509);
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n");
    pipeWithinResponseByteBudget(upstream, clientSocket, state.responseByteBudget);
    // `head` contains tunnel bytes Node read in the same packet as CONNECT.
    // It must be claimed before forwarding just like later socket data.
    pipeWithinByteBudget(clientSocket, upstream, state.uploadByteBudget, head, () => {
      uploadCapped = true;
    });
  });

  upstream.once("error", () => {
    if (!uploadCapped) recordBlockedTarget(state.blockedTargets, safeTargetLabel(targetUrl), "upstream-failed");
    closeTunnel(clientSocket, 502);
  });

  clientSocket.once("error", () => upstream.destroy());
}

function handleUpgradeRequest(request: IncomingMessage, socket: Duplex, state: ProxyState): void {
  // A deliberate policy refusal (plaintext WebSocket proxying is unsupported),
  // not a malformed request and not a private-network block.
  const targetUrl = parseUpgradeProxyUrl(request);
  if (!state.trafficBudget.claim(targetUrl)) {
    recordBlockedTarget(state.blockedTargets, targetUrl ? safeTargetLabel(targetUrl) : request.url ?? "unknown", "resource-limit");
    closeTunnel(socket, 509);
    return;
  }
  recordBlockedTarget(state.blockedTargets, targetUrl ? safeTargetLabel(targetUrl) : request.url ?? "unknown", "upgrade-blocked");
  closeTunnel(socket, 400);
}

type ProxyState = {
  allowNonStandardPorts: boolean;
  resolveHost: ResolvePublicHost;
  blockedTargets: BlockedProxyTarget[];
  pinnedTargets: Map<string, Promise<PinnedTarget>>;
  trafficBudget: ProxyTrafficBudget;
  responseByteBudget: AggregateByteBudget<typeof PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME>;
  uploadByteBudget: AggregateByteBudget<typeof PUBLIC_SCAN_PROXY_UPLOAD_BYTE_BUDGET_NAME>;
  connectUpstream: (target: Readonly<PinnedTarget>) => net.Socket;
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

/**
 * Typed pin failure, so the recorded block reason distinguishes a private/local
 * target (a guard block) from a DNS or policy failure (which proves nothing
 * about the target's network location).
 */
class ProxyTargetBlockedError extends Error {
  constructor(readonly reason: BlockedProxyTarget["reason"]) {
    super(`Proxy target blocked: ${reason}`);
  }
}

function blockedReasonFromError(error: unknown): BlockedProxyTarget["reason"] {
  return error instanceof ProxyTargetBlockedError ? error.reason : "invalid-target";
}

async function resolvePinnedTarget(
  targetUrl: URL,
  hostname: string,
  port: number,
  state: ProxyState
): Promise<PinnedTarget> {
  // The hostname-shape policy (localhost, .local/.internal, private-address
  // literals) applies to every target; the standard-port rule is checked
  // separately so its refusal is never recorded as a private-address block.
  try {
    assertPublicHttpUrlShape(urlWithoutPort(targetUrl.protocol, hostname));
  } catch {
    throw new ProxyTargetBlockedError("non-public-address");
  }
  if (!state.allowNonStandardPorts && targetUrl.port) {
    throw new ProxyTargetBlockedError("blocked-port");
  }

  let addresses: ResolvedHostAddress[];
  if (isIpAddress(hostname)) {
    addresses = [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await state.resolveHost(hostname);
    } catch {
      throw new ProxyTargetBlockedError("resolution-failed");
    }
  }

  if (addresses.length === 0) {
    throw new ProxyTargetBlockedError("resolution-failed");
  }

  if (!addresses.every(({ address }) => isPublicIpAddress(address))) {
    throw new ProxyTargetBlockedError("non-public-address");
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

function closeTunnel(socket: Duplex, status: 400 | 403 | 502 | 509): void {
  if (socket.destroyed) return;
  const message =
    status === 400
      ? "Bad Request"
      : status === 403
        ? "Forbidden"
        : status === 502
          ? "Bad Gateway"
          : "Bandwidth Limit Exceeded";
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

function recordBlockedTarget(
  blockedTargets: BlockedProxyTarget[],
  target: string,
  reason: BlockedProxyTarget["reason"]
): void {
  const entry = { target, reason };
  if (blockedTargets.length < MAX_RECORDED_PROXY_BLOCKS) {
    blockedTargets.push(entry);
    return;
  }
  // Preserve at least one example of every reason even after hostile traffic
  // fills the diagnostics cap; scanner security decisions depend on retaining
  // evidence that a non-public target was blocked.
  if (blockedTargets.some((blocked) => blocked.reason === reason)) return;
  const replaceIndex = blockedTargets.findLastIndex(
    (blocked, index) => blockedTargets.findIndex((candidate) => candidate.reason === blocked.reason) !== index
  );
  if (replaceIndex >= 0) blockedTargets[replaceIndex] = entry;
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

function defaultConnectUpstream(target: Readonly<PinnedTarget>): net.Socket {
  return net.connect({
    host: target.address,
    port: target.port,
    family: target.family
  });
}

type ByteBudgetDiagnostics<Name extends PublicScanProxyByteBudgetName> = {
  name: Name;
  family: "requests";
  limitBytes: number;
  forwardedBytes: number;
  remainingBytes: number;
  limitReached: boolean;
  captureLoss: PublicScanProxyCaptureLoss<Name> | null;
};

class AggregateByteBudget<Name extends PublicScanProxyByteBudgetName> {
  private forwardedBytes = 0;
  private affectedStreams = 0;

  constructor(readonly name: Name, readonly limitBytes: number) {}

  hasCapacity(): boolean {
    return this.forwardedBytes < this.limitBytes;
  }

  claim(requestedBytes: number): { allowedBytes: number; exceeded: boolean } {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
      throw new Error("Proxy byte-budget chunks must have a nonnegative safe-integer byte length.");
    }
    const allowedBytes = Math.min(requestedBytes, this.limitBytes - this.forwardedBytes);
    this.forwardedBytes += allowedBytes;
    return { allowedBytes, exceeded: allowedBytes < requestedBytes };
  }

  recordCaptureLoss(): void {
    this.affectedStreams += 1;
  }

  snapshot(): ByteBudgetDiagnostics<Name> {
    return {
      name: this.name,
      family: "requests",
      limitBytes: this.limitBytes,
      forwardedBytes: this.forwardedBytes,
      remainingBytes: this.limitBytes - this.forwardedBytes,
      limitReached: !this.hasCapacity(),
      captureLoss:
        this.affectedStreams === 0
          ? null
          : {
              family: "requests",
              phaseId: null,
              kind: "cap",
              count: this.affectedStreams,
              detail: this.name
            }
    };
  }
}

/**
 * Independent proxy-layer bound. Page routing is evidence collection, not a
 * resource-control boundary: popup first requests and browser-internal traffic
 * can reach the proxy without a page route. This counter therefore gates every
 * proxy transaction and every new DNS/connect target before upstream work.
 */
class ProxyTrafficBudget {
  private transactionsSeen = 0;
  private refused = 0;
  private readonly uniqueTargets = new Set<string>();

  constructor(
    readonly transactionLimit: number,
    readonly uniqueTargetLimit: number
  ) {}

  claim(target: URL | null): boolean {
    this.transactionsSeen += 1;
    if (this.transactionsSeen > this.transactionLimit) {
      this.refused += 1;
      return false;
    }
    if (target === null) return true;

    const key = proxyTargetKey(target);
    if (this.uniqueTargets.has(key)) return true;
    if (this.uniqueTargets.size >= this.uniqueTargetLimit) {
      this.refused += 1;
      return false;
    }
    this.uniqueTargets.add(key);
    return true;
  }

  snapshot(): PublicScanProxyDiagnostics["trafficBudget"] {
    return {
      name: PUBLIC_SCAN_PROXY_TRAFFIC_BUDGET_NAME,
      family: "requests",
      transactionLimit: this.transactionLimit,
      transactionsSeen: this.transactionsSeen,
      uniqueTargetLimit: this.uniqueTargetLimit,
      uniqueTargetsSeen: this.uniqueTargets.size,
      captureLoss:
        this.refused === 0
          ? null
          : {
              family: "requests",
              phaseId: null,
              kind: "cap",
              count: this.refused,
              detail: PUBLIC_SCAN_PROXY_TRAFFIC_BUDGET_NAME
            }
    };
  }
}

function proxyTargetKey(target: URL): string {
  const hostname = normalizeHostname(target.hostname);
  const port = target.port ? Number(target.port) : defaultPort(target.protocol);
  return `${target.protocol}//${hostname}:${port}`;
}

/**
 * Stream with normal Node backpressure and at most one partial chunk at the
 * boundary. The shared budget is claimed synchronously before each write, so
 * concurrent HTTP responses and CONNECT tunnels cannot oversubscribe it.
 */
function pipeWithinResponseByteBudget(
  source: Readable,
  destination: Writable,
  budget: AggregateByteBudget<typeof PUBLIC_SCAN_PROXY_RESPONSE_BYTE_BUDGET_NAME>
): void {
  pipeWithinByteBudget(source, destination, budget);
}

/**
 * Forward one direction through an aggregate, synchronously claimed budget.
 * An optional initial chunk covers CONNECT bytes parsed alongside its headers.
 * No concurrent stream can oversubscribe because every claim completes before
 * its corresponding write; at the boundary only the allowed prefix is sent.
 */
function pipeWithinByteBudget<Name extends PublicScanProxyByteBudgetName>(
  source: Readable,
  destination: Writable,
  budget: AggregateByteBudget<Name>,
  initialChunk?: Buffer,
  onLimit?: () => void
): void {
  let terminated = false;

  const terminateAtLimit = () => {
    source.destroy();
    destination.destroy();
  };

  const forward = (value: Buffer | string) => {
    if (terminated) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const claim = budget.claim(chunk.byteLength);

    if (claim.exceeded) {
      terminated = true;
      budget.recordCaptureLoss();
      onLimit?.();
      source.pause();
      if (claim.allowedBytes === 0) {
        terminateAtLimit();
        return;
      }
      destination.write(chunk.subarray(0, claim.allowedBytes), terminateAtLimit);
      return;
    }

    if (!destination.write(chunk)) {
      source.pause();
      destination.once("drain", () => {
        if (!terminated && !destination.destroyed) source.resume();
      });
    }
  };

  if (initialChunk && initialChunk.length > 0) forward(initialChunk);
  if (!terminated) source.on("data", forward);

  source.once("end", () => {
    if (!terminated && !destination.destroyed) destination.end();
  });
  source.once("error", () => {
    if (!terminated && !destination.destroyed) destination.destroy();
  });
  destination.once("error", () => {
    if (!terminated && !source.destroyed) source.destroy();
  });
}

function normalizeResponseByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT) {
    throw new Error(
      `Public scan proxy response-byte limit must be a positive integer no greater than ${MAX_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT}.`
    );
  }
  return limit;
}

function normalizeUploadByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT) {
    throw new Error(
      `Public scan proxy upload-byte limit must be a positive integer no greater than ${MAX_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT}.`
    );
  }
  return limit;
}

function normalizeTransactionLimit(value: number | undefined): number {
  return normalizePositiveBoundedLimit(
    value ?? DEFAULT_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT,
    MAX_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT,
    "transaction"
  );
}

function normalizeUniqueTargetLimit(value: number | undefined): number {
  return normalizePositiveBoundedLimit(
    value ?? DEFAULT_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT,
    MAX_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT,
    "unique-target"
  );
}

function normalizePositiveBoundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Public scan proxy ${label} limit must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function trackSocket(socket: Duplex, sockets: Set<Duplex>): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}
