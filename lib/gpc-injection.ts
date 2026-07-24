export const GPC_WORKER_CAPTURE_LOSS_WARNING =
  "The scan blocked or could not verify one or more Web Workers while applying the simulated GPC signal; request evidence may be incomplete.";

const DEFAULT_REGISTRATION_WAIT_MS = 100;
const MAX_REGISTERED_WORKER_URL_LENGTH = 16_384;
export const GPC_WORKER_ROUTE_FETCH_TIMEOUT_MS = 30_000;
// Playwright buffers Route.fetch responses before APIResponse.body() exposes
// them and offers no streaming or AbortSignal API here. This limit bounds the
// subsequent userland transfer-to-string and static-parser work; the scanner's
// enclosing process/container memory limit remains the transport-memory guard.
export const GPC_WORKER_SCRIPT_MAX_BYTES = 8 * 1024 * 1024;

type WorkerConstructor = new (...args: unknown[]) => object;

export type GpcWorkerInitScriptArgs = {
  bindingName: string;
  capability: string;
};

type GpcRouteResponse = {
  body(): Promise<Uint8Array>;
  headers(): Record<string, string>;
  status(): number;
};

type GpcRouteRequest = {
  frame(): object;
  headerValue(name: string): Promise<string | null>;
  resourceType(): string;
  url(): string;
};

type GpcRouteFetch<ResponseT extends GpcRouteResponse> = {
  fetch(options: { maxRedirects: number; timeout: number }): Promise<ResponseT>;
  request(): GpcRouteRequest;
};

type GpcWorkerType = "classic" | "module";

type GpcWorkerRegistration = {
  capability: string;
  kind: "dedicated" | "shared";
  outcome: "network" | "unsupported";
  protocol: string;
  type: GpcWorkerType;
  url?: string;
};

type RegistrationRole = "entry" | "module-dependency";

type RegistrationTicket = {
  expectedReferrers: Set<string>;
  registrationId: number;
  role: RegistrationRole;
  type: GpcWorkerType;
  url: string;
};

type RegistrationTicketInput = Omit<RegistrationTicket, "registrationId">;

type FrameRegistrationState = {
  moduleUrls: Set<string>;
  tickets: Map<string, RegistrationTicket[]>;
  waiters: Map<string, Set<() => void>>;
};

export type GpcWorkerRouteFulfillment<ResponseT extends GpcRouteResponse> = {
  body?: string;
  headers?: Record<string, string>;
  response?: ResponseT;
};

export type GpcWorkerInjectionDiagnostics = {
  ambiguousWorkerRequestCount: number;
  captureLossCount: number;
  pendingWorkerRegistrationCount: number;
  transformFailureCount: number;
  unsupportedWorkerCount: number;
};

export type GpcWorkerInjectionCheckpoint = {
  diagnostics: GpcWorkerInjectionDiagnostics;
  /** Target-free identities used only to attribute pending tickets across phases. */
  pendingWorkerRegistrationIds: readonly number[];
};

export class GpcWorkerInjectionError extends Error {
  constructor(
    readonly reason: "ambiguous-worker-request" | "unsupported-worker" | "worker-transform-failed"
  ) {
    super(GPC_WORKER_CAPTURE_LOSS_WARNING);
    this.name = "GpcWorkerInjectionError";
  }
}

/** Small realm-local initializer used in documents and injected worker source. */
export function installGlobalPrivacyControl(): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl");
  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: false,
      enumerable: true,
      get: () => true
    });
  }
}

/**
 * Document initializer that exposes GPC and records native Worker construction
 * without changing the constructor URL. A per-context capability authenticates
 * the page-to-host binding; knowing the randomized binding name is insufficient
 * to authorize a route response rewrite.
 *
 * Local-scheme workers cannot be instrumented before their first statement by
 * Playwright routing. They are rejected explicitly instead of being rewrapped
 * as blob workers, which would change their URL, origin, CSP, and module base.
 */
export function installGlobalPrivacyControlWithWorkerRegistration(args: GpcWorkerInitScriptArgs): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl");
  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: false,
      enumerable: true,
      get: () => true
    });
  }

  const constructorMarker = Symbol.for("site-behavior-lab.gpc-worker-registration");
  const NativeURL = URL;
  const NativeProxy = Proxy;
  const nativeConstruct = Reflect.construct;
  const nativeDefineProperty = Object.defineProperty;
  const register = Reflect.get(globalThis, args.bindingName) as ((payload: GpcWorkerRegistration) => unknown) | undefined;
  const registeredSharedWorkers = new Set<string>();

  const notify = (payload: GpcWorkerRegistration) => {
    if (typeof register !== "function") return;
    try {
      const pending = register(payload);
      if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
        (pending as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // A missing host callback is handled fail-closed by the route classifier.
    }
  };

  const wrapConstructor = (name: "Worker" | "SharedWorker") => {
    const NativeConstructor = Reflect.get(globalThis, name) as WorkerConstructor | undefined;
    if (!NativeConstructor || Reflect.get(NativeConstructor, constructorMarker) === true) return;

    const WrappedConstructor = new NativeProxy(NativeConstructor, {
      construct(target, constructorArgs, newTarget) {
        const scriptURL = constructorArgs[0];
        const options = constructorArgs[1];
        // Never read page-controlled dictionary members here. WebIDL performs
        // that conversion inside the native constructor, and a getter can
        // return different values across reads. Conservatively treating every
        // dictionary as module-capable ensures static dependencies are also
        // instrumented without changing the native constructor's one read.
        const hasOptionsDictionary = options !== null &&
          (typeof options === "object" || typeof options === "function");
        const type: GpcWorkerType = hasOptionsDictionary ? "module" : "classic";
        const baseURL = typeof document === "object" && document ? document.baseURI : globalThis.location.href;
        let resolved: URL;

        try {
          resolved = new NativeURL(String(scriptURL), baseURL);
        } catch {
          notify({
            capability: args.capability,
            kind: name === "Worker" ? "dedicated" : "shared",
            outcome: "unsupported",
            protocol: "invalid",
            type
          });
          throw new TypeError("The Web Worker URL could not be verified for GPC injection.");
        }

        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
          notify({
            capability: args.capability,
            kind: name === "Worker" ? "dedicated" : "shared",
            outcome: "unsupported",
            protocol: resolved.protocol,
            type
          });
          throw new DOMException(
            "This scan blocked a local-scheme Web Worker because GPC could not be injected without changing its URL or origin.",
            "NotSupportedError"
          );
        }

        // Invoke the native constructor with the caller's exact arguments. This
        // preserves TrustedScriptURL handling, document.baseURI resolution,
        // Worker options, subclassing/newTarget, and worker-visible location.
        const worker = nativeConstruct(target, constructorArgs, newTarget);
        resolved.hash = "";

        // Primitive SharedWorker names have a stable, side-effect-free
        // identity. Dictionary identities would require reading page getters,
        // so leave those registrations distinct and report any unused ticket
        // through the session's pending-registration capture-loss diagnostic.
        const sharedIdentity = name === "SharedWorker" && !hasOptionsDictionary
          ? JSON.stringify([
              resolved.href,
              typeof options === "string" ? options : ""
            ])
          : null;
        if (sharedIdentity && registeredSharedWorkers.has(sharedIdentity)) return worker;
        if (sharedIdentity) registeredSharedWorkers.add(sharedIdentity);

        notify({
          capability: args.capability,
          kind: name === "Worker" ? "dedicated" : "shared",
          outcome: "network",
          protocol: resolved.protocol,
          type,
          url: resolved.href
        });
        return worker;
      }
    });
    nativeDefineProperty(WrappedConstructor, constructorMarker, { value: true });
    nativeDefineProperty(globalThis, name, {
      configurable: true,
      value: WrappedConstructor,
      writable: true
    });
  };

  wrapConstructor("Worker");
  wrapConstructor("SharedWorker");
}

export class GpcWorkerInjectionSession {
  readonly bindingName: string;
  readonly initScriptArgs: GpcWorkerInitScriptArgs;

  private readonly frameStates = new WeakMap<object, FrameRegistrationState>();
  private readonly pendingWorkerRegistrationIds = new Set<number>();
  private readonly registrationWaitMs: number;
  private nextWorkerRegistrationId = 1;
  private ambiguousWorkerRequestCount = 0;
  private pendingWorkerRegistrationCount = 0;
  private transformFailureCount = 0;
  private unsupportedWorkerCount = 0;

  constructor(options: { registrationWaitMs?: number; randomBytes?: Uint8Array } = {}) {
    const randomBytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(24));
    if (randomBytes.length < 16) throw new Error("GPC worker injection requires at least 128 bits of capability entropy.");
    const capability = bytesToHex(randomBytes);
    this.bindingName = `__siteBehaviorLabGpcWorker_${capability.slice(0, 16)}`;
    this.initScriptArgs = Object.freeze({ bindingName: this.bindingName, capability });
    this.registrationWaitMs = normalizeRegistrationWait(options.registrationWaitMs);
  }

  /** Callback target for BrowserContext.exposeBinding. Invalid page calls are ignored. */
  register(bindingSource: { frame?: object }, value: unknown): void {
    const frame = bindingSource.frame;
    if (!frame || !isWorkerRegistration(value) || value.capability !== this.initScriptArgs.capability) return;

    if (value.outcome === "unsupported") {
      if (value.protocol === "http:" || value.protocol === "https:") return;
      this.unsupportedWorkerCount += 1;
      return;
    }

    if (value.protocol !== "http:" && value.protocol !== "https:") return;
    const url = networkUrl(value.url);
    if (!url) return;
    this.addTicket(frame, {
      expectedReferrers: new Set(),
      role: "entry",
      type: value.type,
      url
    });
  }

  /**
   * Build a fulfillment only for an authenticated Worker entry or a statically
   * linked module dependency discovered from an already authenticated module.
   * Callers must run their ordinary URL/SSRF guard before invoking this method.
   */
  async buildRouteFulfillment<ResponseT extends GpcRouteResponse>(
    route: GpcRouteFetch<ResponseT>
  ): Promise<GpcWorkerRouteFulfillment<ResponseT> | null> {
    const request = route.request();
    let frame: object;
    const url = networkUrl(request.url());
    if (!url) return null;
    let userAgent: string | null;
    let referrer: string | null;
    try {
      frame = request.frame();
    } catch {
      if (request.resourceType() === "script") {
        this.ambiguousWorkerRequestCount += 1;
        throw new GpcWorkerInjectionError("ambiguous-worker-request");
      }
      return null;
    }
    if (request.resourceType() !== "script") {
      if (this.hasPendingTicket(frame, url)) {
        this.ambiguousWorkerRequestCount += 1;
        throw new GpcWorkerInjectionError("ambiguous-worker-request");
      }
      return null;
    }
    try {
      [userAgent, referrer] = await Promise.all([
        request.headerValue("user-agent"),
        request.headerValue("referer")
      ]);
    } catch {
      this.ambiguousWorkerRequestCount += 1;
      throw new GpcWorkerInjectionError("ambiguous-worker-request");
    }

    let ticket = this.consumeMatchingTicket(frame, url, userAgent, referrer);

    // Chromium exposes Worker and SharedWorker entry requests as script
    // resources without a user-agent header at the Playwright route boundary.
    // A capability registration must arrive as well; the signature alone never
    // authorizes rewriting and therefore cannot be forged by ordinary page JS.
    if (!ticket && userAgent === null) {
      await this.waitForTicket(frame, url);
      ticket = this.consumeMatchingTicket(frame, url, userAgent, referrer);
      if (!ticket) {
        this.ambiguousWorkerRequestCount += 1;
        throw new GpcWorkerInjectionError("ambiguous-worker-request");
      }
    }

    if (!ticket) {
      if (this.hasPendingTicket(frame, url)) {
        // An authenticated constructor/module registration exists, but the
        // browser's request metadata no longer matches the pinned classifier.
        // Block instead of allowing a version drift to execute uninstrumented.
        this.ambiguousWorkerRequestCount += 1;
        throw new GpcWorkerInjectionError("ambiguous-worker-request");
      }
      const normalizedReferrer = referrer ? networkUrl(referrer) : null;
      if (normalizedReferrer && this.stateFor(frame).moduleUrls.has(normalizedReferrer)) {
        // A module request from an authenticated graph that the static parser did
        // not authorize is unsafe to execute: silently continuing would allow its
        // first statement to observe a false-negative GPC signal.
        this.ambiguousWorkerRequestCount += 1;
        throw new GpcWorkerInjectionError("ambiguous-worker-request");
      }
      return null;
    }

    let response: ResponseT;
    try {
      // Route.fetch has no AbortSignal option. Its finite timeout is therefore
      // the operation-level backstop inside each producer's enclosing 45-second
      // scan deadline (90 seconds for a two-phase comparison).
      response = await route.fetch({
        maxRedirects: 0,
        timeout: GPC_WORKER_ROUTE_FETCH_TIMEOUT_MS
      });
    } catch {
      this.transformFailureCount += 1;
      throw new GpcWorkerInjectionError("worker-transform-failed");
    }
    const status = response.status();
    if (status >= 300 && status < 400) {
      // Playwright does not make Chromium issue a follow-up Worker request when
      // an intercepted 30x is fulfilled. Following here would skip the caller's
      // per-hop URL guard and fulfilling the final body at the entry URL would
      // change WorkerGlobalScope.location. Reject the Worker explicitly instead.
      this.unsupportedWorkerCount += 1;
      throw new GpcWorkerInjectionError("unsupported-worker");
    }

    if (status < 200 || status >= 300) return { response };
    const declaredLength = declaredWorkerScriptLength(response.headers());
    if (declaredLength !== null && declaredLength > GPC_WORKER_SCRIPT_MAX_BYTES) {
      // Oversized source cannot be safely decoded or parsed. Preserve the
      // measured site's exact response and disclose the lost GPC coverage.
      this.transformFailureCount += 1;
      return { response };
    }

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await response.body();
    } catch {
      this.transformFailureCount += 1;
      throw new GpcWorkerInjectionError("worker-transform-failed");
    }
    if (bodyBytes.byteLength > GPC_WORKER_SCRIPT_MAX_BYTES) {
      // Content-Length is only an early rejection hint: it may be absent,
      // compressed, or dishonest. Enforce the cap again on Playwright's
      // already-buffered bytes before decoding or invoking the static parser.
      this.transformFailureCount += 1;
      return { response };
    }
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bodyBytes);

    if (ticket.type === "module") {
      const dependencies = staticModuleSpecifiers(body);
      if (!dependencies) {
        // The dependency scanner is a heuristic over page-controlled source and
        // cannot be proven complete against every real bundle, so an unparsed
        // module fails open: the fetched bytes are served unchanged and the
        // Worker runs without the signal. Aborting would alter the site under
        // measurement, which is worse than a coverage gap; the gap itself is
        // still counted and disclosed as Worker capture loss.
        this.transformFailureCount += 1;
        return { response };
      }
      const state = this.stateFor(frame);
      state.moduleUrls.add(url);
      for (const specifier of dependencies) {
        if (!isResolvableModuleSpecifier(specifier)) {
          this.transformFailureCount += 1;
          throw new GpcWorkerInjectionError("worker-transform-failed");
        }
        const dependency = resolvedNetworkDependency(specifier, url);
        if (!dependency) {
          this.unsupportedWorkerCount += 1;
          throw new GpcWorkerInjectionError("unsupported-worker");
        }
        this.addTicket(frame, {
          expectedReferrers: new Set([url]),
          role: "module-dependency",
          type: "module",
          url: dependency
        });
      }
    }

    return {
      response,
      body: injectGlobalPrivacyControlIntoWorkerSource(body),
      headers: rewrittenWorkerResponseHeaders(response.headers())
    };
  }

  diagnostics(): GpcWorkerInjectionDiagnostics {
    return {
      ambiguousWorkerRequestCount: this.ambiguousWorkerRequestCount,
      captureLossCount:
        this.ambiguousWorkerRequestCount +
        this.pendingWorkerRegistrationCount +
        this.transformFailureCount +
        this.unsupportedWorkerCount,
      pendingWorkerRegistrationCount: this.pendingWorkerRegistrationCount,
      transformFailureCount: this.transformFailureCount,
      unsupportedWorkerCount: this.unsupportedWorkerCount
    };
  }

  checkpoint(): GpcWorkerInjectionCheckpoint {
    return {
      diagnostics: this.diagnostics(),
      pendingWorkerRegistrationIds: [...this.pendingWorkerRegistrationIds].sort((left, right) => left - right)
    };
  }

  private addTicket(frame: object, ticket: RegistrationTicketInput): void {
    const state = this.stateFor(frame);
    const tickets = state.tickets.get(ticket.url) ?? [];
    if (ticket.role === "module-dependency") {
      const existing = tickets.find(
        (candidate) => candidate.role === ticket.role && candidate.type === ticket.type
      );
      if (existing) {
        for (const referrer of ticket.expectedReferrers) existing.expectedReferrers.add(referrer);
        return;
      }
    }
    const registrationTicket: RegistrationTicket = {
      ...ticket,
      registrationId: this.nextWorkerRegistrationId
    };
    this.nextWorkerRegistrationId += 1;
    tickets.push(registrationTicket);
    state.tickets.set(ticket.url, tickets);
    this.pendingWorkerRegistrationCount += 1;
    this.pendingWorkerRegistrationIds.add(registrationTicket.registrationId);
    const waiters = state.waiters.get(ticket.url);
    if (waiters) {
      state.waiters.delete(ticket.url);
      for (const resolve of waiters) resolve();
    }
  }

  private consumeMatchingTicket(
    frame: object,
    url: string,
    userAgent: string | null,
    referrer: string | null
  ): RegistrationTicket | null {
    const state = this.stateFor(frame);
    const tickets = state.tickets.get(url);
    if (!tickets?.length) return null;
    const normalizedReferrer = referrer ? networkUrl(referrer) : null;
    const index = tickets.findIndex((ticket) =>
      ticket.role === "entry"
        ? userAgent === null
        : userAgent !== null && normalizedReferrer !== null && ticket.expectedReferrers.has(normalizedReferrer)
    );
    if (index < 0) return null;
    const [ticket] = tickets.splice(index, 1);
    if (!tickets.length) state.tickets.delete(url);
    this.pendingWorkerRegistrationCount -= 1;
    this.pendingWorkerRegistrationIds.delete(ticket.registrationId);
    return ticket;
  }

  private stateFor(frame: object): FrameRegistrationState {
    let state = this.frameStates.get(frame);
    if (!state) {
      state = { moduleUrls: new Set(), tickets: new Map(), waiters: new Map() };
      this.frameStates.set(frame, state);
    }
    return state;
  }

  private hasPendingTicket(frame: object, url: string): boolean {
    return Boolean(this.stateFor(frame).tickets.get(url)?.length);
  }

  private async waitForTicket(frame: object, url: string): Promise<void> {
    const state = this.stateFor(frame);
    if (state.tickets.has(url)) return;
    await new Promise<void>((resolve) => {
      const waiters = state.waiters.get(url) ?? new Set<() => void>();
      waiters.add(resolve);
      state.waiters.set(url, waiters);
      setTimeout(() => {
        waiters.delete(resolve);
        if (!waiters.size) state.waiters.delete(url);
        resolve();
      }, this.registrationWaitMs);
    });
  }
}

function declaredWorkerScriptLength(headers: Record<string, string>): number | null {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length")?.[1]?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createGpcWorkerInjectionSession(
  options: { registrationWaitMs?: number; randomBytes?: Uint8Array } = {}
): GpcWorkerInjectionSession {
  return new GpcWorkerInjectionSession(options);
}

/** Preserve BOM/hashbang and every directive before inserting executable code. */
export function injectGlobalPrivacyControlIntoWorkerSource(source: string): string {
  const insertionPoint = workerSourceInsertionPoint(source);
  const initializer = `;(${installGlobalPrivacyControl.toString()})();\n`;
  const separator = insertionPoint > 0 && source[insertionPoint - 1] !== "\n" ? "\n" : "";
  return `${source.slice(0, insertionPoint)}${separator}${initializer}${source.slice(insertionPoint)}`;
}

function isWorkerRegistration(value: unknown): value is GpcWorkerRegistration {
  if (!isRecord(value)) return false;
  if (
    typeof value.capability !== "string" ||
    (value.kind !== "dedicated" && value.kind !== "shared") ||
    (value.outcome !== "network" && value.outcome !== "unsupported") ||
    typeof value.protocol !== "string" ||
    (value.type !== "classic" && value.type !== "module")
  ) {
    return false;
  }
  return value.outcome === "unsupported" ||
    (typeof value.url === "string" && value.url.length <= MAX_REGISTERED_WORKER_URL_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function networkUrl(value: string | undefined): string | null {
  if (!value || value.length > MAX_REGISTERED_WORKER_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeRegistrationWait(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REGISTRATION_WAIT_MS;
  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new Error("GPC worker registration wait must be an integer from 0 to 1000 milliseconds.");
  }
  return value;
}

function isResolvableModuleSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
}

/**
 * A specifier is page-controlled text, so a scheme-shaped one can still be an
 * invalid URL. Resolution failure has to stay inside the accounted block path:
 * a raw throw would escape route handling and leave the request with no
 * terminal action and no capture-loss record.
 */
function resolvedNetworkDependency(specifier: string, base: string): string | null {
  try {
    return networkUrl(new URL(specifier, base).href);
  } catch {
    return null;
  }
}

function rewrittenWorkerResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const representationHeaders = new Set([
    "content-digest",
    "content-encoding",
    "content-length",
    "content-md5",
    "content-range",
    "digest",
    "etag",
    "repr-digest",
    "transfer-encoding"
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !representationHeaders.has(name.toLowerCase()))
  );
}

function workerSourceInsertionPoint(source: string): number {
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith("#!", cursor)) {
    const newline = source.indexOf("\n", cursor + 2);
    cursor = newline < 0 ? source.length : newline + 1;
  }

  cursor = skipTrivia(source, cursor).index;
  while (cursor < source.length && (source[cursor] === '"' || source[cursor] === "'")) {
    const literalEnd = readStringLiteral(source, cursor);
    if (!literalEnd) break;
    const trivia = skipTrivia(source, literalEnd.end);
    if (source[trivia.index] === ";") {
      cursor = skipTrivia(source, trivia.index + 1).index;
      continue;
    }
    if (
      trivia.index === source.length ||
      (trivia.sawLineBreak && !canContinueStringLiteralExpression(source, trivia.index))
    ) {
      cursor = trivia.index;
      continue;
    }
    break;
  }
  return cursor;
}

function canContinueStringLiteralExpression(source: string, start: number): boolean {
  const character = source[start];
  if (!character) return false;
  if (["(", "[", "`", ".", "+", "-", "*", "/", "%", "<", ">", "=", "&", "|", "^", "?", ","].includes(character)) {
    return true;
  }
  if (character === "!" && source[start + 1] === "=") return true;
  if (isIdentifierStart(character)) {
    let end = start + 1;
    while (end < source.length && isIdentifierPart(source[end])) end += 1;
    const identifier = source.slice(start, end);
    return identifier === "in" || identifier === "instanceof";
  }
  return false;
}

function skipTrivia(source: string, start: number): { index: number; sawLineBreak: boolean } {
  let index = start;
  let sawLineBreak = false;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      if (character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029") {
        sawLineBreak = true;
      }
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) return { index: source.length, sawLineBreak: true };
      sawLineBreak = true;
      index = newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return { index: source.length, sawLineBreak };
      const comment = source.slice(index, end + 2);
      if (/\r|\n|\u2028|\u2029/.test(comment)) sawLineBreak = true;
      index = end + 2;
      continue;
    }
    break;
  }
  return { index, sawLineBreak };
}

type StringLiteral = { end: number; value: string };

function readStringLiteral(source: string, start: number): StringLiteral | null {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { end: index + 1, value };
    if (character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029") return null;
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }

    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    if (escaped === "\n") {
      index += 1;
      continue;
    }
    if (escaped === "\r") {
      index += source[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    const simple: Record<string, string> = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v"
    };
    if (escaped in simple) {
      if (escaped === "0" && /\d/.test(source[index + 1] ?? "")) return null;
      value += simple[escaped];
      index += 1;
      continue;
    }
    if (escaped === "x") {
      const digits = source.slice(index + 1, index + 3);
      if (!/^[\da-fA-F]{2}$/.test(digits)) return null;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 3;
      continue;
    }
    if (escaped === "u") {
      if (source[index + 1] === "{") {
        const close = source.indexOf("}", index + 2);
        if (close < 0) return null;
        const digits = source.slice(index + 2, close);
        if (!/^[\da-fA-F]{1,6}$/.test(digits)) return null;
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) return null;
        value += String.fromCodePoint(codePoint);
        index = close + 1;
        continue;
      }
      const digits = source.slice(index + 1, index + 5);
      if (!/^[\da-fA-F]{4}$/.test(digits)) return null;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 5;
      continue;
    }
    if (/[1-9]/.test(escaped)) return null;
    value += escaped;
    index += 1;
  }
  return null;
}

type ModuleToken = {
  braceDepth: number;
  bracketDepth: number;
  kind: "identifier" | "punctuator" | "string";
  parenDepth: number;
  value: string;
};

function staticModuleSpecifiers(source: string): string[] | null {
  const tokens = tokenizeModule(source);
  if (!tokens) return null;
  const dependencies = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!atModuleTopLevel(token) || token.kind !== "identifier") continue;
    const previous = tokens[index - 1];
    if (previous?.kind === "punctuator" && (previous.value === "." || previous.value === "?.")) continue;

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (!next) return null;
      if (next.kind === "punctuator" && (next.value === "(" || next.value === ".")) continue;
      if (next.kind === "string" && atModuleTopLevel(next)) {
        dependencies.add(next.value);
        if (hasImportAttributes(tokens, index + 2)) return null;
        continue;
      }
      const from = findTopLevelToken(tokens, index + 1, "from");
      if (from < 0 || tokens[from + 1]?.kind !== "string") return null;
      dependencies.add(tokens[from + 1].value);
      if (hasImportAttributes(tokens, from + 2)) return null;
      continue;
    }

    if (token.value === "export") {
      const next = tokens[index + 1];
      if (!next || next.kind !== "punctuator" || (next.value !== "*" && next.value !== "{")) continue;
      const from = findTopLevelToken(tokens, index + 1, "from");
      if (from < 0) {
        if (next.value === "*") return null;
        continue;
      }
      if (tokens[from + 1]?.kind !== "string") return null;
      dependencies.add(tokens[from + 1].value);
      if (hasImportAttributes(tokens, from + 2)) return null;
    }
  }

  return [...dependencies];
}

/**
 * Template substitutions are scanned recursively, so page-controlled nesting
 * can exhaust the stack. That has to read as an unparsed module, which fails
 * open and is disclosed, rather than escaping route handling as a RangeError.
 */
function tokenizeModule(source: string): ModuleToken[] | null {
  try {
    return moduleTokens(source);
  } catch {
    return null;
  }
}

function moduleTokens(source: string): ModuleToken[] | null {
  const tokens: ModuleToken[] = [];
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith("#!", index)) {
    const newline = source.indexOf("\n", index + 2);
    index = newline < 0 ? source.length : newline + 1;
  }
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let canStartRegex = true;

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const literal = readStringLiteral(source, index);
      if (!literal) return null;
      tokens.push({ braceDepth, bracketDepth, kind: "string", parenDepth, value: literal.value });
      index = literal.end;
      canStartRegex = false;
      continue;
    }
    if (character === "`") {
      const end = skipTemplateLiteral(source, index);
      if (end < 0) return null;
      index = end;
      canStartRegex = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      const value = source.slice(index, end);
      tokens.push({ braceDepth, bracketDepth, kind: "identifier", parenDepth, value });
      index = end;
      canStartRegex = regexMayFollowIdentifier(value);
      continue;
    }
    if (/\d/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[\w.]/.test(source[end])) end += 1;
      index = end;
      canStartRegex = false;
      continue;
    }
    if (character === "/" && canStartRegex) {
      const end = skipRegexLiteral(source, index);
      if (end < 0) return null;
      index = end;
      canStartRegex = false;
      continue;
    }

    const punctuator = source.startsWith("?.", index) ? "?." : character;
    tokens.push({ braceDepth, bracketDepth, kind: "punctuator", parenDepth, value: punctuator });
    index += punctuator.length;
    if (character === "{") braceDepth += 1;
    else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return null;
    } else if (character === "[") bracketDepth += 1;
    else if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) return null;
    } else if (character === "(") parenDepth += 1;
    else if (character === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) return null;
    }
    canStartRegex = regexMayFollowPunctuator(punctuator);
  }

  return braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 ? tokens : null;
}

function atModuleTopLevel(token: ModuleToken): boolean {
  return token.braceDepth === 0 && token.bracketDepth === 0 && token.parenDepth === 0;
}

function findTopLevelToken(tokens: ModuleToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!atModuleTopLevel(token)) continue;
    if (token.kind === "punctuator" && token.value === ";") return -1;
    if (token.kind === "identifier" && (token.value === "import" || token.value === "export") && index > start) {
      return -1;
    }
    if (token.kind === "identifier" && token.value === value) return index;
  }
  return -1;
}

function hasImportAttributes(tokens: ModuleToken[], start: number): boolean {
  const token = tokens[start];
  return Boolean(
    token &&
    atModuleTopLevel(token) &&
    token.kind === "identifier" &&
    (token.value === "assert" || token.value === "with")
  );
}

function skipTemplateLiteral(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") return index + 1;
    if (source[index] === "$" && source[index + 1] === "{") {
      index = skipTemplateExpression(source, index + 2);
      if (index < 0) return -1;
      continue;
    }
    index += 1;
  }
  return -1;
}

function skipTemplateExpression(source: string, start: number): number {
  let index = start;
  let depth = 1;
  let canStartRegex = true;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 2;
      continue;
    }
    const character = source[index];
    if (character === '"' || character === "'") {
      const literal = readStringLiteral(source, index);
      if (!literal) return -1;
      index = literal.end;
      canStartRegex = false;
      continue;
    }
    if (character === "`") {
      index = skipTemplateLiteral(source, index);
      if (index < 0) return -1;
      canStartRegex = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      canStartRegex = regexMayFollowIdentifier(source.slice(index, end));
      index = end;
      continue;
    }
    if (/\d/.test(character)) {
      // Numbers need the same branch the outer token loop has. Falling through
      // to the punctuator rule would leave a digit regex-permitting, so the
      // division in `${1000 / 2}` would start a regex literal that swallows the
      // rest of the substitution and fails the whole module parse.
      let end = index + 1;
      while (end < source.length && /[\w.]/.test(source[end])) end += 1;
      index = end;
      canStartRegex = false;
      continue;
    }
    if (character === "/" && canStartRegex) {
      index = skipRegexLiteral(source, index);
      if (index < 0) return -1;
      canStartRegex = false;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
    canStartRegex = regexMayFollowPunctuator(character);
    index += 1;
  }
  return -1;
}

function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029") return -1;
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_$]/.test(value) || value.charCodeAt(0) > 0x7f;
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z\d_$]/.test(value) || value.charCodeAt(0) > 0x7f;
}

function regexMayFollowIdentifier(value: string): boolean {
  return new Set([
    "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield"
  ]).has(value);
}

function regexMayFollowPunctuator(value: string): boolean {
  return ![")", "]", "}", ".", "?."].includes(value);
}
