"use client";

import { useCallback, useEffect, useState } from "react";
import {
  freshnessExpiryDelayMs,
  freshnessState,
  PUBLIC_STATUS_UI_REFRESH_MS,
  type FreshnessState
} from "@/lib/public-status";

export function StatusFreshness({ timestamp, maxAgeMs, verified = true }: { timestamp: string | null; maxAgeMs: number; verified?: boolean }) {
  const [state, setState] = useState<FreshnessState>("unknown");
  const refresh = useCallback(() => setState(verified ? freshnessState(timestamp, maxAgeMs) : "unknown"), [maxAgeMs, timestamp, verified]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, PUBLIC_STATUS_UI_REFRESH_MS);
    const expiryDelay = freshnessExpiryDelayMs(timestamp, maxAgeMs);
    const expiry = expiryDelay === null ? null : window.setTimeout(refresh, expiryDelay);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      if (expiry !== null) window.clearTimeout(expiry);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [maxAgeMs, refresh, timestamp]);

  return <StatusBadge state={state} />;
}

function StatusBadge({ state }: { state: FreshnessState }) {
  const label = state === "current" ? "Current" : state === "stale" ? "Stale" : "Unknown";
  return <span className={`status-badge state-${state}`}>{label}</span>;
}
