// Fetches the constituent filter lists that make up Brave's default ad-block
// component (from Brave's own list catalog) and vendors a pinned, gzipped
// snapshot for the WASM adblock engine. Brave-owned supply chain only, no
// competitor dataset. Refresh with: npm run lists:brave
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, sourceManifestDigest } from "./brave-list-digests.mjs";

const CATALOG_URL =
  "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json";
const OUT_DIR = path.join(process.cwd(), "lib", "adblock-wasm");
const DEFAULT_FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_TRANSIENT_RETRIES = 2;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

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
    onRetry = () => {}
  } = {}
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Fetch timeout must be a positive integer.");
  if (!Number.isSafeInteger(transientRetries) || transientRetries < 0 || transientRetries > MAX_TRANSIENT_RETRIES) {
    throw new Error(`Transient retry count must be an integer from 0 to ${MAX_TRANSIENT_RETRIES}.`);
  }

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= transientRetries) throw error;
      const retryNumber = attempt + 1;
      const delayMs = exponentialRetryDelayMs(retryNumber);
      onRetry({ attempt: retryNumber, delayMs, reason: transportErrorMessage(error) });
      await wait(delayMs);
      continue;
    }

    if (!response.ok) {
      const status = response.status;
      await discardResponse(response);
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
      return await response.text();
    } catch (error) {
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
  const catalogText = await fetchTextWithRetry(CATALOG_URL, fetchOptions);
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch {
    throw new Error("Brave list catalog returned malformed JSON.");
  }

  const urls = collectDefaultSources(catalog);
  if (urls.length === 0) throw new Error("No default_enabled source URLs found in catalog.");
  console.log(`Default-enabled source lists: ${urls.length}`);

  const parts = [];
  const sources = [];
  const failures = [];
  for (const url of urls) {
    try {
      const text = await fetchTextWithRetry(url, fetchOptions);
      const bytes = Buffer.from(text, "utf8");
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
  await writeFile(
    path.join(OUT_DIR, "brave-default-filters.meta.json"),
    `${JSON.stringify({ fetchedAt, catalog: CATALOG_URL, sourceCount: sources.length, sources, manifestDigest, rulesDigest, rawBytes: combinedBytes.length, gzipBytes: gz.length }, null, 2)}\n`
  );

  console.log(
    `\nWrote lib/adblock-wasm/brave-default-filters.txt.gz, ${(gz.length / 1024).toFixed(0)} KB gz / ${(combinedBytes.length / 1024 / 1024).toFixed(1)} MB raw, from ${sources.length} sources.`
  );
}

function exponentialRetryDelayMs(retryNumber) {
  return Math.min(1_000 * 2 ** (retryNumber - 1), MAX_RETRY_DELAY_MS);
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // A failed body cancellation does not make a permanent status retryable.
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
