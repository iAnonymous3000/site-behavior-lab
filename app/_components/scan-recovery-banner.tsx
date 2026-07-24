"use client";

import { AlertTriangle } from "lucide-react";

export function ScanRecoveryBanner({
  error,
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
  error: string | null;
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
  if (!error && !pendingAdmission && !cancelling && !cancellationError) return null;

  return (
    <section className="error-banner" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="error-banner-copy">
        <span>
          {error ??
            (pendingAdmission
              ? "Checking whether the previous scan request was accepted…"
              : cancelling
                ? "Cancelling the accepted scan…"
                : "The cancellation request did not finish.")}
        </span>
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
              The accepted job is retained; you can resume status checks, cancel it, or dismiss this tab&rsquo;s recovery record.
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
