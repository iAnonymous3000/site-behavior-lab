import { createHash } from "node:crypto";

export const CONTAINER_PACKAGE_INVENTORY_ARTIFACT_KIND =
  "site-behavior-container-image-package-inventory";
export const CONTAINER_PACKAGE_INVENTORY_SCHEMA_VERSION = 1;
export const REQUIRED_TRIVY_VERSION = "0.70.0";
export const REQUIRED_TRIVY_REPORT_SCHEMA_VERSION = 2;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MAX_STRING_LENGTH = 4096;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const canonical = [...expected];
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} must contain exactly the canonical fields`);
  }
}

function requireString(value, label, maximumLength = MAX_STRING_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a trimmed, non-empty bounded string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, label);
}

function requireSha256Id(value, label) {
  const digest = requireString(value, label, 71);
  if (!SHA256_ID_PATTERN.test(digest)) {
    throw new Error(`${label} must be a lowercase sha256 image or layer identity`);
  }
  return digest;
}

function requireCommit(value, label) {
  const commit = requireString(value, label, 40);
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label} must be a full lowercase Git commit`);
  }
  return commit;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPackageEvidence(pkg) {
  return {
    packageType: pkg.packageType,
    name: pkg.name,
    version: pkg.version,
    architecture: pkg.architecture,
    sourceName: pkg.sourceName,
    sourceVersion: pkg.sourceVersion,
    detectedLicenses: pkg.detectedLicenses
  };
}

export function packageEvidenceDigest(pkg) {
  return sha256(JSON.stringify(canonicalPackageEvidence(pkg)));
}

export function packageSetDigest(packages) {
  return sha256(JSON.stringify(packages));
}

function normalizeLicenses(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const licenses = value.map((license, index) =>
    requireString(license, `${label}[${index}]`)
  );
  const unique = new Set(licenses);
  if (unique.size !== licenses.length) {
    throw new Error(`${label} must not contain duplicate licenses`);
  }
  return licenses.sort(compareStrings);
}

function normalizePackage(rawPackage, packageType, index) {
  const raw = requireRecord(rawPackage, `Trivy OS package ${index}`);
  const name = requireString(raw.Name, `Trivy OS package ${index}.Name`);
  const version = requireString(raw.Version, `Trivy OS package ${index}.Version`);
  const architecture = requireString(raw.Arch, `Trivy OS package ${index}.Arch`);
  const sourceName = optionalString(raw.SrcName, `Trivy OS package ${index}.SrcName`);
  const sourceVersion = optionalString(raw.SrcVersion, `Trivy OS package ${index}.SrcVersion`);
  const detectedLicenses = normalizeLicenses(
    raw.Licenses,
    `Trivy OS package ${index}.Licenses`
  );
  const key = `os:${packageType}:${name}@${version}#${architecture}`;
  const normalized = {
    key,
    packageType,
    name,
    version,
    architecture,
    sourceName,
    sourceVersion,
    detectedLicenses
  };
  return {
    ...normalized,
    evidenceDigest: packageEvidenceDigest(normalized)
  };
}

function findContainerArtifact(containerEvidence, sourceCommit) {
  const evidence = requireRecord(containerEvidence, "container release evidence");
  const source = requireRecord(evidence.source, "container release evidence.source");
  if (requireCommit(source.commit, "container release evidence.source.commit") !== sourceCommit) {
    throw new Error("Container release evidence source commit does not match --source-commit");
  }
  if (!Array.isArray(evidence.artifacts)) {
    throw new Error("container release evidence.artifacts must be an array");
  }
  const artifacts = evidence.artifacts.filter(
    (artifact) =>
      isRecord(artifact) &&
      artifact.name === "container-image" &&
      artifact.kind === "docker-image-inspection"
  );
  if (artifacts.length !== 1) {
    throw new Error("Container release evidence must contain exactly one inspected container image");
  }
  const artifact = artifacts[0];
  if (requireCommit(artifact.sourceCommit, "container artifact.sourceCommit") !== sourceCommit) {
    throw new Error("Container artifact source commit does not match --source-commit");
  }
  const imageId = requireSha256Id(artifact.imageId, "container artifact.imageId");
  if (!Array.isArray(artifact.rootfsLayers) || artifact.rootfsLayers.length === 0) {
    throw new Error("container artifact.rootfsLayers must be a non-empty array");
  }
  const rootfsLayers = artifact.rootfsLayers.map((layer, index) =>
    requireSha256Id(layer, `container artifact.rootfsLayers[${index}]`)
  );
  if (new Set(rootfsLayers).size !== rootfsLayers.length) {
    throw new Error("container artifact.rootfsLayers must not contain duplicates");
  }
  return {
    imageId,
    imageDigest: imageId.slice("sha256:".length),
    os: requireString(artifact.os, "container artifact.os"),
    architecture: requireString(artifact.architecture, "container artifact.architecture"),
    rootfsLayers
  };
}

function normalizeTrivyReport(trivyReport, container) {
  const report = requireRecord(trivyReport, "Trivy report");
  if (report.SchemaVersion !== REQUIRED_TRIVY_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Trivy report must use schema version ${REQUIRED_TRIVY_REPORT_SCHEMA_VERSION}`
    );
  }
  const trivy = requireRecord(report.Trivy, "Trivy report.Trivy");
  if (trivy.Version !== REQUIRED_TRIVY_VERSION) {
    throw new Error(`Trivy report must identify version ${REQUIRED_TRIVY_VERSION}`);
  }
  if (report.ArtifactType !== "container_image") {
    throw new Error("Trivy report must identify a container_image artifact");
  }
  const metadata = requireRecord(report.Metadata, "Trivy report.Metadata");
  const imageId = requireSha256Id(metadata.ImageID, "Trivy report.Metadata.ImageID");
  if (imageId !== container.imageId) {
    throw new Error("Trivy report image ID does not match the exact container evidence");
  }
  if (!Array.isArray(metadata.DiffIDs) || metadata.DiffIDs.length === 0) {
    throw new Error("Trivy report.Metadata.DiffIDs must be a non-empty array");
  }
  const diffIds = metadata.DiffIDs.map((layer, index) =>
    requireSha256Id(layer, `Trivy report.Metadata.DiffIDs[${index}]`)
  );
  if (
    diffIds.length !== container.rootfsLayers.length ||
    diffIds.some((layer, index) => layer !== container.rootfsLayers[index])
  ) {
    throw new Error("Trivy report rootfs layers do not match the exact container evidence");
  }
  const imageConfig = requireRecord(metadata.ImageConfig, "Trivy report.Metadata.ImageConfig");
  if (
    requireString(imageConfig.os, "Trivy report.Metadata.ImageConfig.os") !== container.os ||
    requireString(
      imageConfig.architecture,
      "Trivy report.Metadata.ImageConfig.architecture"
    ) !== container.architecture
  ) {
    throw new Error("Trivy report platform does not match the exact container evidence");
  }
  if (!Array.isArray(report.Results)) {
    throw new Error("Trivy report.Results must be an array");
  }
  const osResults = report.Results.filter(
    (result) => isRecord(result) && result.Class === "os-pkgs"
  );
  if (osResults.length !== 1) {
    throw new Error("Trivy report must contain exactly one OS-package result");
  }
  const osResult = osResults[0];
  const packageType = requireString(osResult.Type, "Trivy OS-package result.Type");
  if (!Array.isArray(osResult.Packages) || osResult.Packages.length === 0) {
    throw new Error(
      "Trivy OS-package result must contain packages; the scan requires list-all-pkgs"
    );
  }
  for (const [index, result] of report.Results.entries()) {
    if (
      isRecord(result) &&
      result.Class !== "os-pkgs" &&
      Array.isArray(result.Packages) &&
      result.Packages.length > 0
    ) {
      throw new Error(
        `Trivy result ${index} contains non-OS packages; the scan must use OS package scope`
      );
    }
  }
  const licenseResults = report.Results.filter(
    (result) => isRecord(result) && result.Class === "license"
  );
  if (
    licenseResults.length !== 1 ||
    !Array.isArray(licenseResults[0].Licenses) ||
    licenseResults[0].Licenses.length === 0
  ) {
    throw new Error(
      "Trivy report must contain one non-empty license-classification result"
    );
  }
  for (const [index, finding] of licenseResults[0].Licenses.entries()) {
    const record = requireRecord(finding, `Trivy license finding ${index}`);
    requireString(record.PkgName, `Trivy license finding ${index}.PkgName`);
    requireString(record.Name, `Trivy license finding ${index}.Name`);
  }

  const packages = osResult.Packages.map((pkg, index) =>
    normalizePackage(pkg, packageType, index)
  ).sort(
    (left, right) =>
      compareStrings(left.key, right.key) ||
      compareStrings(left.evidenceDigest, right.evidenceDigest)
  );
  const keys = new Set();
  for (const pkg of packages) {
    if (keys.has(pkg.key)) throw new Error(`Trivy report contains duplicate OS package ${pkg.key}`);
    keys.add(pkg.key);
  }
  return {
    packages,
    classifiedLicenseFindingCount: licenseResults[0].Licenses.length
  };
}

export function buildContainerImagePackageInventory({
  trivyReport,
  containerEvidence,
  sourceCommit
}) {
  const commit = requireCommit(sourceCommit, "--source-commit");
  const container = findContainerArtifact(containerEvidence, commit);
  const normalized = normalizeTrivyReport(trivyReport, container);
  const packagesWithDetectedLicenses = normalized.packages.filter(
    (pkg) => pkg.detectedLicenses.length > 0
  ).length;
  return {
    schemaVersion: CONTAINER_PACKAGE_INVENTORY_SCHEMA_VERSION,
    artifactKind: CONTAINER_PACKAGE_INVENTORY_ARTIFACT_KIND,
    source: {
      commit
    },
    image: {
      id: container.imageId,
      digest: container.imageDigest,
      os: container.os,
      architecture: container.architecture,
      rootfsLayers: container.rootfsLayers
    },
    scanner: {
      name: "trivy",
      version: REQUIRED_TRIVY_VERSION,
      reportSchemaVersion: REQUIRED_TRIVY_REPORT_SCHEMA_VERSION,
      scope: "os-packages",
      licenseMode: "standard"
    },
    summary: {
      packageCount: normalized.packages.length,
      packagesWithDetectedLicenses,
      packagesWithoutDetectedLicenses:
        normalized.packages.length - packagesWithDetectedLicenses,
      classifiedLicenseFindingCount: normalized.classifiedLicenseFindingCount
    },
    packageSetDigest: packageSetDigest(normalized.packages),
    packages: normalized.packages
  };
}

export function validateContainerImagePackageInventory(inventory) {
  const problems = [];
  try {
    const value = requireRecord(inventory, "container package inventory");
    requireExactKeys(
      value,
      [
        "schemaVersion",
        "artifactKind",
        "source",
        "image",
        "scanner",
        "summary",
        "packageSetDigest",
        "packages"
      ],
      "container package inventory"
    );
    if (value.schemaVersion !== CONTAINER_PACKAGE_INVENTORY_SCHEMA_VERSION) {
      throw new Error(
        `container package inventory must use schema version ${CONTAINER_PACKAGE_INVENTORY_SCHEMA_VERSION}`
      );
    }
    if (value.artifactKind !== CONTAINER_PACKAGE_INVENTORY_ARTIFACT_KIND) {
      throw new Error("container package inventory has the wrong artifact kind");
    }
    const source = requireRecord(value.source, "container package inventory.source");
    requireExactKeys(source, ["commit"], "container package inventory.source");
    requireCommit(source.commit, "container package inventory.source.commit");
    const image = requireRecord(value.image, "container package inventory.image");
    requireExactKeys(
      image,
      ["id", "digest", "os", "architecture", "rootfsLayers"],
      "container package inventory.image"
    );
    const imageId = requireSha256Id(image.id, "container package inventory.image.id");
    if (image.digest !== imageId.slice("sha256:".length) || !SHA256_PATTERN.test(image.digest)) {
      throw new Error("container package inventory image digest does not match its image ID");
    }
    requireString(image.os, "container package inventory.image.os");
    requireString(image.architecture, "container package inventory.image.architecture");
    if (!Array.isArray(image.rootfsLayers) || image.rootfsLayers.length === 0) {
      throw new Error("container package inventory rootfs layers must be a non-empty array");
    }
    image.rootfsLayers.forEach((layer, index) =>
      requireSha256Id(layer, `container package inventory.image.rootfsLayers[${index}]`)
    );
    const scanner = requireRecord(value.scanner, "container package inventory.scanner");
    requireExactKeys(
      scanner,
      ["name", "version", "reportSchemaVersion", "scope", "licenseMode"],
      "container package inventory.scanner"
    );
    if (
      scanner.name !== "trivy" ||
      scanner.version !== REQUIRED_TRIVY_VERSION ||
      scanner.reportSchemaVersion !== REQUIRED_TRIVY_REPORT_SCHEMA_VERSION ||
      scanner.scope !== "os-packages" ||
      scanner.licenseMode !== "standard"
    ) {
      throw new Error("container package inventory scanner contract is not the reviewed contract");
    }
    if (!Array.isArray(value.packages) || value.packages.length === 0) {
      throw new Error("container package inventory packages must be a non-empty array");
    }
    const keys = new Set();
    let previousKey = null;
    let packagesWithDetectedLicenses = 0;
    for (const [index, pkgValue] of value.packages.entries()) {
      const pkg = requireRecord(pkgValue, `container package inventory package ${index}`);
      requireExactKeys(
        pkg,
        [
          "key",
          "packageType",
          "name",
          "version",
          "architecture",
          "sourceName",
          "sourceVersion",
          "detectedLicenses",
          "evidenceDigest"
        ],
        `container package inventory package ${index}`
      );
      const expected = normalizePackage(
        {
          Name: pkg.name,
          Version: pkg.version,
          Arch: pkg.architecture,
          SrcName: pkg.sourceName,
          SrcVersion: pkg.sourceVersion,
          Licenses: pkg.detectedLicenses
        },
        requireString(pkg.packageType, `container package inventory package ${index}.packageType`),
        index
      );
      if (
        pkg.key !== expected.key ||
        pkg.packageType !== expected.packageType ||
        pkg.name !== expected.name ||
        pkg.version !== expected.version ||
        pkg.architecture !== expected.architecture ||
        pkg.sourceName !== expected.sourceName ||
        pkg.sourceVersion !== expected.sourceVersion ||
        JSON.stringify(pkg.detectedLicenses) !== JSON.stringify(expected.detectedLicenses) ||
        pkg.evidenceDigest !== expected.evidenceDigest
      ) {
        throw new Error(`container package inventory package ${index} identity or evidence digest is stale`);
      }
      if (keys.has(pkg.key)) {
        throw new Error(`container package inventory contains duplicate package ${pkg.key}`);
      }
      if (previousKey !== null && compareStrings(previousKey, pkg.key) >= 0) {
        throw new Error("container package inventory packages are not in canonical order");
      }
      keys.add(pkg.key);
      previousKey = pkg.key;
      if (expected.detectedLicenses.length > 0) packagesWithDetectedLicenses += 1;
    }
    if (
      typeof value.packageSetDigest !== "string" ||
      !SHA256_PATTERN.test(value.packageSetDigest) ||
      value.packageSetDigest !== packageSetDigest(value.packages)
    ) {
      throw new Error("container package inventory packageSetDigest is stale");
    }
    const summary = requireRecord(value.summary, "container package inventory.summary");
    requireExactKeys(
      summary,
      [
        "packageCount",
        "packagesWithDetectedLicenses",
        "packagesWithoutDetectedLicenses",
        "classifiedLicenseFindingCount"
      ],
      "container package inventory.summary"
    );
    const expectedSummary = {
      packageCount: value.packages.length,
      packagesWithDetectedLicenses,
      packagesWithoutDetectedLicenses: value.packages.length - packagesWithDetectedLicenses
    };
    for (const [field, expected] of Object.entries(expectedSummary)) {
      if (summary[field] !== expected) {
        throw new Error(`container package inventory summary.${field} is stale`);
      }
    }
    if (
      !Number.isSafeInteger(summary.classifiedLicenseFindingCount) ||
      summary.classifiedLicenseFindingCount <= 0
    ) {
      throw new Error(
        "container package inventory summary.classifiedLicenseFindingCount must be positive"
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: problems.length === 0, problems };
}

export function serializeContainerImagePackageInventory(inventory) {
  const verdict = validateContainerImagePackageInventory(inventory);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return `${JSON.stringify(inventory, null, 2)}\n`;
}
