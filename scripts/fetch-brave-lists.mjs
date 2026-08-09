// Fetches the constituent filter lists that make up Brave's default ad-block
// component (from Brave's own list catalog) and vendors a pinned, gzipped
// snapshot for the WASM adblock engine. Brave-owned supply chain only, no
// competitor dataset. Refresh with: npm run lists:brave
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, sourceManifestDigest } from "./brave-list-digests.mjs";

export const CATALOG_COMMIT = "87e925ec3ed08b28b96460b7615b033c52971fa9";
export const CATALOG_SHA256 = "d701b93f8988851c1637548071bed1fe3f4a4abc8b138d4f3109d9373c3a3b0e";
export const CATALOG_URL =
  `https://raw.githubusercontent.com/brave/adblock-resources/${CATALOG_COMMIT}/filter_lists/list_catalog.json`;
const OUT_DIR = path.join(process.cwd(), "lib", "adblock-wasm");
const METADATA_PATH = path.join(OUT_DIR, "brave-default-filters.meta.json");
const DEFAULT_FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_TRANSIENT_RETRIES = 2;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const CATALOG_MAX_BYTES = 512 * 1024;
const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const AGGREGATE_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

class PermanentFetchError extends Error {}

/**
 * The reviewed source lock is exact, but keep an independent host/path policy
 * as defense in depth against accidentally approving a catalog entry that can
 * redirect the updater into an unrelated or private service.
 */
export function validateApprovedSourceUrl(value) {
  const url = strictHttpsUrl(value, "Brave filter-list source");
  if (url.search || url.hash || url.port || hasExplicitPort(value)) {
    throw new Error(`Brave filter-list source must not contain a port, query, or fragment: ${value}`);
  }

  const approved =
    (url.hostname === "raw.githubusercontent.com" &&
      (/^\/uBlockOrigin\/uAssets\/master\/filters\/[A-Za-z0-9._/-]+$/.test(url.pathname) ||
        /^\/brave\/adblock-lists\/master\/[A-Za-z0-9._/-]+$/.test(url.pathname))) ||
    (url.hostname === "easylist.to" && /^\/easylist\/(?:easylist|easyprivacy)\.txt$/.test(url.pathname)) ||
    (url.hostname === "malware-filter.gitlab.io" &&
      url.pathname === "/malware-filter/urlhaus-filter-agh-online.txt") ||
    (url.hostname === "secure.fanboy.co.nz" &&
      /^\/fanboy-(?:cookiemonster_ubo|mobile-notifications)\.txt$/.test(url.pathname));

  if (!approved) throw new Error(`Brave filter-list source is outside the reviewed host/path policy: ${value}`);
  return url.href;
}

export function collectDefaultSources(catalog) {
  const lists = Array.isArray(catalog)
    ? catalog
    : Object.values(catalog).find(Array.isArray) ?? [];
  const urls = lists
    .filter((entry) => entry && entry.default_enabled === true)
    .flatMap((entry) => (Array.isArray(entry.sources) ? entry.sources : []))
    .map((source) => source && source.url)
    .filter((url) => typeof url === "string" && url.length > 0);
  return [...new Set(urls)];
}

export function isTransientHttpStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS) : MAX_RETRY_DELAY_MS;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - now), MAX_RETRY_DELAY_MS);
}

/**
 * Fetch one complete text resource with a bounded deadline and retries. Only
 * transport/body-read failures, HTTP 429, and HTTP 5xx are retried; permanent
 * 4xx responses and malformed catalog data fail immediately. A source only
 * enters the snapshot after its entire body has been read successfully.
 */
export async function fetchTextWithRetry(
  url,
  {
    fetcher = fetch,
    wait = delay,
    now = Date.now,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    transientRetries = DEFAULT_TRANSIENT_RETRIES,
    maxBytes = SOURCE_MAX_BYTES,
    allowedUrls,
    onRetry = () => {}
  } = {}
) {
  const requestedUrl = strictHttpsUrl(url, "Remote text resource").href;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Fetch timeout must be a positive integer.");
  if (!Number.isSafeInteger(transientRetries) || transientRetries < 0 || transientRetries > MAX_TRANSIENT_RETRIES) {
    throw new Error(`Transient retry count must be an integer from 0 to ${MAX_TRANSIENT_RETRIES}.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Fetch byte limit must be a positive integer.");
  if (allowedUrls !== undefined) {
    const allowed = new Set(Array.from(allowedUrls, (entry) => strictHttpsUrl(entry, "Allowed remote resource").href));
    if (!allowed.has(requestedUrl)) throw new Error(`Remote resource is not present in the reviewed source lock: ${url}`);
  }

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetcher(requestedUrl, {
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt >= transientRetries) throw error;
      const retryNumber = attempt + 1;
      const delayMs = exponentialRetryDelayMs(retryNumber);
      onRetry({ attempt: retryNumber, delayMs, reason: transportErrorMessage(error) });
      await wait(delayMs);
      continue;
    }

    if (response.status >= 300 && response.status <= 399) {
      discardResponse(response);
      throw new PermanentFetchError(`HTTP redirect ${response.status} is forbidden for ${requestedUrl}`);
    }

    if (!response.ok) {
      const status = response.status;
      discardResponse(response);
      if (!isTransientHttpStatus(status) || attempt >= transientRetries) {
        throw new Error(`HTTP ${status}`);
      }
      const retryNumber = attempt + 1;
      const delayMs = retryAfterMs(response.headers.get("Retry-After"), now()) ?? exponentialRetryDelayMs(retryNumber);
      onRetry({ attempt: retryNumber, delayMs, reason: `HTTP ${status}` });
      await wait(delayMs);
      continue;
    }

    try {
      if (response.url && strictHttpsUrl(response.url, "Remote response URL").href !== requestedUrl) {
        throw new PermanentFetchError(`Remote response URL changed from its reviewed value: ${requestedUrl}`);
      }
      return await readBoundedUtf8(response, maxBytes);
    } catch (error) {
      if (error instanceof PermanentFetchError) throw error;
      if (attempt >= transientRetries) throw error;
      const retryNumber = attempt + 1;
      const delayMs = exponentialRetryDelayMs(retryNumber);
      onRetry({ attempt: retryNumber, delayMs, reason: transportErrorMessage(error) });
      await wait(delayMs);
    }
  }
}

async function main() {
  console.log(`Fetching Brave list catalog: ${CATALOG_URL}`);
  const fetchOptions = {
    timeoutMs: positiveIntEnv("BRAVE_LIST_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS),
    transientRetries: boundedIntEnv("BRAVE_LIST_FETCH_RETRIES", DEFAULT_TRANSIENT_RETRIES, 0, MAX_TRANSIENT_RETRIES),
    onRetry: ({ attempt, delayMs, reason }) => {
      console.warn(`  retry ${attempt}: ${reason}; waiting ${delayMs}ms`);
    }
  };
  const currentMetadata = JSON.parse(await readFile(METADATA_PATH, "utf8"));
  const reviewedUrls = reviewedSourceUrls(currentMetadata);
  const catalogText = await fetchTextWithRetry(CATALOG_URL, {
    ...fetchOptions,
    maxBytes: CATALOG_MAX_BYTES,
    allowedUrls: [CATALOG_URL]
  });
  if (sha256Hex(Buffer.from(catalogText, "utf8")) !== CATALOG_SHA256) {
    throw new Error("Pinned Brave catalog bytes do not match the reviewed SHA-256.");
  }
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch {
    throw new Error("Brave list catalog returned malformed JSON.");
  }

  const urls = collectDefaultSources(catalog);
  if (urls.length === 0) throw new Error("No default_enabled source URLs found in catalog.");
  if (JSON.stringify(urls) !== JSON.stringify(reviewedUrls)) {
    throw new Error(
      "Pinned Brave catalog source selection differs from the reviewed source lock; update it only in a dedicated review."
    );
  }
  for (const url of urls) validateApprovedSourceUrl(url);
  console.log(`Default-enabled source lists: ${urls.length}`);

  const parts = [];
  const sources = [];
  const failures = [];
  let aggregateBytes = 0;
  for (const url of urls) {
    try {
      const text = await fetchTextWithRetry(url, {
        ...fetchOptions,
        maxBytes: SOURCE_MAX_BYTES,
        allowedUrls: reviewedUrls
      });
      const bytes = Buffer.from(text, "utf8");
      aggregateBytes += bytes.length;
      if (aggregateBytes > AGGREGATE_SOURCE_MAX_BYTES) {
        throw new Error(`Aggregate Brave filter-list input exceeds ${AGGREGATE_SOURCE_MAX_BYTES} bytes.`);
      }
      parts.push(`! ===== source: ${url} =====\n${text}`);
      sources.push({ url, bytes: bytes.length, sha256: sha256Hex(bytes) });
      console.log(`  ok   ${url} (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      console.warn(`  FAIL ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Refusing to write a partial Brave snapshot:\n${failures.join("\n")}`);
  }

  const fetchedAt = new Date().toISOString();
  const header =
    `! Brave default ad-block filters, pinned snapshot\n` +
    `! Fetched ${fetchedAt} from ${sources.length}/${urls.length} sources in Brave's catalog\n` +
    `! Catalog: ${CATALOG_URL}\n`;
  const combined = `${header}${parts.join("\n")}\n`;
  const combinedBytes = Buffer.from(combined, "utf8");
  const gz = gzipSync(combinedBytes);
  const manifestDigest = sourceManifestDigest(sources);
  const rulesDigest = sha256Hex(combinedBytes);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "brave-default-filters.txt.gz"), gz);
  await writeFile(METADATA_PATH, `${JSON.stringify({
    fetchedAt,
    catalog: CATALOG_URL,
    catalogCommit: CATALOG_COMMIT,
    catalogSha256: CATALOG_SHA256,
    sourceCount: sources.length,
    sources,
    manifestDigest,
    rulesDigest,
    rawBytes: combinedBytes.length,
    gzipBytes: gz.length
  }, null, 2)}\n`);

  console.log(
    `\nWrote lib/adblock-wasm/brave-default-filters.txt.gz, ${(gz.length / 1024).toFixed(0)} KB gz / ${(combinedBytes.length / 1024 / 1024).toFixed(1)} MB raw, from ${sources.length} sources.`
  );
}

function reviewedSourceUrls(metadata) {
  if (!metadata || !Array.isArray(metadata.sources) || metadata.sources.length === 0) {
    throw new Error("Committed Brave metadata must provide a non-empty reviewed source lock.");
  }
  const urls = metadata.sources.map((source) => validateApprovedSourceUrl(source?.url));
  if (new Set(urls).size !== urls.length) throw new Error("Committed Brave source lock contains a duplicate URL.");
  return urls;
}

function strictHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  return url;
}

function hasExplicitPort(value) {
  if (typeof value !== "string") return false;
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  if (!authority) return false;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) return /^\[[^\]]+\]:\d+$/.test(hostPort);
  return /:\d+$/.test(hostPort);
}

async function readBoundedUtf8(response, maxBytes) {
  // Undici exposes decoded bytes while retaining a gzip/br wire length. Only
  // absent/identity encoding makes Content-Length comparable to this stream.
  const contentEncoding = response.headers?.get?.("content-encoding");
  const identityEncoded =
    contentEncoding === null ||
    contentEncoding === undefined ||
    contentEncoding.trim().toLowerCase() === "identity";
  const contentLength = identityEncoded
    ? response.headers?.get?.("content-length")
    : null;
  const declaredLength =
    typeof contentLength === "string" && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
  if (
    Number.isSafeInteger(declaredLength) &&
    declaredLength > maxBytes
  ) {
    discardResponse(response);
    throw new PermanentFetchError(`Remote response exceeds the ${maxBytes}-byte limit.`);
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Remote response has no bounded readable body stream.");
  }

  const reader = response.body.getReader();
  // Keep one fixed allocation. The decompressed byte limit must also bound
  // retained metadata when a remote server fragments its body into empty or
  // one-byte chunks.
  const bytes = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new PermanentFetchError("Remote response yielded a non-byte body chunk.");
      }
      if (value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        throw new PermanentFetchError(`Remote response exceeds the ${maxBytes}-byte limit.`);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    cancelReaderDetached(reader, "Remote response was refused.");
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Broken cleanup must not mask the authoritative response verdict.
    }
  }

  if (
    Number.isSafeInteger(declaredLength) &&
    total !== declaredLength
  ) {
    throw new PermanentFetchError(
      "Remote response length does not match Content-Length."
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, total)
    );
  } catch {
    throw new PermanentFetchError("Remote response is not valid UTF-8 text.");
  }
}

function exponentialRetryDelayMs(retryNumber) {
  return Math.min(1_000 * 2 ** (retryNumber - 1), MAX_RETRY_DELAY_MS);
}

function observeDetached(value) {
  void Promise.resolve(value).catch(() => undefined);
}

function discardResponse(response) {
  try {
    observeDetached(response.body?.cancel?.());
  } catch {
    // A failed body cancellation does not make a permanent status retryable.
  }
}

function cancelReaderDetached(reader, reason) {
  try {
    observeDetached(reader.cancel(reason));
  } catch {
    // The body refusal remains authoritative if cleanup is hostile.
  }
}

function transportErrorMessage(error) {
  if (error instanceof Error && error.name === "TimeoutError") return "request deadline exceeded";
  return "transport or response-body failure";
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedIntEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
