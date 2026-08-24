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
import { PREREGISTERED_PILOT_MINIMUM } from "./calibration-pilot-sizing-lib.mjs";
import { createHash } from "node:crypto";

export const CANDIDATE_UNIVERSE_KIND =
  "site-behavior-calibration-candidate-universe";
export const CANDIDATE_UNIVERSE_VERSION = 4;
export const UNIVERSE_PARTITION_METHOD = "seeded-fisher-yates-sha256-v1";

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
const DOMAIN_GRAMMAR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseExternalSourceList(bytes) {
  require(typeof bytes === "string" && bytes.length > 0, "source list requires the file's exact contents");
  // Three shapes, decided by the first non-comment, non-blank line and by
  // nothing else. A line whose lowercased form is exactly "domain" or starts
  // with "domain," is a header: the file is a header-led CSV whose FIRST
  // column is the domain and whose remaining columns are the provider's own
  // annotations, never read. Otherwise every line is a bare domain or a
  // "rank,domain" row (last field), exactly as before.
  const lines = bytes.split("\n");
  let headerCsv = false;
  for (const rawLine of lines) {
    const line = rawLine.trim().toLowerCase();
    if (line.length === 0 || line.startsWith("#")) continue;
    headerCsv = line === "domain" || line.startsWith("domain,");
    break;
  }
  const domains = [];
  const seen = new Set();
  const rejectedRows = [];
  let sawHeader = false;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim().toLowerCase();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (headerCsv && !sawHeader) {
      sawHeader = true;
      continue;
    }
    const field = headerCsv
      ? line.slice(0, line.includes(",") ? line.indexOf(",") : line.length).trim()
      : line.includes(",")
        ? line.slice(line.lastIndexOf(",") + 1).trim()
        : line;
    if (!DOMAIN_GRAMMAR.test(field)) {
      // Both CSV shapes are provider-published datasets, and real snapshots
      // carry rows whose domain field is not a registrable https hostname
      // (Tranco's "_wildcard_" artifacts, a category list's path-suffixed
      // pages). Those rows are rejected by this closed grammar and RECORDED,
      // never silently dropped and never repaired. A bare junk line still
      // refuses the whole file: the bare shape carries nothing but domains,
      // so junk means the bytes are not the claimed kind of list.
      require(
        headerCsv || line.includes(","),
        `source list line is not a domain: "${rawLine.trim().slice(0, 80)}"`
      );
      rejectedRows.push({ line: index + 1, text: rawLine.trim().slice(0, 80) });
      continue;
    }
    if (seen.has(field)) continue;
    seen.add(field);
    domains.push(field);
  }
  require(
    rejectedRows.length <= 100,
    `source list rejected ${rejectedRows.length} rows; the bytes are not a domain list`
  );
  require(domains.length > 0, "source list holds no domains");
  return { domains, sourceSha256: sha256Hex(bytes), rejectedRows };
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
  const { studyId, base, category = null, exclusions, poolSize, pilotSize } = options;
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
    Number.isSafeInteger(pilotSize) && pilotSize >= PREREGISTERED_PILOT_MINIMUM,
    `pilot size must be at least the preregistered minimum of ${PREREGISTERED_PILOT_MINIMUM}; a confirmatory universe without a pilot has no prevalence estimate and no sizing rule`
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
  const {
    domains: baseDomains,
    sourceSha256,
    rejectedRows: baseRejectedRows
  } = parseExternalSourceList(base.bytes);

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
      /** Rows the closed grammar rejected, as emitted proof, never repaired. */
      rejectedRows: parsedCategory.rejectedRows,
      intersection: domains.length
    };
  }

  // ONE FIXED SAMPLING FRAME, then a deterministic, precommitted RANDOM
  // partition into pilot and pool. A prefix pilot was the reviewed defect:
  // popularity rank can correlate with CNAME deployment, so the first K
  // survivors are not representative of the survivors after them. The frame
  // is the first pilotSize + poolSize survivors in source order; MEMBERSHIP
  // in the pilot is then decided by a seeded Fisher-Yates shuffle whose seed
  // derives entirely from the committed inputs, so there is no free seed
  // parameter through which a partition could be steered, and any auditor
  // re-derives the identical split from the artifacts alone. Both sets are
  // emitted in original source order; randomness decides membership only.
  const frame = [];
  const excludedHits = [];
  for (const domain of domains) {
    if (frame.length === pilotSize + poolSize) break;
    if (excluded.has(domain)) {
      excludedHits.push(domain);
      continue;
    }
    frame.push(domain);
  }
  require(
    frame.length === pilotSize + poolSize,
    `the source yields only ${frame.length} of ${pilotSize + poolSize} frame candidates after exclusions; supply a longer external list, never relax an exclusion`
  );
  const exclusionListSha256 = sha256Hex(JSON.stringify([...excluded].sort()));
  const partitionSeed = sha256Hex(
    [
      `${CANDIDATE_UNIVERSE_KIND}-partition-v3`,
      studyId,
      sourceSha256,
      categoryFacts === null ? "no-category" : categoryFacts.sha256,
      exclusionListSha256,
      String(pilotSize),
      String(poolSize)
    ].join("\u0000")
  );
  // Deterministic byte stream: sha256(seed || counter), consumed as unbiased
  // bounded integers by rejection sampling.
  let streamCounter = 0;
  let streamBytes = Buffer.alloc(0);
  let streamOffset = 0;
  const nextByte = () => {
    if (streamOffset === streamBytes.length) {
      streamBytes = createHash("sha256")
        .update(`${partitionSeed}:${streamCounter}`)
        .digest();
      streamCounter += 1;
      streamOffset = 0;
    }
    const byte = streamBytes[streamOffset];
    streamOffset += 1;
    return byte;
  };
  const nextInt = (bound) => {
    // Rejection sampling over 4-byte words keeps the draw unbiased.
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const word =
        nextByte() * 0x1000000 + nextByte() * 0x10000 + nextByte() * 0x100 + nextByte();
      if (word < limit) return word % bound;
    }
  };
  const indices = frame.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swap = nextInt(index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  const pilotIndexSet = new Set(indices.slice(0, pilotSize));
  const pilot = [];
  const candidates = [];
  frame.forEach((domain, index) => {
    const entry = { caseId: domain, url: `https://${domain}/` };
    if (pilotIndexSet.has(index)) pilot.push(entry);
    else candidates.push(entry);
  });

  const candidateSet = { studyId, candidates };
  const candidateSetBytes = `${JSON.stringify(candidateSet, null, 2)}\n`;
  const pilotSet = { studyId: `${studyId}-prevalence-pilot`, candidates: pilot };
  const pilotSetBytes = `${JSON.stringify(pilotSet, null, 2)}\n`;
  const provenance = {
    kind: CANDIDATE_UNIVERSE_KIND,
    version: CANDIDATE_UNIVERSE_VERSION,
    studyId,
    /** Operator-attested; auditor verification is re-fetch by permanentId and digest comparison. */
    attestation: "operator-attested-permanent-id",
    baseManifest: { ...base.manifest },
    sourceSha256,
    sourceDomains: baseDomains.length,
    sourceRejectedRows: baseRejectedRows,
    category: categoryFacts,
    /** Generated, never typed: the population is the transformation. */
    population:
      categoryFacts === null
        ? `domains of ${base.manifest.provider} snapshot ${base.manifest.permanentId}, in source order, development corpus excluded`
        : `domains of ${base.manifest.provider} snapshot ${base.manifest.permanentId}, in source order, intersected with category source ${categoryFacts.manifest.provider} ${categoryFacts.manifest.permanentId}, development corpus excluded`,
    poolSize,
    pilotSize,
    pilotDisjointFromPool: true,
    partition: {
      method: UNIVERSE_PARTITION_METHOD,
      seedSha256: partitionSeed,
      frameSize: frame.length
    },
    candidateSetSha256: sha256Hex(candidateSetBytes),
    pilotSetSha256: sha256Hex(pilotSetBytes),
    /**
     * The proof half: every development-corpus domain the scoped source
     * contained and this build removed, in source order. An auditor checks
     * independence by re-deriving the exclusion set and confirming no
     * repository data did anything but remove.
     */
    excludedDomains: excludedHits,
    exclusionListSha256
  };
  return { candidateSet, candidateSetBytes, pilotSet, pilotSetBytes, provenance };
}
