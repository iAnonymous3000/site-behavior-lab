import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function inventoryLib() {
  return nativeImport(
    pathToFileURL(
      path.join(process.cwd(), "scripts", "container-image-package-inventory-lib.mjs")
    ).href
  );
}

function reviewsLib() {
  return nativeImport(
    pathToFileURL(
      path.join(process.cwd(), "scripts", "container-image-package-reviews-lib.mjs")
    ).href
  );
}

const REPOSITORY_EVIDENCE_REF =
  "repo:LICENSE#sha256=0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0";
const HTTPS_EVIDENCE_REF =
  `https://packages.ubuntu.com/noble/adduser#sha256=${"a".repeat(64)}`;

async function makeInventory() {
  const { packageEvidenceDigest, packageSetDigest } = await inventoryLib();
  const packages = [
    {
      key: "os:ubuntu:adduser@3.137ubuntu1#all",
      packageType: "ubuntu",
      name: "adduser",
      version: "3.137ubuntu1",
      architecture: "all",
      sourceName: "adduser",
      sourceVersion: "3.137ubuntu1",
      detectedLicenses: ["GPL-2.0-only", "GPL-2.0-or-later"]
    },
    {
      key: "os:ubuntu:base-files@13ubuntu10.3#amd64",
      packageType: "ubuntu",
      name: "base-files",
      version: "13ubuntu10.3",
      architecture: "amd64",
      sourceName: "base-files",
      sourceVersion: "13ubuntu10.3",
      detectedLicenses: []
    }
  ].map((pkg) => ({ ...pkg, evidenceDigest: packageEvidenceDigest(pkg) }));
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-container-image-package-inventory",
    source: { commit: "a".repeat(40) },
    image: {
      id: `sha256:${"b".repeat(64)}`,
      digest: "b".repeat(64),
      os: "linux",
      architecture: "amd64",
      rootfsLayers: [`sha256:${"c".repeat(64)}`]
    },
    scanner: {
      name: "trivy",
      version: "0.70.0",
      reportSchemaVersion: 2,
      scope: "os-packages",
      licenseMode: "standard"
    },
    summary: {
      packageCount: 2,
      packagesWithDetectedLicenses: 1,
      packagesWithoutDetectedLicenses: 1,
      classifiedLicenseFindingCount: 2
    },
    packageSetDigest: packageSetDigest(packages),
    packages
  };
}

test("sync seeds exact unreviewed rows without fabricating determinations", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const synced = syncContainerPackageReviewLedger(inventory, null);
  assert.deepEqual(synced.added, inventory.packages.map((pkg: { key: string }) => pkg.key));
  assert.deepEqual(synced.reset, []);
  assert.deepEqual(synced.removed, []);
  assert.equal(synced.ledger.inventoryPackageSetDigest, inventory.packageSetDigest);
  for (const row of synced.ledger.reviews) {
    assert.equal(row.status, "unreviewed");
    assert.equal(row.determinedLicense, null);
    assert.deepEqual(row.licenseEvidenceRefs, []);
    assert.deepEqual(row.obligations, []);
    assert.equal(row.reviewer, null);
    assert.equal(row.reviewedAt, null);
  }
  const verdict = checkContainerPackageReviewLedger(inventory, synced.ledger);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(verdict.complete, false);
  assert.deepEqual(verdict.summary, { total: 2, reviewed: 0, unreviewed: 2 });
});

test("reviewed rows require substantive metadata and obligation evidence", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);
  Object.assign(ledger.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only AND GPL-2.0-or-later",
    licenseEvidenceRefs: [
      HTTPS_EVIDENCE_REF,
      REPOSITORY_EVIDENCE_REF
    ],
    obligations: [
      {
        requirement: "Preserve the packaged copyright and license notices.",
        disposition: "satisfied",
        evidenceRefs: [REPOSITORY_EVIDENCE_REF]
      }
    ],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01",
    notes: "Determination is bound to the exact observed package evidence digest."
  });
  Object.assign(ledger.reviews[1], {
    status: "reviewed",
    determinedLicense: "Public-domain notices plus permissive component terms",
    licenseEvidenceRefs: [HTTPS_EVIDENCE_REF],
    obligations: [],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01",
    notes: null
  });
  const clean = checkContainerPackageReviewLedger(inventory, ledger, {
    now: "2026-08-01T23:59:59.000Z"
  });
  assert.equal(clean.ok, true, clean.problems.join("; "));
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.summary, { total: 2, reviewed: 2, unreviewed: 0 });

  const mutations: Array<[string, unknown, RegExp]> = [
    ["reviewer", " reviewer ", /reviewer must be/],
    ["reviewedAt", "2026-02-30", /canonical YYYY-MM-DD/],
    ["determinedLicense", "UNKNOWN", /meaningful, non-placeholder/],
    ["licenseEvidenceRefs", [], /must contain 1-32 authoritative evidence references/],
    ["licenseEvidenceRefs", ["x"], /repo:.*canonical HTTPS/],
    ["obligations", [{}], /requirement|disposition|evidenceRefs/],
    [
      "obligations",
      [
        {
          requirement: "Notice",
          disposition: "pending",
          evidenceRefs: [REPOSITORY_EVIDENCE_REF]
        }
      ],
      /disposition must be/
    ],
    [
      "obligations",
      [
        {
          requirement: "Notice",
          disposition: "satisfied",
          evidenceRefs: []
        }
      ],
      /evidenceRefs must contain/
    ]
  ];
  for (const [field, value, expected] of mutations) {
    const malformed = structuredClone(ledger);
    malformed.reviews[0][field] = value;
    const verdict = checkContainerPackageReviewLedger(inventory, malformed, {
      now: "2026-08-01T23:59:59.000Z"
    });
    assert.equal(verdict.ok, false, field);
    assert.match(verdict.problems.join(" "), expected);
    assert.equal(verdict.complete, false);
  }
});

test("review dates cannot be future-dated and validation has an explicit clock seam", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);
  Object.assign(ledger.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only",
    licenseEvidenceRefs: [REPOSITORY_EVIDENCE_REF],
    obligations: [],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-02"
  });
  const future = checkContainerPackageReviewLedger(inventory, ledger, {
    now: "2026-08-01T23:59:59.000Z"
  });
  assert.equal(future.ok, false);
  assert.match(future.problems.join(" "), /must not be in the future relative to 2026-08-01/);

  const nextDay = checkContainerPackageReviewLedger(inventory, ledger, {
    now: "2026-08-02T00:00:00.000Z"
  });
  assert.equal(nextDay.ok, true, nextDay.problems.join("; "));

  const invalidClock = checkContainerPackageReviewLedger(inventory, ledger, {
    now: "not-an-instant"
  });
  assert.equal(invalidClock.ok, false);
  assert.match(invalidClock.problems.join(" "), /now must identify a valid instant/);
});

test("package evidence drift resets a prior determination to unreviewed", async () => {
  const { packageEvidenceDigest, packageSetDigest } = await inventoryLib();
  const { syncContainerPackageReviewLedger } = await reviewsLib();
  const inventory = await makeInventory();
  const first = syncContainerPackageReviewLedger(inventory, null);
  Object.assign(first.ledger.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only",
    licenseEvidenceRefs: [REPOSITORY_EVIDENCE_REF],
    obligations: [],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01"
  });

  const changed = structuredClone(inventory);
  changed.packages[0].detectedLicenses = ["GPL-2.0-only", "MIT"];
  changed.packages[0].evidenceDigest = packageEvidenceDigest(changed.packages[0]);
  changed.packageSetDigest = packageSetDigest(changed.packages);
  const second = syncContainerPackageReviewLedger(changed, first.ledger);
  assert.deepEqual(second.reset, [changed.packages[0].key]);
  assert.equal(second.ledger.reviews[0].status, "unreviewed");
  assert.equal(second.ledger.reviews[0].determinedLicense, null);
});

test("sync repairs a noncanonical unreviewed row but never discards a reviewed row", async () => {
  const { syncContainerPackageReviewLedger } = await reviewsLib();
  const inventory = await makeInventory();
  const first = syncContainerPackageReviewLedger(inventory, null);

  const unreviewedLegacy = structuredClone(first.ledger);
  delete unreviewedLegacy.reviews[0].licenseEvidenceRefs;
  const repaired = syncContainerPackageReviewLedger(inventory, unreviewedLegacy);
  assert.deepEqual(repaired.reset, [inventory.packages[0].key]);
  assert.deepEqual(repaired.ledger.reviews[0].licenseEvidenceRefs, []);

  const reviewedLegacy = structuredClone(first.ledger);
  Object.assign(reviewedLegacy.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only",
    obligations: [],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01"
  });
  delete reviewedLegacy.reviews[0].licenseEvidenceRefs;
  assert.throws(
    () => syncContainerPackageReviewLedger(inventory, reviewedLegacy),
    /refusing to discard a reviewed row/
  );
});

test("check fails closed on missing, orphaned, duplicate, and stale review coverage", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);

  const missing = structuredClone(ledger);
  missing.reviews.pop();
  assert.match(
    checkContainerPackageReviewLedger(inventory, missing).problems.join(" "),
    /missing review row/
  );

  const orphaned = structuredClone(ledger);
  orphaned.reviews.push({
    ...structuredClone(orphaned.reviews[0]),
    key: "os:ubuntu:removed@1.0#amd64"
  });
  assert.match(
    checkContainerPackageReviewLedger(inventory, orphaned).problems.join(" "),
    /orphaned review row/
  );

  const duplicate = structuredClone(ledger);
  duplicate.reviews.push(structuredClone(duplicate.reviews[0]));
  assert.match(
    checkContainerPackageReviewLedger(inventory, duplicate).problems.join(" "),
    /duplicate review row/
  );

  const stale = structuredClone(ledger);
  stale.reviews[0].inventoryEvidenceDigest = "0".repeat(64);
  assert.match(
    checkContainerPackageReviewLedger(inventory, stale).problems.join(" "),
    /does not match the package evidence digest/
  );
});

test("ledger, row, and obligation objects reject extra unverifiable claims", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);

  const topLevel = structuredClone(ledger);
  topLevel.unverifiedClaim = true;
  assert.match(
    checkContainerPackageReviewLedger(inventory, topLevel).problems.join(" "),
    /review ledger must contain exactly the canonical fields/
  );

  const rowExtra = structuredClone(ledger);
  rowExtra.reviews[0].unverifiedClaim = true;
  assert.match(
    checkContainerPackageReviewLedger(inventory, rowExtra).problems.join(" "),
    /review row .* must contain exactly the canonical fields/
  );

  const obligationExtra = structuredClone(ledger);
  Object.assign(obligationExtra.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only",
    licenseEvidenceRefs: [REPOSITORY_EVIDENCE_REF],
    obligations: [
      {
        requirement: "Preserve notice.",
        disposition: "satisfied",
        evidenceRefs: [REPOSITORY_EVIDENCE_REF],
        unverifiedClaim: true
      }
    ],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01"
  });
  assert.match(
    checkContainerPackageReviewLedger(inventory, obligationExtra, {
      now: "2026-08-01T23:59:59.000Z"
    }).problems.join(" "),
    /obligation 0 must contain exactly the canonical fields/
  );
});

test("unreviewed rows cannot smuggle partial legal conclusions", async () => {
  const { syncContainerPackageReviewLedger, checkContainerPackageReviewLedger } =
    await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);
  ledger.reviews[0].determinedLicense = "MIT";
  ledger.reviews[0].reviewer = "Someone";
  const verdict = checkContainerPackageReviewLedger(inventory, ledger);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /must remain null while status is unreviewed/);
});

test("review CLI syncs and checks a caller-selected ledger without requiring completeness", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "sbl-container-reviews-"));
  const inventory = await makeInventory();
  const inventoryPath = path.join(temp, "inventory.json");
  const ledgerPath = path.join(temp, "reviews.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const script = path.join(
    process.cwd(),
    "scripts",
    "container-image-package-reviews.mjs"
  );
  const sync = spawnSync(
    process.execPath,
    [script, "--sync", "--inventory", inventoryPath, "--ledger", ledgerPath],
    { encoding: "utf8" }
  );
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).reviews.length, 2);

  const check = spawnSync(
    process.execPath,
    [script, "--check", "--inventory", inventoryPath, "--ledger", ledgerPath],
    { encoding: "utf8" }
  );
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /0\/2 reviewed/);
  assert.match(check.stdout, /legal review incomplete/);
});

test("readiness validator returns exact candidate, image, inventory, and package-set bindings", async () => {
  const { serializeContainerImagePackageInventory } = await inventoryLib();
  const {
    syncContainerPackageReviewLedger,
    validateContainerPackageReviewReadiness
  } = await reviewsLib();
  const inventory = await makeInventory();
  const { ledger } = syncContainerPackageReviewLedger(inventory, null);
  const incomplete = validateContainerPackageReviewReadiness(inventory, ledger, {
    now: "2026-08-01T00:00:00.000Z"
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.complete, false);
  assert.match(incomplete.problems.join(" "), /2 exact-image OS package review/);
  assert.deepEqual(incomplete.bindings, {
    candidateCommit: inventory.source.commit,
    containerImageDigest: inventory.image.digest,
    containerImageId: inventory.image.id,
    packageInventoryDigest: createHash("sha256")
      .update(serializeContainerImagePackageInventory(inventory))
      .digest("hex"),
    packageSetDigest: inventory.packageSetDigest
  });

  for (const row of ledger.reviews) {
    Object.assign(row, {
      status: "reviewed",
      determinedLicense: "Reviewed package-specific license determination",
      licenseEvidenceRefs: [REPOSITORY_EVIDENCE_REF],
      obligations: [],
      reviewer: "Release legal reviewer",
      reviewedAt: "2026-08-01"
    });
  }
  const complete = validateContainerPackageReviewReadiness(inventory, ledger, {
    now: "2026-08-01T23:59:59.000Z"
  });
  assert.equal(complete.ok, true, complete.problems.join("; "));
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.problems, []);
});

test("committed container review ledger contains only observed unreviewed bootstrap rows", () => {
  const ledger = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "CONTAINER_IMAGE_PACKAGE_REVIEWS.json"),
      "utf8"
    )
  );
  assert.equal(
    ledger.artifactKind,
    "site-behavior-container-image-package-review-ledger"
  );
  assert.equal(ledger.schemaVersion, 1);
  assert.ok(ledger.reviews.length > 0);
  assert.equal(
    ledger.reviews.every(
      (row: {
        status: string;
        determinedLicense: null;
        licenseEvidenceRefs: unknown[];
        reviewer: null;
        reviewedAt: null;
        obligations: unknown[];
      }) =>
        row.status === "unreviewed" &&
        row.determinedLicense === null &&
        Array.isArray(row.licenseEvidenceRefs) &&
        row.licenseEvidenceRefs.length === 0 &&
        row.reviewer === null &&
        row.reviewedAt === null &&
        Array.isArray(row.obligations) &&
        row.obligations.length === 0
    ),
    true
  );
  assert.equal(
    ledger.reviews.some(
      (row: { key: string }) =>
        row.key.includes("gstreamer1.0-plugins-bad@") ||
        row.key.includes("libgstreamer-plugins-bad1.0-0@")
    ),
    false
  );
});

test("package scripts expose the exact-image inventory and review workflows", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  );
  assert.equal(
    manifest.scripts["supply-chain:container-inventory"],
    "node scripts/container-image-package-inventory.mjs"
  );
  assert.equal(
    manifest.scripts["supply-chain:container-reviews:sync"],
    "node scripts/container-image-package-reviews.mjs --sync"
  );
  assert.equal(
    manifest.scripts["supply-chain:container-reviews:check"],
    "node scripts/container-image-package-reviews.mjs --check"
  );
});
