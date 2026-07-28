import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS,
  isDetectorReasonCode,
  isDetectorReasonForStatus
} from "./measurement-kernel";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import {
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  PAGEGRAPH_R2_NORMALIZATION_VERSION,
  REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX,
  SUPERSEDED_R2_NORMALIZATIONS
} from "./scan-report-v2-normalization";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { trackerCatalogMetadata } from "./tracker-catalog";
import {
  DETECTOR_IDS,
  type DetectorId,
  type DetectorLedger,
  type Toolchain
} from "./scan-report-v2";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";

/**
 * Public-array ceilings are part of the producer identity, not merely memory
 * safeguards. Managed reads replay them so a self-consistent forged report
 * cannot claim evidence that the named producer would never emit.
 */
export const NODE_R2_PUBLIC_LIMITS = Object.freeze({
  phases: 16,
  warnings: 64,
  requests: MAX_RECORDED_REQUESTS,
  cookieRecords: 1_000,
  cookieMutations: 2_000,
  storageRecords: 1_000,
  storageMutations: 2_000,
  fingerprintEvents: 1_000,
  fingerprintDetections: 256,
  cnameCloaks: 256,
  pixelEvents: 512,
  consentObservations: 32,
  policyClaims: 32,
  policyEntities: 100
});

export const NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION =
  `${NODE_SCANNER_METHODOLOGY_VERSION}+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1`;

/** Exact producer epoch attested by the reviewed Node r2/v3 corpus. */
export const HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.0-request-method-v1+phase-kernel-v1+boundary-state-v1+consent-r2-v1+resource-budget-v1";
export const HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION = "node-detectors-v2";
export const HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST =
  "1961b4197b649b6eb8028f95a9f2f6b28973b7427178b23e661017da7ed0c7c4";
export const HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION = "adblock-rust-0.13.0";
export const HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS = Object.freeze({
  "fingerprint-heuristics": "fingerprint-observer@1",
  "keystroke-exfiltration": "synthetic-sentinel@1",
  "cname-uncloaking": "dns-cname-chain@1",
  "pixel-events": "pixel-request-decoder@1",
  "consent-banner": "consent-control-and-state@1",
  "privacy-policy": "policy-text-cross-check@1"
} satisfies Readonly<Record<DetectorId, string>>);
export const HISTORICAL_R2_2026_06_TRACKER_CATALOG = Object.freeze({
  source: "Hand-curated service catalog",
  version: "hand-curated-2026.06",
  entries: 133,
  digest: "b7d4991063310a81b56342ca7ad949723e785704326179e1658335d7af2f88cf"
} satisfies Toolchain["trackerCatalog"]);
export const HISTORICAL_NODE_R2_V3_TRACKER_CATALOG = HISTORICAL_R2_2026_06_TRACKER_CATALOG;

/**
 * Exact producer epoch for the already-published v4 normalization identities
 * retired by sanitizer-vocabulary widening. Git history pins each identity to
 * its pre-detector-coverage Node release.
 */
export const HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.61.1+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1";
export const HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1";
export const HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION = "node-detectors-v2";
export const HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST =
  "1961b4197b649b6eb8028f95a9f2f6b28973b7427178b23e661017da7ed0c7c4";
export const HISTORICAL_NODE_R2_V4_ADBLOCK_ENGINE_VERSION = "adblock-rust-0.13.2";
export const HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS = HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS;
export const HISTORICAL_NODE_R2_V4_TRACKER_CATALOG = HISTORICAL_NODE_R2_V3_TRACKER_CATALOG;
export const HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1":
    Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1":
    Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1":
    Object.freeze([
      HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
      HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION
    ]),
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1":
    Object.freeze([HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION])
});

export const PAGEGRAPH_R2_DETECTOR_VERSION = "pagegraph-import-unsupported@1" as const;
export const PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION = "pagegraph-import-detectors@1" as const;
export const PAGEGRAPH_R2_METHODOLOGY_VERSION = "pagegraph-passive-import-r2@1" as const;

export const PAGEGRAPH_R2_EXPECTED_DETECTORS = Object.freeze(
  Object.fromEntries(
    DETECTOR_IDS.map((id) => [
      id,
      { version: PAGEGRAPH_R2_DETECTOR_VERSION, status: "unsupported" as const, reason: "unsupported" }
    ])
  ) as DetectorLedger
);

export const PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST = sha256Hex(
  canonicalJson({
    version: PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
    detectors: PAGEGRAPH_R2_EXPECTED_DETECTORS
  })
);

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const PAGEGRAPH_METHODOLOGY = new RegExp(
  `^${escapeRegExp(PAGEGRAPH_R2_METHODOLOGY_VERSION)}` +
    String.raw`\+crawl-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}` +
    String.raw`\+crawl-sha-[0-9a-f]{40}` +
    String.raw`\+schema-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}` +
    String.raw`\+sanitizer-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$`
);

export class R2ProducerContractError extends Error {
  constructor(detail: string) {
    super(`producer-contract: ${detail}`);
    this.name = "R2ProducerContractError";
  }
}

/** Replay the exact active producer family named by one public run. */
export function assertR2ProducerContract(run: ScanRunV2R2): void {
  if (run.provenance.observer === "node-playwright") {
    assertNodeProducerContract(run);
    return;
  }
  if (run.provenance.observer === "pagegraph-import") {
    assertPageGraphProducerContract(run);
    return;
  }
  throw new R2ProducerContractError(`retired or unknown observer ${run.provenance.observer}`);
}

function assertNodeProducerContract(run: ScanRunV2R2): void {
  const epoch = nodeProducerEpochForNormalization(run.toolchain.normalizationVersion);
  if (!epoch.methodologyVersions.includes(run.provenance.methodologyVersion)) {
    throw new R2ProducerContractError("unknown Node methodology identity");
  }
  if (
    run.provenance.detectorRegistry.version !== epoch.detectorRegistry.version ||
    run.provenance.detectorRegistry.digest !== epoch.detectorRegistry.digest
  ) {
    throw new R2ProducerContractError("unknown Node detector registry identity");
  }
  if (run.provenance.sourceArtifactDigest !== undefined) {
    throw new R2ProducerContractError("Node producer cannot claim an imported source artifact");
  }
  if (!FULL_GIT_SHA.test(run.provenance.buildCommit)) {
    throw new R2ProducerContractError("Node build provenance is not a full lowercase Git SHA");
  }
  if (
    run.conditions.automation !== "playwright-chromium" ||
    run.conditions.browser.name !== "chromium" ||
    !run.conditions.headless ||
    run.conditions.language !== run.conditions.locale
  ) {
    throw new R2ProducerContractError("conditions are impossible for the Node producer");
  }
  assertTrackerCatalog(run, epoch.trackerCatalog);
  if (run.toolchain.adblock !== null) {
    if (
      run.toolchain.adblock.engineVersion !== epoch.adblockEngineVersion ||
      !Number.isSafeInteger(run.toolchain.adblock.lists) ||
      run.toolchain.adblock.lists <= 0 ||
      !/^[0-9a-f]{64}$/.test(run.toolchain.adblock.manifestDigest) ||
      !canonicalTimestamp(run.toolchain.adblock.fetchedAt)
    ) {
      throw new R2ProducerContractError("invalid Node adblock toolchain identity");
    }
  }
  assertNodeDetectorLedger(run.detectors, epoch.detectorVersions);
  assertAtMost("phases", run.phases.length, NODE_R2_PUBLIC_LIMITS.phases);
  assertAtMost("warnings", run.warnings.length, NODE_R2_PUBLIC_LIMITS.warnings);
  assertAtMost("requests", run.evidence.requests.length, NODE_R2_PUBLIC_LIMITS.requests);
  assertAtMost("cookie mutations", run.evidence.cookieMutations.length, NODE_R2_PUBLIC_LIMITS.cookieMutations);
  assertAtMost("final cookies", run.evidence.cookiesFinal.length, NODE_R2_PUBLIC_LIMITS.cookieRecords);
  assertAtMost("storage mutations", run.evidence.storageMutations.length, NODE_R2_PUBLIC_LIMITS.storageMutations);
  assertAtMost("final storage", run.evidence.storageFinal.length, NODE_R2_PUBLIC_LIMITS.storageRecords);
  assertAtMost("fingerprint events", run.evidence.fingerprintEvents.length, NODE_R2_PUBLIC_LIMITS.fingerprintEvents);
  assertAtMost(
    "fingerprint detections",
    run.evidence.fingerprintDetections.length,
    NODE_R2_PUBLIC_LIMITS.fingerprintDetections
  );
  assertAtMost("CNAME cloaks", run.evidence.cnameCloaks.length, NODE_R2_PUBLIC_LIMITS.cnameCloaks);
  assertAtMost("pixel events", run.evidence.pixelEvents.length, NODE_R2_PUBLIC_LIMITS.pixelEvents);
  if (run.evidence.consent !== undefined) {
    assertAtMost(
      "consent observations",
      run.evidence.consent.verificationObservations.length,
      NODE_R2_PUBLIC_LIMITS.consentObservations
    );
    if (run.evidence.consent.verificationFailureReason !== undefined) {
      throw new R2ProducerContractError("Node r2 consent cannot carry a free-form failure reason");
    }
  }
  if (run.evidence.privacyPolicy !== undefined) {
    assertAtMost("privacy-policy claims", run.evidence.privacyPolicy.claims.length, NODE_R2_PUBLIC_LIMITS.policyClaims);
    assertAtMost(
      "privacy-policy mentioned entities",
      run.evidence.privacyPolicy.mentionedEntities.length,
      NODE_R2_PUBLIC_LIMITS.policyEntities
    );
    assertAtMost(
      "privacy-policy unmentioned entities",
      run.evidence.privacyPolicy.unmentionedEntities.length,
      NODE_R2_PUBLIC_LIMITS.policyEntities
    );
  }
}

function isHistoricalNodeV3Normalization(normalization: string): boolean {
  for (const source of MIGRATABLE_REDACTION_V3_NORMALIZATIONS["node-playwright"]) {
    if (
      normalization === source ||
      normalization === `${source}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`
    ) {
      return true;
    }
  }
  return false;
}

type NodeProducerEpoch = {
  methodologyVersions: readonly string[];
  detectorRegistry: { version: string; digest: string };
  detectorVersions: Readonly<Record<DetectorId, string>>;
  trackerCatalog: Toolchain["trackerCatalog"];
  adblockEngineVersion: string;
};

function nodeProducerEpochForNormalization(normalization: string): NodeProducerEpoch {
  if (isHistoricalNodeV3Normalization(normalization)) {
    return {
      methodologyVersions: [HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION],
      detectorRegistry: {
        version: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
        digest: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST
      },
      detectorVersions: HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS,
      trackerCatalog: HISTORICAL_NODE_R2_V3_TRACKER_CATALOG,
      adblockEngineVersion: HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION
    };
  }
  const historicalV4Methodologies = HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[normalization];
  if (historicalV4Methodologies !== undefined) {
    return {
      methodologyVersions: historicalV4Methodologies,
      detectorRegistry: {
        version: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION,
        digest: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST
      },
      detectorVersions: HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS,
      trackerCatalog: HISTORICAL_NODE_R2_V4_TRACKER_CATALOG,
      adblockEngineVersion: HISTORICAL_NODE_R2_V4_ADBLOCK_ENGINE_VERSION
    };
  }
  if (normalization === NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION) {
    return {
      methodologyVersions: [NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION],
      detectorRegistry: { version: DETECTOR_REGISTRY_VERSION, digest: DETECTOR_REGISTRY_DIGEST },
      detectorVersions: DETECTOR_VERSIONS,
      trackerCatalog: currentTrackerCatalogIdentity(),
      adblockEngineVersion: NODE_ADBLOCK_ENGINE_VERSION
    };
  }
  throw new R2ProducerContractError("unknown Node normalization identity");
}

function assertPageGraphProducerContract(run: ScanRunV2R2): void {
  if (run.provenance.acquisition !== "upload") {
    throw new R2ProducerContractError("PageGraph acquisition must be upload");
  }
  if (!PAGEGRAPH_METHODOLOGY.test(run.provenance.methodologyVersion)) {
    throw new R2ProducerContractError("unknown PageGraph methodology identity");
  }
  if (!FULL_GIT_SHA.test(run.provenance.buildCommit)) {
    throw new R2ProducerContractError("PageGraph build provenance is not a full lowercase Git SHA");
  }
  if (
    run.provenance.detectorRegistry.version !== PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION ||
    run.provenance.detectorRegistry.digest !== PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST ||
    canonicalJson(run.detectors) !== canonicalJson(PAGEGRAPH_R2_EXPECTED_DETECTORS)
  ) {
    throw new R2ProducerContractError("unknown PageGraph detector contract");
  }
  if (
    run.conditions.automation !== "brave-pagegraph" ||
    run.conditions.consent !== "observe" ||
    run.conditions.shields !== "off" ||
    run.conditions.probes.keystroke ||
    run.conditions.probes.policyVisit ||
    run.toolchain.adblock !== null ||
    run.verificationFacts !== undefined
  ) {
    throw new R2ProducerContractError("conditions or verification facts are impossible for PageGraph");
  }
  assertTrackerCatalog(run, pageGraphTrackerCatalogForNormalization(run.toolchain.normalizationVersion));
  if (
    run.phases.length !== 1 ||
    run.phases[0].phaseId !== 0 ||
    run.phases[0].kind !== "passive-load"
  ) {
    throw new R2ProducerContractError("PageGraph must carry exactly one passive-load phase");
  }
  assertAtMost("PageGraph requests", run.evidence.requests.length, MAX_RECORDED_REQUESTS);
  if (
    run.evidence.cookieMutations.length !== 0 ||
    run.evidence.cookiesFinal.length !== 0 ||
    run.evidence.storageMutations.length !== 0 ||
    run.evidence.storageFinal.length !== 0 ||
    run.evidence.fingerprintEvents.length !== 0 ||
    run.evidence.fingerprintDetections.length !== 0 ||
    run.evidence.cnameCloaks.length !== 0 ||
    run.evidence.pixelEvents.length !== 0 ||
    run.evidence.privacyPolicy !== undefined ||
    run.evidence.consent !== undefined
  ) {
    throw new R2ProducerContractError("PageGraph reports may carry request evidence only");
  }
}

function assertNodeDetectorLedger(
  detectors: DetectorLedger,
  expectedVersions: Readonly<Record<DetectorId, string>>
): void {
  for (const id of DETECTOR_IDS) {
    const entry = detectors[id];
    if (entry.version !== expectedVersions[id]) {
      throw new R2ProducerContractError(`unknown Node detector version for ${id}`);
    }
    if (entry.reason !== undefined && !isDetectorReasonCode(entry.reason)) {
      throw new R2ProducerContractError(`unknown Node detector reason for ${id}`);
    }
    if (
      (entry.status === "complete" && entry.reason !== undefined) ||
      (entry.status !== "complete" && entry.reason === undefined) ||
      (entry.reason !== undefined && !isDetectorReasonForStatus(entry.status, entry.reason))
    ) {
      throw new R2ProducerContractError(`incompatible Node detector status/reason for ${id}`);
    }
  }
}

function currentTrackerCatalogIdentity(): Toolchain["trackerCatalog"] {
  return {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    entries: trackerCatalogMetadata.entries,
    digest: trackerCatalogMetadata.digest
  };
}

function pageGraphTrackerCatalogForNormalization(normalization: string): Toolchain["trackerCatalog"] {
  if (
    SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].has(normalization) ||
    [...MIGRATABLE_REDACTION_V3_NORMALIZATIONS["pagegraph-import"]].some(
      (source) =>
        normalization === source ||
        normalization === `${source}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`
    )
  ) {
    return HISTORICAL_R2_2026_06_TRACKER_CATALOG;
  }
  if (normalization === PAGEGRAPH_R2_NORMALIZATION_VERSION) {
    return currentTrackerCatalogIdentity();
  }
  throw new R2ProducerContractError("unknown PageGraph normalization identity");
}

function assertTrackerCatalog(run: ScanRunV2R2, expected: Toolchain["trackerCatalog"]): void {
  if (canonicalJson(run.toolchain.trackerCatalog) !== canonicalJson(expected)) {
    throw new R2ProducerContractError("unknown tracker catalog identity");
  }
}

function assertAtMost(label: string, actual: number, maximum: number): void {
  if (actual > maximum) throw new R2ProducerContractError(`${label} exceed producer cap ${maximum}`);
}

function canonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
