import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";

// Server-only: loads Brave's adblock engine (vendored WASM) plus the vendored
// Brave default filter lists, and answers "would Brave Shields block this
// request?" at request level. Falls back to null (curated labels only) if the
// wasm cannot be loaded in the current runtime.

function resolveAdblockDir(): string {
  const rel = path.join("lib", "adblock-wasm");
  const cwdDir = path.join(process.cwd(), rel);
  if (existsSync(path.join(cwdDir, "brave-default-filters.txt.gz"))) return cwdDir;
  if (typeof __dirname === "string") {
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, rel);
      if (existsSync(path.join(candidate, "brave-default-filters.txt.gz"))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cwdDir;
}

const ADBLOCK_DIR = resolveAdblockDir();

type AdblockEngineLike = {
  check(url: string, sourceUrl: string, requestType: string): boolean;
  checkWithMethod(url: string, sourceUrl: string, requestType: string, method: string): boolean;
  checkDetailed?(url: string, sourceUrl: string, requestType: string, method: string): string;
  sourceCount?(): number;
};

export type AdblockDetailedResult = {
  shouldBlock: boolean;
  shouldBlockStandard: boolean;
  shouldBlockAggressive: boolean;
  matched: boolean;
  isThirdParty: boolean;
  important: boolean;
  filter: string | null;
  filterList: string | null;
  filterLine: number | null;
  exception: string | null;
  exceptionList: string | null;
  redirect: string | null;
  rewrittenUrl: string | null;
};

export type AdblockListMeta = {
  source: string;
  lists: number;
  fetchedAt: string;
  manifestDigest: string;
};

export type AdblockEngineStatus =
  | (AdblockListMeta & {
      active: true;
      engine: "loaded";
      version: typeof NODE_ADBLOCK_ENGINE_VERSION;
      engineVersion: typeof NODE_ADBLOCK_ENGINE_VERSION;
    })
  | {
      active: false;
      engine: "unavailable";
      source?: string;
      lists?: number;
      fetchedAt?: string;
      manifestDigest?: string;
    };

// Playwright resourceType -> adblock-rust request type. Every value Playwright's
// Chromium backend can report is an explicit key here, so a resource type that
// adblock-rust models separately can never reach the engine as `other` by
// accident. lib/adblock-engine.test.ts derives that vocabulary from the pinned
// playwright-core and fails when it grows.
export const REQUEST_TYPE_MAP: Record<string, string> = {
  document: "document",
  stylesheet: "stylesheet",
  image: "image",
  media: "media",
  font: "font",
  script: "script",
  xhr: "xmlhttprequest",
  fetch: "xmlhttprequest",
  websocket: "websocket",
  ping: "ping",
  eventsource: "other",
  manifest: "other",
  texttrack: "other",
  cspreport: "other",
  other: "other"
};

/**
 * Playwright reports `document` for a navigation in ANY frame, while
 * adblock-rust separates the top-level `document` from a nested `subdocument`.
 * Collapsing both to `document` evaluated `$document` and `$subdocument` filter
 * options against the wrong request type on every site that loads a
 * third-party iframe, which moves the published Shields matched and blocked
 * counts. Callers that can see the frame pass `subFrame`.
 *
 * The same fold hid a second type: Playwright reports `ping` for
 * `navigator.sendBeacon()` and for `<a ping>` navigations, and adblock-rust has
 * a real `Ping` request type (spelled `$ping`, with `$beacon` as its alias).
 * Typing those requests `other` evaluated every beacon against the wrong
 * request type, so no `$ping` rule in the vendored Brave lists could ever
 * match, the beacon channel was reported as unmatched by Shields, and block
 * simulation left the beacon un-aborted. `cspreport` maps to `other` on
 * purpose: the vendored lists carry no CSP-report rules, and this engine build
 * matches nothing at all for a request typed `csp_report`, not even a rule with
 * no type option, so routing CSP reports there would lose the `$other` rules
 * that can catch them today.
 */
export function mapRequestType(resourceType: string, options?: { subFrame?: boolean }): string {
  const mapped = REQUEST_TYPE_MAP[resourceType] ?? "other";
  return mapped === "document" && options?.subFrame === true ? "subdocument" : mapped;
}

// webpack (the Next server bundle) replaces __non_webpack_require__ with Node's
// real require; outside webpack we fall back to eval("require"). Either way this
// loads the vendored wasm-pack glue and its sibling .wasm from disk at runtime,
// instead of letting the bundler rewrite the require into its own module map.
declare const __non_webpack_require__: NodeRequire;

function vendorRequire(): NodeRequire {
  return typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : (eval("require") as NodeRequire);
}

type AdblockWasmGlue = {
  AdblockEngine: {
    new (rules: string): AdblockEngineLike;
    newWithDebug?: (rules: string) => AdblockEngineLike;
  };
};

let enginePromise: Promise<AdblockEngineLike | null> | null = null;
let detailedEnginePromise: Promise<AdblockEngineLike | null> | null = null;

function readVendoredFilterRules(): string {
  const gz = readFileSync(path.join(ADBLOCK_DIR, "brave-default-filters.txt.gz"));
  return gunzipSync(gz).toString("utf8");
}

function loadWasmGlue(): AdblockWasmGlue {
  const runtimeRequire = vendorRequire();
  return runtimeRequire(path.join(ADBLOCK_DIR, "sbl_adblock_wasm.js")) as AdblockWasmGlue;
}

async function loadEngine(): Promise<AdblockEngineLike | null> {
  try {
    const glue = loadWasmGlue();
    const rules = readVendoredFilterRules();
    return new glue.AdblockEngine(rules);
  } catch {
    return null;
  }
}

async function loadDetailedEngine(): Promise<AdblockEngineLike | null> {
  try {
    const glue = loadWasmGlue();
    const rules = readVendoredFilterRules();
    if (typeof glue.AdblockEngine.newWithDebug === "function") {
      return glue.AdblockEngine.newWithDebug(rules);
    }
    return new glue.AdblockEngine(rules);
  } catch {
    return null;
  }
}

/** Lazily loads and caches the wasm adblock engine for the process. Null when unavailable. */
export function getAdblockEngine(): Promise<AdblockEngineLike | null> {
  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  return enginePromise;
}

/**
 * Lazily loads and caches the debug-enabled wasm adblock engine (`FilterSet::new(true)`),
 * exposing matched rule text, list URL, exception rule, `$redirect`, `$removeparam`,
 * and Brave Standard vs. Aggressive verdicts via {@link checkAdblockDetailed}.
 */
export function getDetailedAdblockEngine(): Promise<AdblockEngineLike | null> {
  if (!detailedEnginePromise) {
    detailedEnginePromise = loadDetailedEngine();
  }
  return detailedEnginePromise;
}

const EMPTY_DETAILED_RESULT: AdblockDetailedResult = {
  shouldBlock: false,
  shouldBlockStandard: false,
  shouldBlockAggressive: false,
  matched: false,
  isThirdParty: false,
  important: false,
  filter: null,
  filterList: null,
  filterLine: null,
  exception: null,
  exceptionList: null,
  redirect: null,
  rewrittenUrl: null
};

export function checkAdblockDetailed(
  engine: AdblockEngineLike | null,
  url: string,
  sourceUrl: string,
  requestType: string,
  method = "GET"
): AdblockDetailedResult {
  if (!engine) return { ...EMPTY_DETAILED_RESULT };
  if (typeof engine.checkDetailed === "function") {
    try {
      const parsed = JSON.parse(engine.checkDetailed(url, sourceUrl, requestType, method)) as Partial<AdblockDetailedResult>;
      return {
        shouldBlock: Boolean(parsed.shouldBlock),
        shouldBlockStandard: Boolean(parsed.shouldBlockStandard),
        shouldBlockAggressive: Boolean(parsed.shouldBlockAggressive),
        matched: Boolean(parsed.matched),
        isThirdParty: Boolean(parsed.isThirdParty),
        important: Boolean(parsed.important),
        filter: typeof parsed.filter === "string" ? parsed.filter : null,
        filterList: typeof parsed.filterList === "string" ? parsed.filterList : null,
        filterLine: typeof parsed.filterLine === "number" ? parsed.filterLine : null,
        exception: typeof parsed.exception === "string" ? parsed.exception : null,
        exceptionList: typeof parsed.exceptionList === "string" ? parsed.exceptionList : null,
        redirect: typeof parsed.redirect === "string" ? parsed.redirect : null,
        rewrittenUrl: typeof parsed.rewrittenUrl === "string" ? parsed.rewrittenUrl : null
      };
    } catch {
      // Fall back to boolean check below.
    }
  }
  const blocked = engine.checkWithMethod(url, sourceUrl, requestType, method);
  return {
    ...EMPTY_DETAILED_RESULT,
    shouldBlock: blocked,
    shouldBlockStandard: blocked,
    shouldBlockAggressive: blocked,
    matched: blocked
  };
}

/** Compact display label for a Brave filter list URL (e.g. `easyprivacy.txt`). */
export function shortFilterListName(listUrl: string | null | undefined): string | null {
  if (!listUrl) return null;
  if (listUrl === "custom") return "custom";
  try {
    const parsed = new URL(listUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const file = parts[parts.length - 1];
    if (!file) return parsed.hostname;
    if (parsed.pathname.includes("/uAssets/")) return `uBlock/${file}`;
    if (parsed.pathname.includes("/brave/adblock-lists/")) return `Brave/${file}`;
    return file;
  } catch {
    return listUrl;
  }
}

export function adblockListMeta(): AdblockListMeta | null {
  try {
    const runtimeRequire = vendorRequire();
    const meta = runtimeRequire(path.join(ADBLOCK_DIR, "brave-default-filters.meta.json")) as {
      sourceCount: number;
      fetchedAt: string;
      manifestDigest: string;
    };
    if (
      !Number.isSafeInteger(meta.sourceCount) ||
      meta.sourceCount <= 0 ||
      typeof meta.fetchedAt !== "string" ||
      !/^[a-f0-9]{64}$/.test(meta.manifestDigest)
    ) {
      return null;
    }
    return {
      source: "Brave default ad-block lists",
      lists: meta.sourceCount,
      fetchedAt: meta.fetchedAt,
      manifestDigest: meta.manifestDigest
    };
  } catch {
    return null;
  }
}

export async function adblockEngineStatus(): Promise<AdblockEngineStatus> {
  const meta = adblockListMeta();
  const engine = await getAdblockEngine();
  if (engine) {
    return {
      active: true,
      engine: "loaded",
      version: NODE_ADBLOCK_ENGINE_VERSION,
      engineVersion: NODE_ADBLOCK_ENGINE_VERSION,
      source: meta?.source ?? "Brave default ad-block lists",
      lists: meta?.lists ?? 0,
      fetchedAt: meta?.fetchedAt ?? "unknown",
      manifestDigest: meta?.manifestDigest ?? "unknown"
    };
  }

  return {
    active: false,
    engine: "unavailable",
    source: meta?.source,
    lists: meta?.lists,
    fetchedAt: meta?.fetchedAt,
    manifestDigest: meta?.manifestDigest
  };
}
