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
export const CANDIDATE_UNIVERSE_VERSION = 2;

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * The structured source manifest: free-text provenance cannot prove a list
 * was externally sourced, so the manifest requires a provider, the
 * provider's PERMANENT id for the exact snapshot (a Tranco list id, an
 * archived URL, a versioned dataset DOI), the retrieval URL and instant, and
 * the sha256 of the exact bytes retrieved. The builder refuses a manifest
 * whose digest does not match the supplied bytes, so the claim "these bytes
 * are that snapshot" is checkable by anyone who re-fetches the permanent id.
 * Two limits are stated rather than papered over: the manifest is
 * OPERATOR-ATTESTED (this process fetches nothing; verification is the
 * auditor's re-fetch-and-compare), and it deliberately carries NO free-text
 * scope: a population scope exists only when a category SOURCE binds it,
 * because a popularity provider like Tranco publishes rankings, not
 * finance/news classifications, and a typed string cannot stand in for the
 * classification bytes.
 */
export function validateSourceManifest(manifest, sourceBytes) {
  require(
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest),
    "source manifest must be a record"
  );
  const allowed = ["provider", "permanentId", "url", "retrievedAt", "sha256"];
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
      ["studyId", "base", "category", "exclusions", "poolSize", "pilotSize"].includes(key),
      `universe options carry unexpected field "${key}"`
    );
  }
  const { studyId, base, category = null, exclusions, poolSize, pilotSize = 0 } = options;
  require(typeof studyId === "string" && studyId.length > 0, "universe needs a studyId");
  require(
    typeof base === "object" && base !== null && typeof base.bytes === "string",
    "universe needs base: { bytes, manifest }"
  );
  validateSourceManifest(base.manifest, base.bytes);
  if (category !== null) {
    require(
      typeof category === "object" && typeof category.bytes === "string",
      "category must be { bytes, manifest } or absent"
    );
    validateSourceManifest(category.manifest, category.bytes);
  }
  // No size floor derived from any study's N: the draft's N=350 and its 0.50
  // base rate are withdrawn, so a pool size justified from them would be a
  // withdrawn claim wearing a constant. The size is structural here; its
  // JUSTIFICATION (loss bound plus the precommitted disjoint prevalence
  // pilot) belongs to the preregistration, and the fail condition when the
  // derived N exceeds the swept pool is stated there.
  require(
    Number.isSafeInteger(poolSize) && poolSize >= 1,
    "universe pool size must be a positive integer, justified in the preregistration"
  );
  require(
    Number.isSafeInteger(pilotSize) && pilotSize >= 0,
    "pilot size must be a non-negative integer"
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
  const { domains: baseDomains, sourceSha256 } = parseExternalSourceList(base.bytes);

  // A population scope exists only through the deterministic transformation:
  // base order, intersected with the category source's membership. There is
  // no other scoping input.
  let domains = baseDomains;
  let categoryFacts = null;
  if (category !== null) {
    const parsedCategory = parseExternalSourceList(category.bytes);
    const members = new Set(parsedCategory.domains);
    domains = baseDomains.filter((domain) => members.has(domain));
    categoryFacts = {
      manifest: { ...category.manifest },
      sha256: parsedCategory.sourceSha256,
      domains: parsedCategory.domains.length,
      intersection: domains.length
    };
  }

  // The pilot is a DISJOINT PREFIX: the first pilotSize survivors, then the
  // confirmatory pool from the survivors after them. Disjointness is by
  // construction, so the prevalence pilot can never share a site with the
  // confirmatory frame it sizes.
  const pilot = [];
  const candidates = [];
  const excludedHits = [];
  for (const domain of domains) {
    if (pilot.length + candidates.length === pilotSize + poolSize) break;
    if (excluded.has(domain)) {
      excludedHits.push(domain);
      continue;
    }
    const entry = { caseId: domain, url: `https://${domain}/` };
    if (pilot.length < pilotSize) pilot.push(entry);
    else candidates.push(entry);
  }
  require(
    candidates.length === poolSize && pilot.length === pilotSize,
    `the source yields ${pilot.length} pilot and ${candidates.length} pool candidates of ${pilotSize}+${poolSize} requested after exclusions; supply a longer external list, never relax an exclusion`
  );

  const candidateSet = { studyId, candidates };
  const candidateSetBytes = `${JSON.stringify(candidateSet, null, 2)}\n`;
  const pilotSet = pilotSize > 0 ? { studyId: `${studyId}-prevalence-pilot`, candidates: pilot } : null;
  const pilotSetBytes = pilotSet === null ? null : `${JSON.stringify(pilotSet, null, 2)}\n`;
  const provenance = {
    kind: CANDIDATE_UNIVERSE_KIND,
    version: CANDIDATE_UNIVERSE_VERSION,
    studyId,
    /** Operator-attested; auditor verification is re-fetch by permanentId and digest comparison. */
    attestation: "operator-attested-permanent-id",
    baseManifest: { ...base.manifest },
    sourceSha256,
    sourceDomains: baseDomains.length,
    category: categoryFacts,
    /** Generated, never typed: the population is the transformation. */
    population:
      categoryFacts === null
        ? `domains of ${base.manifest.provider} snapshot ${base.manifest.permanentId}, in source order, development corpus excluded`
        : `domains of ${base.manifest.provider} snapshot ${base.manifest.permanentId}, in source order, intersected with category source ${categoryFacts.manifest.provider} ${categoryFacts.manifest.permanentId}, development corpus excluded`,
    poolSize,
    pilotSize,
    pilotDisjointFromPool: true,
    candidateSetSha256: sha256Hex(candidateSetBytes),
    pilotSetSha256: pilotSetBytes === null ? null : sha256Hex(pilotSetBytes),
    /**
     * The proof half: every development-corpus domain the scoped source
     * contained and this build removed, in source order. An auditor checks
     * independence by re-deriving the exclusion set and confirming no
     * repository data did anything but remove.
     */
    excludedDomains: excludedHits,
    exclusionListSha256: sha256Hex(JSON.stringify([...excluded].sort()))
  };
  return { candidateSet, candidateSetBytes, pilotSet, pilotSetBytes, provenance };
}
