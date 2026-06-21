import dns from "node:dns/promises";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";
import { PublicScanError } from "./public-errors";
import { normalizeHttpUrlInput } from "./url-normalization";

export function normalizeUrl(input: string): URL {
  const result = normalizeHttpUrlInput(input);
  if (!result.ok) {
    throw new PublicScanError(result.message);
  }
  return result.url;
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  assertPublicHttpUrlShape(url);

  const hostname = normalizeHostname(url.hostname);
  if (isIpAddress(hostname)) return;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new PublicScanError("The host could not be resolved to a public address.");
  }

  if (addresses.length === 0) {
    throw new PublicScanError("The host could not be resolved to a public address.");
  }

  const publicOnly = addresses.every(({ address }) => isPublicIpAddress(address));

  if (!publicOnly) {
    throw new PublicScanError("Local and private network targets are blocked.");
  }
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
