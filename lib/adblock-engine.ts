import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

// Server-only: loads Brave's adblock engine (vendored WASM) plus the vendored
// Brave default filter lists, and answers "would Brave Shields block this
// request?" at request level. Falls back to null (curated labels only) if the
// wasm cannot be loaded in the current runtime.

const ADBLOCK_DIR = path.join(process.cwd(), "lib", "adblock-wasm");

type AdblockEngineLike = {
  check(url: string, sourceUrl: string, requestType: string): boolean;
};

export type AdblockListMeta = {
  source: string;
  lists: number;
  fetchedAt: string;
};

export type AdblockEngineStatus =
  | (AdblockListMeta & {
      active: true;
      engine: "loaded";
    })
  | {
      active: false;
      engine: "unavailable";
      source?: string;
      lists?: number;
      fetchedAt?: string;
    };

// Playwright resourceType -> adblock-rust request type.
const REQUEST_TYPE_MAP: Record<string, string> = {
  document: "document",
  stylesheet: "stylesheet",
  image: "image",
  media: "media",
  font: "font",
  script: "script",
  xhr: "xmlhttprequest",
  fetch: "xmlhttprequest",
  websocket: "websocket",
  eventsource: "other",
  manifest: "other",
  texttrack: "other",
  other: "other"
};

export function mapRequestType(resourceType: string): string {
  return REQUEST_TYPE_MAP[resourceType] ?? "other";
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

let enginePromise: Promise<AdblockEngineLike | null> | null = null;

async function loadEngine(): Promise<AdblockEngineLike | null> {
  try {
    const runtimeRequire = vendorRequire();
    const glue = runtimeRequire(path.join(ADBLOCK_DIR, "sbl_adblock_wasm.js")) as {
      AdblockEngine: new (rules: string) => AdblockEngineLike;
    };
    const gz = readFileSync(path.join(ADBLOCK_DIR, "brave-default-filters.txt.gz"));
    const rules = gunzipSync(gz).toString("utf8");
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

export function adblockListMeta(): AdblockListMeta | null {
  try {
    const runtimeRequire = vendorRequire();
    const meta = runtimeRequire(path.join(ADBLOCK_DIR, "brave-default-filters.meta.json")) as {
      sourceCount: number;
      fetchedAt: string;
    };
    return { source: "Brave default ad-block lists", lists: meta.sourceCount, fetchedAt: meta.fetchedAt };
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
      source: meta?.source ?? "Brave default ad-block lists",
      lists: meta?.lists ?? 0,
      fetchedAt: meta?.fetchedAt ?? "unknown"
    };
  }

  return {
    active: false,
    engine: "unavailable",
    source: meta?.source,
    lists: meta?.lists,
    fetchedAt: meta?.fetchedAt
  };
}
