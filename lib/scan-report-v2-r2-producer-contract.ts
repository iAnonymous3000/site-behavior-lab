import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS,
  isDetectorReasonCode,
  isDetectorReasonForStatus
} from "./measurement-kernel";
import {
  DETECTOR_OBLIGATION_CONTRACT_VERSION,
  DETECTOR_OBLIGATION_REGISTRY_DIGEST
} from "./detector-obligations";
import { PHASE_OMISSION_CONTRACT_VERSION } from "./detector-phase-omission";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import {
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  PAGEGRAPH_R2_NORMALIZATION_VERSION
} from "./scan-report-v2-normalization";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";
import { trackerCatalogMetadata } from "./tracker-catalog";
import {
  DETECTOR_IDS,
  type DetectorId,
  type DetectorLedger,
  type DetectorStatus,
  type Toolchain
} from "./scan-report-v2";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";

/**
 * Public-array ceilings are part of the producer identity, not merely memory
 * safeguards. Managed reads replay the limits pinned on the selected row so a
 * self-consistent forged report cannot claim evidence that producer did not
 * emit.
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

export const PAGEGRAPH_R2_PUBLIC_LIMITS = Object.freeze({
  phases: 1,
  requests: MAX_RECORDED_REQUESTS
});

/** Exact accountability epoch immediately before ServiceRole affected producer decisions. */
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+subject-validity-v2+detector-coverage-v2+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1+detector-accountability-v1";

export const NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION =
  `${NODE_SCANNER_METHODOLOGY_VERSION}+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1+detector-accountability-v1+${SERVICE_ROLE_TAXONOMY_VERSION}`;

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
 * its pre-detector-accountability Node release.
 */
export const HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.61.1+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1";
export const HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1";
export const PRE_ACCOUNTABILITY_NODE_R2_METHODOLOGY_VERSION =
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+subject-validity-v2+detector-coverage-v2+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1";
export const HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION = "node-detectors-v2";
export const HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST =
  "1961b4197b649b6eb8028f95a9f2f6b28973b7427178b23e661017da7ed0c7c4";
export const HISTORICAL_NODE_R2_V4_ADBLOCK_ENGINE_VERSION = "adblock-rust-0.13.2";
export const HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS = HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS;
export const HISTORICAL_NODE_R2_V4_TRACKER_CATALOG = HISTORICAL_NODE_R2_V3_TRACKER_CATALOG;

export const PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_REGISTRY_VERSION = "node-detectors-v2";
export const PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_REGISTRY_DIGEST =
  "4f4bf67ce216d0a5c173ae2d1a1ddb79bac3c7699c04e6900908350ee4f5bdc5";
export const PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_VERSIONS = Object.freeze({
  "fingerprint-heuristics": "fingerprint-observer@1",
  "keystroke-exfiltration": "synthetic-sentinel@2",
  "cname-uncloaking": "dns-cname-chain@2",
  "pixel-events": "pixel-request-decoder@2",
  "consent-banner": "consent-control-and-state@2",
  "privacy-policy": "policy-text-cross-check@2"
} satisfies Readonly<Record<DetectorId, string>>);

export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_VERSION =
  "node-detectors-v3";
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_DIGEST =
  "ad2971a6c3eff3a0ba537529ba91cb28686a5101bf2f2c290e47c176cd23c38b";
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_VERSIONS = Object.freeze({
  "fingerprint-heuristics": "fingerprint-observer@1",
  "keystroke-exfiltration": "synthetic-sentinel@3",
  "cname-uncloaking": "dns-cname-chain@3",
  "pixel-events": "pixel-request-decoder@3",
  "consent-banner": "consent-control-and-state@2",
  "privacy-policy": "policy-text-cross-check@3"
} satisfies Readonly<Record<DetectorId, string>>);
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_NORMALIZATION_VERSION =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1";
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_TRACKER_CATALOG = Object.freeze({
  source: "Hand-curated service catalog",
  version: "hand-curated-2026.07",
  entries: 137,
  digest: "7cade02ae20c3bb88e28e0de1135ef63c48f586e7196de3c02c13478f70c95bc"
} satisfies Toolchain["trackerCatalog"]);
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_ADBLOCK_IDENTITY = Object.freeze({
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: "2026-07-25T14:05:35.223Z",
  manifestDigest: "34a785b40cef51a78901561747aa8e1649acdbde8f74370c80bae58e694e187b",
  engineVersion: "adblock-rust-0.13.2"
} satisfies NonNullable<Toolchain["adblock"]>);
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_PUBLIC_LIMITS = Object.freeze({
  phases: 16,
  warnings: 64,
  requests: 1_000,
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
} satisfies Readonly<typeof NODE_R2_PUBLIC_LIMITS>);
export const HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_OBLIGATIONS = Object.freeze({
  version: "detector-obligations-v1",
  digest: "fb8bd07786fdb71c02ffdf1eca40a73b8974c691c6d4ef3c89230ad5314c22a3"
});

const NODE_V3_NORMALIZATION =
  "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+node-evidence-policy-v1";
const NODE_V3_MIGRATED_NORMALIZATION = `${NODE_V3_NORMALIZATION}+v3-to-v4-ip-port-title@1`;
const PAGEGRAPH_V3_NORMALIZATION =
  "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+pagegraph-request-evidence-v1";
const PAGEGRAPH_V3_MIGRATED_NORMALIZATION = `${PAGEGRAPH_V3_NORMALIZATION}+v3-to-v4-ip-port-title@1`;

const V4_NORMALIZATION_PREFIX =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:";
const NODE_NORMALIZATION_SUFFIX = "+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1";
const PAGEGRAPH_NORMALIZATION_SUFFIX =
  "+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1";

const NODE_DBB6_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3${NODE_NORMALIZATION_SUFFIX}`;
const NODE_6E87_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b${NODE_NORMALIZATION_SUFFIX}`;
const NODE_5B1F_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd${NODE_NORMALIZATION_SUFFIX}`;
const NODE_6131_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a${NODE_NORMALIZATION_SUFFIX}`;
const NODE_68C3_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23${NODE_NORMALIZATION_SUFFIX}`;

const PAGEGRAPH_DBB6_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3${PAGEGRAPH_NORMALIZATION_SUFFIX}`;
const PAGEGRAPH_6E87_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b${PAGEGRAPH_NORMALIZATION_SUFFIX}`;
const PAGEGRAPH_5B1F_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd${PAGEGRAPH_NORMALIZATION_SUFFIX}`;
const PAGEGRAPH_6131_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a${PAGEGRAPH_NORMALIZATION_SUFFIX}`;
const PAGEGRAPH_68C3_NORMALIZATION =
  `${V4_NORMALIZATION_PREFIX}68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23${PAGEGRAPH_NORMALIZATION_SUFFIX}`;

export const HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  [NODE_DBB6_NORMALIZATION]: Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  [NODE_6E87_NORMALIZATION]: Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  [NODE_5B1F_NORMALIZATION]: Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  [NODE_6131_NORMALIZATION]: Object.freeze([HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION]),
  [NODE_68C3_NORMALIZATION]: Object.freeze([
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION
  ])
});

export const HISTORICAL_NODE_R2_V3_SHADOW_ADBLOCK_IDENTITY = Object.freeze({
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: "2026-07-12T16:37:07.373Z",
  manifestDigest: "db9450d318ab8b7eea2ac5cac540659290f75967dae688ae8ea23346057cedca",
  engineVersion: HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION
} satisfies NonNullable<Toolchain["adblock"]>);

export const HISTORICAL_NODE_R2_V3_ADBLOCK_IDENTITY = Object.freeze({
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: "2026-07-13T09:47:59.645Z",
  manifestDigest: "17d246aca749766d24266f98061bb05f9d88182529285a3472e57045663261a9",
  engineVersion: HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION
} satisfies NonNullable<Toolchain["adblock"]>);

export const HISTORICAL_NODE_R2_V4_ADBLOCK_IDENTITY = Object.freeze({
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: "2026-07-13T09:47:59.645Z",
  manifestDigest: "17d246aca749766d24266f98061bb05f9d88182529285a3472e57045663261a9",
  engineVersion: HISTORICAL_NODE_R2_V4_ADBLOCK_ENGINE_VERSION
} satisfies NonNullable<Toolchain["adblock"]>);

export const NODE_R2_CURRENT_ADBLOCK_IDENTITY = Object.freeze({
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: "2026-07-25T14:05:35.223Z",
  manifestDigest: "34a785b40cef51a78901561747aa8e1649acdbde8f74370c80bae58e694e187b",
  engineVersion: NODE_ADBLOCK_ENGINE_VERSION
} satisfies NonNullable<Toolchain["adblock"]>);

export const PAGEGRAPH_R2_DETECTOR_VERSION = "pagegraph-import-unsupported@1" as const;
export const PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION = "pagegraph-import-detectors@1" as const;
export const PAGEGRAPH_R2_METHODOLOGY_VERSION = "pagegraph-passive-import-r2@1" as const;

export const PAGEGRAPH_R2_EXPECTED_DETECTORS = Object.freeze(
  Object.fromEntries(
    DETECTOR_IDS.map((id) => [
      id,
      Object.freeze({
        version: PAGEGRAPH_R2_DETECTOR_VERSION,
        status: "unsupported" as const,
        reason: "unsupported"
      })
    ])
  ) as DetectorLedger
);

export const PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST = sha256Hex(
  canonicalJson({
    version: PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
    detectors: PAGEGRAPH_R2_EXPECTED_DETECTORS
  })
);

type DetectorRegistryIdentity = Readonly<{ version: string; digest: string }>;
type AdblockIdentity = Readonly<NonNullable<Toolchain["adblock"]>> | null;
type DetectorObligationIdentity = Readonly<{ version: string; digest: string }> | null;
type ServiceRoleTaxonomyIdentity = Readonly<{ version: string; digest: string }> | null;
type DetectorStatusContractVersion = "detector-status-v1" | "detector-status-v2";

export type NodeR2ProducerTuple = Readonly<{
  id: string;
  normalizationVersion: string;
  methodologyVersion: string;
  detectorRegistry: DetectorRegistryIdentity;
  detectorVersions: Readonly<Record<DetectorId, string>>;
  detectorStatusContractVersion: DetectorStatusContractVersion;
  detectorObligations: DetectorObligationIdentity;
  serviceRoleTaxonomy: ServiceRoleTaxonomyIdentity;
  trackerCatalog: Readonly<Toolchain["trackerCatalog"]>;
  adblockIdentity: AdblockIdentity;
  publicLimits: Readonly<typeof NODE_R2_PUBLIC_LIMITS>;
  phaseOmissionContractVersion: string;
  runtimeIdentity: Readonly<{
    sourceArtifactDigest: "absent";
    automation: "playwright-chromium";
    browserName: "chromium";
    headless: true;
    language: "matches-locale";
  }>;
}>;

export type PageGraphR2ProducerTuple = Readonly<{
  id: string;
  normalizationVersion: string;
  methodologyVersion: typeof PAGEGRAPH_R2_METHODOLOGY_VERSION;
  detectorRegistry: DetectorRegistryIdentity;
  detectors: DetectorLedger;
  trackerCatalog: Readonly<Toolchain["trackerCatalog"]>;
  adblockIdentity: null;
  publicLimits: Readonly<typeof PAGEGRAPH_R2_PUBLIC_LIMITS>;
  phaseOmissionContractVersion: null;
  runtimeIdentity: Readonly<{
    acquisition: "upload";
    automation: "brave-pagegraph";
    consent: "observe";
    shields: "off";
    keystrokeProbe: false;
    policyVisitProbe: false;
    verificationFacts: "absent";
  }>;
}>;

const HISTORICAL_REGISTRY = Object.freeze({
  version: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION,
  digest: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST
});
const PRE_ACCOUNTABILITY_REGISTRY = Object.freeze({
  version: PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_REGISTRY_VERSION,
  digest: PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_REGISTRY_DIGEST
});
const HISTORICAL_ACCOUNTABILITY_V1_REGISTRY = Object.freeze({
  version: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_VERSION,
  digest: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_DIGEST
});
const ACTIVE_REGISTRY = Object.freeze({
  version: DETECTOR_REGISTRY_VERSION,
  digest: DETECTOR_REGISTRY_DIGEST
});
const ACTIVE_DETECTOR_VERSIONS = Object.freeze({ ...DETECTOR_VERSIONS });
const ACTIVE_DETECTOR_OBLIGATIONS = Object.freeze({
  version: DETECTOR_OBLIGATION_CONTRACT_VERSION,
  digest: DETECTOR_OBLIGATION_REGISTRY_DIGEST
});
const ACTIVE_SERVICE_ROLE_TAXONOMY = Object.freeze({
  version: SERVICE_ROLE_TAXONOMY_VERSION,
  digest: SERVICE_ROLE_TAXONOMY_DIGEST
});
const ACTIVE_TRACKER_CATALOG = Object.freeze({
  source: trackerCatalogMetadata.source,
  version: trackerCatalogMetadata.version,
  entries: trackerCatalogMetadata.entries,
  digest: trackerCatalogMetadata.digest
});
const NODE_RUNTIME_IDENTITY = Object.freeze({
  sourceArtifactDigest: "absent" as const,
  automation: "playwright-chromium" as const,
  browserName: "chromium" as const,
  headless: true as const,
  language: "matches-locale" as const
});
const PAGEGRAPH_RUNTIME_IDENTITY = Object.freeze({
  acquisition: "upload" as const,
  automation: "brave-pagegraph" as const,
  consent: "observe" as const,
  shields: "off" as const,
  keystrokeProbe: false as const,
  policyVisitProbe: false as const,
  verificationFacts: "absent" as const
});
const PAGEGRAPH_REGISTRY = Object.freeze({
  version: PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
  digest: PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST
});

type NodeTupleFields = Pick<
  NodeR2ProducerTuple,
  | "detectorRegistry"
  | "detectorVersions"
  | "detectorStatusContractVersion"
  | "detectorObligations"
  | "serviceRoleTaxonomy"
  | "trackerCatalog"
  | "publicLimits"
  | "phaseOmissionContractVersion"
>;

const NODE_V3_FIELDS: NodeTupleFields = Object.freeze({
  detectorRegistry: HISTORICAL_REGISTRY,
  detectorVersions: HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS,
  detectorStatusContractVersion: "detector-status-v1",
  detectorObligations: null,
  serviceRoleTaxonomy: null,
  trackerCatalog: HISTORICAL_NODE_R2_V3_TRACKER_CATALOG,
  publicLimits: NODE_R2_PUBLIC_LIMITS,
  phaseOmissionContractVersion: "phase-omission-v1"
});
const NODE_V4_FIELDS: NodeTupleFields = NODE_V3_FIELDS;
const PRE_ACCOUNTABILITY_FIELDS: NodeTupleFields = Object.freeze({
  detectorRegistry: PRE_ACCOUNTABILITY_REGISTRY,
  detectorVersions: PRE_ACCOUNTABILITY_NODE_R2_DETECTOR_VERSIONS,
  detectorStatusContractVersion: "detector-status-v1",
  detectorObligations: null,
  serviceRoleTaxonomy: null,
  // Frozen to the exact 2026.07 identity this epoch published under. This used to
  // alias ACTIVE_TRACKER_CATALOG, which was only correct while the active catalog
  // still WAS 2026.07; a catalog revision must never rewrite a closed epoch.
  trackerCatalog: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_TRACKER_CATALOG,
  publicLimits: NODE_R2_PUBLIC_LIMITS,
  phaseOmissionContractVersion: "phase-omission-v1"
});
const HISTORICAL_ACCOUNTABILITY_V1_FIELDS: NodeTupleFields = Object.freeze({
  detectorRegistry: HISTORICAL_ACCOUNTABILITY_V1_REGISTRY,
  detectorVersions: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_VERSIONS,
  detectorStatusContractVersion: "detector-status-v2",
  detectorObligations: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_OBLIGATIONS,
  serviceRoleTaxonomy: null,
  trackerCatalog: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_TRACKER_CATALOG,
  publicLimits: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_PUBLIC_LIMITS,
  phaseOmissionContractVersion: "phase-omission-v2"
});
const ACTIVE_DETECTOR_STATUS_CONTRACT_VERSION: DetectorStatusContractVersion =
  isDetectorReasonCode("evidence-cap-reached") ? "detector-status-v2" : "detector-status-v1";
const ACTIVE_NODE_FIELDS: NodeTupleFields = Object.freeze({
  detectorRegistry: ACTIVE_REGISTRY,
  detectorVersions: ACTIVE_DETECTOR_VERSIONS,
  detectorStatusContractVersion: ACTIVE_DETECTOR_STATUS_CONTRACT_VERSION,
  detectorObligations: ACTIVE_DETECTOR_OBLIGATIONS,
  serviceRoleTaxonomy: ACTIVE_SERVICE_ROLE_TAXONOMY,
  trackerCatalog: ACTIVE_TRACKER_CATALOG,
  publicLimits: NODE_R2_PUBLIC_LIMITS,
  phaseOmissionContractVersion: PHASE_OMISSION_CONTRACT_VERSION
});

function nodeTuple(
  id: string,
  normalizationVersion: string,
  methodologyVersion: string,
  fields: NodeTupleFields,
  adblockIdentity: AdblockIdentity
): NodeR2ProducerTuple {
  return Object.freeze({
    id,
    normalizationVersion,
    methodologyVersion,
    detectorRegistry: fields.detectorRegistry,
    detectorVersions: fields.detectorVersions,
    detectorStatusContractVersion: fields.detectorStatusContractVersion,
    detectorObligations: fields.detectorObligations,
    serviceRoleTaxonomy: fields.serviceRoleTaxonomy,
    trackerCatalog: fields.trackerCatalog,
    adblockIdentity,
    publicLimits: fields.publicLimits,
    phaseOmissionContractVersion: fields.phaseOmissionContractVersion,
    runtimeIdentity: NODE_RUNTIME_IDENTITY
  });
}

const ACTIVE_NODE_WIRE_IDENTITY_IS_DISTINCT =
  String(NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION) !==
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION ||
  String(DETECTOR_REGISTRY_VERSION) !==
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_VERSION ||
  DETECTOR_REGISTRY_DIGEST !== HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_DIGEST ||
  canonicalJson(ACTIVE_DETECTOR_VERSIONS) !==
    canonicalJson(HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_VERSIONS) ||
  canonicalJson(ACTIVE_SERVICE_ROLE_TAXONOMY) !==
    canonicalJson(HISTORICAL_ACCOUNTABILITY_V1_FIELDS.serviceRoleTaxonomy);

const ACTIVE_NODE_TUPLES: readonly NodeR2ProducerTuple[] = ACTIVE_NODE_WIRE_IDENTITY_IS_DISTINCT
  ? Object.freeze([
      nodeTuple(
        "node-v4-b68c-active-lists-2026-07-25",
        NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
        NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
        ACTIVE_NODE_FIELDS,
        NODE_R2_CURRENT_ADBLOCK_IDENTITY
      ),
      nodeTuple(
        "node-v4-b68c-active-no-adblock",
        NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
        NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
        ACTIVE_NODE_FIELDS,
        null
      )
    ])
  : Object.freeze([]);

/**
 * Exact, immutable wire producer rows. Every entry names one complete accepted
 * combination. There is no independent "allowed methodologies" set or
 * adblock-engine check that can accidentally cross-product two releases.
 */
export const NODE_R2_PRODUCER_TUPLES: readonly NodeR2ProducerTuple[] = Object.freeze([
  nodeTuple(
    "node-v3-shadow-lists-2026-07-12",
    NODE_V3_NORMALIZATION,
    HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
    NODE_V3_FIELDS,
    HISTORICAL_NODE_R2_V3_SHADOW_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v3-lists-2026-07-13",
    NODE_V3_NORMALIZATION,
    HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
    NODE_V3_FIELDS,
    HISTORICAL_NODE_R2_V3_ADBLOCK_IDENTITY
  ),
  nodeTuple("node-v3-no-adblock", NODE_V3_NORMALIZATION, HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION, NODE_V3_FIELDS, null),
  nodeTuple(
    "node-v3-migrated-shadow-lists-2026-07-12",
    NODE_V3_MIGRATED_NORMALIZATION,
    HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
    NODE_V3_FIELDS,
    HISTORICAL_NODE_R2_V3_SHADOW_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v3-migrated-lists-2026-07-13",
    NODE_V3_MIGRATED_NORMALIZATION,
    HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
    NODE_V3_FIELDS,
    HISTORICAL_NODE_R2_V3_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v3-migrated-no-adblock",
    NODE_V3_MIGRATED_NORMALIZATION,
    HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
    NODE_V3_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-dbb6-lists-2026-07-13",
    NODE_DBB6_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    HISTORICAL_NODE_R2_V4_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-dbb6-lists-2026-07-25",
    NODE_DBB6_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-dbb6-no-adblock",
    NODE_DBB6_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-6e87-lists-2026-07-25",
    NODE_6E87_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-6e87-no-adblock",
    NODE_6E87_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-5b1f-lists-2026-07-25",
    NODE_5B1F_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-5b1f-no-adblock",
    NODE_5B1F_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-6131-pw161-lists-2026-07-25",
    NODE_6131_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-6131-pw161-no-adblock",
    NODE_6131_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-68c3-pw161-lists-2026-07-25",
    NODE_68C3_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-68c3-pw161-no-adblock",
    NODE_68C3_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-68c3-pw162-lists-2026-07-25",
    NODE_68C3_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-68c3-pw162-no-adblock",
    NODE_68C3_NORMALIZATION,
    HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION,
    NODE_V4_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-b68c-pre-accountability-lists-2026-07-25",
    NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
    PRE_ACCOUNTABILITY_NODE_R2_METHODOLOGY_VERSION,
    PRE_ACCOUNTABILITY_FIELDS,
    NODE_R2_CURRENT_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-b68c-pre-accountability-no-adblock",
    NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
    PRE_ACCOUNTABILITY_NODE_R2_METHODOLOGY_VERSION,
    PRE_ACCOUNTABILITY_FIELDS,
    null
  ),
  nodeTuple(
    "node-v4-b68c-accountability-v1-lists-2026-07-25",
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_NORMALIZATION_VERSION,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION,
    HISTORICAL_ACCOUNTABILITY_V1_FIELDS,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_ADBLOCK_IDENTITY
  ),
  nodeTuple(
    "node-v4-b68c-accountability-v1-no-adblock",
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_NORMALIZATION_VERSION,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION,
    HISTORICAL_ACCOUNTABILITY_V1_FIELDS,
    null
  ),
  ...ACTIVE_NODE_TUPLES
]);

function pageGraphTuple(
  id: string,
  normalizationVersion: string,
  trackerCatalog: Readonly<Toolchain["trackerCatalog"]>
): PageGraphR2ProducerTuple {
  return Object.freeze({
    id,
    normalizationVersion,
    methodologyVersion: PAGEGRAPH_R2_METHODOLOGY_VERSION,
    detectorRegistry: PAGEGRAPH_REGISTRY,
    detectors: PAGEGRAPH_R2_EXPECTED_DETECTORS,
    trackerCatalog,
    adblockIdentity: null,
    publicLimits: PAGEGRAPH_R2_PUBLIC_LIMITS,
    phaseOmissionContractVersion: null,
    runtimeIdentity: PAGEGRAPH_RUNTIME_IDENTITY
  });
}

export const PAGEGRAPH_R2_PRODUCER_TUPLES: readonly PageGraphR2ProducerTuple[] = Object.freeze([
  pageGraphTuple("pagegraph-v3", PAGEGRAPH_V3_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v3-migrated", PAGEGRAPH_V3_MIGRATED_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-dbb6", PAGEGRAPH_DBB6_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-6e87", PAGEGRAPH_6E87_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-5b1f", PAGEGRAPH_5B1F_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-6131", PAGEGRAPH_6131_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-68c3", PAGEGRAPH_68C3_NORMALIZATION, HISTORICAL_R2_2026_06_TRACKER_CATALOG),
  pageGraphTuple("pagegraph-v4-active", PAGEGRAPH_R2_NORMALIZATION_VERSION, ACTIVE_TRACKER_CATALOG)
]);

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export class R2ProducerContractError extends Error {
  constructor(detail: string) {
    super(`producer-contract: ${detail}`);
    this.name = "R2ProducerContractError";
  }
}

/** Replay the exact active or historical producer row named by one public run. */
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
  if (!FULL_GIT_SHA.test(run.provenance.buildCommit)) {
    throw new R2ProducerContractError("Node build provenance is not a full lowercase Git SHA");
  }
  const tuple = NODE_R2_PRODUCER_TUPLES.find((candidate) => nodeTupleMatches(run, candidate));
  if (tuple === undefined) {
    throw new R2ProducerContractError("unknown Node producer tuple");
  }
  assertNodeDetectorLedger(run.detectors, tuple);
  assertNodePublicLimits(run, tuple.publicLimits);
}

function nodeTupleMatches(run: ScanRunV2R2, tuple: NodeR2ProducerTuple): boolean {
  return (
    run.toolchain.normalizationVersion === tuple.normalizationVersion &&
    run.provenance.methodologyVersion === tuple.methodologyVersion &&
    canonicalJson(run.provenance.detectorRegistry) === canonicalJson(tuple.detectorRegistry) &&
    canonicalJson(detectorVersions(run.detectors)) === canonicalJson(tuple.detectorVersions) &&
    canonicalJson(run.toolchain.trackerCatalog) === canonicalJson(tuple.trackerCatalog) &&
    canonicalJson(run.toolchain.adblock) === canonicalJson(tuple.adblockIdentity) &&
    canonicalJson(nodeRuntimeIdentity(run)) === canonicalJson(tuple.runtimeIdentity)
  );
}

function detectorVersions(detectors: DetectorLedger): Readonly<Record<DetectorId, string>> {
  return Object.fromEntries(DETECTOR_IDS.map((id) => [id, detectors[id].version])) as Record<DetectorId, string>;
}

function nodeRuntimeIdentity(run: ScanRunV2R2): NodeR2ProducerTuple["runtimeIdentity"] {
  return {
    sourceArtifactDigest: run.provenance.sourceArtifactDigest === undefined ? "absent" : ("present" as never),
    automation: run.conditions.automation as "playwright-chromium",
    browserName: run.conditions.browser.name as "chromium",
    headless: run.conditions.headless as true,
    language: run.conditions.language === run.conditions.locale ? "matches-locale" : ("differs-from-locale" as never)
  };
}

function assertNodePublicLimits(
  run: ScanRunV2R2,
  limits: Readonly<typeof NODE_R2_PUBLIC_LIMITS>
): void {
  assertAtMost("phases", run.phases.length, limits.phases);
  assertAtMost("warnings", run.warnings.length, limits.warnings);
  assertAtMost("requests", run.evidence.requests.length, limits.requests);
  assertAtMost("cookie mutations", run.evidence.cookieMutations.length, limits.cookieMutations);
  assertAtMost("final cookies", run.evidence.cookiesFinal.length, limits.cookieRecords);
  assertAtMost("storage mutations", run.evidence.storageMutations.length, limits.storageMutations);
  assertAtMost("final storage", run.evidence.storageFinal.length, limits.storageRecords);
  assertAtMost("fingerprint events", run.evidence.fingerprintEvents.length, limits.fingerprintEvents);
  assertAtMost("fingerprint detections", run.evidence.fingerprintDetections.length, limits.fingerprintDetections);
  assertAtMost("CNAME cloaks", run.evidence.cnameCloaks.length, limits.cnameCloaks);
  assertAtMost("pixel events", run.evidence.pixelEvents.length, limits.pixelEvents);
  if (run.evidence.consent !== undefined) {
    assertAtMost(
      "consent observations",
      run.evidence.consent.verificationObservations.length,
      limits.consentObservations
    );
    if (run.evidence.consent.verificationFailureReason !== undefined) {
      throw new R2ProducerContractError("Node r2 consent cannot carry a free-form failure reason");
    }
  }
  if (run.evidence.privacyPolicy !== undefined) {
    assertAtMost("privacy-policy claims", run.evidence.privacyPolicy.claims.length, limits.policyClaims);
    assertAtMost(
      "privacy-policy mentioned entities",
      run.evidence.privacyPolicy.mentionedEntities.length,
      limits.policyEntities
    );
    assertAtMost(
      "privacy-policy unmentioned entities",
      run.evidence.privacyPolicy.unmentionedEntities.length,
      limits.policyEntities
    );
  }
}

function assertPageGraphProducerContract(run: ScanRunV2R2): void {
  if (!FULL_GIT_SHA.test(run.provenance.buildCommit)) {
    throw new R2ProducerContractError("PageGraph build provenance is not a full lowercase Git SHA");
  }
  const tuple = PAGEGRAPH_R2_PRODUCER_TUPLES.find((candidate) => pageGraphTupleMatches(run, candidate));
  if (tuple === undefined) {
    throw new R2ProducerContractError("unknown PageGraph producer tuple");
  }
  if (
    run.phases.length !== tuple.publicLimits.phases ||
    run.phases[0]?.phaseId !== 0 ||
    run.phases[0]?.kind !== "passive-load"
  ) {
    throw new R2ProducerContractError("PageGraph must carry exactly one passive-load phase");
  }
  assertAtMost("PageGraph requests", run.evidence.requests.length, tuple.publicLimits.requests);
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

function pageGraphTupleMatches(run: ScanRunV2R2, tuple: PageGraphR2ProducerTuple): boolean {
  return (
    run.toolchain.normalizationVersion === tuple.normalizationVersion &&
    pageGraphMethodologyMatches(run.provenance.methodologyVersion, tuple.methodologyVersion) &&
    canonicalJson(run.provenance.detectorRegistry) === canonicalJson(tuple.detectorRegistry) &&
    canonicalJson(run.detectors) === canonicalJson(tuple.detectors) &&
    canonicalJson(run.toolchain.trackerCatalog) === canonicalJson(tuple.trackerCatalog) &&
    run.toolchain.adblock === tuple.adblockIdentity &&
    canonicalJson(pageGraphRuntimeIdentity(run)) === canonicalJson(tuple.runtimeIdentity)
  );
}

function pageGraphMethodologyMatches(value: string, base: string): boolean {
  const methodology = new RegExp(
    `^${escapeRegExp(base)}` +
      String.raw`\+crawl-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}` +
      String.raw`\+crawl-sha-[0-9a-f]{40}` +
      String.raw`\+schema-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}` +
      String.raw`\+sanitizer-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$`
  );
  return methodology.test(value);
}

function pageGraphRuntimeIdentity(run: ScanRunV2R2): PageGraphR2ProducerTuple["runtimeIdentity"] {
  return {
    acquisition: run.provenance.acquisition as "upload",
    automation: run.conditions.automation as "brave-pagegraph",
    consent: run.conditions.consent as "observe",
    shields: run.conditions.shields as "off",
    keystrokeProbe: run.conditions.probes.keystroke as false,
    policyVisitProbe: run.conditions.probes.policyVisit as false,
    verificationFacts: run.verificationFacts === undefined ? "absent" : ("present" as never)
  };
}

const HISTORICAL_DETECTOR_STATUS_REASON_CODES = Object.freeze({
  partial: Object.freeze(["budget-unavailable", "load-failed", "scan-failed"]),
  skipped: Object.freeze([
    "probe-disabled",
    "budget-unavailable",
    "not-requested",
    "load-failed",
    "engine-unavailable"
  ]),
  unsupported: Object.freeze(["unsupported"]),
  failed: Object.freeze(["load-failed", "engine-unavailable", "scan-failed"])
} satisfies Readonly<Record<Exclude<DetectorStatus, "complete">, readonly string[]>>);

function assertNodeDetectorLedger(detectors: DetectorLedger, tuple: NodeR2ProducerTuple): void {
  for (const id of DETECTOR_IDS) {
    const entry = detectors[id];
    if (entry.version !== tuple.detectorVersions[id]) {
      throw new R2ProducerContractError(`unknown Node detector version for ${id}`);
    }
    if (entry.status === "complete") {
      if (entry.reason !== undefined) {
        throw new R2ProducerContractError(`incompatible Node detector status/reason for ${id}`);
      }
      continue;
    }
    if (entry.reason === undefined) {
      throw new R2ProducerContractError(`incompatible Node detector status/reason for ${id}`);
    }
    const compatible =
      tuple.detectorStatusContractVersion === "detector-status-v1"
        ? HISTORICAL_DETECTOR_STATUS_REASON_CODES[entry.status].includes(entry.reason)
        : isDetectorReasonCode(entry.reason) && isDetectorReasonForStatus(entry.status, entry.reason);
    if (!compatible) {
      throw new R2ProducerContractError(`incompatible Node detector status/reason for ${id}`);
    }
  }
}

function assertAtMost(label: string, actual: number, maximum: number): void {
  if (actual > maximum) throw new R2ProducerContractError(`${label} exceed producer cap ${maximum}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
