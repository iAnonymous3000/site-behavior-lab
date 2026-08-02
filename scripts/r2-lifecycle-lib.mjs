// Validation and canonical receipt production for the production R2 lifecycle
// readback. The standing backstop must be one exact reports/ deletion rule at
// eight days or later. Any second enabled deletion rule whose key-space
// intersects reports/ is a conflict, including bucket-wide, ancestor, and
// child prefixes.

import {
  canonicalEvidenceDigest,
  exactKeys,
  isCanonicalInstant,
  isRecord,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const REPORTS_PREFIX = "reports/";
export const MINIMUM_BACKSTOP_DAYS = 8;
export const PRODUCTION_R2_BUCKET = "site-behavior-lab-reports";
export const R2_LIFECYCLE_RECEIPT_KIND =
  "site-behavior-r2-lifecycle-readback";
export const R2_LIFECYCLE_RECEIPT_VERSION = 2;
export const R2_LIFECYCLE_SOURCE_MAX_BYTES = 1024 * 1024;

const SECONDS_PER_DAY = 86_400;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = [
  "kind",
  "receiptVersion",
  "bucket",
  "source",
  "recordedAt",
  "rules",
  "observedReportsDeletionRules",
  "violations",
  "ok",
  "sourceArtifact",
  "receiptDigest"
];
const SOURCE_ARTIFACT_KEYS = [
  "kind",
  "encoding",
  "byteLength",
  "digest",
  "data"
];
const SOURCES = new Map([
  ["cloudflare-api", "cloudflare-lifecycle-api-response"],
  ["wrangler-oauth-cli-text", "wrangler-lifecycle-cli-output"]
]);

function rulePrefix(rule) {
  const prefix = rule?.conditions?.prefix;
  return typeof prefix === "string" ? prefix : "";
}

function intersectsReports(prefix) {
  return (
    prefix === "" ||
    REPORTS_PREFIX.startsWith(prefix) ||
    prefix.startsWith(REPORTS_PREFIX)
  );
}

function deletionAgeDays(rule) {
  const condition = rule?.deleteObjectsTransition?.condition;
  if (!isRecord(condition)) return null;
  if (condition.type === "Age" && Number.isFinite(condition.maxAge)) {
    return condition.maxAge / SECONDS_PER_DAY;
  }
  // A date-based deletion is not a standing age backstop.
  return condition.type === "Date" ? 0 : null;
}

function enabledDeletionRule(rule) {
  return (
    isRecord(rule) &&
    rule.enabled === true &&
    isRecord(rule.deleteObjectsTransition)
  );
}

/**
 * Judge a bucket's lifecycle rules against the documented retention policy.
 * observed lists every enabled deletion rule whose scope intersects reports/.
 */
export function validateReportsLifecycleRules(rules) {
  const violations = [];
  if (!Array.isArray(rules)) {
    return {
      ok: false,
      violations: ["lifecycle rules must be an array"],
      observed: []
    };
  }

  const observed = [];
  for (const rule of rules) {
    if (!enabledDeletionRule(rule)) continue;
    const prefix = rulePrefix(rule);
    if (!intersectsReports(prefix)) continue;
    observed.push({
      id: typeof rule.id === "string" ? rule.id : "(unnamed rule)",
      prefix,
      effectiveDays: deletionAgeDays(rule)
    });
  }

  const exactRules = observed.filter((rule) => rule.prefix === REPORTS_PREFIX);
  if (exactRules.length === 0) {
    violations.push(
      `no enabled ${REPORTS_PREFIX} deletion backstop with the exact ${REPORTS_PREFIX} prefix exists; the documented policy requires exactly one at ${MINIMUM_BACKSTOP_DAYS} days or later`
    );
  } else if (exactRules.length > 1) {
    violations.push(
      `${exactRules.length} enabled deletion rules use the exact ${REPORTS_PREFIX} prefix; exactly one is permitted`
    );
  }

  const satisfyingRule = exactRules.length === 1 ? exactRules[0] : null;
  for (const rule of observed) {
    if (rule !== satisfyingRule) {
      violations.push(
        `enabled deletion rule ${rule.id} with prefix ${JSON.stringify(
          rule.prefix || "(all objects)"
        )} intersects ${REPORTS_PREFIX}; no ancestor, child, bucket-wide, or second exact deletion rule is permitted`
      );
    }
  }
  for (const exactRule of exactRules) {
    if (
      typeof exactRule.effectiveDays !== "number" ||
      !Number.isFinite(exactRule.effectiveDays)
    ) {
      violations.push(
        `rule ${exactRule.id} must use a finite age-based deletion condition`
      );
    } else if (exactRule.effectiveDays < MINIMUM_BACKSTOP_DAYS) {
      violations.push(
        `rule ${exactRule.id} deletes ${REPORTS_PREFIX} after ${exactRule.effectiveDays} days; the backstop must never be shorter than ${MINIMUM_BACKSTOP_DAYS} days (it would race application deletion)`
      );
    }
  }

  return { ok: violations.length === 0, violations, observed };
}

/**
 * Parse wrangler's fixed rule blocks. Unknown action wording fails closed.
 */
export function rulesFromWranglerText(text) {
  if (typeof text !== "string") {
    throw new Error("wrangler lifecycle output must be text");
  }
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const name = line.match(/^name:\s+(.+)$/);
    if (name) {
      current = {
        id: name[1].trim(),
        enabled: false,
        conditions: { prefix: "" }
      };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const enabled = line.match(/^enabled:\s+(Yes|No)$/);
    if (enabled) current.enabled = enabled[1] === "Yes";
    const prefix = line.match(/^prefix:\s+(.+)$/);
    if (prefix) {
      current.conditions.prefix =
        prefix[1].trim() === "(all prefixes)" ? "" : prefix[1].trim();
    }
    const action = line.match(/^action:\s+(.+)$/);
    if (action) {
      const expire = action[1].match(/^Expire objects after (\d+) days?$/);
      const abort = action[1].match(
        /^Abort incomplete multipart uploads after (\d+) days?$/
      );
      if (expire) {
        current.deleteObjectsTransition = {
          condition: {
            type: "Age",
            maxAge: Number(expire[1]) * SECONDS_PER_DAY
          }
        };
      } else if (abort) {
        current.abortMultipartUploadsTransition = {
          condition: {
            type: "Age",
            maxAge: Number(abort[1]) * SECONDS_PER_DAY
          }
        };
      } else {
        throw new Error(
          `Unrecognized wrangler lifecycle action wording: ${action[1]}`
        );
      }
    }
  }
  if (rules.length === 0) {
    throw new Error("No lifecycle rules found in wrangler output.");
  }
  return rules;
}

function sourceBytesFromArtifact(sourceArtifact, source, problems) {
  if (
    !exactKeys(
      sourceArtifact,
      SOURCE_ARTIFACT_KEYS,
      "sourceArtifact",
      problems
    )
  ) {
    return null;
  }
  if (sourceArtifact.kind !== SOURCES.get(source)) {
    problems.push("sourceArtifact.kind must match the receipt source");
  }
  if (sourceArtifact.encoding !== "base64") {
    problems.push("sourceArtifact.encoding must be exactly base64");
  }
  if (
    !Number.isSafeInteger(sourceArtifact.byteLength) ||
    sourceArtifact.byteLength < 1 ||
    sourceArtifact.byteLength > R2_LIFECYCLE_SOURCE_MAX_BYTES
  ) {
    problems.push(
      `sourceArtifact.byteLength must be between 1 and ${R2_LIFECYCLE_SOURCE_MAX_BYTES}`
    );
  }
  if (
    typeof sourceArtifact.digest !== "string" ||
    !SHA256_REF.test(sourceArtifact.digest)
  ) {
    problems.push(
      "sourceArtifact.digest must be an exact sha256:<64 lowercase hex> reference"
    );
  }
  if (
    typeof sourceArtifact.data !== "string" ||
    sourceArtifact.data.length < 1 ||
    sourceArtifact.data.length >
      Math.ceil(R2_LIFECYCLE_SOURCE_MAX_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      sourceArtifact.data
    )
  ) {
    problems.push("sourceArtifact.data must be bounded canonical base64");
    return null;
  }
  const bytes = Buffer.from(sourceArtifact.data, "base64");
  if (bytes.toString("base64") !== sourceArtifact.data) {
    problems.push("sourceArtifact.data must use canonical padded base64");
  }
  if (bytes.length !== sourceArtifact.byteLength) {
    problems.push("sourceArtifact.byteLength must match the embedded source bytes");
  }
  if (`sha256:${sha256Bytes(bytes)}` !== sourceArtifact.digest) {
    problems.push("sourceArtifact.digest must match the embedded source bytes");
  }
  return bytes;
}

function rulesFromSourceBytes(source, sourceBytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  if (source === "wrangler-oauth-cli-text") {
    return rulesFromWranglerText(text);
  }
  if (source === "cloudflare-api") {
    const payload = JSON.parse(text);
    if (!isRecord(payload) || payload.success !== true) {
      throw new Error("Cloudflare lifecycle source must be a successful response");
    }
    if (!Array.isArray(payload.result?.rules)) {
      throw new Error("Cloudflare lifecycle source must contain result.rules");
    }
    return payload.result.rules;
  }
  throw new Error("unsupported lifecycle source");
}

function receiptDigestFor(value) {
  const copy = { ...value };
  delete copy.receiptDigest;
  return canonicalEvidenceDigest(copy);
}

export function validateR2LifecycleReadbackReceipt(value) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "lifecycle receipt", problems)) {
    return {
      ok: false,
      problems,
      bindings: null
    };
  }
  if (value.kind !== R2_LIFECYCLE_RECEIPT_KIND) {
    problems.push(`kind must be exactly ${R2_LIFECYCLE_RECEIPT_KIND}`);
  }
  if (value.receiptVersion !== R2_LIFECYCLE_RECEIPT_VERSION) {
    problems.push(
      `receiptVersion must be exactly ${R2_LIFECYCLE_RECEIPT_VERSION}`
    );
  }
  if (value.bucket !== PRODUCTION_R2_BUCKET) {
    problems.push(`bucket must be exactly ${PRODUCTION_R2_BUCKET}`);
  }
  if (!SOURCES.has(value.source)) {
    problems.push("source must be cloudflare-api or wrangler-oauth-cli-text");
  }
  if (!isCanonicalInstant(value.recordedAt)) {
    problems.push(
      "recordedAt must be a canonical millisecond-precision UTC instant"
    );
  }

  const sourceBytes = sourceBytesFromArtifact(
    value.sourceArtifact,
    value.source,
    problems
  );
  let sourceRules = null;
  if (sourceBytes !== null && SOURCES.has(value.source)) {
    try {
      sourceRules = rulesFromSourceBytes(value.source, sourceBytes);
    } catch (error) {
      problems.push(
        `sourceArtifact cannot be verified: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (!Array.isArray(value.rules)) {
    problems.push("rules must be an array");
  } else if (
    sourceRules !== null &&
    serializeCanonicalEvidence(value.rules) !==
      serializeCanonicalEvidence(sourceRules)
  ) {
    problems.push("rules must exactly match the authenticated source bytes");
  }

  const verdict = validateReportsLifecycleRules(value.rules);
  if (
    serializeCanonicalEvidence(value.observedReportsDeletionRules) !==
    serializeCanonicalEvidence(verdict.observed)
  ) {
    problems.push(
      "observedReportsDeletionRules must exactly match re-validation"
    );
  }
  if (
    serializeCanonicalEvidence(value.violations) !==
    serializeCanonicalEvidence(verdict.violations)
  ) {
    problems.push("violations must exactly match re-validation");
  }
  if (value.ok !== verdict.ok) {
    problems.push("ok must exactly match re-validation");
  }
  if (
    typeof value.receiptDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.receiptDigest)
  ) {
    problems.push("receiptDigest must be a lowercase sha256 digest");
  } else if (value.receiptDigest !== receiptDigestFor(value)) {
    problems.push("receiptDigest must bind the exact canonical receipt");
  }

  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          bucket: value.bucket,
          source: value.source,
          recordedAt: value.recordedAt,
          sourceArtifactDigest: value.sourceArtifact.digest.slice(
            "sha256:".length
          ),
          receiptDigest: value.receiptDigest
        }
      : null
  };
}

export function buildR2LifecycleReadbackReceipt({
  bucket,
  source,
  recordedAt,
  sourceBytes
}) {
  if (!SOURCES.has(source)) {
    throw new Error("source must be cloudflare-api or wrangler-oauth-cli-text");
  }
  if (bucket !== PRODUCTION_R2_BUCKET) {
    throw new Error(`bucket must be exactly ${PRODUCTION_R2_BUCKET}`);
  }
  const bytes =
    typeof sourceBytes === "string"
      ? Buffer.from(sourceBytes, "utf8")
      : sourceBytes instanceof Uint8Array
        ? Buffer.from(
            sourceBytes.buffer,
            sourceBytes.byteOffset,
            sourceBytes.byteLength
          )
        : null;
  if (
    bytes === null ||
    bytes.length < 1 ||
    bytes.length > R2_LIFECYCLE_SOURCE_MAX_BYTES
  ) {
    throw new Error(
      `sourceBytes must contain 1 through ${R2_LIFECYCLE_SOURCE_MAX_BYTES} bytes`
    );
  }
  const rules = rulesFromSourceBytes(source, bytes);
  const verdict = validateReportsLifecycleRules(rules);
  const receipt = {
    kind: R2_LIFECYCLE_RECEIPT_KIND,
    receiptVersion: R2_LIFECYCLE_RECEIPT_VERSION,
    bucket,
    source,
    recordedAt,
    rules,
    observedReportsDeletionRules: verdict.observed,
    violations: verdict.violations,
    ok: verdict.ok,
    sourceArtifact: {
      kind: SOURCES.get(source),
      encoding: "base64",
      byteLength: bytes.length,
      digest: `sha256:${sha256Bytes(bytes)}`,
      data: bytes.toString("base64")
    }
  };
  receipt.receiptDigest = receiptDigestFor(receipt);
  const validation = validateR2LifecycleReadbackReceipt(receipt);
  if (!validation.ok) {
    throw new Error(
      `invalid lifecycle receipt: ${validation.problems.join("; ")}`
    );
  }
  return receipt;
}

export function serializeR2LifecycleReadbackReceipt(value) {
  const validation = validateR2LifecycleReadbackReceipt(value);
  if (!validation.ok) {
    throw new Error(validation.problems.join("; "));
  }
  return serializeCanonicalEvidence(value);
}
