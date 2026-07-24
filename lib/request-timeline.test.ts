import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestTimelineModel, REQUEST_TIMELINE_MARK_LIMIT } from "./request-timeline";
import type { NetworkRequestRecord } from "./types";

test("timeline buckets an adversarial request collection into a fixed DOM budget", () => {
  const requests = Array.from({ length: 50_000 }, (_, index) => request(index + 1, index));
  const model = buildRequestTimelineModel(requests);
  assert.equal(model.maxTime, 49_999);
  assert.ok(model.marks.length <= REQUEST_TIMELINE_MARK_LIMIT);
  assert.equal(model.marks.some((mark) => mark.role === "tracker"), true);
});

test("timeline retains every ordinary request below the render budget", () => {
  const model = buildRequestTimelineModel([request(1, 0), request(2, 10)]);
  assert.equal(model.maxTime, 10);
  assert.equal(model.marks.length, 2);
});

function request(id: number, startedAtMs: number): NetworkRequestRecord {
  return {
    id,
    url: "https://cdn.example.test/a",
    domain: "cdn.example.test",
    method: "GET",
    resourceType: "image",
    status: 200,
    thirdParty: true,
    tracker: id % 3 === 0
      ? { domain: "example.test", entity: "Example", category: "analytics", confidence: "curated" }
      : null,
    startedAtMs
  };
}
