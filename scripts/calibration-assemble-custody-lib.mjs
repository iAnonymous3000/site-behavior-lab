import {
  canonicalCalibrationAcquisitionText,
  buildCalibrationLabelRosterSelectionLedger
} from "./calibration-acquisition-authorization-lib.mjs";
import { sha256Hex } from "./calibration-study-lib.mjs";

/**
 * Acquire and cross-bind the three pre-acquisition custody files the study
 * assembler requires. This is the wiring the assemble CLI's refusal guarded:
 * everything here must succeed BEFORE the reveal private key is read, so a
 * custody failure can never cost a sealed envelope its secrecy.
 *
 * Inputs are injected so the binding rules are testable offline:
 * `fetchRoster` performs the authenticated roster re-fetch (live: the
 * roster-lib fetcher over the GitHub API) and `fetchAttemptLedger` builds the
 * acquisition-attempt ledger from the Actions run history. Neither result is
 * trusted as given; every identity the pre-acquisition authorization pinned
 * is re-checked here against what the fetchers returned, so a substituted
 * roster artifact, a re-run acquisition, or a divergent selection snapshot
 * refuses before any output exists.
 */
export async function acquireAssemblyCustody({
  studyId,
  authorization,
  acquisitionSnapshotText,
  carrierCommit,
  fetchRoster,
  fetchAttemptLedger
}) {
  if (typeof studyId !== "string" || studyId.length === 0) {
    throw new Error("custody acquisition requires the study id");
  }
  if (!authorization || typeof authorization !== "object") {
    throw new Error("custody acquisition requires the acquisition authorization");
  }
  if (typeof acquisitionSnapshotText !== "string" || acquisitionSnapshotText.length === 0) {
    throw new Error("custody acquisition requires the acquisition-embedded selection snapshot text");
  }

  const fetched = await fetchRoster();

  // The roster the assembler archives must be the exact artifact the
  // pre-acquisition authorization named, byte for byte, not merely a roster
  // that validates. Every pinned coordinate is compared.
  if (fetched.sha256 !== authorization.roster.authorizationSha256) {
    throw new Error("re-fetched roster authorization bytes differ from the pre-acquisition digest");
  }
  if (fetched.metadata.headSha !== authorization.roster.headSha) {
    throw new Error("re-fetched roster run head differs from the authorized roster head");
  }
  if (fetched.metadata.runId !== authorization.roster.runId) {
    throw new Error("re-fetched roster run id differs from the authorized roster run");
  }
  if (fetched.metadata.runAttempt !== authorization.roster.runAttempt) {
    throw new Error("re-fetched roster run attempt differs from the authorized roster attempt");
  }
  if (fetched.metadata.artifactId !== authorization.roster.artifactId) {
    throw new Error("re-fetched roster artifact id differs from the authorized roster artifact");
  }
  if (fetched.metadata.archiveSha256 !== authorization.roster.archiveSha256) {
    throw new Error("re-fetched roster archive digest differs from the authorized roster archive");
  }
  if (fetched.roster.commitmentSetSha256 !== authorization.commitmentSetSha256) {
    throw new Error("re-fetched roster commitment set differs from the authorized commitment set");
  }

  // The selection snapshot inside acquisition.json was validated against the
  // authorization at inspection time; the independently re-derived snapshot
  // must be the same object, so the two custody trails cannot diverge.
  const fetchedSnapshotText = canonicalCalibrationAcquisitionText(fetched.selectionSnapshot);
  if (fetchedSnapshotText !== acquisitionSnapshotText) {
    throw new Error("re-derived roster selection snapshot differs from the acquisition-embedded snapshot");
  }

  const selectionLedger = buildCalibrationLabelRosterSelectionLedger({
    rosterAuthorizationSha256: fetched.sha256,
    selection: fetched.selectionSnapshot,
    selectedArtifact: selectedArtifactFromMetadata(fetched.metadata)
  });
  const selectionLedgerText = canonicalCalibrationAcquisitionText(selectionLedger);

  const attemptLedger = await fetchAttemptLedger();
  if (
    !attemptLedger ||
    typeof attemptLedger.text !== "string" ||
    typeof attemptLedger.sha256 !== "string"
  ) {
    throw new Error("acquisition attempt ledger fetch returned no canonical ledger");
  }
  if (attemptLedger.sha256 !== sha256Hex(attemptLedger.text)) {
    throw new Error("acquisition attempt ledger digest does not match its canonical bytes");
  }

  const studyDir = `calibration/${studyId}`;
  const custody = {
    labelRosterAuthorization: {
      path: `${studyDir}/label-roster-authorization.json`,
      text: fetched.text,
      sha256: fetched.sha256
    },
    rosterSelectionLedger: {
      path: `${studyDir}/roster-selection-ledger.json`,
      text: selectionLedgerText,
      sha256: sha256Hex(selectionLedgerText)
    },
    acquisitionAttemptLedger: {
      path: `${studyDir}/acquisition-attempt-ledger.json`,
      text: attemptLedger.text,
      sha256: attemptLedger.sha256
    }
  };

  return {
    custody,
    roster: {
      authorizationPath: custody.labelRosterAuthorization.path,
      authorizationSha256: custody.labelRosterAuthorization.sha256,
      selectionLedgerPath: custody.rosterSelectionLedger.path,
      selectionLedgerSha256: custody.rosterSelectionLedger.sha256,
      candidateCommit: authorization.candidateCommit,
      carrierCommit,
      authenticatedCommitments: fetched.roster.authenticatedCommitments,
      commitmentSetSha256: fetched.roster.commitmentSetSha256
    }
  };
}

/**
 * Project the roster fetch metadata onto the selection ledger's exact
 * selectedArtifact shape. Every field is required: an undefined value here
 * means the fetcher and the ledger contract drifted, and the ledger builder's
 * own validation must see the miss rather than a silently absent key.
 */
function selectedArtifactFromMetadata(metadata) {
  const fields = [
    "runId",
    "runAttempt",
    "headSha",
    "actor",
    "triggeringActor",
    "runName",
    "runStatus",
    "runConclusion",
    "runStartedAt",
    "runUpdatedAt",
    "runCompletedAt",
    "artifactId",
    "artifactName",
    "archiveSha256",
    "archiveBytes",
    "artifactCreatedAt",
    "artifactExpiresAt"
  ];
  const artifact = {};
  for (const field of fields) {
    if (metadata[field] === undefined) {
      throw new Error(`roster metadata is missing ${field} required by the selection ledger`);
    }
    artifact[field] = metadata[field];
  }
  return artifact;
}
