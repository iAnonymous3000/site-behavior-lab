import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  accountR2RemediationInventoryPage,
  EMPTY_R2_REMEDIATION_INVENTORY_USAGE,
  R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES,
  R2_REMEDIATION_INVENTORY_MAX_OBJECTS,
  R2_REMEDIATION_INVENTORY_MAX_PAGES,
  R2_REMEDIATION_REPORT_MAX_BYTES,
  R2_REMEDIATION_SIDECAR_MAX_BYTES,
  R2RemediationDecodeError,
  R2RemediationResourceLimitError,
  readR2RemediationObjectText
} from "./r2-remediation-resource-limits";

test("R2 remediation rejects an oversized report before reading its body", async () => {
  let reads = 0;
  await assert.rejects(
    readR2RemediationObjectText(
      {
        size: R2_REMEDIATION_REPORT_MAX_BYTES + 1,
        async arrayBuffer() {
          reads += 1;
          return new ArrayBuffer(0);
        }
      },
      "report"
    ),
    (error: unknown) =>
      error instanceof R2RemediationResourceLimitError && error.resource === "report-object"
  );
  assert.equal(reads, 0);
});

test("R2 remediation rejects an oversized sidecar before reading its body", async () => {
  let reads = 0;
  await assert.rejects(
    readR2RemediationObjectText(
      {
        size: R2_REMEDIATION_SIDECAR_MAX_BYTES + 1,
        async arrayBuffer() {
          reads += 1;
          return new ArrayBuffer(0);
        }
      },
      "sidecar"
    ),
    (error: unknown) =>
      error instanceof R2RemediationResourceLimitError && error.resource === "sidecar-object"
  );
  assert.equal(reads, 0);
});

test("R2 remediation preserves exact-size valid UTF-8 reads", async () => {
  let reads = 0;
  const bytes = new TextEncoder().encode("{}");
  const arrayBuffer = async () => {
    reads += 1;
    return bytes.slice().buffer;
  };

  assert.equal(
    await readR2RemediationObjectText({ size: bytes.byteLength, arrayBuffer }, "report"),
    "{}"
  );
  assert.equal(
    await readR2RemediationObjectText({ size: bytes.byteLength, arrayBuffer }, "sidecar"),
    "{}"
  );
  assert.equal(reads, 2);
});

test("R2 remediation preserves a leading BOM for strict JSON rejection", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  for (const kind of ["report", "sidecar"] as const) {
    assert.equal(
      await readR2RemediationObjectText(
        { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } },
        kind
      ),
      "\uFEFF{}"
    );
  }
});

test("R2 remediation rejects invalid object sizes before reading", async () => {
  for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let reads = 0;
    await assert.rejects(
      readR2RemediationObjectText(
        {
          size,
          async arrayBuffer() {
            reads += 1;
            return new ArrayBuffer(0);
          }
        },
        "report"
      ),
      R2RemediationResourceLimitError
    );
    assert.equal(reads, 0);
  }
});

test("R2 remediation rejects declared and returned byte-count disagreement", async () => {
  for (const kind of ["report", "sidecar"] as const) {
    await assert.rejects(
      readR2RemediationObjectText(
        { size: 1, async arrayBuffer() { return new Uint8Array([0x7b, 0x7d]).buffer; } },
        kind
      ),
      (error: unknown) =>
        error instanceof R2RemediationResourceLimitError &&
        error.resource === (kind === "report" ? "report-object" : "sidecar-object")
    );
  }
});

test("R2 remediation rejects malformed UTF-8 report and sidecar bytes", async () => {
  const malformed = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const kind of ["report", "sidecar"] as const) {
    await assert.rejects(
      readR2RemediationObjectText(
        { size: malformed.byteLength, async arrayBuffer() { return malformed.slice().buffer; } },
        kind
      ),
      (error: unknown) => error instanceof R2RemediationDecodeError && error.kind === kind
    );
  }
});

test("R2 remediation inventory accounting preserves finite legitimate pages", () => {
  const first = accountR2RemediationInventoryPage(EMPTY_R2_REMEDIATION_INVENTORY_USAGE, [
    "reports/20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    "reports/20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.provenance.json"
  ]);
  const second = accountR2RemediationInventoryPage(first, ["reports/unknown"]);

  assert.deepEqual(second, {
    pages: 2,
    objects: 3,
    keyBytes: new TextEncoder().encode(
      "reports/20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json" +
        "reports/20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.provenance.json" +
        "reports/unknown"
    ).byteLength
  });
});

test("R2 remediation inventory preserves the exact aggregate ceilings", () => {
  assert.deepEqual(
    accountR2RemediationInventoryPage(
      {
        pages: R2_REMEDIATION_INVENTORY_MAX_PAGES - 1,
        objects: R2_REMEDIATION_INVENTORY_MAX_OBJECTS - 1,
        keyBytes: R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES - 1
      },
      ["x"]
    ),
    {
      pages: R2_REMEDIATION_INVENTORY_MAX_PAGES,
      objects: R2_REMEDIATION_INVENTORY_MAX_OBJECTS,
      keyBytes: R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES
    }
  );
});

test("R2 remediation inventory fails closed at the page ceiling", () => {
  assert.throws(
    () =>
      accountR2RemediationInventoryPage(
        { pages: R2_REMEDIATION_INVENTORY_MAX_PAGES, objects: 0, keyBytes: 0 },
        []
      ),
    (error: unknown) =>
      error instanceof R2RemediationResourceLimitError && error.resource === "inventory-pages"
  );
});

test("R2 remediation inventory fails closed at the object ceiling", () => {
  assert.throws(
    () =>
      accountR2RemediationInventoryPage(
        { pages: 0, objects: R2_REMEDIATION_INVENTORY_MAX_OBJECTS, keyBytes: 0 },
        ["reports/next"]
      ),
    (error: unknown) =>
      error instanceof R2RemediationResourceLimitError && error.resource === "inventory-objects"
  );
});

test("R2 remediation inventory fails closed at the aggregate UTF-8 key-byte ceiling", () => {
  assert.throws(
    () =>
      accountR2RemediationInventoryPage(
        { pages: 0, objects: 0, keyBytes: R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES - 1 },
        ["é"]
      ),
    (error: unknown) =>
      error instanceof R2RemediationResourceLimitError && error.resource === "inventory-key-bytes"
  );
});

test("the privileged remediation Worker wires every R2 body read and list page through the limits", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare", "r2-remediation-worker.ts"), "utf8");

  assert.doesNotMatch(source, /\.(?:text|json|arrayBuffer)\s*\(/);
  assert.equal(source.match(/await readR2RemediationObjectText\(/g)?.length, 6);
  assert.match(source, /limit: R2_REMEDIATION_LIST_PAGE_SIZE/);
  assert.match(source, /usage = accountR2RemediationInventoryPage\(usage, pageKeys\);\s+keys\.push\(\.\.\.pageKeys\);/);
  assert.match(source, /seenCursors\.has\(nextCursor\)/);
  assert.match(
    source,
    /reportContents !== expectedReportWire \|\| sidecarContents !== expectedSidecarWire/
  );
});
