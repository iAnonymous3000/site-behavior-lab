const MANIFEST_KIND = "site-behavior-downloaded-build-tool-manifest";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLATFORM_SHAPES = Object.freeze({
  "linux-x64": Object.freeze({
    archivePlatform: "linux_amd64",
    format: "tar.gz"
  }),
  "linux-arm64": Object.freeze({
    archivePlatform: "linux_arm64",
    format: "tar.gz"
  }),
  "darwin-x64": Object.freeze({
    archivePlatform: "macOS_amd64",
    format: "zip"
  }),
  "darwin-arm64": Object.freeze({
    archivePlatform: "macOS_arm64",
    format: "zip"
  })
});
const ORDERED_PLATFORMS = Object.freeze(Object.keys(PLATFORM_SHAPES));

export const GITHUB_CLI_BUILD_TOOL_MANIFEST_PATH =
  "scripts/github-cli-build-tool-manifest.json";

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(record, expected, label) {
  const actual = Object.keys(record);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function requireString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a canonical non-empty string`);
  }
  return value;
}

function requireHttpsUrl(value, label) {
  const url = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  return url;
}

function requireSha256(value, label) {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

export function parseGithubCliBuildToolManifest(
  source,
  label = GITHUB_CLI_BUILD_TOOL_MANIFEST_PATH
) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const manifest = requireRecord(parsed, label);
  requireExactKeys(
    manifest,
    [
      "schemaVersion",
      "artifactKind",
      "id",
      "name",
      "version",
      "sourceUrl",
      "checksumManifest",
      "license",
      "licenseStatus",
      "licenseEvidence",
      "usage",
      "runtime",
      "redistributed",
      "assets"
    ],
    label
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactKind !== MANIFEST_KIND ||
    manifest.id !== "github-cli" ||
    manifest.name !== "GitHub CLI"
  ) {
    throw new Error(`${label} has the wrong schema or GitHub CLI identity`);
  }
  const version = requireString(manifest.version, `${label}.version`);
  if (!/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`${label}.version must be an exact stable semantic version`);
  }
  const releaseBase = `https://github.com/cli/cli/releases/download/v${version}/`;
  if (
    requireHttpsUrl(manifest.sourceUrl, `${label}.sourceUrl`) !==
    `https://github.com/cli/cli/releases/tag/v${version}`
  ) {
    throw new Error(`${label}.sourceUrl must identify the exact official release`);
  }
  const checksumManifest = requireRecord(
    manifest.checksumManifest,
    `${label}.checksumManifest`
  );
  requireExactKeys(
    checksumManifest,
    ["url", "sha256"],
    `${label}.checksumManifest`
  );
  if (
    requireHttpsUrl(
      checksumManifest.url,
      `${label}.checksumManifest.url`
    ) !== `${releaseBase}gh_${version}_checksums.txt`
  ) {
    throw new Error(`${label}.checksumManifest.url must identify the exact official release asset`);
  }
  requireSha256(
    checksumManifest.sha256,
    `${label}.checksumManifest.sha256`
  );
  if (
    manifest.license !== "MIT" ||
    manifest.licenseStatus !== "declared-in-tagged-upstream-license" ||
    requireHttpsUrl(
      manifest.licenseEvidence,
      `${label}.licenseEvidence`
    ) !== `https://github.com/cli/cli/blob/v${version}/LICENSE`
  ) {
    throw new Error(`${label} must bind the exact tagged upstream MIT declaration`);
  }
  if (
    manifest.usage !== "build-only" ||
    manifest.runtime !== false ||
    manifest.redistributed !== false
  ) {
    throw new Error(`${label} must remain build-only, non-runtime, and non-redistributed`);
  }
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== ORDERED_PLATFORMS.length
  ) {
    throw new Error(`${label}.assets must contain all four supported platforms`);
  }
  const assets = manifest.assets.map((rawAsset, index) => {
    const assetLabel = `${label}.assets[${index}]`;
    const asset = requireRecord(rawAsset, assetLabel);
    requireExactKeys(
      asset,
      [
        "platform",
        "archive",
        "directory",
        "format",
        "url",
        "archiveSha256",
        "binarySha256"
      ],
      assetLabel
    );
    const platform = requireString(asset.platform, `${assetLabel}.platform`);
    if (platform !== ORDERED_PLATFORMS[index]) {
      throw new Error(`${label}.assets must use the canonical four-platform order`);
    }
    const shape = PLATFORM_SHAPES[platform];
    const archive = `gh_${version}_${shape.archivePlatform}.${shape.format}`;
    const directory = `gh_${version}_${shape.archivePlatform}`;
    if (
      asset.archive !== archive ||
      asset.directory !== directory ||
      asset.format !== shape.format ||
      requireHttpsUrl(asset.url, `${assetLabel}.url`) !==
        `${releaseBase}${archive}`
    ) {
      throw new Error(`${assetLabel} does not match the official release asset shape`);
    }
    requireSha256(asset.archiveSha256, `${assetLabel}.archiveSha256`);
    requireSha256(asset.binarySha256, `${assetLabel}.binarySha256`);
    return { ...asset };
  });
  const canonical = {
    ...manifest,
    checksumManifest: { ...checksumManifest },
    assets
  };
  if (source !== `${JSON.stringify(canonical, null, 2)}\n`) {
    throw new Error(`${label} must be canonical serialized JSON`);
  }
  return canonical;
}
