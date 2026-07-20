"use client";

import { AlertTriangle } from "lucide-react";

export function ScanRecoveryBanner({
  error,
  acceptedJob,
  loading,
  cancelling,
  cancellationError,
  onResume,
  onCancel
}: {
  error: string | null;
  acceptedJob: boolean;
  loading: boolean;
  cancelling: boolean;
  cancellationError: string | null;
  onResume: () => void;
  onCancel: () => void;
}) {
  if (!error) return null;

  return (
    <section className="error-banner" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="error-banner-copy">
        <span>{error}</span>
        {acceptedJob && !loading && (
          <div className="scan-recovery-controls">
            <p>The accepted job is retained; you can safely resume status checks or cancel it.</p>
            <div className="scan-recovery-actions">
              <button className="secondary-button" type="button" onClick={onResume}>
                Resume status checks
              </button>
              <button className="ghost-button" type="button" onClick={onCancel} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel scan"}
              </button>
            </div>
            {cancellationError && <p>{cancellationError} The accepted job is still retained.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
