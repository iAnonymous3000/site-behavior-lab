import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { KEYSTROKE_PROBE_REQUESTS_OMITTED_WARNING_FRAGMENT, runHitKeystrokeProbeRequestsOmitted } from "./comparison-eligibility";
import { redactScanResultV1 } from "./redact-scan-report-v1";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { typingProbeRecord } from "./typing-disclosure";
import type { ScanResult } from "./types";

// Every admitted form of the disclosure, as lib/fv-warning-fragments.test.ts
// builds them: both generations, at 1, 2 and 1000 fields, with each ending.
const FIELD_COUNTS: ReadonlyArray<[string, number]> = [["1 form field", 1], ["2 form fields", 2], ["1000 form fields", 1000]];
const typedCurrent = (fields: string, tail: string) =>
  `This scan typed a synthetic test value into ${fields} with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. ${tail}`;
const typedHistorical = (fields: string, tail: string) =>
  `This scan typed a synthetic test value into ${fields} (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored.${tail}`;
const ADMITTED: ReadonlyArray<[string, number]> = FIELD_COUNTS.flatMap(([fields, count]) =>
  [
    typedCurrent(fields, KEYSTROKE_PROBE_REQUESTS_OMITTED_WARNING_FRAGMENT),
    typedCurrent(fields, "Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured."),
    typedHistorical(fields, ` ${KEYSTROKE_PROBE_REQUESTS_OMITTED_WARNING_FRAGMENT}`),
    typedHistorical(fields, " Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts."),
    typedHistorical(fields, "")
  ].map((form): [string, number] => [form, count])
);

function admitted(warning: string): string {
  const result = makeScanReportV1() as ScanResult;
  result.warnings = [warning];
  return (redactScanResultV1(result).report as ScanResult).warnings[0];
}

test("every admitted typing disclosure reads its field count, and omitted exactly when the comparison check reads it", () => {
  let omitted = 0;
  for (const [form, fields] of ADMITTED) {
    // Only a sentence the sanitizer admits as written is one a report can carry.
    assert.equal(admitted(form), form, "the sanitizer admits the disclosure as written");
    const record = typingProbeRecord({ warnings: [form] });
    assert.ok(record, form);
    assert.equal(record.fields, fields, form);
    assert.equal(record.requestsOmitted, runHitKeystrokeProbeRequestsOmitted({ warnings: [form] }), form);
    if (record.requestsOmitted) omitted += 1;
  }
  // Both answers occur, so the equality above is not held by one constant.
  assert.equal(omitted, FIELD_COUNTS.length * 2);
});

test("an ending this reader has not seen leaves the probe's requests counted, never omitted or absent", () => {
  const record = typingProbeRecord({ warnings: ["This scan typed a synthetic test value into 3 form fields and ended a new way."] });
  assert.deepEqual(record, { fields: 3, requestsOmitted: false });
  assert.equal(typingProbeRecord({ warnings: ["A warning about something else."] }), null);
  assert.equal(typingProbeRecord({ warnings: [] }), null);
});

/** Non-test source files under the given roots. */
function sources(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry) && !/\.test\./.test(entry)) found.push(full);
    }
  };
  for (const root of roots) walk(path.join(process.cwd(), root));
  return found;
}

test("the typing disclosure is written or read only by the scanner, the sanitizer, the comparison check and this reader", () => {
  const holders = sources("lib", "app", "scripts")
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("This scan typed a synthetic test value") || text.includes("Requests from this incomplete probe were omitted");
    })
    .map((file) => path.relative(process.cwd(), file))
    .sort();
  assert.ok(holders.length > 0, "no source holds the disclosure, so this comparison would hold vacuously");
  assert.deepEqual(holders, [
    "lib/comparison-eligibility.ts",
    "lib/redact-scan-report-v1.ts",
    "lib/scanner.ts",
    "lib/typing-disclosure.ts"
  ]);
});
