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

const require = createRequire(import.meta.url);
const adblockDir = path.join(process.cwd(), "lib", "adblock-wasm");

const meta = JSON.parse(readFileSync(path.join(adblockDir, "brave-default-filters.meta.json"), "utf8"));
assert.ok(meta.sourceCount >= 20, `expected at least 20 source lists, got ${meta.sourceCount}`);

const rules = gunzipSync(readFileSync(path.join(adblockDir, "brave-default-filters.txt.gz"))).toString("utf8");
assert.ok(rules.length > 2_000_000, `filter snapshot suspiciously small: ${rules.length} chars`);

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
  `Adblock engine OK: ${meta.sourceCount} lists fetched ${meta.fetchedAt}, ${(rules.length / 1024 / 1024).toFixed(1)} MB of rules, block and method checks pass.`
);
