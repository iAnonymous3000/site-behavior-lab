import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function reviewsLib() {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", "third-party-reviews-lib.mjs")).href
  );
}

const INVENTORY = {
  npm: [
    { name: "left-pad", version: "1.0.0", license: "MIT", developmentOnly: false },
    { name: "dev-tool", version: "2.0.0", license: "ISC", developmentOnly: true }
  ],
  cargo: [
    { name: "adblock", version: "0.13.2", kind: "third-party", license: "UNKNOWN" },
    { name: "sbl-adblock-wasm", version: "0.1.0", kind: "workspace", license: "UNKNOWN" }
  ],
  filterLists: {
    sources: [{ url: "https://lists.example/a.txt", sha256: "a".repeat(64), license: "UNKNOWN" }]
  }
};

test("sync creates unreviewed rows for third-party items only and preserves reviews verbatim", async () => {
  const { syncReviewLedger } = await reviewsLib();
  const first = syncReviewLedger(INVENTORY, null);
  assert.deepEqual(
    first.ledger.reviews.map((row: { key: string }) => row.key).sort(),
    [
      "cargo:adblock@0.13.2",
      "filter-list:https://lists.example/a.txt@sha256:" + "a".repeat(64),
      "npm:dev-tool@2.0.0",
      "npm:left-pad@1.0.0"
    ]
  );
  assert.equal(first.ledger.reviews.every((row: { status: string }) => row.status === "unreviewed"), true);
  assert.equal(
    first.ledger.reviews.find((row: { key: string }) => row.key === "npm:dev-tool@2.0.0")?.runtime,
    false
  );

  // A human review survives a resync; a version bump creates a NEW row.
  const reviewed = structuredClone(first.ledger);
  const target = reviewed.reviews.find((row: { key: string }) => row.key === "cargo:adblock@0.13.2");
  Object.assign(target, {
    status: "reviewed",
    reviewer: "iAnonymous3000",
    reviewedAt: "2026-08-01",
    determinedLicense: "MPL-2.0",
    obligations: ["source-availability"]
  });
  const bumped = structuredClone(INVENTORY);
  bumped.cargo[0] = { ...bumped.cargo[0], version: "0.14.0" };
  const resynced = syncReviewLedger(bumped, reviewed);
  assert.deepEqual(resynced.added, ["cargo:adblock@0.14.0"]);
  assert.deepEqual(resynced.removed, ["cargo:adblock@0.13.2"]);
  assert.equal(
    resynced.ledger.reviews.find((row: { key: string }) => row.key === "cargo:adblock@0.14.0")?.status,
    "unreviewed"
  );
});

test("check fails on drift and on incomplete reviewed rows, and summarizes coverage", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);
  const clean = checkReviewLedger(INVENTORY, ledger);
  assert.equal(clean.ok, true, clean.problems.join("; "));
  assert.deepEqual(clean.summary.npm, { total: 2, reviewed: 0, unreviewedRuntime: 1 });

  const bumped = structuredClone(INVENTORY);
  bumped.npm.push({ name: "new-dep", version: "1.0.0", license: "MIT", developmentOnly: false });
  const drifted = checkReviewLedger(bumped, ledger);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.problems.some((problem: string) => /missing ledger row: npm:new-dep@1\.0\.0/.test(problem)), true);

  const incomplete = structuredClone(ledger);
  incomplete.reviews[0].status = "reviewed";
  const partial = checkReviewLedger(INVENTORY, incomplete);
  assert.equal(partial.ok, false);
  assert.equal(partial.problems.some((problem: string) => /missing reviewer/.test(problem)), true);
});

test("the committed ledger is in sync with the committed inventory", async () => {
  const { checkReviewLedger } = await reviewsLib();
  const inventory = JSON.parse(readFileSync(path.join(process.cwd(), "THIRD_PARTY_INVENTORY.json"), "utf8"));
  const ledger = JSON.parse(readFileSync(path.join(process.cwd(), "THIRD_PARTY_REVIEWS.json"), "utf8"));
  const verdict = checkReviewLedger(inventory, ledger);
  assert.equal(verdict.ok, true, verdict.problems.slice(0, 3).join("; "));
  assert.equal(verdict.summary.npm.total, 148);
  assert.equal(verdict.summary.cargo.total, 68);
  assert.equal(verdict.summary["filter-list"].total, 31);
});
