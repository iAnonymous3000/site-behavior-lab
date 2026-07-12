#!/usr/bin/env node

// Validates the vendored Brave Shields snapshot end to end: loads the WASM
// engine with the (freshly fetched) filter lists and asserts that a known ad
// URL is blocked while an ordinary first-party asset is not. Run after
// `npm run lists:brave` (and by the scheduled refresh workflow) so a corrupted
// or gutted list snapshot can never be committed silently.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256Hex, sourceManifestDigest } from "./brave-list-digests.mjs";

const require = createRequire(import.meta.url);
const adblockDir = path.join(process.cwd(), "lib", "adblock-wasm");

const meta = JSON.parse(readFileSync(path.join(adblockDir, "brave-default-filters.meta.json"), "utf8"));
assert.deepEqual(
  Object.keys(meta).sort(),
  ["catalog", "fetchedAt", "gzipBytes", "manifestDigest", "rawBytes", "rulesDigest", "sourceCount", "sources"].sort(),
  "unexpected Brave list metadata shape"
);
assert.equal(meta.catalog, "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json");
assert.equal(new Date(meta.fetchedAt).toISOString(), meta.fetchedAt, "fetchedAt must be a canonical ISO timestamp");
assert.ok(meta.sourceCount >= 20, `expected at least 20 source lists, got ${meta.sourceCount}`);
assert.ok(Array.isArray(meta.sources), "sources must be an array");
assert.equal(meta.sources.length, meta.sourceCount, "sourceCount must equal sources.length");

const sourceUrls = new Set();
for (const source of meta.sources) {
  assert.deepEqual(Object.keys(source).sort(), ["bytes", "sha256", "url"], "unexpected per-source metadata shape");
  assert.match(source.url, /^https:\/\//, "source URL must use HTTPS");
  assert.equal(sourceUrls.has(source.url), false, `duplicate source URL: ${source.url}`);
  sourceUrls.add(source.url);
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0, `invalid byte count for ${source.url}`);
  assert.match(source.sha256, /^[a-f0-9]{64}$/, `invalid SHA-256 for ${source.url}`);
}

assert.match(meta.manifestDigest, /^[a-f0-9]{64}$/, "manifestDigest must be lowercase SHA-256");
assert.equal(meta.manifestDigest, sourceManifestDigest(meta.sources), "manifestDigest does not match canonical sources");
assert.equal(
  sourceManifestDigest(meta.sources),
  sourceManifestDigest(meta.sources.map((source) => ({ ...source, fetchedAt: "1970-01-01T00:00:00.000Z" }))),
  "manifestDigest must not depend on fetchedAt or incidental source metadata"
);

const compressedRules = readFileSync(path.join(adblockDir, "brave-default-filters.txt.gz"));
assert.equal(meta.gzipBytes, compressedRules.length, "gzipBytes does not match the vendored snapshot");
const rulesBuffer = gunzipSync(compressedRules);
assert.equal(meta.rawBytes, rulesBuffer.length, "rawBytes does not match the decompressed snapshot");
assert.match(meta.rulesDigest, /^[a-f0-9]{64}$/, "rulesDigest must be lowercase SHA-256");
assert.equal(meta.rulesDigest, sha256Hex(rulesBuffer), "rulesDigest does not match the decompressed snapshot");
const rules = rulesBuffer.toString("utf8");
assert.ok(rules.length > 2_000_000, `filter snapshot suspiciously small: ${rules.length} chars`);

const embeddedSourceUrls = [...rules.matchAll(/^! ===== source: (https:\/\/\S+) =====$/gm)].map((match) => match[1]);
assert.deepEqual(embeddedSourceUrls, meta.sources.map((source) => source.url), "embedded source order must match metadata");

for (let index = 0; index < meta.sources.length; index += 1) {
  const source = meta.sources[index];
  const marker = `! ===== source: ${source.url} =====\n`;
  const markerIndex = rules.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing embedded source marker for ${source.url}`);
  const contentStart = markerIndex + marker.length;
  const nextMarkerIndex = index + 1 < meta.sources.length
    ? rules.indexOf(`! ===== source: ${meta.sources[index + 1].url} =====\n`, contentStart)
    : rules.length;
  assert.notEqual(nextMarkerIndex, -1, `missing next embedded source marker after ${source.url}`);
  const appendedSeparatorIndex = nextMarkerIndex - 1;
  assert.equal(rules[appendedSeparatorIndex], "\n", `missing generated separator after ${source.url}`);
  const sourceBytes = Buffer.from(rules.slice(contentStart, appendedSeparatorIndex), "utf8");
  assert.equal(source.bytes, sourceBytes.length, `byte count does not match embedded rules for ${source.url}`);
  assert.equal(source.sha256, sha256Hex(sourceBytes), `SHA-256 does not match embedded rules for ${source.url}`);
}

const { AdblockEngine } = require(path.join(adblockDir, "sbl_adblock_wasm.js"));
const engine = new AdblockEngine(rules);

const blocked = [
  ["https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script"],
  ["https://www.googletagmanager.com/gtag/js?id=G-TEST", "script"],
  ["https://connect.facebook.net/en_US/fbevents.js", "script"]
];
for (const [url, type] of blocked) {
  assert.equal(engine.check(url, "https://example.com/", type), true, `expected the engine to block ${url}`);
}

assert.equal(
  engine.check("https://example.com/assets/logo.png", "https://example.com/", "image"),
  false,
  "expected the engine to allow an ordinary first-party asset"
);

const methodEngine = new AdblockEngine("||method-test.invalid^$method=post");
assert.equal(
  methodEngine.checkWithMethod("https://method-test.invalid/collect", "https://example.com/", "xmlhttprequest", "POST"),
  true,
  "expected a POST-only rule to match POST"
);
assert.equal(
  methodEngine.checkWithMethod("https://method-test.invalid/collect", "https://example.com/", "xmlhttprequest", "GET"),
  false,
  "expected a POST-only rule not to match GET"
);
assert.equal(
  methodEngine.check("https://method-test.invalid/collect", "https://example.com/", "xmlhttprequest"),
  false,
  "expected the legacy three-argument API to keep GET semantics"
);

console.log(
  `Adblock engine OK: ${meta.sourceCount} lists fetched ${meta.fetchedAt}, manifest ${meta.manifestDigest.slice(0, 12)}, ${(rulesBuffer.length / 1024 / 1024).toFixed(1)} MB of verified rules, block and method checks pass.`
);
