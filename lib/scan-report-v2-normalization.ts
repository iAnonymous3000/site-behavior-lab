import {
  PUBLIC_SUFFIX_ENGINE_VERSION,
  REDACTION_ALLOWLISTS_DIGEST,
  REDACTION_ALLOWLISTS_VERSION,
  REDACTION_VERSION
} from "./redaction-v2";
import {
  PUBLIC_STRING_POLICY_DIGEST,
  PUBLIC_STRING_POLICY_VERSION
} from "./redact-scan-report-v1";
import type { ObserverKind } from "./scan-report-v2";

/** Current producer identities. Builders and remediation must use one source. */
export const NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION =
  `redaction-v${REDACTION_VERSION}+${REDACTION_ALLOWLISTS_VERSION}:${REDACTION_ALLOWLISTS_DIGEST}+${PUBLIC_STRING_POLICY_VERSION}:${PUBLIC_STRING_POLICY_DIGEST}+${PUBLIC_SUFFIX_ENGINE_VERSION}+node-evidence-policy-v1+r2-http-status-compat-v1`;

export const PAGEGRAPH_R2_NORMALIZATION_VERSION =
  `redaction-v${REDACTION_VERSION}+${REDACTION_ALLOWLISTS_VERSION}:${REDACTION_ALLOWLISTS_DIGEST}+${PUBLIC_STRING_POLICY_VERSION}:${PUBLIC_STRING_POLICY_DIGEST}+${PUBLIC_SUFFIX_ENGINE_VERSION}+pagegraph-request-evidence-v1+r2-http-status-compat-v1`;

/**
 * Exact reviewed v3 identities that can be replayed through the v4 sanitizer.
 * This is intentionally not a regex: a self-declared or unreviewed v3
 * normalization must fail closed instead of being blessed by remediation.
 */
export const MIGRATABLE_REDACTION_V3_NORMALIZATIONS: Readonly<Record<ObserverKind, ReadonlySet<string>>> = {
  "node-playwright": new Set([
    "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+node-evidence-policy-v1"
  ]),
  "pagegraph-import": new Set([
    "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+pagegraph-request-evidence-v1"
  ]),
  // Browser Run is a retired report producer. Its historical r1/r2 outputs
  // have no reviewed v3 replay identity and cannot be upgraded by inference.
  "browser-run-worker": new Set()
};

export function currentR2NormalizationForObserver(observer: ObserverKind): string | null {
  if (observer === "node-playwright") return NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION;
  if (observer === "pagegraph-import") return PAGEGRAPH_R2_NORMALIZATION_VERSION;
  return null;
}

export const REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX = "v3-to-v4-ip-port-title@1";

export function migratedR2NormalizationForV3(observer: ObserverKind, source: string): string | null {
  if (!MIGRATABLE_REDACTION_V3_NORMALIZATIONS[observer].has(source)) return null;
  // Preserve the exact historical base. Replacing it with a fresh-producer
  // identity would falsely make a remediated tldts/list snapshot comparable
  // to a newly captured v4 run.
  return `${source}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`;
}
