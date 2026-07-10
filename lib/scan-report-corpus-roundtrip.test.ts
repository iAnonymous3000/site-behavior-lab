/**
 * The committed-corpus round-trip gate: every published report must read
 * through the version-aware reader and project through the persistence
 * boundary without data loss (screenshots aside, which persisted reports
 * already store as null). Guards the exhaustive v1 guard and the deep v1
 * projector against regressions using the full real corpus.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readStoredScanReport } from "./scan-report-reader";
import { readScanTransportPayload, publicWireForExportOrPersistence } from "./scan-report-view";

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

test("every committed report reads and projects without data loss", () => {
  let files: string[] = [];
  try {
    files = readdirSync(reportsDir).filter((name) => reportFilePattern.test(name));
  } catch {
    // A checkout without the committed corpus has nothing to gate.
    return;
  }
  assert.equal(files.length > 0, true, "expected a committed corpus");

  let projected = 0;
  for (const name of files) {
    const raw = JSON.parse(readFileSync(path.join(reportsDir, name), "utf8"));
    const read = readStoredScanReport(raw);
    assert.equal(read.ok, true, `reader rejected committed report ${name}`);

    const transport = readScanTransportPayload(raw);
    assert.equal(transport.kind, "report", `transport rejected committed report ${name}`);
    if (transport.kind !== "report") continue;

    const wire = publicWireForExportOrPersistence(transport.loaded) as Record<string, unknown>;
    const expected = structuredClone(raw) as Record<string, unknown>;
    // Persisted reports already carry null screenshots; normalize anyway so
    // the gate keeps holding if an inline screenshot ever slips into git.
    if (expected.reportType === "comparison") {
      (expected.baseline as Record<string, unknown>).screenshot = null;
      (expected.variant as Record<string, unknown>).screenshot = null;
    } else {
      expected.screenshot = null;
    }
    assert.deepEqual(wire, expected, `projection lost data for ${name}`);
    projected += 1;
  }
  assert.equal(projected, files.length);
});
