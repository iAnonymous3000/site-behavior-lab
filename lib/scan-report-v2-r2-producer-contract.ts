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
  isReadableR2Normalization,
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX
} from "./scan-report-v2-normalization";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { trackerCatalogMetadata } from "./tracker-catalog";
import {
  DETECTOR_IDS,
  type DetectorLedger
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
  const historicalV3 = isHistoricalNodeV3Normalization(run.toolchain.normalizationVersion);
  const expectedMethodology = historicalV3
    ? HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION
    : NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION;
  const expectedRegistry = historicalV3
    ? {
        version: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
        digest: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST
      }
    : { version: DETECTOR_REGISTRY_VERSION, digest: DETECTOR_REGISTRY_DIGEST };
  if (run.provenance.methodologyVersion !== expectedMethodology) {
    throw new R2ProducerContractError("unknown Node methodology identity");
  }
  if (
    run.provenance.detectorRegistry.version !== expectedRegistry.version ||
    run.provenance.detectorRegistry.digest !== expectedRegistry.digest
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
  assertCurrentTrackerCatalog(run);
  if (run.toolchain.adblock !== null) {
    if (
      run.toolchain.adblock.engineVersion !==
        (historicalV3 ? HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION : NODE_ADBLOCK_ENGINE_VERSION) ||
      !Number.isSafeInteger(run.toolchain.adblock.lists) ||
      run.toolchain.adblock.lists <= 0 ||
      !/^[0-9a-f]{64}$/.test(run.toolchain.adblock.manifestDigest) ||
      !canonicalTimestamp(run.toolchain.adblock.fetchedAt)
    ) {
      throw new R2ProducerContractError("invalid Node adblock toolchain identity");
    }
  }
  assertNodeDetectorLedger(run.detectors);
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
  // Every non-historical Node report must carry an identity this generation
  // reviewed: the active one, or one it superseded by widening the sanitizer's
  // admitted strings. The sanitizer repeats this check, but the producer
  // contract must not select the active identity for an arbitrary string.
  if (!isReadableR2Normalization("node-playwright", normalization)) {
    throw new R2ProducerContractError("unknown Node normalization identity");
  }
  return false;
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
  assertCurrentTrackerCatalog(run);
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

function assertNodeDetectorLedger(detectors: DetectorLedger): void {
  for (const id of DETECTOR_IDS) {
    const entry = detectors[id];
    if (entry.version !== DETECTOR_VERSIONS[id]) {
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

function assertCurrentTrackerCatalog(run: ScanRunV2R2): void {
  const expected = {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    entries: trackerCatalogMetadata.entries,
    digest: trackerCatalogMetadata.digest
  };
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
