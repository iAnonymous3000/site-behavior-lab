"use client";

import { AlertTriangle, ChevronDown, Cookie, Database } from "lucide-react";
import { useMemo, useState } from "react";
import {
  STATE_CHANGE_ROW_LIMIT,
  buildVisitPhaseEvidence,
  visitPhaseSpanLabel,
  type MutationTally,
  type VisitPhaseRow
} from "@/lib/report-phase-evidence";
import { plural } from "@/lib/text-format";
import { familyUnsupportedOnRun, type RunView } from "@/lib/scan-report-views";

/**
 * The v2-only, per-run phase surface. It follows the report shell's selected
 * arm because the shell passes the currently displayed RunView. Legacy v1
 * views return null rather than presenting derived stand-ins as recorded fact.
 */
export function VisitPhasesAndStateChanges({ run }: { run: RunView }) {
  const evidence = useMemo(() => buildVisitPhaseEvidence(run), [run]);
  const [ledgerOpened, setLedgerOpened] = useState(false);

  if (evidence === null) return null;

  const shownChanges = evidence.changes.slice(0, STATE_CHANGE_ROW_LIMIT);
  const cookieUnsupported = familyUnsupportedOnRun(run, "cookies");
  const storageUnsupported = familyUnsupportedOnRun(run, "storage");
  const ledgerUnsupported = cookieUnsupported || storageUnsupported;
  const ledgerIncomplete =
    (evidence.cookieLedgerIncomplete && !cookieUnsupported) ||
    (evidence.storageLedgerIncomplete && !storageUnsupported);
  const incompleteFamilies = [
    evidence.cookieLedgerIncomplete && !cookieUnsupported ? "cookie" : null,
    evidence.storageLedgerIncomplete && !storageUnsupported ? "storage" : null
  ].filter((family): family is string => family !== null);

  return (
    <section className="data-section visit-phase-evidence" aria-labelledby="visit-phases-title">
      <div className="section-heading visit-phase-heading">
        <div>
          <p className="eyebrow">Recorded visit structure</p>
          <h2 id="visit-phases-title">Visit phases &amp; state changes</h2>
        </div>
        <span className="count-badge">{plural(evidence.phases.length, "phase")}</span>
      </div>

      <p className="visit-phase-intro">
        Request counts are retained request rows whose start fell in each phase. A phase with no retained rows does not
        prove that no traffic occurred; some phase traffic can be intentionally excluded from the public request log.
      </p>

      <div className="table-wrap visit-phase-table" role="region" aria-label="Visit phase evidence table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Phase</th>
              <th>Span from run start</th>
              <th>Recorded requests</th>
              <th>Third-party</th>
              <th>Known service</th>
              <th>Cookie records</th>
              <th>Storage records</th>
            </tr>
          </thead>
          <tbody>
            {evidence.phases.map((phase) => (
              <tr key={phase.phaseId}>
                <td data-label="Phase">
                  <strong>{phase.label}</strong>
                  <small className="phase-code">P{phase.phaseId} · {phase.kind}</small>
                </td>
                <td className="mono" data-label="Span from run start">{visitPhaseSpanLabel(phase)}</td>
                <td data-label="Recorded requests">
                  {phase.requestCountState === "recorded" ? (
                    phase.requestCounts!.totalRequests.toLocaleString("en-US")
                  ) : (
                    <span className="muted">
                      No retained rows
                    </span>
                  )}
                </td>
                <td data-label="Third-party">
                  {phase.requestCounts ? phase.requestCounts.thirdPartyRequests.toLocaleString("en-US") : "—"}
                </td>
                <td data-label="Known service">
                  {phase.requestCounts ? phase.requestCounts.knownTrackerRequests.toLocaleString("en-US") : "—"}
                </td>
                <MutationTallyCell
                  family="cookies"
                  phase={phase}
                  tally={phase.cookieChanges}
                  unsupported={cookieUnsupported}
                />
                <MutationTallyCell
                  family="storage"
                  phase={phase}
                  tally={phase.storageChanges}
                  unsupported={storageUnsupported}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details
        className="disclosure state-change-disclosure"
        onToggle={(event) => {
          if (event.currentTarget.open) setLedgerOpened(true);
        }}
      >
        <summary className="section-heading">
          <h3>Cookie &amp; storage snapshot ledger</h3>
          <span className="count-badge">{plural(evidence.changes.length, "change record")}</span>
          <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
        </summary>

        {ledgerOpened ? (
          <div className="state-change-content">
            <p className="state-change-caveat">
              Changes are inferred from privacy-filtered snapshots at phase boundaries, not instrumented browser write
              events. Cookie values are never recorded; storage values are omitted and only byte counts remain.
            </p>

            {ledgerUnsupported && (
              <p className="state-change-warning">
                Cookie and storage state evidence was not captured by this request-only PageGraph import. Its empty
                ledgers are unavailable measurements, not observed zeroes.
              </p>
            )}

            {ledgerIncomplete && (
              <p className="state-change-warning">
                <AlertTriangle size={15} aria-hidden="true" />
                Some {incompleteFamilies.join(" and ")} evidence was incomplete or clipped, so this public change
                ledger is partial.
              </p>
            )}

            {shownChanges.length > 0 ? (
              <ol className="state-change-list">
                {shownChanges.map((change) => {
                  const Icon = change.family === "cookie" ? Cookie : Database;
                  return (
                    <li key={change.id} className="state-change-row">
                      <Icon size={16} aria-hidden="true" />
                      <div>
                        <div className="state-change-meta">
                          <span>P{change.phaseId} · {change.phaseLabel}</span>
                          <span className={`state-change-op op-${change.operation}`}>{change.operationLabel}</span>
                        </div>
                        <strong>{change.subjectLabel}</strong>
                        <small>{change.context}</small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="table-empty">
                {ledgerUnsupported
                  ? "Cookie and storage snapshot changes were not captured by this PageGraph import."
                  : ledgerIncomplete
                  ? "No complete cookie or storage snapshot-change records are available for this visit."
                  : "No cookie or storage snapshot changes were recorded for this visit."}
              </p>
            )}

            {evidence.hiddenNameRecords > 0 && (
              <p className="state-change-note">
                {plural(evidence.hiddenNameRecords, "change record")} hide unreviewed names or keys because they can
                contain identifiers.
              </p>
            )}
            {evidence.changes.length > shownChanges.length && (
              <p className="row-more">
                Showing the first {shownChanges.length.toLocaleString("en-US")} of{" "}
                {evidence.changes.length.toLocaleString("en-US")} recorded snapshot changes. Export JSON for the full
                ledger.
              </p>
            )}
          </div>
        ) : (
          <p className="muted disclosure-lazy-note">
            Open the snapshot ledger to render its bounded first {STATE_CHANGE_ROW_LIMIT} change records.
          </p>
        )}
      </details>
    </section>
  );
}

function MutationTallyCell({
  family,
  phase,
  tally,
  unsupported
}: {
  family: "cookies" | "storage";
  phase: VisitPhaseRow;
  tally: MutationTally;
  unsupported: boolean;
}) {
  if (unsupported) {
    return (
      <td data-label={family === "cookies" ? "Cookie records" : "Storage records"}>
        Not captured
        <small className="phase-incomplete">PageGraph unsupported</small>
      </td>
    );
  }
  const incomplete = phase.incompleteFamilies.includes(family);
  const additions = phase.kind === "passive-load" ? "present" : "appeared";
  const parts = [
    tally.added > 0 ? `${tally.added.toLocaleString("en-US")} ${additions}` : null,
    tally.changed > 0 ? `${tally.changed.toLocaleString("en-US")} changed` : null,
    tally.removed > 0 ? `${tally.removed.toLocaleString("en-US")} absent` : null
  ].filter((part): part is string => part !== null);

  return (
    <td data-label={family === "cookies" ? "Cookie records" : "Storage records"}>
      {parts.length > 0 ? parts.join(" · ") : "0 retained"}
      {incomplete && <small className="phase-incomplete">Ledger partial</small>}
    </td>
  );
}
