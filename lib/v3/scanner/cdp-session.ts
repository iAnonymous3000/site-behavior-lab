/**
 * Single flattened CDP session collector for Site Behavior Lab v3.
 *
 * Replaces ~6,000 LOC of Playwright-fighting worker-CDP race machinery with
 * one clean flattened CDP target collector that observes:
 *  - Main page, OOPIFs, Dedicated Workers, SharedWorkers, and Service Workers
 *  - O(1) Map-indexed network requests, redirects, allowlisted headers, and
 *    initiator call stacks
 *  - WebSocket connections, frame counts, byte totals, and transient outgoing
 *    frames for active keystroke-exfiltration detection
 *  - Service Worker registrations
 *  - CDP `Storage.getCookies` (exact TTL + CHIPS `partitionKey`)
 *  - CDP `IndexedDB` and `CacheStorage` inventories across all frame origins
 *  - Main/iframe/worker fingerprint telemetry snapshots
 */

import type { BrowserContext, CDPSession, Page } from "playwright";
import { checkAdblockDetailed, mapRequestType, shortFilterListName } from "../../adblock-engine";
import { partyKey } from "../../domain-utils";
import { attributeDomainV3 } from "../entity-catalog";
import {
  buildFingerprintInitScriptV3,
  FINGERPRINT_V3_GLOBAL_KEY,
  type RawFingerprintEventV3,
  type RawFingerprintSnapshotV3
} from "../probes/fingerprint-probe";
import type { BeaconInputV3 } from "../probes/beacons";
import type { KeystrokePayloadCandidateV3 } from "../probes/keystroke-probe";
import type {
  AllowlistedRequestHeadersV3,
  AllowlistedResponseHeadersV3,
  CallStackFrameV3,
  CookieRecordV3,
  FingerprintRealmV3,
  NetworkRequestV3,
  RequestInitiatorV3,
  ScanPhaseName,
  ServiceWorkerRecordV3,
  ShieldsModeV3,
  StorageRecordV3,
  WebSocketRecordV3
} from "../schema";

export const MAX_V3_REQUESTS = 1_500;
export const MAX_V3_WEBSOCKETS = 64;
const MAX_TRANSIENT_BODY_CHARS = 64_000;

type AdblockEngineArg = Parameters<typeof checkAdblockDetailed>[0];

type MutableRequest = {
  id: number;
  cdpRequestId: string;
  phase: ScanPhaseName;
  rawUrl: string;
  domain: string;
  registrableDomain: string;
  method: string;
  resourceType: string;
  status: number | null;
  thirdParty: boolean;
  protocol: string | null;
  encodedBytes: number;
  startedAtMs: number;
  cdpTimestamp: number;
  durationMs: number | null;
  redirectChain: string[];
  responseHeaders: AllowlistedResponseHeadersV3;
  requestHeaders: AllowlistedRequestHeadersV3;
  initiator: RequestInitiatorV3 | null;
  rawPostData: string | null;
  rawContentType: string | null;
  rawContentEncoding: string | null;
  blockedByRoute: boolean;
};

type MutableWebSocket = {
  id: number;
  phase: ScanPhaseName;
  rawUrl: string;
  domain: string;
  registrableDomain: string;
  thirdParty: boolean;
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  startedAtMs: number;
  closedAtMs: number | null;
};

type AttachedWorkerSession = {
  sessionId: string;
  targetType: string;
  realm: FingerprintRealmV3;
};

export type CdpCollectorOptionsV3 = {
  page: Page;
  context: BrowserContext;
  firstPartyHost: string;
  shieldsMode: ShieldsModeV3;
  adblockEngine: AdblockEngineArg;
  startedAtEpochMs: number;
};

export type CollectedStorageAndCookiesV3 = {
  cookies: CookieRecordV3[];
  rawCmpCookies: { name: string; value: string }[];
  storage: StorageRecordV3[];
  fingerprintEvents: RawFingerprintEventV3[];
  droppedFingerprintEvents: number;
};

export class CdpSessionCollectorV3 {
  private readonly page: Page;
  private readonly context: BrowserContext;
  private readonly firstPartyHost: string;
  private readonly firstPartyReg: string;
  private readonly shieldsMode: ShieldsModeV3;
  private readonly adblockEngine: AdblockEngineArg;
  private readonly startedAtEpochMs: number;

  private cdp: CDPSession | null = null;
  private currentPhase: ScanPhaseName = "passive-load";
  private nextRequestSeq = 1;
  private nextWsSeq = 1;
  private omittedRequests = 0;

  private readonly requestsByCdpId = new Map<string, MutableRequest>();
  private readonly orderedRequests: MutableRequest[] = [];
  private readonly blockedUrlSet = new Set<string>();
  private readonly websocketsById = new Map<string, MutableWebSocket>();
  private readonly wsKeystrokeCandidates: KeystrokePayloadCandidateV3[] = [];
  private readonly serviceWorkers = new Map<string, ServiceWorkerRecordV3>();
  private readonly attachedWorkers = new Map<string, AttachedWorkerSession>();
  private readonly workerTelemetry: RawFingerprintEventV3[] = [];

  constructor(options: CdpCollectorOptionsV3) {
    this.page = options.page;
    this.context = options.context;
    this.firstPartyHost = options.firstPartyHost.toLowerCase();
    this.firstPartyReg = partyKey(this.firstPartyHost).toLowerCase();
    this.shieldsMode = options.shieldsMode;
    this.adblockEngine = options.adblockEngine;
    this.startedAtEpochMs = options.startedAtEpochMs;
  }

  setPhase(phase: ScanPhaseName): void {
    this.currentPhase = phase;
  }

  markRouteBlocked(url: string): void {
    this.blockedUrlSet.add(url);
  }

  getOmittedRequestCount(): number {
    return this.omittedRequests;
  }

  async attach(): Promise<boolean> {
    try {
      const cdp = await this.context.newCDPSession(this.page);
      this.cdp = cdp;
      this.bindCdpListeners(cdp);

      await Promise.allSettled([
        cdp.send("Network.enable", { maxPostDataSize: MAX_TRANSIENT_BODY_CHARS }),
        cdp.send("Runtime.enable"),
        cdp.send("ServiceWorker.enable"),
        cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        })
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async detach(): Promise<void> {
    if (!this.cdp) return;
    try {
      await this.cdp.detach();
    } catch {
      // Page/context already closed
    }
    this.cdp = null;
  }

  private bindCdpListeners(cdp: CDPSession): void {
    // 1. Auto-attached child targets (OOPIFs + Dedicated / Shared / Service Workers)
    cdp.on("Target.attachedToTarget", (params) => {
      const type = String(params.targetInfo?.type ?? "");
      const sessionId = String(params.sessionId ?? "");
      if (!sessionId) return;
      if (type === "worker" || type === "shared_worker" || type === "service_worker") {
        const realm: FingerprintRealmV3 =
          type === "shared_worker"
            ? "shared-worker"
            : type === "service_worker"
              ? "service-worker"
              : "dedicated-worker";
        this.attachedWorkers.set(sessionId, { sessionId, targetType: type, realm });
        void this.instrumentAttachedTarget(sessionId, realm);
      } else if (type === "iframe") {
        void this.sendToChild(sessionId, "Network.enable", { maxPostDataSize: MAX_TRANSIENT_BODY_CHARS });
      }
    });

    cdp.on("Target.detachedFromTarget", (params) => {
      const sessionId = String(params.sessionId ?? "");
      if (sessionId) this.attachedWorkers.delete(sessionId);
    });

    // 2. Network events (O(1) Map lookup by requestId)
    cdp.on("Network.requestWillBeSent", (params) => {
      this.onRequestWillBeSent(params as Record<string, unknown>);
    });
    cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
      this.onRequestExtraInfo(params as Record<string, unknown>);
    });
    cdp.on("Network.responseReceived", (params) => {
      this.onResponseReceived(params as Record<string, unknown>);
    });
    cdp.on("Network.responseReceivedExtraInfo", (params) => {
      this.onResponseExtraInfo(params as Record<string, unknown>);
    });
    cdp.on("Network.loadingFinished", (params) => {
      this.onLoadingFinished(params as Record<string, unknown>);
    });
    cdp.on("Network.loadingFailed", (params) => {
      const id = String(params.requestId ?? "");
      const entry = this.requestsByCdpId.get(id);
      if (entry && params.blockedReason) {
        entry.blockedByRoute = true;
      }
    });

    // 3. WebSockets
    cdp.on("Network.webSocketCreated", (params) => {
      this.onWebSocketCreated(params as Record<string, unknown>);
    });
    cdp.on("Network.webSocketFrameSent", (params) => {
      this.onWebSocketFrame(params as Record<string, unknown>, "sent");
    });
    cdp.on("Network.webSocketFrameReceived", (params) => {
      this.onWebSocketFrame(params as Record<string, unknown>, "received");
    });
    cdp.on("Network.webSocketClosed", (params) => {
      const id = String(params.requestId ?? "");
      const ws = this.websocketsById.get(id);
      if (ws) ws.closedAtMs = Math.max(0, Date.now() - this.startedAtEpochMs);
    });

    // 4. Service Workers
    cdp.on("ServiceWorker.workerVersionUpdated", (params) => {
      const versions = Array.isArray(params.versions) ? params.versions : [];
      for (const v of versions) {
        const rec = v as unknown as Record<string, unknown>;
        const scriptUrl = typeof rec.scriptURL === "string" ? rec.scriptURL : "";
        if (!scriptUrl) continue;
        const host = safeHostname(scriptUrl);
        if (!host) continue;
        const scope = typeof rec.registrationId === "string" ? scriptUrl : scriptUrl;
        const existing = this.serviceWorkers.get(scriptUrl);
        this.serviceWorkers.set(scriptUrl, {
          scope: existing?.scope ?? scope,
          scriptUrl,
          domain: host,
          state: typeof rec.status === "string" ? rec.status : "unknown",
          interceptedRequests: existing?.interceptedRequests ?? 0
        });
      }
    });
  }

  private async instrumentAttachedTarget(sessionId: string, realm: FingerprintRealmV3): Promise<void> {
    await this.sendToChild(sessionId, "Network.enable", { maxPostDataSize: MAX_TRANSIENT_BODY_CHARS });
    await this.sendToChild(sessionId, "Runtime.evaluate", {
      expression: buildFingerprintInitScriptV3(realm),
      silent: true
    });
  }

  private async sendToChild(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.cdp) return null;
    try {
      // Playwright CDPSession supports flattened sessionId routing via internal transport or Target.sendMessageToTarget.
      const msg = JSON.stringify({ id: Date.now() % 1_000_000, method, params: params ?? {} });
      return await this.cdp.send("Target.sendMessageToTarget", { sessionId, message: msg });
    } catch {
      return null;
    }
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const req = params.request as Record<string, unknown> | undefined;
    const rawUrl = typeof req?.url === "string" ? req.url : "";
    if (!requestId || !rawUrl || (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://"))) return;

    const existing = this.requestsByCdpId.get(requestId);
    const redirectResponse = params.redirectResponse as Record<string, unknown> | undefined;
    if (existing && redirectResponse) {
      existing.redirectChain.push(existing.rawUrl);
      existing.rawUrl = rawUrl;
      const host = safeHostname(rawUrl);
      if (host) {
        existing.domain = host;
        existing.registrableDomain = partyKey(host).toLowerCase();
        existing.thirdParty = existing.registrableDomain !== this.firstPartyReg;
      }
      return;
    }

    if (this.orderedRequests.length >= MAX_V3_REQUESTS) {
      this.omittedRequests += 1;
      return;
    }

    const host = safeHostname(rawUrl);
    if (!host) return;
    const reg = partyKey(host).toLowerCase();
    const headers = normalizeHeaderMap(req?.headers);
    const rawPostData =
      typeof req?.postData === "string"
        ? req.postData.slice(0, MAX_TRANSIENT_BODY_CHARS)
        : null;

    const record: MutableRequest = {
      id: this.nextRequestSeq++,
      cdpRequestId: requestId,
      phase: this.currentPhase,
      rawUrl,
      domain: host,
      registrableDomain: reg,
      method: typeof req?.method === "string" ? req.method.toUpperCase() : "GET",
      resourceType: normalizeCdpResourceType(typeof params.type === "string" ? params.type : "other"),
      status: null,
      thirdParty: reg !== this.firstPartyReg,
      protocol: null,
      encodedBytes: 0,
      startedAtMs: Math.max(0, Date.now() - this.startedAtEpochMs),
      cdpTimestamp: typeof params.timestamp === "number" ? params.timestamp : 0,
      durationMs: null,
      redirectChain: [],
      responseHeaders: {},
      requestHeaders: extractAllowlistedRequestHeaders(headers),
      initiator: parseInitiator(params.initiator, typeof params.frameId === "string" ? params.frameId : undefined),
      rawPostData,
      rawContentType: headers["content-type"] ?? null,
      rawContentEncoding: headers["content-encoding"] ?? null,
      blockedByRoute: this.blockedUrlSet.has(rawUrl)
    };

    this.requestsByCdpId.set(requestId, record);
    this.orderedRequests.push(record);
  }

  private onRequestExtraInfo(params: Record<string, unknown>): void {
    const entry = this.requestsByCdpId.get(String(params.requestId ?? ""));
    if (!entry) return;
    const headers = normalizeHeaderMap(params.headers);
    entry.requestHeaders = {
      ...entry.requestHeaders,
      ...extractAllowlistedRequestHeaders(headers)
    };
    if (headers["content-type"] && !entry.rawContentType) entry.rawContentType = headers["content-type"];
    if (headers["content-encoding"] && !entry.rawContentEncoding) entry.rawContentEncoding = headers["content-encoding"];
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const entry = this.requestsByCdpId.get(String(params.requestId ?? ""));
    if (!entry) return;
    const resp = params.response as Record<string, unknown> | undefined;
    if (!resp) return;
    if (typeof resp.status === "number") entry.status = resp.status;
    if (typeof resp.protocol === "string") entry.protocol = resp.protocol;
    if (resp.fromServiceWorker === true) {
      for (const sw of this.serviceWorkers.values()) {
        sw.interceptedRequests += 1;
        break;
      }
    }
    const headers = normalizeHeaderMap(resp.headers);
    entry.responseHeaders = {
      ...entry.responseHeaders,
      ...extractAllowlistedResponseHeaders(headers)
    };
  }

  private onResponseExtraInfo(params: Record<string, unknown>): void {
    const entry = this.requestsByCdpId.get(String(params.requestId ?? ""));
    if (!entry) return;
    const headers = normalizeHeaderMap(params.headers);
    const merged = extractAllowlistedResponseHeaders(headers);
    if (typeof headers["set-cookie"] === "string" && headers["set-cookie"].length > 0) {
      const count = headers["set-cookie"].split("\n").filter((l) => l.trim().length > 0).length;
      merged.setCookieCount = Math.max(merged.setCookieCount ?? 0, count);
    }
    entry.responseHeaders = { ...entry.responseHeaders, ...merged };
  }

  private onLoadingFinished(params: Record<string, unknown>): void {
    const entry = this.requestsByCdpId.get(String(params.requestId ?? ""));
    if (!entry) return;
    if (typeof params.encodedDataLength === "number" && Number.isFinite(params.encodedDataLength)) {
      entry.encodedBytes = Math.max(0, Math.round(params.encodedDataLength));
    }
    if (typeof params.timestamp === "number" && entry.cdpTimestamp > 0) {
      entry.durationMs = Math.max(0, Math.round((params.timestamp - entry.cdpTimestamp) * 1000));
    }
  }

  private onWebSocketCreated(params: Record<string, unknown>): void {
    if (this.websocketsById.size >= MAX_V3_WEBSOCKETS) return;
    const id = String(params.requestId ?? "");
    const rawUrl = typeof params.url === "string" ? params.url : "";
    const host = safeHostname(rawUrl);
    if (!id || !host) return;
    const reg = partyKey(host).toLowerCase();
    this.websocketsById.set(id, {
      id: this.nextWsSeq++,
      phase: this.currentPhase,
      rawUrl,
      domain: host,
      registrableDomain: reg,
      thirdParty: reg !== this.firstPartyReg,
      framesSent: 0,
      framesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      startedAtMs: Math.max(0, Date.now() - this.startedAtEpochMs),
      closedAtMs: null
    });
  }

  private onWebSocketFrame(params: Record<string, unknown>, dir: "sent" | "received"): void {
    const id = String(params.requestId ?? "");
    const ws = this.websocketsById.get(id);
    if (!ws) return;
    const resp = params.response as Record<string, unknown> | undefined;
    const payload = typeof resp?.payloadData === "string" ? resp.payloadData : "";
    const bytes = Buffer.byteLength(payload, "utf8");
    if (dir === "sent") {
      ws.framesSent += 1;
      ws.bytesSent += bytes;
      if (payload && this.wsKeystrokeCandidates.length < 200) {
        this.wsKeystrokeCandidates.push({
          domain: ws.domain,
          registrableDomain: ws.registrableDomain,
          thirdParty: ws.thirdParty,
          url: ws.rawUrl,
          body: payload.slice(0, MAX_TRANSIENT_BODY_CHARS),
          isWebSocketFrame: true,
          phase: this.currentPhase
        });
      }
    } else {
      ws.framesReceived += 1;
      ws.bytesReceived += bytes;
    }
  }

  /** Produce finalized NetworkRequestV3[] with Shields BlockerResult + Entity attribution. */
  buildNetworkRequests(sourcePageUrl: string): NetworkRequestV3[] {
    return this.orderedRequests.map((entry) => {
      const adblockType = mapRequestType(entry.resourceType);
      const shieldsResult = checkAdblockDetailed(
        this.adblockEngine,
        entry.rawUrl,
        sourcePageUrl,
        adblockType,
        entry.method
      );
      const blocked =
        entry.blockedByRoute ||
        (this.shieldsMode === "standard" && shieldsResult.shouldBlockStandard) ||
        (this.shieldsMode === "aggressive" && shieldsResult.shouldBlockAggressive);
      const entity = attributeDomainV3(entry.domain, {
        shieldsMatched: shieldsResult.shouldBlockAggressive,
        registrableDomain: entry.registrableDomain
      });

      return {
        id: entry.id,
        phase: entry.phase,
        url: entry.rawUrl,
        domain: entry.domain,
        registrableDomain: entry.registrableDomain,
        method: entry.method,
        resourceType: entry.resourceType,
        status: entry.status,
        thirdParty: entry.thirdParty,
        protocol: entry.protocol,
        encodedBytes: entry.encodedBytes,
        startedAtMs: entry.startedAtMs,
        durationMs: entry.durationMs,
        redirectChain: [...entry.redirectChain],
        responseHeaders: entry.responseHeaders,
        requestHeaders: entry.requestHeaders,
        entity,
        shields: {
          matched: shieldsResult.matched,
          shouldBlockStandard: shieldsResult.shouldBlockStandard,
          shouldBlockAggressive: shieldsResult.shouldBlockAggressive,
          blocked,
          rule: shieldsResult.filter,
          list: shortFilterListName(shieldsResult.filterList),
          exception: shieldsResult.exception,
          redirect: shieldsResult.redirect,
          rewrittenUrl: shieldsResult.rewrittenUrl,
          important: shieldsResult.important
        },
        initiator: entry.initiator
      };
    });
  }

  buildBeaconInputs(): BeaconInputV3[] {
    return this.orderedRequests.map((entry) => ({
      url: entry.rawUrl,
      method: entry.method,
      postData: entry.rawPostData,
      contentType: entry.rawContentType,
      thirdParty: entry.thirdParty,
      phase: entry.phase
    }));
  }

  buildKeystrokeCandidates(): KeystrokePayloadCandidateV3[] {
    const httpCandidates: KeystrokePayloadCandidateV3[] = this.orderedRequests.map((entry) => ({
      domain: entry.domain,
      registrableDomain: entry.registrableDomain,
      thirdParty: entry.thirdParty,
      url: entry.rawUrl,
      body: entry.rawPostData,
      contentEncoding: entry.rawContentEncoding,
      resourceType: entry.resourceType,
      isWebSocketFrame: false,
      phase: entry.phase
    }));
    return [...httpCandidates, ...this.wsKeystrokeCandidates];
  }

  buildWebSockets(): WebSocketRecordV3[] {
    return [...this.websocketsById.values()].map((ws) => ({
      id: ws.id,
      phase: ws.phase,
      url: ws.rawUrl,
      domain: ws.domain,
      registrableDomain: ws.registrableDomain,
      thirdParty: ws.thirdParty,
      framesSent: ws.framesSent,
      framesReceived: ws.framesReceived,
      bytesSent: ws.bytesSent,
      bytesReceived: ws.bytesReceived,
      entity: attributeDomainV3(ws.domain, { registrableDomain: ws.registrableDomain }),
      startedAtMs: ws.startedAtMs,
      closedAtMs: ws.closedAtMs
    }));
  }

  buildServiceWorkers(): ServiceWorkerRecordV3[] {
    return [...this.serviceWorkers.values()].sort((a, b) => a.scriptUrl.localeCompare(b.scriptUrl));
  }

  /**
   * Collect cookies (via CDP `Storage.getCookies` for exact TTL + CHIPS `partitionKey`),
   * multi-origin storage (`localStorage`, `sessionStorage`, `indexedDB`, `cacheStorage`),
   * and main/iframe/worker fingerprint telemetry snapshots.
   */
  async collectStorageCookiesAndTelemetry(): Promise<CollectedStorageAndCookiesV3> {
    const fingerprintEvents: RawFingerprintEventV3[] = [...this.workerTelemetry];
    const jsCookieNames = new Set<string>();
    let droppedFingerprintEvents = 0;
    const storage: StorageRecordV3[] = [];
    const frameOrigins = new Set<string>();

    // 1. Read frame telemetry + localStorage/sessionStorage across main frame + accessible iframes
    for (const frame of this.page.frames()) {
      const frameUrl = frame.url();
      if (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://")) continue;
      let origin: string;
      let host: string;
      try {
        const parsed = new URL(frameUrl);
        origin = parsed.origin;
        host = parsed.hostname.toLowerCase();
        frameOrigins.add(origin);
      } catch {
        continue;
      }
      const reg = partyKey(host).toLowerCase();
      const thirdParty = reg !== this.firstPartyReg;
      const entity = attributeDomainV3(host, { registrableDomain: reg });

      try {
        const snapshot = await frame.evaluate(
          (key: string) => {
            const fp = (globalThis as Record<string, unknown>)[key] as RawFingerprintSnapshotV3 | undefined;
            const local: { key: string; bytes: number }[] = [];
            const session: { key: string; bytes: number }[] = [];
            try {
              for (let i = 0; i < Math.min(window.localStorage.length, 200); i++) {
                const k = window.localStorage.key(i);
                if (k !== null) {
                  const v = window.localStorage.getItem(k) ?? "";
                  local.push({ key: k, bytes: v.length });
                }
              }
            } catch {}
            try {
              for (let i = 0; i < Math.min(window.sessionStorage.length, 200); i++) {
                const k = window.sessionStorage.key(i);
                if (k !== null) {
                  const v = window.sessionStorage.getItem(k) ?? "";
                  session.push({ key: k, bytes: v.length });
                }
              }
            } catch {}
            return {
              fp: fp ?? { events: [], jsCookieNames: [], droppedEvents: 0 },
              local,
              session
            };
          },
          FINGERPRINT_V3_GLOBAL_KEY
        );

        fingerprintEvents.push(...snapshot.fp.events);
        droppedFingerprintEvents += snapshot.fp.droppedEvents;
        for (const name of snapshot.fp.jsCookieNames) jsCookieNames.add(name);
        for (const item of snapshot.local) {
          storage.push({
            origin,
            domain: host,
            thirdParty,
            area: "localStorage",
            keyOrStore: item.key,
            valueBytes: item.bytes,
            phase: this.currentPhase,
            entity
          });
        }
        for (const item of snapshot.session) {
          storage.push({
            origin,
            domain: host,
            thirdParty,
            area: "sessionStorage",
            keyOrStore: item.key,
            valueBytes: item.bytes,
            phase: this.currentPhase,
            entity
          });
        }
      } catch {
        // Cross-origin frame detached or navigation in progress
      }
    }

    // 2. Collect IndexedDB + CacheStorage names via CDP across all observed frame origins
    if (this.cdp) {
      for (const origin of frameOrigins) {
        const host = safeHostname(origin);
        if (!host) continue;
        const reg = partyKey(host).toLowerCase();
        const thirdParty = reg !== this.firstPartyReg;
        const entity = attributeDomainV3(host, { registrableDomain: reg });

        try {
          const idb = (await this.cdp.send("IndexedDB.requestDatabaseNames", { securityOrigin: origin })) as {
            databaseNames?: string[];
          };
          for (const dbName of (idb.databaseNames ?? []).slice(0, 50)) {
            storage.push({
              origin,
              domain: host,
              thirdParty,
              area: "indexedDB",
              keyOrStore: dbName,
              valueBytes: 0,
              phase: this.currentPhase,
              entity
            });
          }
        } catch {
          // IndexedDB query unsupported or origin closed
        }

        try {
          const caches = (await this.cdp.send("CacheStorage.requestCacheNames", { securityOrigin: origin })) as {
            caches?: { cacheName?: string }[];
          };
          for (const cache of (caches.caches ?? []).slice(0, 50)) {
            if (!cache.cacheName) continue;
            storage.push({
              origin,
              domain: host,
              thirdParty,
              area: "cacheStorage",
              keyOrStore: cache.cacheName,
              valueBytes: 0,
              phase: this.currentPhase,
              entity
            });
          }
        } catch {
          // CacheStorage query unsupported
        }
      }
    }

    // 3. Collect cookies with TTL & CHIPS partitionKey via CDP `Storage.getCookies` (fallback to context.cookies)
    const nowSec = Date.now() / 1000;
    const rawCmpCookies: { name: string; value: string }[] = [];
    const cookies: CookieRecordV3[] = [];
    const CMP_COOKIE_NAMES = new Set(["OptanonConsent", "CookieConsent", "didomi_token", "euconsent-v2"]);

    let cdpCookies: Array<Record<string, unknown>> = [];
    if (this.cdp) {
      try {
        const res = (await this.cdp.send("Storage.getCookies")) as unknown as {
          cookies?: Array<Record<string, unknown>>;
        };
        cdpCookies = res.cookies ?? [];
      } catch {
        cdpCookies = [];
      }
    }
    if (cdpCookies.length === 0) {
      try {
        const fallback = await this.context.cookies();
        cdpCookies = fallback.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          session: c.expires <= 0
        }));
      } catch {
        cdpCookies = [];
      }
    }

    for (const raw of cdpCookies.slice(0, 500)) {
      const name = String(raw.name ?? "");
      const domain = String(raw.domain ?? "").replace(/^\./, "").toLowerCase();
      if (!name || !domain) continue;
      if (CMP_COOKIE_NAMES.has(name) && typeof raw.value === "string") {
        rawCmpCookies.push({ name, value: raw.value });
      }
      const reg = partyKey(domain).toLowerCase();
      const thirdParty = reg !== this.firstPartyReg;
      const expires = typeof raw.expires === "number" ? raw.expires : -1;
      const isSession = raw.session === true || expires <= 0;
      const ttlDays = isSession ? null : Math.max(0, Math.round(((expires - nowSec) / 86_400) * 10) / 10);
      const rawPartition = raw.partitionKey;
      const partitionKey =
        typeof rawPartition === "string"
          ? rawPartition
          : rawPartition && typeof rawPartition === "object" && typeof (rawPartition as Record<string, unknown>).topLevelSite === "string"
            ? String((rawPartition as Record<string, unknown>).topLevelSite)
            : null;
      const httpOnly = Boolean(raw.httpOnly);
      const setVia: CookieRecordV3["setVia"] = httpOnly
        ? "http"
        : jsCookieNames.has(name)
          ? "js"
          : "unknown";

      cookies.push({
        name,
        domain,
        registrableDomain: reg,
        path: typeof raw.path === "string" ? raw.path : "/",
        sameSite: typeof raw.sameSite === "string" ? raw.sameSite : "None",
        secure: Boolean(raw.secure),
        httpOnly,
        session: isSession,
        thirdParty,
        ttlDays,
        partitionKey,
        setVia,
        phase: this.currentPhase,
        entity: attributeDomainV3(domain, { registrableDomain: reg })
      });
    }

    return {
      cookies,
      rawCmpCookies,
      storage,
      fingerprintEvents,
      droppedFingerprintEvents
    };
  }
}

// --- Pure helper utilities --------------------------------------------------

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeHeaderMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

function extractAllowlistedRequestHeaders(headers: Record<string, string>): AllowlistedRequestHeadersV3 {
  const out: AllowlistedRequestHeadersV3 = {};
  if (headers["sec-gpc"]) out.secGpc = headers["sec-gpc"].slice(0, 16);
  if (headers["dnt"]) out.dnt = headers["dnt"].slice(0, 16);
  if (headers["origin"]) out.origin = headers["origin"].slice(0, 256);
  if (headers["referer"]) {
    try {
      out.refererOrigin = new URL(headers["referer"]).origin;
    } catch {}
  }
  if (headers["sec-fetch-site"]) out.secFetchSite = headers["sec-fetch-site"].slice(0, 32);
  if (headers["sec-fetch-mode"]) out.secFetchMode = headers["sec-fetch-mode"].slice(0, 32);
  return out;
}

function extractAllowlistedResponseHeaders(headers: Record<string, string>): AllowlistedResponseHeadersV3 {
  const out: AllowlistedResponseHeadersV3 = {};
  if (headers["cache-control"]) out.cacheControl = headers["cache-control"].slice(0, 128);
  if (headers["etag"]) out.etagPresent = true;
  if (headers["access-control-allow-origin"]) {
    out.accessControlAllowOrigin = headers["access-control-allow-origin"].slice(0, 128);
  }
  if (headers["access-control-allow-credentials"]?.toLowerCase() === "true") {
    out.accessControlAllowCredentials = true;
  }
  if (headers["content-security-policy"]) out.contentSecurityPolicyPresent = true;
  if (headers["permissions-policy"] || headers["feature-policy"]) out.permissionsPolicyPresent = true;
  if (headers["strict-transport-security"]) out.strictTransportSecurityPresent = true;
  if (headers["referrer-policy"]) out.referrerPolicy = headers["referrer-policy"].slice(0, 64);
  if (headers["clear-site-data"]) out.clearSiteData = headers["clear-site-data"].slice(0, 128);
  return out;
}

function normalizeCdpResourceType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "xhr") return "xhr";
  if (lower === "fetch") return "fetch";
  if (lower === "document") return "document";
  if (lower === "stylesheet") return "stylesheet";
  if (lower === "image") return "image";
  if (lower === "media") return "media";
  if (lower === "font") return "font";
  if (lower === "script") return "script";
  if (lower === "ping") return "ping";
  if (lower === "websocket") return "websocket";
  if (lower === "eventsource") return "eventsource";
  if (lower === "manifest") return "manifest";
  return "other";
}

function parseInitiator(raw: unknown, frameId?: string): RequestInitiatorV3 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rawType = typeof rec.type === "string" ? rec.type.toLowerCase() : "other";
  const type: RequestInitiatorV3["type"] =
    rawType === "parser" || rawType === "script" || rawType === "preload" || rawType === "preflight"
      ? rawType
      : "other";

  const frames: CallStackFrameV3[] = [];
  let stack = rec.stack as Record<string, unknown> | undefined;
  let depth = 0;
  while (stack && depth < 4 && frames.length < 10) {
    const callFrames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
    for (const f of callFrames) {
      if (frames.length >= 10) break;
      const frame = f as Record<string, unknown>;
      const url = typeof frame.url === "string" ? frame.url : "";
      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) continue;
      const domain = safeHostname(url);
      if (!domain) continue;
      frames.push({
        url,
        domain,
        ...(typeof frame.lineNumber === "number" ? { line: frame.lineNumber + 1 } : {}),
        ...(typeof frame.columnNumber === "number" ? { column: frame.columnNumber + 1 } : {}),
        ...(typeof frame.functionName === "string" && frame.functionName ? { functionName: frame.functionName.slice(0, 64) } : {})
      });
    }
    stack = stack.parent as Record<string, unknown> | undefined;
    depth += 1;
  }

  const directUrl = typeof rec.url === "string" && rec.url.startsWith("http") ? rec.url : frames[0]?.url;
  const directDomain = directUrl ? safeHostname(directUrl) : frames[0]?.domain;

  return {
    type,
    ...(directUrl ? { scriptUrl: directUrl } : {}),
    ...(directDomain ? { scriptDomain: directDomain } : {}),
    ...(frames.length > 0 ? { callStack: frames } : {}),
    ...(frameId ? { frameId } : {})
  };
}
