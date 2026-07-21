import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedScanJobProgress, readScanJobProgress, scanJobProgressCopy } from "./scan-job-progress";

test("scan progress accepts only the six bounded server stages", () => {
  assert.deepEqual(readScanJobProgress({ phase: "queued", completedRuns: 0, totalRuns: 1 }), {
    phase: "queued",
    completedRuns: 0,
    totalRuns: 1
  });
  assert.deepEqual(readScanJobProgress({ phase: "navigating", completedRuns: 1, totalRuns: 2 }), {
    phase: "navigating",
    completedRuns: 1,
    totalRuns: 2
  });

  for (const value of [
    { phase: "almost-done", completedRuns: 0, totalRuns: 1 },
    { phase: "saving", completedRuns: 3, totalRuns: 2 },
    { phase: "saving", completedRuns: 1.5, totalRuns: 2 },
    { phase: "saving", completedRuns: 1, totalRuns: 99 },
    { phase: "saving", completedRuns: 1, totalRuns: 1, percent: 99 }
  ]) {
    assert.equal(readScanJobProgress(value), null);
  }
});

test("scan progress copy names observed work without percentages or estimates", () => {
  const submitting = scanJobProgressCopy(null);
  assert.equal(submitting.title, "Submitting scan request");
  assert.match(submitting.detail, /confirm the request/);
  assert.doesNotMatch(`${submitting.title} ${submitting.detail}`, /accepted/i);

  const accepted = scanJobProgressCopy(acceptedScanJobProgress(2));
  assert.equal(accepted.title, "Scan accepted and queued");
  assert.equal(accepted.completedRuns, null, "run counts begin with coordinator progress, not admission");

  const navigating = scanJobProgressCopy({ phase: "navigating", completedRuns: 1, totalRuns: 2 });
  assert.match(navigating.title, /Loading the requested page/);
  assert.equal(navigating.completedRuns, "1 of 2 controlled visits completed.");

  const saving = scanJobProgressCopy({ phase: "saving", completedRuns: 1, totalRuns: 1 });
  assert.match(saving.detail, /being persisted/);
  assert.doesNotMatch(
    [submitting.title, submitting.detail, accepted.title, accepted.detail, navigating.title, navigating.detail, navigating.completedRuns, saving.title, saving.detail, saving.completedRuns].join(" "),
    /%|\bETA\b|usually|seconds|minutes/i
  );
});
