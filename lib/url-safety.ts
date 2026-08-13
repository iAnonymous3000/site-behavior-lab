import dns from "node:dns/promises";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";
import { PublicScanError } from "./public-errors";
import { normalizeHttpUrlInput } from "./url-normalization";

export const PUBLIC_URL_DNS_TIMEOUT_MS = 5_000;
export const PUBLIC_URL_MAX_RESOLVED_ADDRESSES = 64;

export class PublicUrlDnsTimeoutError extends PublicScanError {
  constructor(readonly timeoutMs: number) {
    super("Public host verification timed out. Try again shortly.", 503);
    this.name = "PublicUrlDnsTimeoutError";
  }
}

/**
 * The resolver failed, so whether the host is public was never established.
 *
 * Distinct from a host that resolved to a private address (a refusal the
 * scanner proved) and from a host with no address records (a property of the
 * caller's URL). A resolver that returned a temporary failure, SERVFAIL, or was
 * itself unreachable proves nothing about the target, so the caller must not be
 * told its address is unresolvable and the status must not be a 4xx. Refuses
 * the scan exactly like every other branch here; only the status and the
 * sentence differ.
 *
 * `code` is retained for operator logs and is never part of the public message.
 */
export class PublicUrlDnsUnavailableError extends PublicScanError {
  constructor(readonly code: string | null) {
    super("Public host verification could not complete. Try again shortly.", 503);
    this.name = "PublicUrlDnsUnavailableError";
  }
}

/**
 * getaddrinfo codes that prove the HOST has no address: the resolver answered
 * authoritatively. Every other code (EAI_AGAIN, ESERVFAIL, ETIMEDOUT,
 * ECONNREFUSED, EAI_SYSTEM, and whatever a future libc or resolver adds) is a
 * failure OF the resolver, and an unproven answer is not a negative one.
 */
const AUTHORITATIVE_DNS_FAILURE_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

function dnsFailureCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

export type PublicUrlDnsLookup = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

export type PublicUrlVerificationOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam; production always uses the operating system resolver. */
  lookup?: PublicUrlDnsLookup;
}>;

export function normalizeUrl(input: string): URL {
  const result = normalizeHttpUrlInput(input);
  if (!result.ok) {
    // Every failure `normalizeHttpUrlInput` can return is a problem with the
    // address as typed -- empty, non-HTTP, unparseable, or carrying
    // credentials -- so they share one cause. The message still varies and is
    // still shown; the cause only decides what we tell the visitor to do.
    throw new PublicScanError(result.message, 400, "invalid-url");
  }
  return result.url;
}

export async function assertPublicHttpUrl(
  url: URL,
  options: PublicUrlVerificationOptions = {}
): Promise<void> {
  assertPublicHttpUrlShape(url);

  const hostname = normalizeHostname(url.hostname);
  if (isIpAddress(hostname)) return;

  const timeoutMs = options.timeoutMs ?? PUBLIC_URL_DNS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The public-host DNS timeout must be a positive safe integer.");
  }
  options.signal?.throwIfAborted();

  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new PublicUrlDnsTimeoutError(timeoutMs)),
    timeoutMs
  );
  const abort = publicUrlDnsAbortGate(signal);
  const lookup = options.lookup ?? defaultPublicUrlDnsLookup;
  const pending = Promise.resolve().then(() => lookup(hostname));
  // A resolver cannot be portably cancelled. Observe a late failure after the
  // explicit race so it can never become an unhandled rejection.
  void pending.catch(() => undefined);

  let addresses: { address: string; family: number }[];
  try {
    addresses = await Promise.race([pending, abort.promise]);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    // A resolver failure is not a verdict about the host. Only an authoritative
    // "no such name / no such record" is; anything else means verification did
    // not run, which is a scanner-side outage the caller may retry.
    const code = dnsFailureCode(error);
    if (code === null || !AUTHORITATIVE_DNS_FAILURE_CODES.has(code)) {
      throw new PublicUrlDnsUnavailableError(code);
    }
    throw new PublicScanError("The host could not be resolved to a public address.", 400, "target-unreachable");
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new PublicScanError("The host could not be resolved to a public address.", 400, "target-unreachable");
  }

  // A fan-out refusal, not a resolution failure: the host answered, with more
  // addresses than the scanner will verify. Saying "could not be resolved" here
  // would blame the lookup for a policy ceiling.
  if (addresses.length > PUBLIC_URL_MAX_RESOLVED_ADDRESSES) {
    throw new PublicScanError(
      `The host resolved to more than ${PUBLIC_URL_MAX_RESOLVED_ADDRESSES} addresses, which this scanner will not verify.`
    );
  }

  const publicOnly = addresses.every(({ address }) => isPublicIpAddress(address));

  if (!publicOnly) {
    throw new PublicScanError("Local and private network targets are blocked.", 400, "private-target");
  }
}

function defaultPublicUrlDnsLookup(
  hostname: string
): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function publicUrlDnsAbortGate(
  signal: AbortSignal
): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = () => reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
    if (signal.aborted) {
      rejectFromSignal();
      return;
    }
    listener = rejectFromSignal;
    signal.addEventListener("abort", rejectFromSignal, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    }
  };
}

export function assertPublicHttpUrlShape(url: URL): void {
  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "0.0.0.0"
  ) {
    throw new PublicScanError("Local and private network targets are blocked.", 400, "private-target");
  }

  if (isIpAddress(hostname) && !isPublicIpAddress(hostname)) {
    throw new PublicScanError("Local and private network targets are blocked.", 400, "private-target");
  }

  assertStandardHttpPort(url);
}

function assertStandardHttpPort(url: URL): void {
  if (url.port) {
    throw new PublicScanError("Only standard HTTP and HTTPS ports can be scanned.", 400, "invalid-url");
  }
}
