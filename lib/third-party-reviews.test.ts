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
  schemaVersion: 1,
  artifactKind: "deterministic-third-party-inventory-and-notice-evidence",
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
  },
  downloadedTools: [
    {
      id: "github-cli",
      name: "GitHub CLI",
      version: "2.96.0",
      sourceUrl: "https://github.com/cli/cli/releases/tag/v2.96.0",
      license: "MIT",
      usage: "build-only",
      runtime: false,
      redistributed: false
    }
  ]
};

test("sync creates unreviewed rows for third-party items only and preserves reviews verbatim", async () => {
  const { syncReviewLedger } = await reviewsLib();
  const first = syncReviewLedger(INVENTORY, null);
  assert.deepEqual(
    first.ledger.reviews.map((row: { key: string }) => row.key).sort(),
    [
      "cargo:adblock@0.13.2",
      "downloaded-tool:github-cli@2.96.0",
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
  assert.deepEqual(
    first.ledger.reviews.find(
      (row: { key: string }) => row.key === "downloaded-tool:github-cli@2.96.0"
    ),
    {
      key: "downloaded-tool:github-cli@2.96.0",
      ecosystem: "downloaded-tool",
      name: "GitHub CLI",
      version: "2.96.0",
      runtime: false,
      status: "unreviewed",
      declaredLicense: "MIT",
      determinedLicense: null,
      obligations: [],
      reviewer: null,
      reviewedAt: null,
      notes: null,
      redistributed: false,
      usage: "build-only",
      sourceUrl: "https://github.com/cli/cli/releases/tag/v2.96.0"
    }
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
  assert.equal(partial.problems.some((problem: string) => /reviewer must be/.test(problem)), true);
});

test("reviewed rows require canonical substantive metadata", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);
  const reviewed = structuredClone(ledger);
  const row = reviewed.reviews.find((candidate: { key: string }) => candidate.key === "npm:left-pad@1.0.0");
  Object.assign(row, {
    status: "reviewed",
    reviewer: "iAnonymous3000",
    reviewedAt: "2026-08-01",
    determinedLicense: "MIT",
    obligations: []
  });
  const valid = checkReviewLedger(INVENTORY, reviewed);
  assert.equal(valid.ok, true, valid.problems.join("; "));
  assert.equal(valid.summary.npm.reviewed, 1);
  assert.equal(valid.summary.npm.unreviewedRuntime, 0);

  const mutations: [string, unknown, RegExp][] = [
    ["reviewer", " iAnonymous3000 ", /reviewer must be/],
    ["reviewer", null, /reviewer must be/],
    ["reviewedAt", "not-a-date", /canonical YYYY-MM-DD/],
    ["reviewedAt", "2026-02-30", /canonical YYYY-MM-DD/],
    ["reviewedAt", "2026-8-1", /canonical YYYY-MM-DD/],
    ["reviewedAt", "9999-12-31", /cannot be in the future/],
    ["determinedLicense", "?", /meaningful, non-placeholder/],
    ["determinedLicense", "---", /meaningful, non-placeholder/],
    ["determinedLicense", "UNKNOWN pending review", /meaningful, non-placeholder/],
    ["determinedLicense", " MIT ", /meaningful, non-placeholder/],
    ["determinedLicense", "M".repeat(513), /meaningful, non-placeholder/],
    ["determinedLicense", null, /meaningful, non-placeholder/],
    ["obligations", [null], /every obligation must be/],
    ["obligations", [""], /every obligation must be/],
    ["obligations", [" notice-file "], /every obligation must be/],
    ["obligations", ["n".repeat(513)], /every obligation must be/],
    ["obligations", ["notice-file", "notice-file"], /duplicate entry/],
    ["obligations", Array.from({ length: 65 }, (_, index) => `obligation-${index}`), /at most 64/],
    ["obligations", null, /obligations must be an array/]
  ];
  for (const [field, value, expected] of mutations) {
    const malformed = structuredClone(reviewed);
    const target = malformed.reviews.find(
      (candidate: { key: string }) => candidate.key === "npm:left-pad@1.0.0"
    );
    target[field] = value;
    const verdict = checkReviewLedger(INVENTORY, malformed);
    assert.equal(verdict.ok, false, `${field}=${JSON.stringify(value)} should fail`);
    assert.match(verdict.problems.join(" "), expected);
    assert.equal(verdict.summary.npm.reviewed, 0);
    assert.equal(verdict.summary.npm.unreviewedRuntime, 1);
  }
});

test("review ledger rejects malformed and duplicate rows without throwing", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);

  const malformed = structuredClone(ledger);
  malformed.reviews.push(null);
  malformed.reviews.push(structuredClone(malformed.reviews[0]));
  const verdict = checkReviewLedger(INVENTORY, malformed);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.some((problem: string) => /must be an object/.test(problem)), true);
  assert.equal(verdict.problems.some((problem: string) => /duplicate ledger row/.test(problem)), true);
});

test("review ledger binds both artifact schemas and every copied inventory identity field", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);

  const wrongLedgerSchema = structuredClone(ledger);
  delete wrongLedgerSchema.schemaVersion;
  assert.match(
    checkReviewLedger(INVENTORY, wrongLedgerSchema).problems.join(" "),
    /review ledger schemaVersion/
  );

  const wrongInventorySchema = structuredClone(INVENTORY);
  wrongInventorySchema.artifactKind = "not-the-inventory";
  assert.match(
    checkReviewLedger(wrongInventorySchema, ledger).problems.join(" "),
    /third-party inventory artifactKind/
  );

  for (const [field, value] of [
    ["ecosystem", "cargo"],
    ["name", "another-package"],
    ["version", "9.9.9"],
    ["declaredLicense", "Apache-2.0"]
  ] as const) {
    const doctored = structuredClone(ledger);
    const row = doctored.reviews.find(
      (candidate: { key: string }) => candidate.key === "npm:left-pad@1.0.0"
    );
    row[field] = value;
    const verdict = checkReviewLedger(INVENTORY, doctored);
    assert.equal(verdict.ok, false, `${field} drift must fail`);
    assert.match(verdict.problems.join(" "), new RegExp(`declares ${field}=`));
  }
});

test("a hand-edited runtime flag is drift, not opinion", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);
  const doctored = structuredClone(ledger);
  const runtimeRow = doctored.reviews.find((row: { key: string }) => row.key === "npm:left-pad@1.0.0");
  runtimeRow.runtime = false;
  const verdict = checkReviewLedger(INVENTORY, doctored);
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.problems.some((problem: string) => /declares runtime=false but the inventory says true/.test(problem)),
    true
  );
});

test("downloaded build-tool scope and redistribution posture are inventory truth", async () => {
  const { syncReviewLedger, checkReviewLedger } = await reviewsLib();
  const { ledger } = syncReviewLedger(INVENTORY, null);
  for (const [field, value] of [
    ["redistributed", true],
    ["usage", "runtime"],
    ["sourceUrl", "https://example.invalid/not-the-release"]
  ] as const) {
    const doctored = structuredClone(ledger);
    const row = doctored.reviews.find(
      (candidate: { key: string }) => candidate.key === "downloaded-tool:github-cli@2.96.0"
    );
    row[field] = value;
    const verdict = checkReviewLedger(INVENTORY, doctored);
    assert.equal(verdict.ok, false, `${field} drift must fail`);
    assert.match(verdict.problems.join(" "), new RegExp(`declares ${field}=`));
  }
});

test("the committed ledger is in sync with the committed inventory", async () => {
  const { checkReviewLedger } = await reviewsLib();
  const inventory = JSON.parse(readFileSync(path.join(process.cwd(), "THIRD_PARTY_INVENTORY.json"), "utf8"));
  const ledger = JSON.parse(readFileSync(path.join(process.cwd(), "THIRD_PARTY_REVIEWS.json"), "utf8"));
  const verdict = checkReviewLedger(inventory, ledger);
  assert.equal(verdict.ok, true, verdict.problems.slice(0, 3).join("; "));

  // Derived from the committed inventory, not restated. These were four frozen
  // literals, and every dependency bump that changed a package count failed
  // here with `actual: 155, expected: 149` and no hint that the number was
  // simply out of date. The invariant worth asserting is that the ledger's view
  // of each ecosystem counts exactly what the inventory declares, and that one
  // cannot go stale.
  const ecosystems = [
    ["npm", "npm"],
    ["cargo", "cargo"],
    ["filter-list", "filterLists"],
    ["downloaded-tool", "downloadedTools"]
  ] as const;

  for (const [ledgerKey, inventoryKey] of ecosystems) {
    const declared = inventory.summary?.[inventoryKey]?.total;
    // Both sides must be real counts. Comparing two `undefined`s would pass
    // while asserting nothing, which is how a renamed summary key would slip
    // through and quietly empty this test.
    assert.equal(
      typeof declared,
      "number",
      `the inventory must declare a ${inventoryKey} total for this comparison to mean anything`
    );
    assert.ok(declared > 0, `${inventoryKey} total should be a positive count, got ${declared}`);
    assert.equal(
      verdict.summary[ledgerKey]?.total,
      declared,
      `the ledger counts a different number of ${ledgerKey} items than the inventory declares`
    );
  }
});
