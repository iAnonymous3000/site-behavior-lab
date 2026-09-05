"use client";

import type { Ref } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

export function ScanRecoveryBanner({
  bannerRef,
  error,
  notice,
  acceptedJob,
  pendingAdmission,
  recoveringAdmission,
  loading,
  cancelling,
  cancellationError,
  onResume,
  onCheckAdmission,
  onCancel,
  onDismiss
}: {
  bannerRef?: Ref<HTMLElement>;
  error: string | null;
  notice: string | null;
  acceptedJob: boolean;
  pendingAdmission: boolean;
  recoveringAdmission: boolean;
  loading: boolean;
  cancelling: boolean;
  cancellationError: string | null;
  onResume: () => void;
  onCheckAdmission: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!error && !notice && !pendingAdmission && !cancelling && !cancellationError) return null;

  // Only a failure earns an assertive interruption and the warning styling. Progress
  // states ("checking admission", "cancelling") and completed actions the visitor
  // asked for are routine, so they announce politely in the neutral tone.
  const failed = Boolean(error ?? cancellationError);
  const settled = Boolean(notice) && !failed;

  return (
    <section
      className={failed ? "error-banner" : "error-banner error-banner-progress"}
      ref={bannerRef}
      role={failed ? "alert" : "status"}
      tabIndex={-1}
    >
      {failed ? (
        <AlertTriangle size={18} aria-hidden="true" />
      ) : settled ? (
        <CheckCircle2 size={18} aria-hidden="true" />
      ) : (
        <Loader2 className="spin" size={18} aria-hidden="true" />
      )}
      <div className="error-banner-copy">
        <span>
          {error ??
            notice ??
            (pendingAdmission
              ? "Checking whether the previous scan request was accepted…"
              : cancelling
                ? "Cancelling the accepted scan…"
                : "The cancellation request did not finish.")}
        </span>
        {(settled || (failed && !cancelling)) && !acceptedJob && !pendingAdmission && (
          <div className="scan-recovery-controls">
            <div className="scan-recovery-actions">
              <button className="ghost-button" type="button" onClick={onDismiss}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {pendingAdmission && !acceptedJob && (
          <div className="scan-recovery-controls">
            <p>
              This tab retained only an opaque, request-bound recovery capability. Check admission without
              resubmitting work, or re-enter the exact original URL and options and press Scan for an idempotent retry.
              Changed request semantics are rejected before any network request.
            </p>
            <div className="scan-recovery-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={onCheckAdmission}
                disabled={recoveringAdmission || loading}
              >
                {recoveringAdmission ? "Checking admission…" : "Check admission"}
              </button>
            </div>
          </div>
        )}
        {acceptedJob && !loading && (
          <div className="scan-recovery-controls">
            <p>
              This tab retained the scan reference. Resume status checks to look for its outcome, cancel the scan, or dismiss this tab&rsquo;s recovery record.
            </p>
            <div className="scan-recovery-actions">
              <button className="secondary-button" type="button" onClick={onResume} disabled={cancelling}>
                Resume status checks
              </button>
              <button className="ghost-button" type="button" onClick={onCancel} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel scan"}
              </button>
              <button className="ghost-button" type="button" onClick={onDismiss} disabled={cancelling}>
                Dismiss recovery
              </button>
            </div>
            {cancellationError && <p>{cancellationError} The accepted job is still retained.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
