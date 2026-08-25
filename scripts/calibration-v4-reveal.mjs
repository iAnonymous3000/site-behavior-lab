#!/usr/bin/env node
/**
 * The v4 pilot authenticated reveal. Key-free custody first: the
 * repo-committed pilot labeling authorization supplies BOTH the chronology
 * boundary and the authorized commitment set (the reveal accepts neither
 * as a free parameter), every task's bytes are verified against the frame,
 * and only after all of it passes is the reveal private key read from
 * CALIBRATION_LABEL_REVEAL_PRIVATE_KEY (then deleted from the
 * environment). Commitment record files must come from the authenticated
 * fetcher at close time and are read in lexicographic filename order, the
 * same order the close froze.
 *
 * Output: the resolved-labels artifact (a pure projection of the
 * assembly bridge) plus one adjudication artifact per tiebreaker-resolved
 * case, all create-only.
 *
 *   CALIBRATION_LABEL_REVEAL_PRIVATE_KEY=... \
 *   node scripts/calibration-v4-reveal.mjs \
 *     --frame-tasks <frame-tasks.json> --tasks-dir <dir> \
 *     --authorization <calibration/<studyId>/pilot-labeling-authorization.json> \
 *     --commitments-dir <dir> --out-dir <dir>
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calibrationLabelPublicKeyIdentity } from "./calibration-label-source-envelope-lib.mjs";
import {
  buildV4ResolvedLabelsArtifact,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact,
  revealAuthenticatedV4PilotLabelBatches
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { canonicalPrettyJson } from "./calibration-study-lib.mjs";

const USAGE =
  "usage: calibration-v4-reveal.mjs --frame-tasks <frame-tasks.json> --tasks-dir <dir> --authorization <pilot-labeling-authorization.json> --commitments-dir <dir> --out-dir <dir>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const allowed = new Set([
  "--frame-tasks",
  "--tasks-dir",
  "--authorization",
  "--commitments-dir",
  "--out-dir"
]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of allowed) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}

const frameTasksBytes = readFileSync(values.get("--frame-tasks"), "utf8");
const frameTasks = parseV4FrameTasksBytes(frameTasksBytes);
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({ rootDir: repoRoot, detector: frameTasks.detector });
requireFrameMatchesApprovedArtifact(frameTasks, approvedArtifact);
if (
  !values.get("--authorization").endsWith(
    path.join("calibration", frameTasks.studyId, "pilot-labeling-authorization.json")
  )
) {
  fail(
    `--authorization must end with calibration/${frameTasks.studyId}/pilot-labeling-authorization.json. This is a naming-convention check only; the ANCHOR is the repository commit of that file, which the ceremony runbook verifies against the checkout before any reveal.`
  );
}
const authorizationBytes = readFileSync(values.get("--authorization"), "utf8");
const taskBytesByCaseId = new Map();
for (const file of readdirSync(values.get("--tasks-dir"))) {
  if (!file.endsWith(".json")) fail(`${file} in the tasks directory is not a task file`);
  taskBytesByCaseId.set(
    file.slice(0, -".json".length),
    readFileSync(path.join(values.get("--tasks-dir"), file), "utf8")
  );
}
const commitments = [];
for (const file of readdirSync(values.get("--commitments-dir")).sort()) {
  if (!file.endsWith(".json")) fail(`${file} in the commitments directory is not a record file`);
  commitments.push(JSON.parse(readFileSync(path.join(values.get("--commitments-dir"), file), "utf8")));
}

const outDir = values.get("--out-dir");
// KEY-FREE, AND FIRST: a destination that already holds a reveal makes every
// write below fail. Discovering that after the key has been read and every
// envelope opened costs the plaintext its secrecy for nothing, and invites a
// retry that starts by reading the key again.
for (const existing of ["resolved-labels.json", "adjudications"]) {
  if (existsSync(path.join(outDir, existing))) {
    fail(
      `--out-dir already contains ${existing}; reveal writes are create-only. Point --out-dir at an empty directory rather than deleting a previous reveal's evidence.`
    );
  }
}

const authorizationKeyId = JSON.parse(authorizationBytes).labelSealingKey?.keyId ?? "";
let revealed;
try {
  revealed = revealAuthenticatedV4PilotLabelBatches({
    authorizationBytes,
    commitments,
    readPrivateKey: () => {
      const key = process.env.CALIBRATION_LABEL_REVEAL_PRIVATE_KEY;
      delete process.env.CALIBRATION_LABEL_REVEAL_PRIVATE_KEY;
      if (!key) fail("CALIBRATION_LABEL_REVEAL_PRIVATE_KEY is required once custody passes");
      // THE ANCHOR IS THE KEY IN HAND, not the artifact's claim about it.
      // Deriving the identity from the private key the operator actually
      // supplied is what makes the comparison capable of failing: taking the
      // keyId from the authorization and then checking envelopes against it
      // compared the artifact with itself.
      let derivedKeyId;
      try {
        derivedKeyId = calibrationLabelPublicKeyIdentity(
          createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "pem" }).toString()
        ).keyId;
      } catch (error) {
        fail(`the supplied reveal key is not a usable sealing key: ${error.message}`);
      }
      if (derivedKeyId !== authorizationKeyId) {
        fail(
          `the supplied reveal key has keyId ${derivedKeyId}, and the authorization was closed under ${authorizationKeyId}; this is the wrong key for this pilot`
        );
      }
      return key;
    },
    candidate: {
      studyId: frameTasks.studyId,
      detector: frameTasks.detector,
      labelSealingKey: { keyId: authorizationKeyId }
    },
    candidateCommit: frameTasks.candidateCommit,
    frameTasks,
    taskBytesByCaseId
  });
} catch (error) {
  // Every custody refusal on this path is something the operator can act on.
  fail(`calibration:v4-reveal: ${error.message}`);
}

const resolved = buildV4ResolvedLabelsArtifact({
  frameTasks,
  labelerBatches: revealed.labelerBatches,
  tiebreakerBatch: revealed.tiebreakerBatch,
  commitmentSetSha256: revealed.commitmentSetSha256
});
mkdirSync(outDir, { recursive: true, mode: 0o700 });
writeFileSync(path.join(outDir, "resolved-labels.json"), resolved.text, {
  flag: "wx",
  mode: 0o600
});
let adjudications = 0;
for (const [caseId, entry] of resolved.bridgeCases) {
  const adjudication = entry.artifacts.adjudication;
  if (adjudication === null) continue;
  const dir = path.join(outDir, "adjudications");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, `${caseId}.json`),
    canonicalPrettyJson(adjudication.artifact),
    { flag: "wx", mode: 0o600 }
  );
  adjudications += 1;
}
console.log(
  `revealed ${revealed.labelerBatches.length} labeler batches plus the tiebreaker; resolved ${resolved.artifact.cases.length} cases (${adjudications} tiebreaker adjudications); resolved-labels sha256 ${resolved.sha256}`
);
