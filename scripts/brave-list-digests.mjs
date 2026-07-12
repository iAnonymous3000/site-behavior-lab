import { createHash } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical bytes for the aggregate source manifest. Array order is
 * intentional because filter-list order can affect the resulting ruleset;
 * object key order is rebuilt here so incidental metadata or serialization
 * order cannot affect the digest.
 */
export function canonicalSourceManifest(sources) {
  return JSON.stringify(
    sources.map((source) => ({
      url: source.url,
      bytes: source.bytes,
      sha256: source.sha256
    }))
  );
}

export function sourceManifestDigest(sources) {
  return sha256Hex(canonicalSourceManifest(sources));
}
