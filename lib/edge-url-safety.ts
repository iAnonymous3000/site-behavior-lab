import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";
import { PublicFacingError } from "./public-errors";

const DEFAULT_EDGE_DNS_RESOLVER_URL = "https://cloudflare-dns.com/dns-query";

type DnsAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsAnswer[];
};

export type EdgeUrlSafetyOptions = {
  cache?: Map<string, Promise<void>>;
  fetch?: typeof fetch;
  resolverUrl?: string;
};

export class EdgeUrlSafetyError extends PublicFacingError {
  constructor(message: string, status = 400) {
    super(message, status, "EdgeUrlSafetyError");
  }
}

export async function assertEdgePublicHttpUrl(url: URL, options: EdgeUrlSafetyOptions = {}): Promise<void> {
  assertEdgePublicHttpUrlShape(url);

  const hostname = normalizeHostname(url.hostname);
  if (isIpAddress(hostname)) return;

  const resolverUrl = options.resolverUrl ?? DEFAULT_EDGE_DNS_RESOLVER_URL;
  const cacheKey = `${resolverUrl}|${hostname}`;
  const cached = options.cache?.get(cacheKey);
  if (cached) return cached;

  const promise = assertHostnameResolvesPublic(hostname, options);
  options.cache?.set(cacheKey, promise);

  try {
    await promise;
  } catch (error) {
    if (options.cache?.get(cacheKey) === promise) {
      options.cache.delete(cacheKey);
    }
    throw error;
  }
}

export function assertEdgePublicHttpUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EdgeUrlSafetyError("Only HTTP and HTTPS URLs can be scanned.");
  }
  if (url.username || url.password) {
    throw new EdgeUrlSafetyError("Credentials in URLs are not supported.");
  }
  if (url.port) {
    throw new EdgeUrlSafetyError("Only standard HTTP and HTTPS ports can be scanned.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "0.0.0.0"
  ) {
    throw new EdgeUrlSafetyError("Local and private network targets are blocked.");
  }

  if (isIpAddress(hostname) && !isPublicIpAddress(hostname)) {
    throw new EdgeUrlSafetyError("Local and private network targets are blocked.");
  }
}

async function assertHostnameResolvesPublic(hostname: string, options: EdgeUrlSafetyOptions): Promise<void> {
  const addresses = await resolveHostnameAddresses(hostname, options);
  if (addresses.length === 0) {
    throw new EdgeUrlSafetyError("The host could not be resolved to a public address.");
  }

  if (!addresses.every((address) => isPublicIpAddress(address))) {
    throw new EdgeUrlSafetyError("Local and private network targets are blocked.");
  }
}

async function resolveHostnameAddresses(hostname: string, options: EdgeUrlSafetyOptions): Promise<string[]> {
  try {
    const [aRecords, aaaaRecords] = await Promise.all([
      queryDnsAddresses(hostname, "A", 1, options),
      queryDnsAddresses(hostname, "AAAA", 28, options)
    ]);
    return [...aRecords, ...aaaaRecords];
  } catch (error) {
    if (error instanceof EdgeUrlSafetyError) throw error;
    throw new EdgeUrlSafetyError("The host could not be verified as public.");
  }
}

async function queryDnsAddresses(
  hostname: string,
  recordTypeName: "A" | "AAAA",
  recordType: number,
  options: EdgeUrlSafetyOptions
): Promise<string[]> {
  const dnsFetch = options.fetch ?? fetch;
  const queryUrl = new URL(options.resolverUrl ?? DEFAULT_EDGE_DNS_RESOLVER_URL);
  queryUrl.searchParams.set("name", hostname);
  queryUrl.searchParams.set("type", recordTypeName);

  const response = await dnsFetch(queryUrl.toString(), {
    headers: {
      Accept: "application/dns-json"
    }
  });
  if (!response.ok) {
    throw new EdgeUrlSafetyError("The host could not be verified as public.");
  }

  const body = (await response.json()) as DnsJsonResponse;
  if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) {
    throw new EdgeUrlSafetyError("The host could not be verified as public.");
  }
  if (body.Status === 3) return [];

  return (body.Answer ?? [])
    .filter((answer) => answer.type === recordType && typeof answer.data === "string")
    .map((answer) => answer.data?.trim() ?? "")
    .filter(Boolean);
}
