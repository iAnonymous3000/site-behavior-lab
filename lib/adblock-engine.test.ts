import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { REQUEST_TYPE_MAP, adblockEngineStatus, adblockListMeta, mapRequestType } from "./adblock-engine";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";

type VendoredMetadata = {
  sourceCount: number;
  fetchedAt: string;
  manifestDigest: string;
};

function vendoredMetadata(): VendoredMetadata {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "lib", "adblock-wasm", "brave-default-filters.meta.json"), "utf8")
  ) as VendoredMetadata;
}

/**
 * Loads the vendored wasm engine over hand-written rules, so a type mapping can
 * be checked against the engine that actually answers in production without
 * depending on which rules this week's Brave snapshot happens to carry.
 */
function syntheticEngine(rules: string): { check(url: string, sourceUrl: string, requestType: string): boolean } {
  const vendorRequire = createRequire(__filename);
  const glue = vendorRequire(path.join(process.cwd(), "lib", "adblock-wasm", "sbl_adblock_wasm.js")) as {
    AdblockEngine: new (rules: string) => { check(url: string, sourceUrl: string, requestType: string): boolean };
  };
  return new glue.AdblockEngine(rules);
}

/** The exact set of resource types the pinned playwright-core can report. */
function playwrightResourceTypes(): Set<string> {
  const bundle = readFileSync(
    path.join(process.cwd(), "node_modules", "playwright-core", "lib", "coreBundle.js"),
    "utf8"
  );
  const start = bundle.indexOf("function toResourceType(");
  assert.notEqual(start, -1, "playwright-core no longer spells toResourceType; re-derive the resource type vocabulary");
  const body = bundle.slice(start, bundle.indexOf("\n}", start));
  const reported = new Set([...body.matchAll(/return "([a-z]+)"/g)].map((match) => match[1]));
  assert.ok(reported.has("other") && reported.size >= 10, "toResourceType parse looks wrong, not a real vocabulary");
  return reported;
}

test("mapRequestType maps Playwright resource types to adblock request types", () => {
  assert.equal(mapRequestType("script"), "script");
  assert.equal(mapRequestType("stylesheet"), "stylesheet");
  assert.equal(mapRequestType("image"), "image");
  assert.equal(mapRequestType("font"), "font");
  assert.equal(mapRequestType("xhr"), "xmlhttprequest");
  assert.equal(mapRequestType("fetch"), "xmlhttprequest");
  assert.equal(mapRequestType("websocket"), "websocket");
});

test("a frame navigation is typed subdocument, which is a different filter option", () => {
  // Playwright reports `document` for a navigation in any frame, but
  // adblock-rust separates the top-level `document` from a nested
  // `subdocument`. Typing every iframe load as `document` evaluated
  // $document and $subdocument rules against the wrong type on any site with a
  // third-party frame, which moves the published Shields counts.
  assert.equal(mapRequestType("document"), "document");
  assert.equal(mapRequestType("document", { subFrame: false }), "document");
  assert.equal(mapRequestType("document", { subFrame: true }), "subdocument");
  // The flag only reclassifies navigations; a subresource loaded from inside a
  // frame keeps its own type.
  assert.equal(mapRequestType("script", { subFrame: true }), "script");
  assert.equal(mapRequestType("image", { subFrame: true }), "image");
  assert.equal(mapRequestType("totally-unknown", { subFrame: true }), "other");
});

test("a sendBeacon or <a ping> request is typed ping, which is a different filter option", () => {
  // Playwright reports `ping` for navigator.sendBeacon() and for <a ping>
  // navigations, and adblock-rust has a real Ping request type. Folding ping
  // into `other` evaluated every beacon against the wrong request type, so no
  // $ping rule in the vendored Brave lists could match and the beacon channel
  // was published as unmatched by Shields.
  assert.equal(mapRequestType("ping"), "ping");
  assert.equal(mapRequestType("ping", { subFrame: true }), "ping");

  const engine = syntheticEngine("||probe.example^$ping");
  const beacon = ["https://probe.example/collect", "https://site.example/"] as const;
  assert.equal(engine.check(beacon[0], beacon[1], mapRequestType("ping")), true);
  // The fallback the mapper used to return misses that rule outright.
  assert.equal(engine.check(beacon[0], beacon[1], "other"), false);
});

test("mapRequestType falls back to 'other' for unknown or non-network types", () => {
  assert.equal(mapRequestType("eventsource"), "other");
  assert.equal(mapRequestType("manifest"), "other");
  assert.equal(mapRequestType("texttrack"), "other");
  assert.equal(mapRequestType("totally-unknown"), "other");
  // `cspreport` is deliberate rather than incidental: this engine build matches
  // nothing at all for a request typed `csp_report`, while `other` still lets
  // untyped and $other rules apply.
  assert.equal(mapRequestType("cspreport"), "other");
  const engine = syntheticEngine("||probe.example^");
  const report = ["https://probe.example/csp", "https://site.example/"] as const;
  assert.equal(engine.check(report[0], report[1], mapRequestType("cspreport")), true);
  assert.equal(engine.check(report[0], report[1], "csp_report"), false);
});

test("REQUEST_TYPE_MAP names every resource type the pinned Playwright can report", () => {
  // Three files restate this vocabulary. An unnamed type silently degrades to
  // `other`, which is how the ping gap survived, so a Playwright upgrade that
  // adds a type has to fail here instead of quietly widening the fold.
  const unmapped = [...playwrightResourceTypes()].filter(
    (resourceType) => !Object.prototype.hasOwnProperty.call(REQUEST_TYPE_MAP, resourceType)
  );
  assert.deepEqual(
    unmapped,
    [],
    `playwright-core reports resource types REQUEST_TYPE_MAP does not name: ${unmapped.join(", ")}`
  );
});

test("adblockListMeta exposes the verified snapshot identity", () => {
  const vendored = vendoredMetadata();
  assert.deepEqual(adblockListMeta(), {
    source: "Brave default ad-block lists",
    lists: vendored.sourceCount,
    fetchedAt: vendored.fetchedAt,
    manifestDigest: vendored.manifestDigest
  });
  assert.match(vendored.manifestDigest, /^[a-f0-9]{64}$/);
});

test("adblockEngineStatus pairs the loaded engine version with the list manifest", async () => {
  const vendored = vendoredMetadata();
  const status = await adblockEngineStatus();

  assert.equal(status.active, true);
  if (!status.active) return;
  assert.equal(status.version, NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(status.engineVersion, NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(status.manifestDigest, vendored.manifestDigest);
  assert.equal(status.lists, vendored.sourceCount);
});
