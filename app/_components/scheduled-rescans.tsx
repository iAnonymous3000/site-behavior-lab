"use client";

import { CalendarClock, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ScanFormState } from "./scan-controls";
import { scannerApiUrl } from "../client-runtime";
import {
  createEncryptedWatch,
  deleteEncryptedWatch,
  encryptedWatchManagementUrl,
  mintEncryptedWatchCredentials,
  parseEncryptedWatchCredentialsFromUrl,
  readEncryptedWatch,
  type EncryptedWatchCredentials,
  type EncryptedWatchStatus
} from "@/lib/encrypted-watch-client";
import {
  SCHEDULED_RESCAN_BOUNDARY_COPY,
  SCHEDULED_RESCAN_CAPABILITY_COPY,
  SCHEDULED_RESCAN_INVALID_LINK_COPY,
  SCHEDULED_RESCAN_POLICY_COPY,
  SCHEDULED_RESCAN_RETRY_COPY,
  normalizeScheduledRescanTarget,
  retainScheduledRescanCreationBeforePost,
  scheduledRescanActionState,
  scheduledRescanCanRetryCreation,
  scheduledRescanCredentialsMatchDerivedId,
  scheduledRescanPanelVisible,
  scheduledRescanRunPresentation
} from "@/lib/scheduled-rescan-ui";
import type { EncryptedWatchPayload } from "@/lib/encrypted-watch-contract";
import type { PendingScheduledRescanCreation } from "@/lib/scheduled-rescan-ui";

type ScheduledRescansProps = {
  enabled: boolean;
  form: ScanFormState;
  scanBlocked: boolean;
  scanBusy: boolean;
  acceptedScanJob: boolean;
  scannerRequiresAccessKey: boolean;
  turnstileRequired: boolean;
  turnstileToken: string;
  onTargetNormalized: (targetUrl: string, removedPrivateParts: boolean) => void;
  onCreateBusyChange: (busy: boolean) => void;
  onCreateNetworkAttemptSettled: () => void;
};

type WatchActivity = "recovering" | "creating" | "refreshing" | "deleting" | null;

export function ScheduledRescans({
  enabled,
  form,
  scanBlocked,
  scanBusy,
  acceptedScanJob,
  scannerRequiresAccessKey,
  turnstileRequired,
  turnstileToken,
  onTargetNormalized,
  onCreateBusyChange,
  onCreateNetworkAttemptSettled
}: ScheduledRescansProps) {
  const [credentials, setCredentials] = useState<EncryptedWatchCredentials | null>(null);
  const [status, setStatus] = useState<EncryptedWatchStatus | null>(null);
  const [activity, setActivity] = useState<WatchActivity>(null);
  const [error, setError] = useState<string | null>(null);
  const [fragmentChecked, setFragmentChecked] = useState(false);
  const [invalidManagementFragment, setInvalidManagementFragment] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const retainedCredentialsRef = useRef<EncryptedWatchCredentials | null>(null);
  const pendingCreationRef = useRef<PendingScheduledRescanCreation | null>(null);
  const createInFlightRef = useRef(false);
  const fragmentRecoverySequenceRef = useRef(0);
  const accessTokenRef = useRef<string | undefined>(undefined);
  accessTokenRef.current = scannerRequiresAccessKey ? form.accessKey.trim() : undefined;
  const normalizedTarget = normalizeScheduledRescanTarget(form.url);
  const comparisonMode = form.compareGpc || form.compareShields || form.compareConsent;
  const canRetryCreation = scheduledRescanCanRetryCreation(pendingCreationRef.current, credentials);
  const action = scheduledRescanActionState({
    featureEnabled: enabled,
    comparisonMode: canRetryCreation ? false : comparisonMode,
    targetReady: canRetryCreation || normalizedTarget !== null,
    scanBlocked,
    busy: scanBusy || activity !== null,
    acceptedScanJob
  });

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function recoverFromFragment() {
      const recoverySequence = ++fragmentRecoverySequenceRef.current;
      const observedHref = window.location.href;
      let recovered = parseEncryptedWatchCredentialsFromUrl(observedHref);
      if (recovered && !(await scheduledRescanCredentialsMatchDerivedId(recovered))) {
        recovered = null;
      }
      if (
        cancelled ||
        recoverySequence !== fragmentRecoverySequenceRef.current ||
        window.location.href !== observedHref
      ) {
        return;
      }
      if (!recovered) {
        const hasInvalidManagementFragment = window.location.hash.startsWith("#watch=");
        pendingCreationRef.current = null;
        retainedCredentialsRef.current = null;
        setCredentials(null);
        setStatus(null);
        setInvalidManagementFragment(hasInvalidManagementFragment);
        setError(null);
        setFragmentChecked(true);
        return;
      }
      const controller = new AbortController();
      requestControllerRef.current?.abort();
      requestControllerRef.current = controller;
      if (!sameWatchCredentials(pendingCreationRef.current?.credentials ?? null, recovered)) {
        pendingCreationRef.current = null;
      }
      retainedCredentialsRef.current = recovered;
      setInvalidManagementFragment(false);
      setCredentials(recovered);
      setStatus(null);
      setActivity("recovering");
      setError(null);
      setFragmentChecked(true);
      try {
        const recoveredStatus = await readEncryptedWatch({
          credentials: recovered,
          accessToken: accessTokenRef.current,
          resolveApiUrl: scannerApiUrl,
          signal: controller.signal
        });
        if (!cancelled) {
          pendingCreationRef.current = null;
          setStatus(recoveredStatus);
        }
      } catch (readError) {
        if (!cancelled) setError(errorMessage(readError));
      } finally {
        if (!cancelled) setActivity(null);
        if (requestControllerRef.current === controller) requestControllerRef.current = null;
      }
    }

    void recoverFromFragment();
    window.addEventListener("hashchange", recoverFromFragment);
    return () => {
      cancelled = true;
      fragmentRecoverySequenceRef.current += 1;
      window.removeEventListener("hashchange", recoverFromFragment);
    };
  }, []);

  // Creation is capability-gated, but a valid fragment remains manageable
  // during rollback because GET/delete are deliberately rollback-safe.
  if (!fragmentChecked) return null;
  if (!scheduledRescanPanelVisible(action, credentials !== null, invalidManagementFragment)) return null;

  function retainPendingCreation(nextCreation: PendingScheduledRescanCreation): void {
    if (typeof window === "undefined") {
      throw new Error("The scheduled rescan management link could not be prepared.");
    }
    const managementUrl = encryptedWatchManagementUrl(window.location.href, nextCreation.credentials);
    window.history.replaceState(window.history.state, "", managementUrl);
    pendingCreationRef.current = nextCreation;
    retainedCredentialsRef.current = nextCreation.credentials;
    setCredentials(nextCreation.credentials);
  }

  async function createSchedule() {
    const pendingCreation = pendingCreationRef.current;
    if (
      action.visibility !== "ready" ||
      createInFlightRef.current ||
      (credentials !== null && !scheduledRescanCanRetryCreation(pendingCreation, credentials)) ||
      (!pendingCreation && !normalizedTarget)
    ) {
      return;
    }
    const accessToken = scannerRequiresAccessKey ? form.accessKey.trim() : undefined;
    if (accessToken && (accessToken.length > 4_096 || /[\r\n]/.test(accessToken))) {
      setError("The scanner access key is invalid.");
      return;
    }
    const createTurnstileToken = turnstileRequired ? turnstileToken.trim() : undefined;
    if (
      createTurnstileToken !== undefined &&
      (!createTurnstileToken ||
        createTurnstileToken.length > 4_096 ||
        /[\u0000-\u001f\u007f]/.test(createTurnstileToken))
    ) {
      setError("Complete the Turnstile check before scheduling.");
      return;
    }

    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    createInFlightRef.current = true;
    onCreateBusyChange(true);
    setActivity("creating");
    setError(null);
    if (!pendingCreation && normalizedTarget) {
      onTargetNormalized(normalizedTarget.url, normalizedTarget.removedPrivateParts);
    }
    let creationHelperInvoked = false;
    try {
      const candidatePayload: EncryptedWatchPayload = pendingCreation?.payload ?? {
        version: 1,
        target: { url: normalizedTarget!.url },
        options: {
          device: form.device,
          gpcEnabled: form.gpcEnabled,
          reportMode: "r2",
          comparison: "none"
        }
      };
      const creation = await retainScheduledRescanCreationBeforePost({
        pendingCreation,
        candidatePayload,
        mintCredentials: mintEncryptedWatchCredentials,
        retainCreation: retainPendingCreation
      });
      // Inputs have passed the client contract at this point, so invoking the
      // helper is the exact network-attempt boundary for one-shot Turnstile.
      creationHelperInvoked = true;
      const created = await createEncryptedWatch({
        payload: creation.payload,
        accessToken,
        turnstileToken: createTurnstileToken,
        credentials: creation.credentials,
        onCredentialsReady: (readyCredentials) => {
          if (!sameWatchCredentials(retainedCredentialsRef.current, readyCredentials)) {
            throw new Error("The scheduled rescan capability changed before creation.");
          }
        },
        resolveApiUrl: scannerApiUrl,
        signal: controller.signal
      });
      pendingCreationRef.current = null;
      retainedCredentialsRef.current = created.credentials;
      setCredentials(created.credentials);
      setStatus(created.status);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      if (creationHelperInvoked) onCreateNetworkAttemptSettled();
      createInFlightRef.current = false;
      onCreateBusyChange(false);
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setActivity(null);
    }
  }

  async function refreshSchedule() {
    if (!credentials || activity) return;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setActivity("refreshing");
    setError(null);
    try {
      const refreshedStatus = await readEncryptedWatch({
        credentials,
        accessToken: scannerRequiresAccessKey ? form.accessKey.trim() : undefined,
        resolveApiUrl: scannerApiUrl,
        signal: controller.signal
      });
      pendingCreationRef.current = null;
      setStatus(refreshedStatus);
    } catch (readError) {
      setError(errorMessage(readError));
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setActivity(null);
    }
  }

  async function deleteSchedule() {
    if (!credentials || activity) return;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setActivity("deleting");
    setError(null);
    try {
      await deleteEncryptedWatch({
        credentials,
        accessToken: scannerRequiresAccessKey ? form.accessKey.trim() : undefined,
        resolveApiUrl: scannerApiUrl,
        signal: controller.signal
      });
      clearManagementFragment(credentials);
      pendingCreationRef.current = null;
      retainedCredentialsRef.current = null;
      setCredentials(null);
      setStatus(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setActivity(null);
    }
  }

  function removeInvalidManagementLink(): void {
    if (typeof window === "undefined" || !window.location.hash.startsWith("#watch=")) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.href);
    setInvalidManagementFragment(false);
    setError(null);
  }

  return (
    <section className="scan-panel scheduled-rescan-panel" aria-labelledby="scheduled-rescan-title">
      <div className="scheduled-rescan-heading">
        <CalendarClock size={20} aria-hidden="true" />
        <div>
          <p className="eyebrow">Optional retention</p>
          <h2 id="scheduled-rescan-title">
            {credentials || invalidManagementFragment ? "Manage scheduled rescan" : "Schedule weekly rescans"}
          </h2>
        </div>
      </div>
      <p>{SCHEDULED_RESCAN_POLICY_COPY}</p>
      <p className="scheduled-rescan-boundary">
        <strong>{SCHEDULED_RESCAN_BOUNDARY_COPY}</strong> Each run is independent evidence, and ordinary report retention still applies.
      </p>

      {invalidManagementFragment ? (
        <div className="scheduled-rescan-status">
          <p role="alert"><strong>This scheduled rescan management link is invalid.</strong></p>
          <p className="scheduled-rescan-private-note">{SCHEDULED_RESCAN_INVALID_LINK_COPY}</p>
          <div className="scheduled-rescan-actions">
            <button className="ghost-button" type="button" onClick={removeInvalidManagementLink}>
              Remove invalid management link
            </button>
          </div>
        </div>
      ) : credentials ? (
        <div className="scheduled-rescan-status" role="status" aria-live="polite">
          {status ? (
            <>
              <p>
                <strong>{status.state === "completed" ? "Schedule completed." : "Schedule active."}</strong>{" "}
                {status.attemptCount} of {status.maxAttempts} scheduled {status.attemptCount === 1 ? "attempt" : "attempts"} used.
              </p>
              <dl>
                <div>
                  <dt>Next run</dt>
                  <dd>{status.nextRunAt === null ? "No more runs" : formatWatchTime(status.nextRunAt)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{formatWatchTime(status.expiresAt)}</dd>
                </div>
              </dl>
              <div className="scheduled-rescan-runs">
                <h3>Attempt history</h3>
                <p>Saved report links follow ordinary retention and may expire.</p>
                <ol>
                  {status.runs.map((run) => {
                    const presentation = scheduledRescanRunPresentation(run);
                    return (
                      <li key={run.sequence}>
                        <span>
                          Attempt {run.sequence}: <strong>{presentation.label}</strong>
                        </span>
                        {presentation.reportId && (
                          <a
                            href={scannerApiUrl(`/reports/${presentation.reportId}`)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open report if retained
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </>
          ) : (
            <p>
              {activity === "recovering"
                ? "Recovering schedule status…"
                : activity === "creating"
                  ? "Creating schedule…"
                  : "Schedule status is unavailable."}
            </p>
          )}
          <p className="scheduled-rescan-private-note">{SCHEDULED_RESCAN_CAPABILITY_COPY}</p>
          {!status && enabled && canRetryCreation && (
            <p className="scanner-status-note">{SCHEDULED_RESCAN_RETRY_COPY}</p>
          )}
          <div className="scheduled-rescan-actions">
            {!status && enabled && canRetryCreation && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void createSchedule()}
                disabled={activity !== null || action.visibility !== "ready"}
              >
                {activity === "creating" ? (
                  <Loader2 className="spin" size={16} aria-hidden="true" />
                ) : (
                  <CalendarClock size={16} aria-hidden="true" />
                )}
                {activity === "creating" ? "Scheduling…" : "Retry scheduling"}
              </button>
            )}
            <button className="secondary-button" type="button" onClick={() => void refreshSchedule()} disabled={activity !== null}>
              {activity === "refreshing" || activity === "recovering" ? (
                <Loader2 className="spin" size={16} aria-hidden="true" />
              ) : (
                <RefreshCw size={16} aria-hidden="true" />
              )}
              Refresh status
            </button>
            <button className="ghost-button" type="button" onClick={() => void deleteSchedule()} disabled={activity !== null}>
              {activity === "deleting" ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
              {activity === "deleting" ? "Deleting…" : "Delete schedule"}
            </button>
          </div>
        </div>
      ) : (
        <div className="scheduled-rescan-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void createSchedule()}
            disabled={action.visibility !== "ready"}
          >
            {activity === "creating" ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <CalendarClock size={16} aria-hidden="true" />}
            {activity === "creating" ? "Scheduling…" : "Schedule weekly rescans"}
          </button>
          {action.visibility === "disabled" && <span className="scanner-status-note">{action.reason}</span>}
        </div>
      )}

      {error && <p className="scanner-status-note scanner-status-note-error" role="alert">{error}</p>}
    </section>
  );
}

function sameWatchCredentials(
  left: EncryptedWatchCredentials | null,
  right: EncryptedWatchCredentials
): boolean {
  return left?.watchId === right.watchId && left.capabilityToken === right.capabilityToken;
}

function formatWatchTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function clearManagementFragment(credentials: EncryptedWatchCredentials): void {
  if (typeof window === "undefined") return;
  const current = parseEncryptedWatchCredentialsFromUrl(window.location.href);
  if (
    !current ||
    current.watchId !== credentials.watchId ||
    current.capabilityToken !== credentials.capabilityToken
  ) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.href);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The scheduled rescan request failed.";
}
