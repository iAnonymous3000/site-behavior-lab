import { isIP } from "node:net";
import {
  CONTROLLED_RUNNER_IDENTITY_REF_PATTERN,
  runnerLabelRef,
  runnerNatIdentityRef
} from "./controlled-runner-identity-lib.mjs";
import {
  boundedString,
  canonicalEvidenceDigest,
  exactKeys,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const EGRESS_BACKSTOP_EVIDENCE_KIND =
  "site-behavior-egress-backstop-probe-receipt";
export const EGRESS_BACKSTOP_EVIDENCE_SCHEMA_VERSION = 1;
export const EGRESS_BACKSTOP_EVIDENCE_PATH =
  "research/ops-evidence/egress-backstop.json";

export const EGRESS_BLOCKED_CLASS_CONTRACT = Object.freeze([
  Object.freeze({
    id: "private",
    probeDestination: "10.255.255.1",
    requiredCidrs: Object.freeze([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7"
    ])
  }),
  Object.freeze({
    id: "link-local",
    probeDestination: "169.254.1.1",
    requiredCidrs: Object.freeze(["169.254.0.0/16", "fe80::/10"])
  }),
  Object.freeze({
    id: "metadata",
    probeDestination: "169.254.169.254",
    requiredCidrs: Object.freeze(["169.254.169.254/32"])
  })
]);
export const EGRESS_PUBLIC_CONTROL = Object.freeze({
  destination: "1.1.1.1",
  port: 443
});

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "candidateCommit",
  "deploymentCommit",
  "capturedAt",
  "networkPolicy",
  "networkPolicyDigest",
  "failureModeProbe",
  "sourceArtifacts"
];
const POLICY_KEYS = [
  "provider",
  "policyId",
  "policyVersion",
  "enforcementBoundary",
  "applicationProcessOwnership",
  "defaultAction",
  "allowedPublicTcpPorts",
  "blockedClasses",
  "publicControl",
  "collectionEgress"
];
const BLOCKED_CLASS_KEYS = ["id", "ruleId", "cidrs", "probeDestination", "probePort"];
const CONTROL_KEYS = ["destination", "port"];
const RAW_COLLECTION_KEYS = ["label", "region", "natIdentity"];
const COLLECTION_KEYS = ["labelRef", "region", "natIdentityRef"];
const PROBE_KEYS = [
  "tool",
  "applicationGuardMode",
  "startedAt",
  "completedAt",
  "attempts",
  "publicControl"
];
const TOOL_KEYS = ["name", "version", "executionBoundary"];
const ATTEMPT_KEYS = [
  "classId",
  "destination",
  "port",
  "observedAt",
  "outcome",
  "policyDecision",
  "policyRuleId"
];
const CONTROL_RESULT_KEYS = [
  "destination",
  "port",
  "observedAt",
  "outcome",
  "policyDecision"
];
const SOURCE_ARTIFACTS_KEYS = [
  "networkPolicyExport",
  "failureProbeTranscript"
];
const SOURCE_REF_KEYS = ["kind", "digest", "byteLength"];
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
export const EGRESS_POLICY_EXPORT_MAX_BYTES = 1024 * 1024;
export const EGRESS_PROBE_TRANSCRIPT_MAX_BYTES = 1024 * 1024;
export const EGRESS_FAILURE_PROBE_MAX_WINDOW_MS = 60_000;
export const EGRESS_FAILURE_PROBE_MAX_OBSERVATION_AGE_MS = 30_000;

export function networkPolicyDigest(networkPolicy) {
  return canonicalEvidenceDigest(networkPolicy);
}

export function egressIdentityRef(domain, value) {
  if (
    !boundedString(domain, { maximum: 64, pattern: /^[a-z][a-z0-9-]*$/ }) ||
    !boundedString(value, { maximum: 256, pattern: OPAQUE_ID })
  ) {
    throw new Error("egress identity references require bounded domain and value");
  }
  return `sha256:${sha256Bytes(
    `site-behavior-lab-egress-identity-v1\u0000${domain}\u0000${value}`
  )}`;
}

function policyProblems(policy, { redactedIdentities = true } = {}) {
  const problems = [];
  if (!exactKeys(policy, POLICY_KEYS, "networkPolicy", problems)) return problems;
  for (const field of ["policyVersion", "enforcementBoundary"]) {
    if (!boundedString(policy[field], { maximum: 256, pattern: OPAQUE_ID })) {
      problems.push(`networkPolicy.${field} must be a bounded opaque identifier`);
    }
  }
  for (const field of ["provider", "policyId"]) {
    if (redactedIdentities) {
      if (typeof policy[field] !== "string" || !SHA256_REF.test(policy[field])) {
        problems.push(`networkPolicy.${field} must be a domain-separated sha256 reference`);
      }
    } else if (!boundedString(policy[field], { maximum: 256, pattern: OPAQUE_ID })) {
      problems.push(`networkPolicy.${field} must be a bounded opaque identifier`);
    }
  }
  if (policy.applicationProcessOwnership !== "external") {
    problems.push("networkPolicy.applicationProcessOwnership must be exactly external");
  }
  if (policy.defaultAction !== "deny") {
    problems.push("networkPolicy.defaultAction must be exactly deny");
  }
  if (
    !Array.isArray(policy.allowedPublicTcpPorts) ||
    policy.allowedPublicTcpPorts.length !== 2 ||
    policy.allowedPublicTcpPorts[0] !== 80 ||
    policy.allowedPublicTcpPorts[1] !== 443
  ) {
    problems.push("networkPolicy.allowedPublicTcpPorts must be exactly [80,443]");
  }
  if (
    !Array.isArray(policy.blockedClasses) ||
    policy.blockedClasses.length !== EGRESS_BLOCKED_CLASS_CONTRACT.length
  ) {
    problems.push("networkPolicy.blockedClasses must contain private, link-local, and metadata");
  } else {
    for (const [index, contract] of EGRESS_BLOCKED_CLASS_CONTRACT.entries()) {
      const entry = policy.blockedClasses[index];
      const label = `networkPolicy.blockedClasses[${index}]`;
      if (!exactKeys(entry, BLOCKED_CLASS_KEYS, label, problems)) continue;
      if (entry.id !== contract.id) {
        problems.push(`${label}.id must be exactly ${contract.id}`);
      }
      if (redactedIdentities) {
        if (typeof entry.ruleId !== "string" || !SHA256_REF.test(entry.ruleId)) {
          problems.push(`${label}.ruleId must be a domain-separated sha256 reference`);
        }
      } else if (!boundedString(entry.ruleId, { maximum: 256, pattern: OPAQUE_ID })) {
        problems.push(`${label}.ruleId must be a bounded opaque identifier`);
      }
      if (
        !Array.isArray(entry.cidrs) ||
        entry.cidrs.length !== contract.requiredCidrs.length ||
        entry.cidrs.some((cidr, cidrIndex) => cidr !== contract.requiredCidrs[cidrIndex])
      ) {
        problems.push(`${label}.cidrs must be the canonical ${contract.id} CIDR set`);
      }
      if (typeof entry.probeDestination !== "string" || isIP(entry.probeDestination) === 0) {
        problems.push(`${label}.probeDestination must be a literal IP address`);
      } else if (entry.probeDestination !== contract.probeDestination) {
        problems.push(
          `${label}.probeDestination must be exactly ${contract.probeDestination}`
        );
      }
      if (entry.probePort !== 80) {
        problems.push(`${label}.probePort must be exactly 80`);
      }
    }
  }
  if (exactKeys(policy.publicControl, CONTROL_KEYS, "networkPolicy.publicControl", problems)) {
    if (
      policy.publicControl.destination !== EGRESS_PUBLIC_CONTROL.destination
    ) {
      problems.push(
        `networkPolicy.publicControl.destination must be exactly ${EGRESS_PUBLIC_CONTROL.destination}`
      );
    }
    if (policy.publicControl.port !== EGRESS_PUBLIC_CONTROL.port) {
      problems.push(
        `networkPolicy.publicControl.port must be exactly ${EGRESS_PUBLIC_CONTROL.port}`
      );
    }
  }
  if (
    exactKeys(
      policy.collectionEgress,
      redactedIdentities ? COLLECTION_KEYS : RAW_COLLECTION_KEYS,
      "networkPolicy.collectionEgress",
      problems
    )
  ) {
    if (redactedIdentities) {
      if (
        typeof policy.collectionEgress.labelRef !== "string" ||
        !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(
          policy.collectionEgress.labelRef
        )
      ) {
        problems.push(
          "networkPolicy.collectionEgress.labelRef must be a domain-separated sha256 reference"
        );
      }
      if (
        typeof policy.collectionEgress.natIdentityRef !== "string" ||
        !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(
          policy.collectionEgress.natIdentityRef
        )
      ) {
        problems.push(
          "networkPolicy.collectionEgress.natIdentityRef must be a domain-separated sha256 reference"
        );
      }
    } else {
      for (const field of ["label", "natIdentity"]) {
        if (
          !boundedString(policy.collectionEgress[field], {
            maximum: 256,
            pattern: OPAQUE_ID
          })
        ) {
          problems.push(
            `networkPolicy.collectionEgress.${field} must be a bounded opaque identifier`
          );
        }
      }
    }
    if (
      !boundedString(policy.collectionEgress.region, {
        maximum: 32,
        pattern: /^[a-z]{2,8}(?:-[a-z0-9]{2,12}){1,2}$/
      })
    ) {
      problems.push(
        "networkPolicy.collectionEgress.region must be a coarse public region label"
      );
    }
  }
  return problems;
}

function failureProbeProblems(probe, policy) {
  const problems = [];
  if (!exactKeys(probe, PROBE_KEYS, "failureModeProbe", problems)) return problems;
  if (exactKeys(probe.tool, TOOL_KEYS, "failureModeProbe.tool", problems)) {
    for (const field of ["name", "version"]) {
      if (!boundedString(probe.tool[field], { maximum: 200, pattern: OPAQUE_ID })) {
        problems.push(`failureModeProbe.tool.${field} must be a bounded opaque identifier`);
      }
    }
    if (probe.tool.executionBoundary !== "outside-application") {
      problems.push(
        "failureModeProbe.tool.executionBoundary must be exactly outside-application"
      );
    }
  }
  if (probe.applicationGuardMode !== "disabled") {
    problems.push("failureModeProbe.applicationGuardMode must be exactly disabled");
  }
  const startedAt = requireCanonicalInstant(
    probe.startedAt,
    "failureModeProbe.startedAt",
    problems
  );
  const completedAt = requireCanonicalInstant(
    probe.completedAt,
    "failureModeProbe.completedAt",
    problems
  );
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    problems.push("failureModeProbe.completedAt must not precede startedAt");
  } else if (
    startedAt !== null &&
    completedAt !== null &&
    completedAt - startedAt > EGRESS_FAILURE_PROBE_MAX_WINDOW_MS
  ) {
    problems.push("failureModeProbe must complete within one minute");
  }
  if (
    !Array.isArray(probe.attempts) ||
    probe.attempts.length !== EGRESS_BLOCKED_CLASS_CONTRACT.length
  ) {
    problems.push("failureModeProbe.attempts must cover all three blocked classes");
  } else if (Array.isArray(policy.blockedClasses)) {
    for (const [index, expected] of policy.blockedClasses.entries()) {
      const attempt = probe.attempts[index];
      const label = `failureModeProbe.attempts[${index}]`;
      if (!exactKeys(attempt, ATTEMPT_KEYS, label, problems)) continue;
      const expectedValues = {
        classId: expected.id,
        destination: expected.probeDestination,
        port: expected.probePort,
        outcome: "blocked",
        policyDecision: "deny"
      };
      for (const [field, expectedValue] of Object.entries(expectedValues)) {
        if (attempt[field] !== expectedValue) {
          problems.push(`${label}.${field} must be exactly ${expectedValue}`);
        }
      }
      if (attempt.policyRuleId !== expected.ruleId) {
        problems.push(
          `${label}.policyRuleId must match its bound blocked-class rule`
        );
      }
      const observedAt = requireCanonicalInstant(
        attempt.observedAt,
        `${label}.observedAt`,
        problems
      );
      if (
        observedAt !== null &&
        startedAt !== null &&
        completedAt !== null &&
        (observedAt < startedAt || observedAt > completedAt)
      ) {
        problems.push(`${label}.observedAt must fall inside the probe window`);
      } else if (
        observedAt !== null &&
        completedAt !== null &&
        completedAt - observedAt >
          EGRESS_FAILURE_PROBE_MAX_OBSERVATION_AGE_MS
      ) {
        problems.push(
          `${label}.observedAt must be within 30 seconds of probe completion`
        );
      }
    }
  }
  if (
    exactKeys(
      probe.publicControl,
      CONTROL_RESULT_KEYS,
      "failureModeProbe.publicControl",
      problems
    )
  ) {
    const expectedValues = {
      destination: policy.publicControl?.destination,
      port: policy.publicControl?.port,
      outcome: "allowed",
      policyDecision: "allow"
    };
    for (const [field, expectedValue] of Object.entries(expectedValues)) {
      if (probe.publicControl[field] !== expectedValue) {
        problems.push(
          `failureModeProbe.publicControl.${field} must be exactly ${expectedValue}`
        );
      }
    }
    const observedAt = requireCanonicalInstant(
      probe.publicControl.observedAt,
      "failureModeProbe.publicControl.observedAt",
      problems
    );
    if (
      observedAt !== null &&
      startedAt !== null &&
      completedAt !== null &&
      (observedAt < startedAt || observedAt > completedAt)
    ) {
      problems.push("failureModeProbe.publicControl.observedAt must fall inside the probe window");
    } else if (
      observedAt !== null &&
      completedAt !== null &&
      completedAt - observedAt >
        EGRESS_FAILURE_PROBE_MAX_OBSERVATION_AGE_MS
    ) {
      problems.push(
        "failureModeProbe.publicControl.observedAt must be within 30 seconds of probe completion"
      );
    }
  }
  return problems;
}

function sourceArtifactProblems(sourceArtifacts) {
  const problems = [];
  if (
    !exactKeys(
      sourceArtifacts,
      SOURCE_ARTIFACTS_KEYS,
      "sourceArtifacts",
      problems
    )
  ) {
    return problems;
  }
  const contracts = [
    [
      "networkPolicyExport",
      "provider-network-policy-export",
      EGRESS_POLICY_EXPORT_MAX_BYTES
    ],
    [
      "failureProbeTranscript",
      "independent-egress-failure-probe-transcript",
      EGRESS_PROBE_TRANSCRIPT_MAX_BYTES
    ]
  ];
  for (const [name, expectedKind, maximumBytes] of contracts) {
    const value = sourceArtifacts[name];
    const label = `sourceArtifacts.${name}`;
    if (!exactKeys(value, SOURCE_REF_KEYS, label, problems)) continue;
    if (value.kind !== expectedKind) {
      problems.push(`${label}.kind must be exactly ${expectedKind}`);
    }
    if (typeof value.digest !== "string" || !SHA256_REF.test(value.digest)) {
      problems.push(`${label}.digest must be an exact sha256:<64 lowercase hex> reference`);
    }
    if (
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 ||
      value.byteLength > maximumBytes
    ) {
      problems.push(
        `${label}.byteLength must be between 1 and ${maximumBytes}`
      );
    }
  }
  return problems;
}

export function validateEgressBackstopEvidence(value) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "egress receipt", problems)) {
    return { ok: false, problems, bindings: null, receiptDigest: null };
  }
  if (value.schemaVersion !== EGRESS_BACKSTOP_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${EGRESS_BACKSTOP_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (value.artifactKind !== EGRESS_BACKSTOP_EVIDENCE_KIND) {
    problems.push(`artifactKind must be exactly ${EGRESS_BACKSTOP_EVIDENCE_KIND}`);
  }
  requireCommit(value.candidateCommit, "candidateCommit", problems);
  requireCommit(value.deploymentCommit, "deploymentCommit", problems);
  const capturedAt = requireCanonicalInstant(value.capturedAt, "capturedAt", problems);
  problems.push(...policyProblems(value.networkPolicy));
  let expectedPolicyDigest = null;
  try {
    expectedPolicyDigest = networkPolicyDigest(value.networkPolicy);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(value.networkPolicyDigest, "networkPolicyDigest", problems);
  if (
    expectedPolicyDigest !== null &&
    value.networkPolicyDigest !== expectedPolicyDigest
  ) {
    problems.push(
      "networkPolicyDigest does not match the exact canonical networkPolicy bytes"
    );
  }
  problems.push(...failureProbeProblems(value.failureModeProbe, value.networkPolicy));
  problems.push(...sourceArtifactProblems(value.sourceArtifacts));
  const effectiveSourceObservedAt = value.failureModeProbe?.completedAt;
  const effectiveSourceInstant = requireCanonicalInstant(
    effectiveSourceObservedAt,
    "failureModeProbe.completedAt",
    []
  );
  if (
    capturedAt !== null &&
    effectiveSourceInstant !== null &&
    value.capturedAt !== effectiveSourceObservedAt
  ) {
    problems.push(
      "capturedAt must exactly equal the effective source observation time"
    );
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          candidateCommit: value.candidateCommit,
          deploymentCommit: value.deploymentCommit,
          networkPolicyDigest: expectedPolicyDigest,
          networkPolicyExportDigest:
            value.sourceArtifacts.networkPolicyExport.digest.slice(
              "sha256:".length
            ),
          failureProbeTranscriptDigest:
            value.sourceArtifacts.failureProbeTranscript.digest.slice(
              "sha256:".length
            ),
          effectiveSourceObservedAt
        }
      : null,
    receiptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

function parseSourceArtifact(bytes, label, maximumBytes) {
  let sourceBytes;
  if (typeof bytes === "string") {
    sourceBytes = Buffer.from(bytes, "utf8");
  } else if (bytes instanceof Uint8Array) {
    sourceBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    throw new Error(`${label} must be supplied as exact bytes`);
  }
  if (sourceBytes.length < 1 || sourceBytes.length > maximumBytes) {
    throw new Error(`${label} must contain 1 through ${maximumBytes} bytes`);
  }
  let source;
  try {
    source = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes)
    );
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
  return { source, sourceBytes };
}

function redactEgressSources(networkPolicy, failureModeProbe) {
  const providerRef = egressIdentityRef("provider", networkPolicy.provider);
  const policyRef = egressIdentityRef("policy", networkPolicy.policyId);
  const ruleRefs = new Map(
    networkPolicy.blockedClasses.map((entry) => [
      entry.ruleId,
      egressIdentityRef(`rule-${entry.id}`, entry.ruleId)
    ])
  );
  const redactedPolicy = {
    ...networkPolicy,
    provider: providerRef,
    policyId: policyRef,
    blockedClasses: networkPolicy.blockedClasses.map((entry) => ({
      ...entry,
      ruleId: ruleRefs.get(entry.ruleId)
    })),
    collectionEgress: {
      labelRef: runnerLabelRef(networkPolicy.collectionEgress.label),
      region: networkPolicy.collectionEgress.region,
      natIdentityRef: runnerNatIdentityRef(
        networkPolicy.collectionEgress.natIdentity
      )
    }
  };
  const redactedProbe = {
    ...failureModeProbe,
    attempts: failureModeProbe.attempts.map((attempt) => ({
      ...attempt,
      policyRuleId: ruleRefs.get(attempt.policyRuleId)
    }))
  };
  return {
    networkPolicy: redactedPolicy,
    failureModeProbe: redactedProbe
  };
}

export function buildEgressBackstopEvidence({
  candidateCommit,
  deploymentCommit,
  networkPolicySourceBytes,
  failureModeProbeSourceBytes
}) {
  const policySource = parseSourceArtifact(
    networkPolicySourceBytes,
    "network policy export",
    EGRESS_POLICY_EXPORT_MAX_BYTES
  );
  const probeSource = parseSourceArtifact(
    failureModeProbeSourceBytes,
    "failure probe transcript",
    EGRESS_PROBE_TRANSCRIPT_MAX_BYTES
  );
  const sourcePolicyProblems = policyProblems(policySource.source, {
    redactedIdentities: false
  });
  const sourceProbeProblems = failureProbeProblems(
    probeSource.source,
    policySource.source
  );
  if (sourcePolicyProblems.length > 0 || sourceProbeProblems.length > 0) {
    throw new Error(
      `Invalid egress source artifacts: ${[
        ...sourcePolicyProblems,
        ...sourceProbeProblems
      ].join("; ")}`
    );
  }
  const { networkPolicy, failureModeProbe } = redactEgressSources(
    policySource.source,
    probeSource.source
  );
  const receipt = {
    schemaVersion: EGRESS_BACKSTOP_EVIDENCE_SCHEMA_VERSION,
    artifactKind: EGRESS_BACKSTOP_EVIDENCE_KIND,
    candidateCommit,
    deploymentCommit,
    capturedAt: failureModeProbe.completedAt,
    networkPolicy,
    networkPolicyDigest: networkPolicyDigest(networkPolicy),
    failureModeProbe,
    sourceArtifacts: {
      networkPolicyExport: {
        kind: "provider-network-policy-export",
        digest: `sha256:${sha256Bytes(policySource.sourceBytes)}`,
        byteLength: policySource.sourceBytes.length
      },
      failureProbeTranscript: {
        kind: "independent-egress-failure-probe-transcript",
        digest: `sha256:${sha256Bytes(probeSource.sourceBytes)}`,
        byteLength: probeSource.sourceBytes.length
      }
    }
  };
  const verdict = validateEgressBackstopEvidence(receipt);
  if (!verdict.ok) {
    throw new Error(`Invalid egress evidence: ${verdict.problems.join("; ")}`);
  }
  return receipt;
}

export function serializeEgressBackstopEvidence(value) {
  const verdict = validateEgressBackstopEvidence(value);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}
