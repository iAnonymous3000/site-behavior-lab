/**
 * Candidate-universe construction for calibration sweeps
 * (docs/reliability-sweep-cluster-design.md; pool rules in
 * docs/calibration-prereg-drafts/frame-construction.md).
 *
 * THE INDEPENDENCE RULE, enforced by shape: the universe comes from an
 * operator-supplied EXTERNAL source list whose exact bytes are digested into
 * the provenance record, taken in SOURCE ORDER. No scanner output, corpus
 * report, detection, or screening result may rank, filter, or admit a
 * candidate: the only thing repository data may do here is EXCLUDE, because
 * the censoring analysis's own boundary requires development-corpus sites to
 * be excluded from a confirmatory frame or the frame fixed from an
 * independently defined universe. Exclusion by development data removes
 * contamination; selection by it is how a calibration study becomes a
 * measurement of itself. The builder therefore takes a source file and an
 * exclusion list, and the provenance artifact records both digests plus
 * every excluded domain, so the independence claim is checkable byte by
 * byte.
 */

import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

export const CANDIDATE_UNIVERSE_KIND =
  "site-behavior-calibration-candidate-universe";
export const CANDIDATE_UNIVERSE_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * The structured source manifest: free-text provenance cannot prove a list
 * was externally sourced, so the manifest requires a provider, the
 * provider's PERMANENT id for the exact snapshot (a Tranco list id, an
 * archived URL, a versioned dataset DOI), the retrieval URL and instant, the
 * declared population scope, and the sha256 of the exact bytes retrieved.
 * The builder refuses a manifest whose digest does not match the supplied
 * bytes, so the claim "these bytes are that snapshot" is checkable by anyone
 * who re-fetches the permanent id.
 */
export function validateSourceManifest(manifest, sourceBytes) {
  require(
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest),
    "source manifest must be a record"
  );
  const allowed = ["provider", "permanentId", "url", "retrievedAt", "scope", "sha256"];
  for (const key of Object.keys(manifest)) {
    require(allowed.includes(key), `source manifest carries unexpected field "${key}"`);
  }
  for (const field of allowed) {
    require(
      typeof manifest[field] === "string" && manifest[field].length > 0,
      `source manifest needs ${field}`
    );
  }
  require(/^https:\/\//.test(manifest.url), "source manifest url must be https");
  require(ISO_UTC.test(manifest.retrievedAt), "source manifest retrievedAt must be ISO-8601 UTC");
  require(SHA256.test(manifest.sha256), "source manifest sha256 must be a sha256");
  require(
    manifest.sha256 === sha256Hex(sourceBytes),
    "source manifest sha256 does not match the supplied source bytes; the bytes are not the named snapshot"
  );
  return manifest;
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Parse an external source list: one domain per line, comments and blanks
 * ignored, order preserved. The digest is over the exact bytes, so the
 * provenance names the file the operator supplied, not a normalization.
 */
export function parseExternalSourceList(bytes) {
  require(typeof bytes === "string" && bytes.length > 0, "source list requires the file's exact contents");
  const domains = [];
  const seen = new Set();
  for (const rawLine of bytes.split("\n")) {
    const line = rawLine.trim().toLowerCase();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Accept "rank,domain" CSV rows (the common published-list shape) or bare
    // domains; anything else is refused rather than guessed at.
    const field = line.includes(",") ? line.slice(line.lastIndexOf(",") + 1).trim() : line;
    require(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(field),
      `source list line is not a domain: "${rawLine.trim().slice(0, 80)}"`
    );
    if (seen.has(field)) continue;
    seen.add(field);
    domains.push(field);
  }
  require(domains.length > 0, "source list holds no domains");
  return { domains, sourceSha256: sha256Hex(bytes) };
}

/**
 * Build the candidate universe: source order, exclusions applied, first
 * `poolSize` survivors. Deterministic and selection-free: the one ordering
 * is the external source's own, and the one filter is the exclusion set.
 */
export function buildCandidateUniverse(options) {
  require(typeof options === "object" && options !== null, "universe needs its options record");
  // Closed signature, as with the v4 merge: there is no parameter through
  // which scanner results could rank or admit a candidate, and an unknown
  // argument must not silently become one.
  for (const key of Object.keys(options)) {
    require(
      ["studyId", "sourceBytes", "sourceManifest", "exclusions", "poolSize"].includes(key),
      `universe options carry unexpected field "${key}"`
    );
  }
  const { studyId, sourceBytes, sourceManifest, exclusions, poolSize } = options;
  require(typeof studyId === "string" && studyId.length > 0, "universe needs a studyId");
  validateSourceManifest(sourceManifest, sourceBytes);
  require(
    Number.isSafeInteger(poolSize) && poolSize >= 600,
    "universe pool size must be at least 600 (frame-construction: a pool of 600 or more for CNAME at N ~ 350)"
  );
  require(Array.isArray(exclusions), "universe needs the exclusion list (possibly empty, but stated)");
  const excluded = new Set();
  for (const entry of exclusions) {
    require(
      typeof entry === "string" && entry.length > 0,
      "each exclusion must be a domain string"
    );
    excluded.add(entry.toLowerCase());
  }
  const { domains, sourceSha256 } = parseExternalSourceList(sourceBytes);

  const candidates = [];
  const excludedHits = [];
  for (const domain of domains) {
    if (candidates.length === poolSize) break;
    if (excluded.has(domain)) {
      excludedHits.push(domain);
      continue;
    }
    candidates.push({ caseId: domain, url: `https://${domain}/` });
  }
  require(
    candidates.length === poolSize,
    `the source list yields only ${candidates.length} of ${poolSize} candidates after exclusions; supply a longer external list, never relax an exclusion`
  );

  const candidateSet = { studyId, candidates };
  const candidateSetBytes = `${JSON.stringify(candidateSet, null, 2)}\n`;
  const provenance = {
    kind: CANDIDATE_UNIVERSE_KIND,
    version: CANDIDATE_UNIVERSE_VERSION,
    studyId,
    sourceManifest: { ...sourceManifest },
    sourceSha256,
    sourceDomains: domains.length,
    poolSize,
    candidateSetSha256: sha256Hex(candidateSetBytes),
    /**
     * The proof half: every development-corpus domain the source list
     * contained and this build removed, in source order. An auditor checks
     * independence by re-deriving the exclusion set and confirming no
     * repository data did anything but remove.
     */
    excludedDomains: excludedHits,
    exclusionListSha256: sha256Hex(JSON.stringify([...excluded].sort()))
  };
  return { candidateSet, candidateSetBytes, provenance };
}
