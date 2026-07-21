"use client";

import { AlertTriangle } from "lucide-react";

export function ScanRecoveryBanner({
  error,
  acceptedJob,
  loading,
  cancelling,
  cancellationError,
  onResume,
  onCancel,
  onDismiss
}: {
  error: string | null;
  acceptedJob: boolean;
  loading: boolean;
  cancelling: boolean;
  cancellationError: string | null;
  onResume: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!error && !cancelling && !cancellationError) return null;

  return (
    <section className="error-banner" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="error-banner-copy">
        <span>{error ?? (cancelling ? "Cancelling the accepted scan…" : "The cancellation request did not finish.")}</span>
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
