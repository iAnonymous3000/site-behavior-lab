#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import {
  buildMeasurementFreezeActivationReceipt,
  featuredControlledR2WorkflowIssues,
  MEASUREMENT_FREEZE_DEFAULT_BRANCH,
  MEASUREMENT_FREEZE_REPOSITORY,
  MEASUREMENT_FREEZE_WORKFLOW,
  measurementFreezeReceiptText,
  sha256Hex,
  verifyMeasurementFreezeActivationReceipt
} from "./measurement-freeze-activation-lib.mjs";
import {
  canonicalFeaturedReadjudicationText,
  extractFeaturedReadjudicationArtifactZip,
  FEATURED_READJUDICATION_ARTIFACT_FILE,
  FEATURED_READJUDICATION_CATALOG,
  FEATURED_READJUDICATION_CYCLE_KIND,
  FEATURED_READJUDICATION_DATES,
  FEATURED_READJUDICATION_RECEIPT_PATH,
  FEATURED_READJUDICATION_SCHEDULE,
  FEATURED_READJUDICATION_WORKFLOW,
  featuredReadjudicationActivationFreshnessIssues,
  featuredReadjudicationCatalogBinding,
  featuredReadjudicationDispositionsSha256,
  featuredReadjudicationOutcomesSha256,
  featuredReadjudicationWorkflowIssues,
  parseFeaturedReadjudicationCycle,
  parseFeaturedReadjudicationReceipt
} from "./featured-readjudication-lib.mjs";

const args = process.argv.slice(2);
let candidateSha = "";
let output = "";
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === "--candidate") candidateSha = args[++index] ?? "";
  else if (flag === "--output") output = args[++index] ?? "";
  else throw new Error(`Unknown argument: ${flag}`);
}
if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
  throw new Error("--candidate must be a full lowercase Git commit");
}
if (!output) throw new Error("--output is required");

const token = process.env.GITHUB_TOKEN ?? "";
if (!token) throw new Error("GITHUB_TOKEN is required for the read-only evidence queries");
const runnerReadToken = process.env.RUNNER_READ_TOKEN || token;
if (process.env.GITHUB_REPOSITORY !== MEASUREMENT_FREEZE_REPOSITORY) {
  throw new Error(`GITHUB_REPOSITORY must be exactly ${MEASUREMENT_FREEZE_REPOSITORY}`);
}
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
  throw new Error("the activation receipt may only be captured by workflow_dispatch");
}
if (process.env.GITHUB_REF !== `refs/heads/${MEASUREMENT_FREEZE_DEFAULT_BRANCH}`) {
  throw new Error("the activation workflow must be dispatched on refs/heads/main");
}
if (process.env.GITHUB_SHA !== candidateSha) {
  throw new Error("the declared candidate does not match the workflow event SHA");
}
if (!/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "")) {
  throw new Error("GITHUB_RUN_ID must be a positive integer");
}
if (!/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) {
  throw new Error("GITHUB_RUN_ATTEMPT must be a positive integer");
}

const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8"
}).trim();
if (checkoutCommit !== candidateSha) {
  throw new Error("the checked-out commit does not match the declared candidate");
}
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8"
  }).trim() !== ""
) {
  throw new Error("the activation checkout is dirty");
}

function readCandidateRegular(file, maximumBytes, encoding) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > maximumBytes) {
      throw new Error(`${file} must be a bounded non-symlink regular file`);
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== info.size) {
      throw new Error(`${file} changed while it was read`);
    }
    return encoding
      ? new TextDecoder(encoding, { fatal: true }).decode(bytes)
      : bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const activationWorkflowSource = readCandidateRegular(
  MEASUREMENT_FREEZE_WORKFLOW,
  1024 * 1024
);
const featuredWorkflowSource = readCandidateRegular(
  ".github/workflows/scan-featured.yml",
  1024 * 1024,
  "utf8"
);
const featuredIssues = featuredControlledR2WorkflowIssues(featuredWorkflowSource);
if (featuredIssues.length > 0) {
  throw new Error(featuredIssues.join("; "));
}
const activationWorkflowSha256 = createHash("sha256")
  .update(activationWorkflowSource)
  .digest("hex");
const featuredWorkflowSha256 = createHash("sha256")
  .update(featuredWorkflowSource)
  .digest("hex");
const readjudicationReceiptBytes = readCandidateRegular(
  FEATURED_READJUDICATION_RECEIPT_PATH,
  1024 * 1024
);
const finalFeaturedSitesBytes = readCandidateRegular(
  FEATURED_READJUDICATION_CATALOG,
  2 * 1024 * 1024
);
let readjudicationReceiptText;
try {
  readjudicationReceiptText = new TextDecoder("utf-8", { fatal: true }).decode(
    readjudicationReceiptBytes
  );
} catch {
  throw new Error("the committed featured re-adjudication receipt is not UTF-8");
}
const readjudicationReceipt = parseFeaturedReadjudicationReceipt(
  readjudicationReceiptText,
  finalFeaturedSitesBytes
);

async function api(path, authToken = token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "site-behavior-lab-measurement-freeze-activation"
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    if (
      path === `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runners` ||
      path.startsWith(
        `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runners?`
      )
    ) {
      throw new Error(
        `GitHub API ${path} failed with HTTP ${response.status}; runner inventory is mandatory. Install a repository-scoped App with Administration:read and configure RUNNER_READ_APP_CLIENT_ID/RUNNER_READ_APP_PRIVATE_KEY if GITHUB_TOKEN cannot read this endpoint.`
      );
    }
    throw new Error(`GitHub API ${path} failed with HTTP ${response.status}`);
  }
  const bytes = await boundedApiResponseBytes(response, path, 1024 * 1024);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`GitHub API ${path} did not return valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub API ${path} did not return valid JSON`);
  }
}

async function boundedApiResponseBytes(response, path, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength <= 0 ||
      declaredLength > maximumBytes
    ) {
      throw new Error(`GitHub API ${path} returned an out-of-bounds body`);
    }
  }
  if (!response.body) throw new Error(`GitHub API ${path} returned no body`);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`GitHub API ${path} exceeded its ${maximumBytes}-byte bound`);
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error(`GitHub API ${path} returned an empty body`);
  return Buffer.concat(chunks, total);
}

async function apiBytes(path, maximumBytes) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "site-behavior-lab-measurement-freeze-activation"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with HTTP ${response.status}`);
  }
  return boundedApiResponseBytes(response, path, maximumBytes);
}

async function paged(path, field) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await api(`${path}${separator}per_page=100&page=${page}`);
    const batch = field === null ? response : response?.[field];
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub API ${path} did not return the expected array`);
    }
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub API ${path} exceeded the bounded 2,000-item query`);
}

async function repositoryRunners() {
  const runners = [];
  let declaredTotal = null;
  for (let page = 1; page <= 10; page += 1) {
    const response = await api(
      `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runners?per_page=100&page=${page}`,
      runnerReadToken
    );
    if (
      !Number.isSafeInteger(response?.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response?.runners)
    ) {
      throw new Error("repository runner inventory has a malformed response shape");
    }
    if (declaredTotal === null) declaredTotal = response.total_count;
    if (response.total_count !== declaredTotal || declaredTotal > 1_000) {
      throw new Error("repository runner inventory changed or exceeded the 1,000-runner bound");
    }
    runners.push(...response.runners);
    if (runners.length >= declaredTotal) {
      if (runners.length !== declaredTotal) {
        throw new Error("repository runner inventory count is inconsistent");
      }
      return runners;
    }
    if (response.runners.length === 0) {
      throw new Error("repository runner inventory ended before total_count");
    }
  }
  throw new Error("repository runner inventory exceeded ten bounded pages");
}

function canonicalInstant(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid instant`);
  return new Date(parsed).toISOString();
}

const repository = await api(`/repos/${MEASUREMENT_FREEZE_REPOSITORY}`);
if (
  repository?.full_name !== MEASUREMENT_FREEZE_REPOSITORY ||
  repository?.default_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH
) {
  throw new Error("repository identity or default branch does not match the activation contract");
}

const runId = Number(process.env.GITHUB_RUN_ID);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const run = await api(
  `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${runId}`
);
const expectedRunUrl = `https://github.com/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${runId}`;
if (
  run?.id !== runId ||
  run?.run_attempt !== runAttempt ||
  run?.event !== "workflow_dispatch" ||
  run?.path !== MEASUREMENT_FREEZE_WORKFLOW ||
  run?.head_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
  run?.head_sha !== candidateSha ||
  run?.html_url !== expectedRunUrl ||
  run?.repository?.full_name !== MEASUREMENT_FREEZE_REPOSITORY
) {
  throw new Error("live Actions run metadata does not bind this workflow to the exact main candidate");
}

function normalizedArtifactDigest(value, label) {
  const normalized =
    typeof value === "string" && value.startsWith("sha256:")
      ? value.slice(7)
      : value;
  if (!/^[0-9a-f]{64}$/.test(normalized ?? "")) {
    throw new Error(`${label} is not a lowercase sha256 digest`);
  }
  return normalized;
}

async function historicalRepositoryFile(
  repositoryPath,
  headSha,
  maximumBytes,
  label
) {
  const response = await api(
    `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/contents/${repositoryPath}?ref=${headSha}`
  );
  if (
    response?.type !== "file" ||
    response?.path !== repositoryPath ||
    response?.encoding !== "base64" ||
    typeof response.content !== "string" ||
    !Number.isSafeInteger(response.size) ||
    response.size <= 0 ||
    response.size > maximumBytes
  ) {
    throw new Error(
      `${label} at ${headSha} has malformed content metadata`
    );
  }
  const encoded = response.content.replace(/\s/g, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  ) {
    throw new Error(`${label} at ${headSha} is not canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength !== response.size ||
    bytes.toString("base64") !== encoded
  ) {
    throw new Error(`${label} at ${headSha} changed in transit`);
  }
  return bytes;
}

async function historicalFeaturedWorkflow(headSha) {
  const bytes = await historicalRepositoryFile(
    FEATURED_READJUDICATION_WORKFLOW,
    headSha,
    1024 * 1024,
    "historical featured workflow"
  );
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`historical featured workflow at ${headSha} is not UTF-8`);
  }
  const issues = featuredReadjudicationWorkflowIssues(source);
  if (issues.length > 0) {
    throw new Error(
      `historical featured workflow at ${headSha} is ineligible: ${issues.join("; ")}`
    );
  }
  return sha256Hex(bytes);
}

const readjudicationCycles = [];
for (const [index, boundCycle] of readjudicationReceipt.cycles.entries()) {
  const expectedDate = FEATURED_READJUDICATION_DATES[index];
  const cycleRunId = boundCycle.actionsRun.id;
  const cycleRun = await api(
    `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${cycleRunId}`
  );
  const cycleRunStartedAt = canonicalInstant(
    cycleRun?.run_started_at,
    `Aug ${index === 0 ? "3" : "10"} featured run start`
  );
  if (
    cycleRun?.id !== cycleRunId ||
    cycleRun?.run_attempt !== boundCycle.actionsRun.attempt ||
    cycleRun?.event !== "schedule" ||
    cycleRun?.path !== FEATURED_READJUDICATION_WORKFLOW ||
    cycleRun?.head_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
    cycleRun?.head_sha !== boundCycle.actionsRun.headSha ||
    cycleRun?.repository?.full_name !== MEASUREMENT_FREEZE_REPOSITORY ||
    cycleRun?.status !== "completed" ||
    !["success", "failure"].includes(cycleRun?.conclusion) ||
    cycleRunStartedAt.slice(0, 10) !== expectedDate ||
    boundCycle.actionsRun.event !== "schedule" ||
    boundCycle.actionsRun.schedule !== FEATURED_READJUDICATION_SCHEDULE
  ) {
    throw new Error(
      `${expectedDate} live Actions run does not bind the exact scheduled main gallery cycle`
    );
  }
  const historicalWorkflowSha256 = await historicalFeaturedWorkflow(
    cycleRun.head_sha
  );
  const historicalCatalogBytes = await historicalRepositoryFile(
    FEATURED_READJUDICATION_CATALOG,
    cycleRun.head_sha,
    2 * 1024 * 1024,
    "historical featured-sites catalog"
  );
  const historicalCatalog = featuredReadjudicationCatalogBinding(
    historicalCatalogBytes
  );
  if (
    historicalCatalog.sha256 !== boundCycle.catalog.sha256 ||
    historicalCatalog.targetsSha256 !== boundCycle.catalog.targetsSha256 ||
    historicalCatalog.version !== boundCycle.catalog.version
  ) {
    throw new Error(
      `${expectedDate} live historical catalog does not match the exact cycle binding`
    );
  }

  const artifactId = boundCycle.artifact.id;
  const artifact = await api(
    `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/artifacts/${artifactId}`
  );
  const artifactCreatedAt = canonicalInstant(
    artifact?.created_at,
    `${expectedDate} re-adjudication artifact creation`
  );
  const expectedArtifactName =
    `featured-readjudication-outcomes-${cycleRunId}-${cycleRun.run_attempt}`;
  const apiArtifactDigest = normalizedArtifactDigest(
    artifact?.digest,
    `${expectedDate} live artifact digest`
  );
  if (
    artifact?.id !== artifactId ||
    artifact?.name !== expectedArtifactName ||
    artifact?.expired !== false ||
    !Number.isSafeInteger(artifact?.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > 1024 * 1024 ||
    artifactCreatedAt.slice(0, 10) !== expectedDate ||
    artifact?.workflow_run?.id !== cycleRunId ||
    artifact?.workflow_run?.head_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
    artifact?.workflow_run?.head_sha !== cycleRun.head_sha ||
    apiArtifactDigest !== boundCycle.artifact.sha256
  ) {
    throw new Error(
      `${expectedDate} live artifact metadata does not match the aggregate receipt`
    );
  }
  const archiveBytes = await apiBytes(
    `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
    1024 * 1024
  );
  const archiveSha256 = sha256Hex(archiveBytes);
  if (archiveSha256 !== boundCycle.artifact.sha256) {
    throw new Error(
      `${expectedDate} exact artifact ZIP bytes do not match the aggregate receipt`
    );
  }
  const outcomeBytes = extractFeaturedReadjudicationArtifactZip(archiveBytes);
  let outcomeText;
  try {
    outcomeText = new TextDecoder("utf-8", { fatal: true }).decode(outcomeBytes);
  } catch {
    throw new Error(
      `${expectedDate} ${FEATURED_READJUDICATION_ARTIFACT_FILE} is not UTF-8`
    );
  }
  const liveCycle = parseFeaturedReadjudicationCycle(outcomeText);
  const aggregateCycle = {
    schemaVersion: 1,
    artifactKind: FEATURED_READJUDICATION_CYCLE_KIND,
    repository: readjudicationReceipt.repository,
    workflow: readjudicationReceipt.workflow,
    actionsRun: boundCycle.actionsRun,
    catalog: boundCycle.catalog,
    complete: boundCycle.complete,
    outcomes: boundCycle.outcomes
  };
  if (
    canonicalFeaturedReadjudicationText(liveCycle) !==
    canonicalFeaturedReadjudicationText(aggregateCycle)
  ) {
    throw new Error(
      `${expectedDate} exact artifact contents do not match the aggregate receipt`
    );
  }
  readjudicationCycles.push({
    date: expectedDate,
    runId: cycleRunId,
    runAttempt: cycleRun.run_attempt,
    headSha: cycleRun.head_sha,
    runStartedAt: cycleRunStartedAt,
    workflowSha256: historicalWorkflowSha256,
    catalogSha256: historicalCatalog.sha256,
    catalogTargetsSha256: historicalCatalog.targetsSha256,
    catalogVersion: historicalCatalog.version,
    artifactId,
    artifactName: artifact.name,
    artifactSha256: archiveSha256,
    artifactCreatedAt,
    outcomesSha256: featuredReadjudicationOutcomesSha256(liveCycle)
  });
}
const readjudicationVerifiedAt = new Date().toISOString();
const reAdjudication = {
  receiptPath: FEATURED_READJUDICATION_RECEIPT_PATH,
  receiptSha256: sha256Hex(readjudicationReceiptBytes),
  verifiedAt: readjudicationVerifiedAt,
  finalFeaturedSitesSha256: sha256Hex(finalFeaturedSitesBytes),
  finalFeaturedTargetsSha256:
    featuredReadjudicationCatalogBinding(finalFeaturedSitesBytes).targetsSha256,
  dispositionsSha256:
    featuredReadjudicationDispositionsSha256(readjudicationReceipt),
  cycles: readjudicationCycles
};

async function matchingOpenPullRequests() {
  const pulls = await paged(
    `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/pulls?state=open&base=${MEASUREMENT_FREEZE_DEFAULT_BRANCH}&sort=created&direction=asc`,
    null
  );
  return pulls.filter(
    (pull) =>
      typeof pull?.head?.ref === "string" &&
      (pull.head.ref.startsWith("automation/") ||
        pull.head.ref.startsWith("dependabot/"))
  );
}

const runnerLabel = process.env.FEATURED_RUNNER_LABEL ?? "";
const runners = await repositoryRunners();
const controlledRunnerQueriedAt = new Date().toISOString();
const controlledRunnerMatches = runners
  .filter((runner) => {
    const labels = Array.isArray(runner?.labels)
      ? runner.labels.map((label) => label?.name)
      : [];
    return (
      runner?.status === "online" &&
      labels.includes("self-hosted") &&
      labels.includes(runnerLabel)
    );
  })
  .map((runner) => {
    if (
      !Number.isSafeInteger(runner?.id) ||
      runner.id <= 0 ||
      typeof runner?.name !== "string" ||
      runner.name.length === 0 ||
      typeof runner?.busy !== "boolean" ||
      !Array.isArray(runner?.labels) ||
      runner.labels.some((label) => typeof label?.name !== "string")
    ) {
      throw new Error("a matching repository runner has malformed identity metadata");
    }
    const labelNames = runner.labels.map((label) => label.name).sort();
    return {
      identitySha256: sha256Hex(`runner-identity\u0000${runner.id}\u0000${runner.name}`),
      nameSha256: sha256Hex(`runner-name\u0000${runner.name}`),
      labelSetSha256: sha256Hex(JSON.stringify(labelNames)),
      status: "online",
      busy: runner.busy
    };
  });
if (controlledRunnerMatches.length === 0) {
  throw new Error(
    "no online repository self-hosted runner carries FEATURED_RUNNER_LABEL"
  );
}

// Zero open pre-freeze automation is deliberately stronger than trying to
// race the four checks: a pending proposal can become green after activation
// while still carrying pre-epoch inputs.
const proposalSnapshots = await matchingOpenPullRequests();
const proposalCheckedAt = new Date().toISOString();
if (proposalSnapshots.length !== 0) {
  throw new Error(
    `measurement freeze requires zero open automation/* or dependabot/* pull requests; observed ${proposalSnapshots.length}`
  );
}

// Re-read main LAST, after runner and proposal evidence. activatedAt is minted
// only once the exact candidate is still current and the zero-open guard has
// passed.
const mainRef = await api(
  `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/git/ref/heads/${MEASUREMENT_FREEZE_DEFAULT_BRANCH}`
);
const mainRefObservedAt = new Date().toISOString();
if (mainRef?.ref !== "refs/heads/main" || mainRef?.object?.sha !== candidateSha) {
  throw new Error("main no longer identifies the declared activation candidate");
}
const activatedAt = new Date().toISOString();
const freshnessIssues = featuredReadjudicationActivationFreshnessIssues(
  readjudicationReceipt,
  activatedAt
);
if (freshnessIssues.length > 0) {
  throw new Error(
    `featured re-adjudication evidence is stale at activation: ${freshnessIssues.join("; ")}`
  );
}

const receipt = buildMeasurementFreezeActivationReceipt({
  candidateSha,
  checkoutCommit,
  mainRefCommit: mainRef.object.sha,
  mainRefObservedAt,
  activationWorkflowSha256,
  runHeadSha: run.head_sha,
  runId,
  runAttempt,
  runStartedAt: canonicalInstant(
    run.run_started_at ?? run.created_at,
    "Actions run start"
  ),
  activatedAt,
  featuredWorkflowSha256,
  reAdjudication,
  configuration: {
    measurementFreeze:
      process.env.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE ?? "",
    runnerLabel: process.env.FEATURED_RUNNER_LABEL ?? "",
    scannerEgress: process.env.SCANNER_EGRESS ?? "",
    scannerEgressRegion: process.env.SCANNER_EGRESS_REGION ?? "",
    featuredR2EgressAttested:
      process.env.FEATURED_R2_EGRESS_ATTESTED ?? ""
  },
  controlledRunnerQueriedAt,
  controlledRunnerMatches,
  proposalCheckedAt,
  proposalSnapshots
});

const verification = verifyMeasurementFreezeActivationReceipt(receipt, {
  // Proposal and runner observations precede the final main read; activation
  // is therefore the earliest instant that can validate every receipt time.
  now: activatedAt,
  expectedRepository: MEASUREMENT_FREEZE_REPOSITORY,
  expectedCandidateSha: candidateSha,
  expectedRunId: runId,
  expectedRunAttempt: runAttempt,
  expectedActivationWorkflowSha256: activationWorkflowSha256,
  expectedFeaturedWorkflowSha256: featuredWorkflowSha256,
  expectedReAdjudicationReceiptSha256: reAdjudication.receiptSha256,
  expectedFeaturedSitesSha256: reAdjudication.finalFeaturedSitesSha256,
  expectedFeaturedTargetsSha256:
    reAdjudication.finalFeaturedTargetsSha256,
  expectedReAdjudicationDispositionsSha256:
    reAdjudication.dispositionsSha256,
  expectedReAdjudicationReceipt: readjudicationReceipt,
  expectedMeasurementFreeze:
    process.env.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE,
  expectedRunnerLabel: process.env.FEATURED_RUNNER_LABEL,
  expectedScannerEgress: process.env.SCANNER_EGRESS,
  expectedScannerEgressRegion: process.env.SCANNER_EGRESS_REGION,
  expectedFeaturedR2EgressAttested:
    process.env.FEATURED_R2_EGRESS_ATTESTED
});
if (!verification.ok) {
  throw new Error(`activation receipt refused: ${verification.issues.join("; ")}`);
}

writeFileSync(output, measurementFreezeReceiptText(receipt), {
  flag: "wx",
  mode: 0o600
});
console.log(
  `PASS captured canonical measurement-freeze activation receipt sha256:${verification.receiptSha256}`
);
