import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_REASON_CODES,
  DETECTOR_STATUS_REASON_CODES,
  detectorStatusReasonIsValid,
  isDetectorReasonCode,
  isDetectorReasonForStatus
} from "./detector-status-contract";
import type { DetectorStatus } from "./scan-report-v2";
import { isScanRunV2 } from "./scan-report-v2-validation";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";

const STATUSES: readonly DetectorStatus[] = [
  "complete",
  "partial",
  "skipped",
  "unsupported",
  "failed"
];

test("detector status/reason contract covers the complete cross-product", () => {
  const reasons: readonly (string | undefined)[] = [
    undefined,
    ...DETECTOR_REASON_CODES,
    "invented-reason"
  ];

  for (const status of STATUSES) {
    for (const reason of reasons) {
      const expected =
        status === "complete"
          ? reason === undefined
          : typeof reason === "string" &&
            isDetectorReasonCode(reason) &&
            (DETECTOR_STATUS_REASON_CODES[status] as readonly string[]).includes(reason);
      assert.equal(
        detectorStatusReasonIsValid({ status, reason }),
        expected,
        `${status}/${reason ?? "(absent)"}`
      );
      if (typeof reason === "string") {
        const compatibleReasons =
          status === "complete"
            ? []
            : (DETECTOR_STATUS_REASON_CODES[status] as readonly string[]);
        assert.equal(
          isDetectorReasonForStatus(status, reason),
          compatibleReasons.includes(reason),
          `${status}/${reason}`
        );
      }
    }
  }
});

test("the generic structural reader enforces reason presence and compatibility", () => {
  const cases: Array<{
    status: DetectorStatus;
    reason?: string;
    valid: boolean;
  }> = [
    { status: "complete", valid: true },
    { status: "complete", reason: "scan-failed", valid: false },
    { status: "partial", valid: false },
    { status: "partial", reason: "unsupported", valid: false },
    { status: "partial", reason: "evidence-cap-reached", valid: true },
    { status: "skipped", reason: "evidence-cap-reached", valid: true },
    { status: "unsupported", reason: "unsupported", valid: true },
    { status: "failed", reason: "scan-failed", valid: true }
  ];

  for (const fixture of cases) {
    const run = makeScanRunV2R2();
    run.detectors["cname-uncloaking"] = {
      version: run.detectors["cname-uncloaking"].version,
      status: fixture.status,
      ...(fixture.reason === undefined ? {} : { reason: fixture.reason }),
      phaseId: 0
    };
    assert.equal(
      isScanRunV2(run, 2),
      fixture.valid,
      `${fixture.status}/${fixture.reason ?? "(absent)"}`
    );
  }
});
