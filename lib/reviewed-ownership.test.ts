import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEWED_OWNERSHIP_VERSION,
  isReviewedSameOrganizationDomain,
  reviewedOrganizationForDomain,
  reviewedOwnershipRecords,
  reviewedOwnershipRelationship
} from "./reviewed-ownership";

test("reviewed ownership maps X and twimg infrastructure without changing site boundaries", () => {
  assert.equal(reviewedOrganizationForDomain("x.com"), "X");
  assert.equal(reviewedOrganizationForDomain("video.twimg.com"), "X");
  assert.equal(isReviewedSameOrganizationDomain("x.com", "pbs.twimg.com"), true);
});

test("reviewed ownership maps Google and YouTube service families", () => {
  assert.equal(reviewedOrganizationForDomain("www.youtube.com"), "Google");
  assert.equal(reviewedOrganizationForDomain("stats.g.doubleclick.net"), "Google");
  assert.deepEqual(reviewedOwnershipRelationship("youtube.com", "stats.g.doubleclick.net"), {
    kind: "same-organization",
    organization: "Google"
  });
});

test("ownership never infers an outside organization from an unreviewed domain", () => {
  assert.deepEqual(reviewedOwnershipRelationship("youtube.com", "collector.example"), {
    kind: "unreviewed",
    subjectOrganization: "Google",
    recipientOrganization: null
  });
  assert.deepEqual(reviewedOwnershipRelationship("example.com", "collector.example"), {
    kind: "unreviewed",
    subjectOrganization: null,
    recipientOrganization: null
  });
});

test("ownership records retain authoritative sources and explicit mapping limits", () => {
  assert.equal(REVIEWED_OWNERSHIP_VERSION, "reviewed-ownership-v1");
  const records = reviewedOwnershipRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.source.url),
    [
      "https://support.google.com/youtube/answer/69961?hl=en",
      "https://help.x.com/en/using-x/x-videos"
    ]
  );
  assert.equal(records.every((record) => record.limitations.includes("maintainer-reviewed mapping")), true);
  assert.equal(records.every((record) => record.reviewedAt === "2026-07-28"), true);
});
