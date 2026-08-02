import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

type Outcome =
  | {
      domain: string;
      status: "available";
      reportId: string;
      attemptCount: number;
    }
  | {
      domain: string;
      status: "unavailable";
      reason: string;
    }
  | {
      domain: string;
      status: "not-attempted";
    };

type Cycle = {
  schemaVersion: number;
  artifactKind: string;
  repository: string;
  workflow: string;
  actionsRun: {
    id: number;
    attempt: number;
    headSha: string;
    event: string;
    schedule: string;
  };
  catalog: {
    path: string;
    sha256: string;
    targetsSha256: string;
    version: number;
  };
  complete: boolean;
  outcomes: Outcome[];
};

type Receipt = {
  cycles: Array<{
    actionsRun: Cycle["actionsRun"];
    artifact: { id: number; name: string; sha256: string };
    catalog: Cycle["catalog"];
    complete: boolean;
    outcomes: Outcome[];
  }>;
  finalFeaturedSites: {
    path: string;
    sha256: string;
    targetsSha256: string;
    version: number;
  };
  dispositions: Array<Record<string, unknown>>;
};

type ReadjudicationModule = {
  FEATURED_READJUDICATION_ARTIFACT_FILE: string;
  FEATURED_READJUDICATION_CATALOG: string;
  FEATURED_READJUDICATION_DOMAINS: readonly string[];
  FEATURED_READJUDICATION_REPOSITORY: string;
  FEATURED_READJUDICATION_SCHEDULE: string;
  FEATURED_READJUDICATION_WORKFLOW: string;
  buildFeaturedReadjudicationCycle: (input: Record<string, unknown>) => Cycle;
  buildFeaturedReadjudicationReceipt: (input: Record<string, unknown>) => Receipt;
  canonicalFeaturedReadjudicationText: (value: unknown) => string;
  extractFeaturedReadjudicationArtifactZip: (bytes: Buffer) => Buffer;
  featuredReadjudicationActivationFreshnessIssues: (
    receipt: unknown,
    activatedAt: string
  ) => string[];
  featuredReadjudicationCatalogBinding: (bytes: Buffer) => {
    version: number;
    sha256: string;
    targetsSha256: string;
  };
  featuredReadjudicationCycleIssues: (cycle: unknown) => string[];
  featuredReadjudicationReceiptIssues: (
    receipt: unknown,
    featuredSitesBytes: Buffer
  ) => string[];
  featuredReadjudicationWorkflowIssues: (source: string) => string[];
  parseFeaturedReadjudicationCycle: (text: string) => Cycle;
  parseFeaturedReadjudicationReceipt: (
    text: string,
    featuredSitesBytes: Buffer
  ) => Receipt;
};

const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<ReadjudicationModule>;

async function readjudicationModule(): Promise<ReadjudicationModule> {
  return nativeImport(
    pathToFileURL(
      path.join(process.cwd(), "scripts", "featured-readjudication-lib.mjs")
    ).href
  );
}

const RUN_IDS = [30_600_000_003, 30_600_000_010] as const;
const ARTIFACT_IDS = [4_000_000_003, 4_000_000_010] as const;
const HEAD_SHAS = ["1".repeat(40), "2".repeat(40)] as const;
const REPORT_IDS = [
  `20260803-${"a".repeat(32)}`,
  `20260810-${"b".repeat(32)}`
] as const;

function catalogBytes(
  domains: readonly string[],
  availability?: {
    domain: string;
    reason: string;
    runIds?: readonly number[];
    observedAt?: string;
    reviewAfter?: string;
  }
): Buffer {
  const sites = domains.map((domain) => {
    const site: Record<string, unknown> = {
      domain,
      category: "test",
      description: `Fixture for ${domain}`
    };
    if (availability?.domain === domain) {
      site.scanAvailability = {
        status: "temporarily-unavailable",
        reason: availability.reason,
        observedAt: availability.observedAt ?? "2026-08-10",
        reviewAfter: availability.reviewAfter ?? "2026-08-24",
        workflowRunIds: (availability.runIds ?? RUN_IDS).map(String)
      };
    }
    return site;
  });
  return Buffer.from(`${JSON.stringify({ version: 2, sites }, null, 2)}\n`);
}

function availableResult(
  domain: string,
  reportId: string = REPORT_IDS[0],
  attemptCount = 1
): Record<string, unknown> {
  return { domain, status: "available", reportId, attemptCount };
}

async function buildCycle(
  index: 0 | 1,
  catalog: Buffer,
  scanResults: ReadonlyArray<Record<string, unknown>>
): Promise<Cycle> {
  const module = await readjudicationModule();
  return module.buildFeaturedReadjudicationCycle({
    repository: module.FEATURED_READJUDICATION_REPOSITORY,
    workflow: module.FEATURED_READJUDICATION_WORKFLOW,
    runId: RUN_IDS[index],
    runAttempt: index + 1,
    headSha: HEAD_SHAS[index],
    event: "schedule",
    schedule: module.FEATURED_READJUDICATION_SCHEDULE,
    catalogPath: module.FEATURED_READJUDICATION_CATALOG,
    catalogBytes: catalog,
    summary: { scanResults }
  });
}

function binding(cycle: Cycle, index: 0 | 1): Record<string, unknown> {
  return {
    cycle,
    artifactId: ARTIFACT_IDS[index],
    artifactName:
      `featured-readjudication-outcomes-${cycle.actionsRun.id}-${cycle.actionsRun.attempt}`,
    artifactSha256: String(index + 3).repeat(64)
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("cycle output is canonical, fixed to the 13 domains, and strips free-form scan data", async () => {
  const module = await readjudicationModule();
  const catalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS);
  const scanResults: Array<Record<string, unknown>> =
    module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
      availableResult(domain)
    );
  scanResults[0] = {
    ...availableResult(
      module.FEATURED_READJUDICATION_DOMAINS[0],
      REPORT_IDS[0],
      3
    ),
    diagnostic: "raw browser exception must not escape",
    url: "https://private.invalid/path",
    stack: "sensitive stack"
  };
  scanResults[1] = {
    domain: module.FEATURED_READJUDICATION_DOMAINS[1],
    status: "unavailable",
    reason: "access-denied",
    diagnostic: "403 with private response details",
    attempts: 3
  };
  scanResults.push({
    domain: "not-in-the-fixed-set.example",
    status: "available",
    reportId: REPORT_IDS[0],
    attemptCount: 1
  });

  const cycle = await buildCycle(0, catalog, scanResults);
  assert.deepEqual(
    cycle.outcomes.map((outcome) => outcome.domain),
    module.FEATURED_READJUDICATION_DOMAINS
  );
  assert.deepEqual(cycle.outcomes[0], {
    domain: module.FEATURED_READJUDICATION_DOMAINS[0],
    status: "available",
    reportId: REPORT_IDS[0],
    attemptCount: 3
  });
  assert.deepEqual(cycle.outcomes[1], {
    domain: module.FEATURED_READJUDICATION_DOMAINS[1],
    status: "unavailable",
    reason: "access-denied"
  });
  assert.equal(cycle.outcomes.length, 13);
  assert.equal(cycle.complete, true);
  assert.equal(JSON.stringify(cycle).includes("diagnostic"), false);
  assert.equal(JSON.stringify(cycle).includes("private.invalid"), false);
  assert.deepEqual(module.featuredReadjudicationCycleIssues(cycle), []);

  const canonical = module.canonicalFeaturedReadjudicationText(cycle);
  assert.deepEqual(module.parseFeaturedReadjudicationCycle(canonical), cycle);
  assert.throws(
    () =>
      module.parseFeaturedReadjudicationCycle(
        `${JSON.stringify(cycle, null, 2)}\n`
      ),
    /not canonical/
  );
});

test("missing, malformed, duplicate, or invalid summary entries close to explicit not-attempted outcomes", async () => {
  const module = await readjudicationModule();
  const catalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS);
  const common = {
    repository: module.FEATURED_READJUDICATION_REPOSITORY,
    workflow: module.FEATURED_READJUDICATION_WORKFLOW,
    runId: RUN_IDS[0],
    runAttempt: 1,
    headSha: HEAD_SHAS[0],
    event: "schedule",
    schedule: module.FEATURED_READJUDICATION_SCHEDULE,
    catalogPath: module.FEATURED_READJUDICATION_CATALOG,
    catalogBytes: catalog
  };

  for (const summary of [
    undefined,
    null,
    { scanResults: "not-an-array" },
    {
      scanResults: [
        {
          domain: module.FEATURED_READJUDICATION_DOMAINS[0],
          status: "available",
          reportId: "not-a-report-id",
          attemptCount: 99
        },
        {
          domain: module.FEATURED_READJUDICATION_DOMAINS[0],
          status: "unavailable",
          reason: "rate-limited"
        },
        {
          domain: module.FEATURED_READJUDICATION_DOMAINS[1],
          status: "unavailable",
          reason: "free-form-reason"
        }
      ]
    }
  ]) {
    const cycle = module.buildFeaturedReadjudicationCycle({
      ...common,
      summary
    });
    assert.equal(cycle.outcomes.length, 13);
    assert.ok(
      cycle.outcomes.every(
        (outcome) =>
          outcome.status === "not-attempted" &&
          Object.keys(outcome).length === 2
      )
    );
    assert.equal(cycle.complete, false);
    assert.deepEqual(module.featuredReadjudicationCycleIssues(cycle), []);
  }
});

test("aggregate derives a deferral only from the same closed failure twice and activates a recovered site", async () => {
  const module = await readjudicationModule();
  const deferred = module.FEATURED_READJUDICATION_DOMAINS[0];
  const recovered = module.FEATURED_READJUDICATION_DOMAINS[1];
  const catalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS, {
    domain: deferred,
    reason: "automation-blocked"
  });
  const first = module.FEATURED_READJUDICATION_DOMAINS.map((domain) => {
    if (domain === deferred) {
      return { domain, status: "unavailable", reason: "automation-blocked" };
    }
    if (domain === recovered) {
      return { domain, status: "unavailable", reason: "access-denied" };
    }
    return availableResult(domain, REPORT_IDS[0], 1);
  });
  const second = module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
    domain === deferred
      ? { domain, status: "unavailable", reason: "automation-blocked" }
      : availableResult(domain, REPORT_IDS[1], 2)
  );
  const cycles = [
    await buildCycle(0, catalog, first),
    await buildCycle(1, catalog, second)
  ] as const;

  const receipt = module.buildFeaturedReadjudicationReceipt({
    cycles: [binding(cycles[0], 0), binding(cycles[1], 1)],
    featuredSitesBytes: catalog
  });
  assert.deepEqual(receipt.dispositions[0], {
    domain: deferred,
    status: "deferred",
    scanAvailability: {
      status: "temporarily-unavailable",
      reason: "automation-blocked",
      observedAt: "2026-08-10",
      reviewAfter: "2026-08-24",
      workflowRunIds: RUN_IDS.map(String)
    }
  });
  assert.deepEqual(receipt.dispositions[1], {
    domain: recovered,
    status: "active"
  });
  assert.ok(
    receipt.dispositions
      .slice(1)
      .every((disposition) => disposition.status === "active")
  );
  assert.deepEqual(
    module.featuredReadjudicationReceiptIssues(receipt, catalog),
    []
  );
  const canonical = module.canonicalFeaturedReadjudicationText(receipt);
  assert.deepEqual(
    module.parseFeaturedReadjudicationReceipt(canonical, catalog),
    receipt
  );
});

test("aggregate binds identical fixed-domain targets across both cycles and the final catalog", async () => {
  const module = await readjudicationModule();
  const activeCatalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS);
  const changedCatalogValue = JSON.parse(activeCatalog.toString("utf8"));
  changedCatalogValue.sites[0].description = "A different scan target contract";
  const changedCatalog = Buffer.from(
    `${JSON.stringify(changedCatalogValue, null, 2)}\n`
  );
  const firstOutcomes = module.FEATURED_READJUDICATION_DOMAINS.map(
    (domain, index) =>
      index === 0
        ? { domain, status: "unavailable", reason: "automation-blocked" }
        : availableResult(domain, REPORT_IDS[0])
  );
  const secondOutcomes = module.FEATURED_READJUDICATION_DOMAINS.map(
    (domain, index) =>
      index === 0
        ? { domain, status: "unavailable", reason: "automation-blocked" }
        : availableResult(domain, REPORT_IDS[1])
  );
  const first = await buildCycle(0, activeCatalog, firstOutcomes);
  const changedSecond = await buildCycle(1, changedCatalog, secondOutcomes);

  assert.notEqual(
    first.catalog.targetsSha256,
    changedSecond.catalog.targetsSha256
  );
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [binding(first, 0), binding(changedSecond, 1)],
        featuredSitesBytes: changedCatalog
      }),
    /identical fixed-domain target identities/
  );

  const second = await buildCycle(1, activeCatalog, secondOutcomes);
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [binding(first, 0), binding(second, 1)],
        featuredSitesBytes: changedCatalog
      }),
    /final featured catalog must preserve/
  );

  const deferredCatalog = catalogBytes(
    module.FEATURED_READJUDICATION_DOMAINS,
    {
      domain: module.FEATURED_READJUDICATION_DOMAINS[0],
      reason: "automation-blocked"
    }
  );
  assert.equal(
    module.featuredReadjudicationCatalogBinding(activeCatalog).targetsSha256,
    module.featuredReadjudicationCatalogBinding(deferredCatalog).targetsSha256,
    "only governed scanAvailability metadata may change after the cycles"
  );
  const receipt = module.buildFeaturedReadjudicationReceipt({
    cycles: [binding(first, 0), binding(second, 1)],
    featuredSitesBytes: deferredCatalog
  });
  assert.equal(receipt.dispositions[0].status, "deferred");
});

test("activation freshness rejects stale evidence and already-due deferral reviews", async () => {
  const module = await readjudicationModule();
  const deferredCatalog = catalogBytes(
    module.FEATURED_READJUDICATION_DOMAINS,
    {
      domain: module.FEATURED_READJUDICATION_DOMAINS[0],
      reason: "automation-blocked",
      reviewAfter: "2026-08-24"
    }
  );
  const outcomes = module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
    domain === module.FEATURED_READJUDICATION_DOMAINS[0]
      ? { domain, status: "unavailable", reason: "automation-blocked" }
      : availableResult(domain)
  );
  const cycles = [
    await buildCycle(0, deferredCatalog, outcomes),
    await buildCycle(
      1,
      deferredCatalog,
      outcomes.map((outcome) =>
        outcome.status === "available"
          ? { ...outcome, reportId: REPORT_IDS[1] }
          : outcome
      )
    )
  ] as const;
  const receipt = module.buildFeaturedReadjudicationReceipt({
    cycles: [binding(cycles[0], 0), binding(cycles[1], 1)],
    featuredSitesBytes: deferredCatalog
  });

  assert.deepEqual(
    module.featuredReadjudicationActivationFreshnessIssues(
      receipt,
      "2026-08-11T12:00:00.000Z"
    ),
    []
  );
  assert.match(
    module
      .featuredReadjudicationActivationFreshnessIssues(
        receipt,
        "2026-08-24T00:00:00.000Z"
      )
      .join("; "),
    /reviewAfter date later than activation/
  );
  assert.match(
    module
      .featuredReadjudicationActivationFreshnessIssues(
        { ...receipt, dispositions: [] },
        "2026-09-08T00:00:00.000Z"
      )
      .join("; "),
    /within 28 calendar days/
  );
});

test("aggregate refuses tampering, duplicate identities, and wrong repeated-failure evidence", async () => {
  const module = await readjudicationModule();
  const deferred = module.FEATURED_READJUDICATION_DOMAINS[0];
  const catalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS, {
    domain: deferred,
    reason: "automation-blocked"
  });
  const bothBlocked = module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
    domain === deferred
      ? { domain, status: "unavailable", reason: "automation-blocked" }
      : availableResult(domain)
  );
  const cycle0 = await buildCycle(0, catalog, bothBlocked);
  const cycle1 = await buildCycle(
    1,
    catalog,
    bothBlocked.map((entry) =>
      entry.status === "available"
        ? { ...entry, reportId: REPORT_IDS[1] }
        : entry
    )
  );
  const receipt = module.buildFeaturedReadjudicationReceipt({
    cycles: [binding(cycle0, 0), binding(cycle1, 1)],
    featuredSitesBytes: catalog
  });

  const dispositionTamper = clone(receipt);
  dispositionTamper.dispositions[0] = {
    domain: deferred,
    status: "active"
  };
  assert.ok(
    module
      .featuredReadjudicationReceiptIssues(dispositionTamper, catalog)
      .some((issue) => /dispositions|scanAvailability/.test(issue))
  );

  const catalogDigestTamper = clone(receipt);
  catalogDigestTamper.finalFeaturedSites.sha256 = "f".repeat(64);
  assert.ok(
    module
      .featuredReadjudicationReceiptIssues(catalogDigestTamper, catalog)
      .some((issue) => /exact candidate catalog/.test(issue))
  );

  const targetDigestTamper = clone(receipt);
  targetDigestTamper.cycles[1].catalog.targetsSha256 = "e".repeat(64);
  assert.ok(
    module
      .featuredReadjudicationReceiptIssues(targetDigestTamper, catalog)
      .some((issue) => /identical fixed-domain target identities/.test(issue))
  );

  const duplicateRun = clone(cycle1);
  duplicateRun.actionsRun.id = cycle0.actionsRun.id;
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [
          binding(cycle0, 0),
          {
            ...binding(duplicateRun, 1),
            artifactName:
              `featured-readjudication-outcomes-${duplicateRun.actionsRun.id}-${duplicateRun.actionsRun.attempt}`
          }
        ],
        featuredSitesBytes: catalog
      }),
    /distinct run and artifact ids/
  );
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [
          binding(cycle0, 0),
          { ...binding(cycle1, 1), artifactId: ARTIFACT_IDS[0] }
        ],
        featuredSitesBytes: catalog
      }),
    /distinct run and artifact ids/
  );

  const disagreeingCycle = clone(cycle1);
  const firstOutcome = disagreeingCycle.outcomes[0];
  assert.equal(firstOutcome.status, "unavailable");
  if (firstOutcome.status === "unavailable") {
    firstOutcome.reason = "access-denied";
  }
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [binding(cycle0, 0), binding(disagreeingCycle, 1)],
        featuredSitesBytes: catalog
      }),
    /active re-adjudication domain .* must not retain scanAvailability/
  );
  const activeCatalog = catalogBytes(
    module.FEATURED_READJUDICATION_DOMAINS
  );
  const disagreementReceipt = module.buildFeaturedReadjudicationReceipt({
    cycles: [binding(cycle0, 0), binding(disagreeingCycle, 1)],
    featuredSitesBytes: activeCatalog
  });
  assert.deepEqual(disagreementReceipt.dispositions[0], {
    domain: deferred,
    status: "active"
  });

  const wrongCatalogReason = catalogBytes(
    module.FEATURED_READJUDICATION_DOMAINS,
    { domain: deferred, reason: "rate-limited" }
  );
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [binding(cycle0, 0), binding(cycle1, 1)],
        featuredSitesBytes: wrongCatalogReason
      }),
    /reason does not match both cycles/
  );

  const outcomeTamper = clone(cycle0);
  Object.assign(outcomeTamper.outcomes[0], { diagnostic: "must be refused" });
  assert.throws(
    () =>
      module.parseFeaturedReadjudicationCycle(
        module.canonicalFeaturedReadjudicationText(outcomeTamper)
      ),
    /must contain exactly/
  );

  const incompleteCycle = clone(cycle1);
  incompleteCycle.complete = false;
  incompleteCycle.outcomes[0] = {
    domain: module.FEATURED_READJUDICATION_DOMAINS[0],
    status: "not-attempted"
  };
  assert.throws(
    () =>
      module.buildFeaturedReadjudicationReceipt({
        cycles: [binding(cycle0, 0), binding(incompleteCycle, 1)],
        featuredSitesBytes: catalog
      }),
    /must attempt all fixed 13 domains/
  );
});

test("aggregate CLI writes only the fixed create-once receipt and independently verifies it", async () => {
  const module = await readjudicationModule();
  const catalog = catalogBytes(module.FEATURED_READJUDICATION_DOMAINS);
  const cycles = [
    await buildCycle(
      0,
      catalog,
      module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
        availableResult(domain, REPORT_IDS[0], 1)
      )
    ),
    await buildCycle(
      1,
      catalog,
      module.FEATURED_READJUDICATION_DOMAINS.map((domain) =>
        availableResult(domain, REPORT_IDS[1], 2)
      )
    )
  ] as const;
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-featured-readjudication-")
  );
  try {
    const receiptPath = path.join(
      directory,
      "research/ops-receipts/featured-readjudication.json"
    );
    const catalogPath = path.join(directory, "public/featured-sites.json");
    const cyclePaths = [
      path.join(directory, "aug-3.json"),
      path.join(directory, "aug-10.json")
    ];
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, catalog);
    for (const [index, cycle] of cycles.entries()) {
      writeFileSync(
        cyclePaths[index],
        module.canonicalFeaturedReadjudicationText(cycle)
      );
    }
    const cli = path.join(
      process.cwd(),
      "scripts/featured-readjudication.mjs"
    );
    const aggregateArgs = [
      cli,
      "--aggregate",
      "--checkout-root",
      directory,
      "--aug-3-outcomes",
      cyclePaths[0],
      "--aug-3-artifact-id",
      String(ARTIFACT_IDS[0]),
      "--aug-3-artifact-digest",
      "3".repeat(64),
      "--aug-10-outcomes",
      cyclePaths[1],
      "--aug-10-artifact-id",
      String(ARTIFACT_IDS[1]),
      "--aug-10-artifact-digest",
      "4".repeat(64),
      "--featured-sites",
      catalogPath,
      "--output",
      receiptPath
    ];
    const aggregate = spawnSync(process.execPath, aggregateArgs, {
      encoding: "utf8"
    });
    assert.equal(aggregate.status, 0, aggregate.stderr);
    const receiptText = readFileSync(receiptPath, "utf8");
    assert.equal(
      module.parseFeaturedReadjudicationReceipt(receiptText, catalog)
        .dispositions.length,
      13
    );
    const duplicate = spawnSync(process.execPath, aggregateArgs, {
      encoding: "utf8"
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /EEXIST|file already exists/i);

    const verify = spawnSync(
      process.execPath,
      [
        cli,
        "--verify",
        "--receipt",
        receiptPath,
        "--featured-sites",
        catalogPath
      ],
      { encoding: "utf8" }
    );
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /PASS verified 13/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum =
      CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

type ZipEntry = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  extra?: Buffer;
  externalAttributes?: number;
  compressedSuffix?: Buffer;
};

function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const extra = entry.extra ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const encoded =
      method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data);
    const compressed = Buffer.concat([
      encoded,
      entry.compressedSuffix ?? Buffer.alloc(0)
    ]);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(extra.byteLength, 28);
    const localRecord = Buffer.concat([local, name, extra, compressed]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(extra.byteLength, 30);
    central.writeUInt32LE(
      entry.externalAttributes ?? ((0o100644 << 16) >>> 0),
      38
    );
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, name, extra]));
    localOffset += localRecord.byteLength;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(localBytes.byteLength, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

test("artifact ZIP extraction accepts only one regular stored or deflated canonical file", async () => {
  const module = await readjudicationModule();
  const contents = Buffer.from('{"sanitized":true}\n');
  for (const method of [0, 8] as const) {
    const archive = buildZip([
      {
        name: module.FEATURED_READJUDICATION_ARTIFACT_FILE,
        data: contents,
        method
      }
    ]);
    assert.deepEqual(
      module.extractFeaturedReadjudicationArtifactZip(archive),
      contents
    );
  }
});

test("artifact ZIP extraction rejects extras, multiple files, symlinks, traversal, and trailing deflate streams", async () => {
  const module = await readjudicationModule();
  const contents = Buffer.from('{"sanitized":true}\n');
  const expectedName = module.FEATURED_READJUDICATION_ARTIFACT_FILE;
  const invalidArchives = [
    buildZip([
      {
        name: expectedName,
        data: contents,
        extra: Buffer.from([0xfe, 0xca, 0, 0])
      }
    ]),
    buildZip([
      { name: expectedName, data: contents },
      { name: "hidden.json", data: Buffer.from("{}\n") }
    ]),
    buildZip([
      {
        name: expectedName,
        data: contents,
        externalAttributes: (0o120777 << 16) >>> 0
      }
    ]),
    buildZip([{ name: `../${expectedName}`, data: contents }]),
    buildZip([
      {
        name: expectedName,
        data: contents,
        method: 8,
        compressedSuffix: Buffer.from([0xde, 0xad, 0xbe, 0xef])
      }
    ])
  ];
  for (const archive of invalidArchives) {
    assert.throws(
      () => module.extractFeaturedReadjudicationArtifactZip(archive),
      /artifact ZIP|deflate/
    );
  }
});

test("featured workflow always uploads the gallery-only sanitized artifact with at least 30 days retention", async () => {
  const module = await readjudicationModule();
  const source = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"),
    "utf8"
  );
  assert.deepEqual(module.featuredReadjudicationWorkflowIssues(source), []);

  const galleryOnlyCondition =
    "if: always() && github.event_name == 'schedule' && github.event.schedule == '23 5 * * 1'";
  assert.equal(source.split(galleryOnlyCondition).length - 1, 2);
  const uploadBlock = source.match(
    /- name: Upload featured re-adjudication outcomes[\s\S]*?retention-days:\s*(\d+)/
  );
  assert.ok(uploadBlock, "re-adjudication upload step must exist");
  assert.ok(Number(uploadBlock[1]) >= 30);
  assert.match(
    source,
    /- name: Canonicalize featured re-adjudication outcomes[\s\S]*?FEATURED_SITES_FILE: public\/featured-sites\.json/
  );
  assert.doesNotMatch(
    uploadBlock[0],
    /github\.event\.schedule == '23 7 \* \* 1'/
  );

  assert.notDeepEqual(
    module.featuredReadjudicationWorkflowIssues(
      source.replaceAll(galleryOnlyCondition, "if: success()")
    ),
    []
  );
  assert.notDeepEqual(
    module.featuredReadjudicationWorkflowIssues(
      source.replace("retention-days: 45", "retention-days: 29")
    ),
    []
  );
});
