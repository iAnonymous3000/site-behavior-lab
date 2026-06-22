import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildKeystrokeExfiltrationDetection,
  createSentinel,
  findSentinelLeaks,
  sentinelEncodings,
  type CapturedRequest
} from "./keystroke-exfiltration";

const SENTINEL = createSentinel("a1b2c3d4e5f6");

test("the sentinel is distinctive and synthetic", () => {
  assert.match(SENTINEL, /^sblcanary[0-9a-f]+$/);
});

test("sentinelEncodings covers plain, base64, hex, and hash forms", () => {
  const encodings = sentinelEncodings(SENTINEL);
  const byName = new Map(encodings.map((encoding) => [encoding.encoding, encoding.value]));

  assert.equal(byName.get("plain"), SENTINEL);
  assert.equal(byName.get("hex"), Buffer.from(SENTINEL).toString("hex"));
  assert.equal(byName.get("base64"), Buffer.from(SENTINEL).toString("base64").replace(/=+$/, ""));
  assert.equal(byName.get("sha256"), createHash("sha256").update(SENTINEL).digest("hex"));
});

test("findSentinelLeaks detects the plain value in a third-party request URL", () => {
  const requests: CapturedRequest[] = [
    { domain: "tracker.example", thirdParty: true, url: `https://tracker.example/c?k=${SENTINEL}`, body: null }
  ];
  const leaks = findSentinelLeaks(sentinelEncodings(SENTINEL), requests);
  assert.equal(leaks.length, 1);
  assert.deepEqual(leaks[0], { domain: "tracker.example", thirdParty: true, encoding: "plain", location: "url" });
});

test("findSentinelLeaks detects a base64-encoded value in a POST body", () => {
  const b64 = Buffer.from(SENTINEL).toString("base64");
  const requests: CapturedRequest[] = [
    { domain: "rec.example", thirdParty: true, url: "https://rec.example/beacon", body: `{"keys":"${b64}"}` }
  ];
  const leaks = findSentinelLeaks(sentinelEncodings(SENTINEL), requests);
  assert.equal(leaks.some((leak) => leak.encoding === "base64" && leak.location === "body"), true);
});

test("findSentinelLeaks ignores requests that do not contain the sentinel", () => {
  const requests: CapturedRequest[] = [
    { domain: "cdn.example", thirdParty: true, url: "https://cdn.example/app.js", body: null },
    { domain: "first.example", thirdParty: false, url: "https://first.example/ping?t=123", body: "noise" }
  ];
  assert.deepEqual(findSentinelLeaks(sentinelEncodings(SENTINEL), requests), []);
});

test("buildKeystrokeExfiltrationDetection fires only on a third-party leak", () => {
  const firstPartyOnly: CapturedRequest[] = [
    { domain: "first.example", thirdParty: false, url: `https://first.example/save?v=${SENTINEL}`, body: null }
  ];
  const firstPartyLeaks = findSentinelLeaks(sentinelEncodings(SENTINEL), firstPartyOnly);
  // The site sending its own form value to itself is expected, not flagged.
  assert.equal(buildKeystrokeExfiltrationDetection(firstPartyLeaks, { fieldsTyped: 2, fieldTypes: ["email"] }), null);

  const thirdParty: CapturedRequest[] = [
    { domain: "a.tracker.example", thirdParty: true, url: `https://a.tracker.example/c?k=${SENTINEL}`, body: null },
    { domain: "b.tracker.example", thirdParty: true, url: "https://b.tracker.example/p", body: Buffer.from(SENTINEL).toString("hex") }
  ];
  const detection = buildKeystrokeExfiltrationDetection(findSentinelLeaks(sentinelEncodings(SENTINEL), thirdParty), {
    fieldsTyped: 3,
    fieldTypes: ["email", "password", "text"]
  });

  assert.ok(detection);
  assert.equal(detection.kind, "keystroke-exfiltration");
  assert.equal(detection.count, 2);
  assert.deepEqual(detection.evidence.recipients, ["a.tracker.example", "b.tracker.example"]);
  assert.deepEqual(detection.evidence.encodings, ["hex", "plain"]);
  assert.equal(detection.evidence.fieldsTyped, 3);
  assert.deepEqual(detection.evidence.fieldTypes, ["email", "password", "text"]);
});
