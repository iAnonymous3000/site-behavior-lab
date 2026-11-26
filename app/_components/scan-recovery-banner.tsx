"use client";

import type { Ref } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

export function ScanRecoveryBanner({
  bannerRef,
  error,
  notice,
  onDismiss
}: {
  bannerRef?: Ref<HTMLElement>;
  error: string | null;
  notice: string | null;
  onDismiss: () => void;
}) {
  if (!error && !notice) return null;

  // Only a failure earns an assertive interruption and the warning styling. Completed
  // actions the visitor asked for (such as cancelling a scan) announce politely.
  const failed = Boolean(error);
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
      ) : (
        <CheckCircle2 size={18} aria-hidden="true" />
      )}
      <div className="error-banner-copy">
        <span>{error ?? notice}</span>
        {(settled || failed) && (
          <div className="scan-recovery-controls">
            <div className="scan-recovery-actions">
              <button className="ghost-button" type="button" onClick={onDismiss}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
