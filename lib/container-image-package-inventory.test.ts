import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const COMMIT = "a".repeat(40);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const LAYERS = [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`];

// Deliberately loose: tests mutate the raw scanner JSON across mutually
// exclusive result shapes to exercise the runtime validator.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixture(): any {
  const trivyReport = {
    SchemaVersion: 2,
    Trivy: { Version: "0.70.0" },
    ReportID: "nondeterministic-report-id",
    CreatedAt: "2026-08-01T00:00:00Z",
    ArtifactID: "scanner-specific-artifact-id",
    ArtifactName: "site-behavior-lab:smoke",
    ArtifactType: "container_image",
    Metadata: {
      ImageID: IMAGE_ID,
      DiffIDs: [...LAYERS],
      RepoTags: ["site-behavior-lab:smoke"],
      ImageConfig: {
        architecture: "amd64",
        os: "linux"
      }
    },
    Results: [
      {
        Target: "site-behavior-lab:smoke (ubuntu 24.04)",
        Class: "os-pkgs",
        Type: "ubuntu",
        Packages: [
          {
            Name: "zlib1g",
            Version: "1:1.3.dfsg-3.1ubuntu2.1",
            Arch: "amd64",
            SrcName: "zlib",
            SrcVersion: "1:1.3.dfsg-3.1ubuntu2.1",
            Licenses: ["Zlib"]
          },
          {
            Name: "adduser",
            Version: "3.137ubuntu1",
            Arch: "all",
            SrcName: "adduser",
            SrcVersion: "3.137ubuntu1",
            Licenses: ["GPL-2.0-or-later", "GPL-2.0-only"]
          },
          {
            Name: "base-files",
            Version: "13ubuntu10.3",
            Arch: "amd64",
            SrcName: "base-files",
            SrcVersion: "13ubuntu10.3",
            Licenses: []
          }
        ]
      },
      {
        Target: "OS Packages",
        Class: "license",
        Licenses: [
          { PkgName: "zlib1g", Name: "Zlib", Severity: "LOW" },
          { PkgName: "adduser", Name: "GPL-2.0-only", Severity: "HIGH" }
        ]
      }
    ]
  };
  const containerEvidence = {
    schemaVersion: 1,
    source: { commit: COMMIT },
    artifacts: [
      {
        name: "container-image",
        kind: "docker-image-inspection",
        imageId: IMAGE_ID,
        os: "linux",
        architecture: "amd64",
        rootfsLayers: [...LAYERS],
        sourceCommit: COMMIT
      }
    ]
  };
  return { trivyReport, containerEvidence };
}

test("container inventory is deterministic and excludes raw Trivy scan noise", async () => {
  const { buildContainerImagePackageInventory, serializeContainerImagePackageInventory } =
    await inventoryLib();
  const firstInputs = fixture();
  const first = buildContainerImagePackageInventory({
    ...firstInputs,
    sourceCommit: COMMIT
  });
  const firstBytes = serializeContainerImagePackageInventory(first);

  const secondInputs = fixture();
  secondInputs.trivyReport.ReportID = "another-random-id";
  secondInputs.trivyReport.CreatedAt = "2030-01-01T00:00:00Z";
  secondInputs.trivyReport.ArtifactName = "ignored-moving-tag";
  secondInputs.trivyReport.Metadata.RepoTags = ["ignored:tag"];
  secondInputs.trivyReport.Results.reverse();
  const osResult = secondInputs.trivyReport.Results.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result: any) => result.Class === "os-pkgs"
  );
  assert.ok(osResult && "Packages" in osResult);
  osResult.Packages.reverse();
  osResult.Packages[1].Licenses.reverse();
  const licenseResult = secondInputs.trivyReport.Results.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result: any) => result.Class === "license"
  );
  assert.ok(licenseResult && "Licenses" in licenseResult);
  licenseResult.Licenses.reverse();
  const second = buildContainerImagePackageInventory({
    ...secondInputs,
    sourceCommit: COMMIT
  });
  const secondBytes = serializeContainerImagePackageInventory(second);

  assert.equal(secondBytes, firstBytes);
  assert.deepEqual(
    first.packages.map((pkg: { key: string }) => pkg.key),
    [
      "os:ubuntu:adduser@3.137ubuntu1#all",
      "os:ubuntu:base-files@13ubuntu10.3#amd64",
      "os:ubuntu:zlib1g@1:1.3.dfsg-3.1ubuntu2.1#amd64"
    ]
  );
  assert.equal(first.image.id, IMAGE_ID);
  assert.equal(first.image.digest, "b".repeat(64));
  assert.equal(first.source.commit, COMMIT);
  assert.equal(first.summary.packageCount, 3);
  assert.equal(first.summary.packagesWithoutDetectedLicenses, 1);
  assert.match(first.packageSetDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(firstBytes, /ReportID|CreatedAt|ArtifactName|RepoTags|Target/);
});

test("container inventory rejects identity, platform, and rootfs mismatches", async () => {
  const { buildContainerImagePackageInventory } = await inventoryLib();
  const mutations: Array<[string, (input: ReturnType<typeof fixture>) => void, RegExp]> = [
    [
      "image ID",
      (input) => {
        input.trivyReport.Metadata.ImageID = `sha256:${"e".repeat(64)}`;
      },
      /image ID does not match/
    ],
    [
      "rootfs order",
      (input) => {
        input.trivyReport.Metadata.DiffIDs.reverse();
      },
      /rootfs layers do not match/
    ],
    [
      "architecture",
      (input) => {
        input.trivyReport.Metadata.ImageConfig.architecture = "arm64";
      },
      /platform does not match/
    ],
    [
      "receipt commit",
      (input) => {
        input.containerEvidence.source.commit = "f".repeat(40);
      },
      /source commit does not match/
    ]
  ];
  for (const [label, mutate, expected] of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => buildContainerImagePackageInventory({ ...input, sourceCommit: COMMIT }),
      expected,
      label
    );
  }
});

test("container inventory fails closed on missing, duplicate, malformed, or non-OS package data", async () => {
  const { buildContainerImagePackageInventory } = await inventoryLib();
  const mutations: Array<[(input: ReturnType<typeof fixture>) => void, RegExp]> = [
    [
      (input) => {
        const result = input.trivyReport.Results.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (candidate: any) => candidate.Class === "os-pkgs"
        );
        assert.ok(result && "Packages" in result);
        result.Packages = [];
      },
      /requires list-all-pkgs/
    ],
    [
      (input) => {
        const result = input.trivyReport.Results.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (candidate: any) => candidate.Class === "os-pkgs"
        );
        assert.ok(result && "Packages" in result);
        result.Packages.push(structuredClone(result.Packages[0]));
      },
      /duplicate OS package/
    ],
    [
      (input) => {
        const result = input.trivyReport.Results.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (candidate: any) => candidate.Class === "os-pkgs"
        );
        assert.ok(result && "Packages" in result);
        result.Packages[0].Version = " bad ";
      },
      /Version must be/
    ],
    [
      (input) => {
        input.trivyReport.Results.push({
          Target: "npm",
          Class: "lang-pkgs",
          Type: "npm",
          Packages: [
            {
              Name: "unexpected",
              Version: "1.0.0",
              Arch: "unknown",
              SrcName: "unexpected",
              SrcVersion: "1.0.0",
              Licenses: ["MIT"]
            }
          ]
        });
      },
      /non-OS packages/
    ],
    [
      (input) => {
        input.trivyReport.Results = input.trivyReport.Results.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (candidate: any) => candidate.Class !== "license"
        );
      },
      /license-classification result/
    ]
  ];
  for (const [mutate, expected] of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => buildContainerImagePackageInventory({ ...input, sourceCommit: COMMIT }),
      expected
    );
  }
});

test("package evidence and package-set digests change on material package drift", async () => {
  const { buildContainerImagePackageInventory } = await inventoryLib();
  const originalInputs = fixture();
  const original = buildContainerImagePackageInventory({
    ...originalInputs,
    sourceCommit: COMMIT
  });
  for (const field of ["Version", "Arch", "SrcName", "SrcVersion", "Licenses"] as const) {
    const changedInputs = fixture();
    const result = changedInputs.trivyReport.Results.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (candidate: any) => candidate.Class === "os-pkgs"
    );
    assert.ok(result && "Packages" in result);
    const pkg = result.Packages[0];
    if (field === "Licenses") pkg[field] = ["MIT"];
    else pkg[field] = `${pkg[field]}-changed`;
    const changed = buildContainerImagePackageInventory({
      ...changedInputs,
      sourceCommit: COMMIT
    });
    const originalRow = original.packages.find(
      (candidate: { name: string }) => candidate.name === "zlib1g"
    );
    const changedRow = changed.packages.find(
      (candidate: { name: string }) => candidate.name === "zlib1g"
    );
    assert.notEqual(changedRow?.evidenceDigest, originalRow?.evidenceDigest, field);
    assert.notEqual(changed.packageSetDigest, original.packageSetDigest, field);
  }
});

test("canonical inventory validation detects package and aggregate tampering", async () => {
  const {
    buildContainerImagePackageInventory,
    validateContainerImagePackageInventory
  } = await inventoryLib();
  const input = fixture();
  const inventory = buildContainerImagePackageInventory({
    ...input,
    sourceCommit: COMMIT
  });
  assert.equal(validateContainerImagePackageInventory(inventory).ok, true);

  const rowTamper = structuredClone(inventory);
  rowTamper.packages[0].detectedLicenses = ["MIT"];
  assert.equal(validateContainerImagePackageInventory(rowTamper).ok, false);
  const digestTamper = structuredClone(inventory);
  digestTamper.packageSetDigest = "0".repeat(64);
  assert.equal(validateContainerImagePackageInventory(digestTamper).ok, false);
  const orderTamper = structuredClone(inventory);
  orderTamper.packages.reverse();
  assert.equal(validateContainerImagePackageInventory(orderTamper).ok, false);
  const extraClaim = structuredClone(inventory);
  extraClaim.unverifiedClaim = true;
  assert.equal(validateContainerImagePackageInventory(extraClaim).ok, false);
  const reorderedRow = structuredClone(inventory);
  const row = reorderedRow.packages[0];
  reorderedRow.packages[0] = {
    packageType: row.packageType,
    key: row.key,
    name: row.name,
    version: row.version,
    architecture: row.architecture,
    sourceName: row.sourceName,
    sourceVersion: row.sourceVersion,
    detectedLicenses: row.detectedLicenses,
    evidenceDigest: row.evidenceDigest
  };
  assert.equal(validateContainerImagePackageInventory(reorderedRow).ok, false);
});

test("inventory CLI writes one exclusive canonical artifact", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "sbl-container-inventory-"));
  const trivyPath = path.join(temp, "trivy.json");
  const evidencePath = path.join(temp, "evidence.json");
  const outputPath = path.join(temp, "inventory.json");
  const input = fixture();
  writeFileSync(trivyPath, JSON.stringify(input.trivyReport));
  writeFileSync(evidencePath, JSON.stringify(input.containerEvidence));
  const script = path.join(
    process.cwd(),
    "scripts",
    "container-image-package-inventory.mjs"
  );
  const args = [
    script,
    "--trivy-report",
    trivyPath,
    "--container-evidence",
    evidencePath,
    "--source-commit",
    COMMIT,
    "--output",
    outputPath
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /3 packages/);
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).summary.packageCount, 3);

  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /must not already exist/);
});
