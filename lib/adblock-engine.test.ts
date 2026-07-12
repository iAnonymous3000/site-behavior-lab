import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adblockEngineStatus, adblockListMeta, mapRequestType } from "./adblock-engine";
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

test("mapRequestType maps Playwright resource types to adblock request types", () => {
  assert.equal(mapRequestType("script"), "script");
  assert.equal(mapRequestType("stylesheet"), "stylesheet");
  assert.equal(mapRequestType("image"), "image");
  assert.equal(mapRequestType("font"), "font");
  assert.equal(mapRequestType("xhr"), "xmlhttprequest");
  assert.equal(mapRequestType("fetch"), "xmlhttprequest");
  assert.equal(mapRequestType("websocket"), "websocket");
});

test("mapRequestType falls back to 'other' for unknown or non-network types", () => {
  assert.equal(mapRequestType("eventsource"), "other");
  assert.equal(mapRequestType("manifest"), "other");
  assert.equal(mapRequestType("texttrack"), "other");
  assert.equal(mapRequestType("totally-unknown"), "other");
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
