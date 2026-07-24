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
    throw new PublicScanError(result.message);
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
    throw new PublicScanError("The host could not be resolved to a public address.");
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.length > PUBLIC_URL_MAX_RESOLVED_ADDRESSES
  ) {
    throw new PublicScanError("The host could not be resolved to a public address.");
  }

  const publicOnly = addresses.every(({ address }) => isPublicIpAddress(address));

  if (!publicOnly) {
    throw new PublicScanError("Local and private network targets are blocked.");
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
    throw new PublicScanError("Local and private network targets are blocked.");
  }

  if (isIpAddress(hostname) && !isPublicIpAddress(hostname)) {
    throw new PublicScanError("Local and private network targets are blocked.");
  }

  assertStandardHttpPort(url);
}

function assertStandardHttpPort(url: URL): void {
  if (url.port) {
    throw new PublicScanError("Only standard HTTP and HTTPS ports can be scanned.");
  }
}
