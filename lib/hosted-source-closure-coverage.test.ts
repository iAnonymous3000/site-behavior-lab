import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS
} from "./measurement-candidate-binding";

type ScriptExports = Record<string, any>;
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const EXACT_PATHS = {
  "durable-transition:promotion": [
    ".github/required-ci-jobs.json",
    "scripts/verify-required-ci-jobs.mjs"
  ],
  "durable-transition:production-health": [
    "lib/strict-json.ts",
    "package.json",
    "scripts/http-response.mjs",
    "scripts/scan-admission.mjs",
    "scripts/smoke-deployed-scanner-report.mjs",
    "scripts/smoke-production-r2-delete.mjs",
    "scripts/smoke-production-synthetic.mjs"
  ],
  "durable-soak:monitor": [
    "lib/strict-json.ts",
    "scripts/archive-hosted-evidence.mjs",
    "scripts/durable-soak-exercise-evidence-lib.mjs",
    "scripts/durable-soak-ledger-lib.mjs",
    "scripts/durable-soak-ledger.mjs",
    "scripts/durable-soak-restart-evidence-lib.mjs",
    "scripts/hosted-evidence-provenance-lib.mjs",
    "scripts/operator-evidence-common.mjs",
    "scripts/staging-teardown-evidence-lib.mjs",
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "scripts/waf-ceiling-evidence-lib.mjs",
    "scripts/waf-hosted-capture-lib.mjs"
  ],
  "durable-soak:restart": [
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.schema.json",
    "lib/canonical-json.ts",
    "lib/durable-restart-control-auth.ts",
    "lib/sha256.ts",
    "lib/strict-json.ts",
    "scripts/build-schema.mjs",
    "scripts/durable-soak-restart-evidence-lib.mjs",
    "scripts/durable-soak-restart-evidence.mjs",
    "scripts/http-response.mjs",
    "scripts/operator-evidence-common.mjs",
    "scripts/scan-admission.mjs"
  ],
  "durable-soak:exercises": [
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.schema.json",
    "lib/canonical-json.ts",
    "lib/sha256.ts",
    "lib/strict-json.ts",
    "scripts/build-schema.mjs",
    "scripts/durable-soak-exercise-evidence-lib.mjs",
    "scripts/durable-soak-exercise-evidence.mjs",
    "scripts/http-response.mjs",
    "scripts/operator-evidence-common.mjs",
    "scripts/scan-admission.mjs",
    "scripts/smoke-deployed-scanner-report.mjs"
  ],
  "lifecycle:production-health": [
    "lib/strict-json.ts",
    "package.json",
    "scripts/http-response.mjs",
    "scripts/scan-admission.mjs",
    "scripts/smoke-deployed-scanner-report.mjs",
    "scripts/smoke-production-r2-delete.mjs",
    "scripts/smoke-production-synthetic.mjs"
  ]
} as const;

const ACCEPTED_HISTORY = new Set([
  "controlled-publication:publisher",
  "runner-destruction:collection",
  "runner-destruction:destruction",
  "lifecycle:readback"
]);

function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T18:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T18:00:00Z"
    }
  }).trim();
}

test("every hosted profile role has one pinned source-trust mechanism", async () => {
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const staging = await script(
    "staging-teardown-hosted-capture-lib.mjs"
  );
  const waf = await script("waf-hosted-capture-lib.mjs");
  const profileNames = [
    "controlled-publication",
    "runner-destruction",
    "durable-transition",
    "durable-soak",
    "lifecycle",
    "staging-teardown",
    "waf-ceilings"
  ];
  const seen = new Set<string>();
  for (const profile of profileNames) {
    const contract = hosted.hostedEvidenceCollectionContract(profile);
    assert.deepEqual(
      Object.keys(contract.sources),
      contract.exactRoles,
      `${profile} role order`
    );
    for (const role of contract.exactRoles as string[]) {
      const key = `${profile}:${role}`;
      seen.add(key);
      const trustedPaths =
        contract.sources[role].trustedSourcePaths as string[];
      if (key === "staging-teardown:provider-capture") {
        assert.deepEqual(
          [
            contract.sources[role].workflows[0],
            ...trustedPaths
          ],
          staging.STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS
        );
        assert.deepEqual(
          MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS,
          staging.STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS
        );
      } else if (key === "waf-ceilings:provider-capture") {
        assert.deepEqual(trustedPaths, []);
        assert.deepEqual(
          waf.WAF_HOSTED_PRODUCER_CLOSURE_PATHS[0],
          contract.sources[role].workflows[0]
        );
        assert.equal(
          waf.WAF_HOSTED_PRODUCER_CLOSURE_PATHS.length > 1,
          true
        );
      } else if (key === "durable-transition:ci") {
        assert.deepEqual(trustedPaths, []);
      } else if (key in EXACT_PATHS) {
        assert.deepEqual(
          trustedPaths,
          EXACT_PATHS[key as keyof typeof EXACT_PATHS],
          key
        );
      } else {
        assert.equal(
          ACCEPTED_HISTORY.has(key),
          true,
          `${key} has no classified source-trust mechanism`
        );
        assert.deepEqual(trustedPaths, []);
      }
    }
  }
  assert.deepEqual(seen, new Set([
    ...ACCEPTED_HISTORY,
    ...Object.keys(EXACT_PATHS),
    "durable-transition:ci",
    "staging-teardown:provider-capture",
    "waf-ceilings:provider-capture"
  ]));
});

test("accepted-history and pre-candidate exceptions remain fail-closed", () => {
  const readiness = readFileSync(
    path.join(process.cwd(), "scripts", "release-readiness-lib.mjs"),
    "utf8"
  );
  const trustFunction = readiness.slice(
    readiness.indexOf(
      "export function hostedEvidenceSourceTrustProblems"
    ),
    readiness.indexOf(
      "export function durableSoakNestedWorkflowTrustProblems"
    )
  );
  assert.match(
    trustFunction,
    /measurementCandidateAcceptsProducer\([\s\S]*source\?\.headSha/
  );
  assert.match(
    trustFunction,
    /profile === "durable-transition"[\s\S]*profile === "durable-soak"/
  );
  assert.doesNotMatch(
    trustFunction,
    /profile === "(?:controlled-publication|runner-destruction|lifecycle|staging-teardown|waf-ceilings)"/
  );
  assert.match(
    trustFunction,
    /hostedEvidenceSourceClosureProblems/
  );
});

test("every hosted archive profile is carrier-only evidence after candidate C", () => {
  const binding = readFileSync(
    path.join(
      process.cwd(),
      "lib",
      "measurement-candidate-binding.ts"
    ),
    "utf8"
  );
  const archivePolicy = binding.slice(
    binding.indexOf('"hosted-evidence-archive":'),
    binding.indexOf('"release-policy-finalization":')
  );
  for (const profile of [
    "controlled-publication",
    "runner-destruction",
    "durable-transition",
    "durable-soak",
    "staging-teardown",
    "lifecycle",
    "waf-ceilings"
  ]) {
    assert.match(archivePolicy, new RegExp(profile));
  }
  assert.equal(
    (
      binding.match(
        /authenticated hosted archive must be introduced after candidate C, never embedded in C/g
      ) ?? []
    ).length,
    2,
    "staging and durable candidate prerequisites must reject an archive embedded in C"
  );
  assert.match(
    binding,
    /request\.candidateCommit,[\s\S]*archiverCommit,[\s\S]*request\.carrierCommit/
  );

  const readiness = readFileSync(
    path.join(process.cwd(), "scripts", "release-readiness-lib.mjs"),
    "utf8"
  );
  const verifier = readiness.slice(
    readiness.indexOf("function verifyHostedEvidenceSubject"),
    readiness.indexOf("export function hostedSubjectFinalizationCommit")
  );
  assert.match(
    verifier,
    /boundEvidence\([\s\S]*"hosted-evidence-archive"/
  );
  assert.match(
    verifier,
    /measurementCandidateAcceptsProducer\([\s\S]*archiverCommit/
  );
  assert.doesNotMatch(
    verifier,
    /candidateCommit[^\n]*research\/hosted-evidence/
  );
});

test("durable transition rejects stale invoked helper bytes for every non-inline role", async () => {
  const readiness = await script("release-readiness-lib.mjs");
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const cases = [
    {
      role: "promotion",
      workflowPath: ".github/workflows/promote-production.yml",
      changedPath: "scripts/verify-required-ci-jobs.mjs"
    },
    {
      role: "production-health",
      workflowPath: ".github/workflows/production-health.yml",
      changedPath: "scripts/smoke-production-synthetic.mjs"
    }
  ];
  const contract = hosted.hostedEvidenceCollectionContract(
    "durable-transition"
  );
  for (const entry of cases) {
    const root = mkdtempSync(
      path.join(tmpdir(), `sbl-${entry.role}-closure-`)
    );
    try {
      const sourceContract = contract.sources[entry.role];
      for (const repositoryPath of [
        entry.workflowPath,
        ...sourceContract.trustedSourcePaths
      ]) {
        const absolute = path.join(
          root,
          ...repositoryPath.split("/")
        );
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(
          absolute,
          `${repositoryPath}: authenticated source\n`
        );
      }
      git(root, ["init", "-q"]);
      git(root, ["config", "user.name", "Source Closure Test"]);
      git(root, [
        "config",
        "user.email",
        "source-closure@example.invalid"
      ]);
      git(root, ["config", "commit.gpgsign", "false"]);
      git(root, ["add", "--all"]);
      git(root, ["commit", "-q", "-m", "authenticated source"]);
      const sourceCommit = git(root, ["rev-parse", "HEAD"]);

      writeFileSync(
        path.join(root, ...entry.changedPath.split("/")),
        `${entry.changedPath}: later hardened candidate\n`
      );
      git(root, ["add", "--all"]);
      git(root, ["commit", "-q", "-m", "harden candidate"]);
      const candidateCommit = git(root, ["rev-parse", "HEAD"]);
      const context = {
        binding: {
          candidateCommit,
          carrierCommit: candidateCommit,
          acceptedProducerCommits: []
        }
      };
      const source = {
        role: entry.role,
        workflowPath: entry.workflowPath,
        headSha: sourceCommit
      };
      assert.match(
        readiness.hostedEvidenceSourceTrustProblems(
          root,
          context,
          "durable-transition",
          sourceCommit,
          [source]
        ).join(" "),
        new RegExp(entry.changedPath.replace(/[./-]/g, "\\$&"))
      );
      assert.deepEqual(
        readiness.hostedEvidenceSourceTrustProblems(
          root,
          context,
          "durable-transition",
          candidateCommit,
          [{ ...source, headSha: candidateCommit }]
        ),
        []
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("WAF hosted archive is exact at carrier S and absent from candidate C", async () => {
  const readiness = await script("release-readiness-lib.mjs");
  const root = mkdtempSync(
    path.join(tmpdir(), "sbl-waf-carrier-placement-")
  );
  try {
    writeFileSync(path.join(root, "candidate.txt"), "candidate C\n");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Carrier Placement Test"]);
    git(root, [
      "config",
      "user.email",
      "carrier-placement@example.invalid"
    ]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "--all"]);
    git(root, ["commit", "-q", "-m", "candidate C"]);
    const candidateCommit = git(root, ["rev-parse", "HEAD"]);

    const digestDirectory = "a".repeat(64);
    const archiveRoot =
      `research/hosted-evidence/waf-ceilings/${digestDirectory}`;
    const values = new Map([
      [`${archiveRoot}/context.json`, '{"context":true}\n'],
      [
        `${archiveRoot}/context.sigstore.json`,
        '{"bundle":true}\n'
      ],
      [`${archiveRoot}/subject.json`, '{"subject":true}\n']
    ]);
    for (const [relativePath, value] of values) {
      const absolutePath = path.join(
        root,
        ...relativePath.split("/")
      );
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, value);
    }
    git(root, ["add", "--all"]);
    git(root, ["commit", "-q", "-m", "carrier S archive"]);
    const carrierCommit = git(root, ["rev-parse", "HEAD"]);
    const entries = [...values].map(([entryPath, value]) => ({
      path: entryPath,
      sha256: createHash("sha256").update(value).digest("hex")
    }));

    assert.deepEqual(
      readiness.hostedArchiveCarrierPlacementProblems(
        root,
        candidateCommit,
        carrierCommit,
        entries
      ),
      []
    );
    assert.deepEqual(
      readiness.hostedArchiverCarrierOrderProblems(
        root,
        candidateCommit,
        carrierCommit,
        carrierCommit
      ),
      []
    );
    assert.match(
      readiness
        .hostedArchiveCarrierPlacementProblems(
          root,
          candidateCommit,
          carrierCommit,
          [
            {
              ...entries[0],
              sha256: "0".repeat(64)
            },
            ...entries.slice(1)
          ]
        )
        .join(" "),
      /not the exact digest-enumerated byte sequence/
    );
    assert.match(
      readiness
        .hostedArchiveCarrierPlacementProblems(
          root,
          carrierCommit,
          carrierCommit,
          entries
        )
        .join(" "),
      /never embedded in C/
    );
    assert.match(
      readiness
        .hostedArchiveCarrierPlacementProblems(
          root,
          carrierCommit,
          candidateCommit,
          entries
        )
        .join(" "),
      /candidate-to-carrier history/
    );
    assert.match(
      readiness
        .hostedArchiverCarrierOrderProblems(
          root,
          carrierCommit,
          candidateCommit,
          carrierCommit
        )
        .join(" "),
      /candidate C <= archiver <= evidence carrier S/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
