import assert from "node:assert/strict";
import { test } from "node:test";
import { mapRequestType } from "./adblock-engine";

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
