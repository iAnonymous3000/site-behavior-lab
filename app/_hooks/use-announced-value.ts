"use client";

import { useEffect, useState } from "react";

/**
 * The screen-reader copy of a value that changes on every keystroke.
 *
 * Polite live-region announcements queue rather than replace, so announcing a
 * result count live turned an eight-character search into eight announcements
 * still playing after typing stopped. Sighted users keep the instant value;
 * the announced copy waits for a pause.
 *
 * One hook because this was implemented twice: the gallery search carried the
 * original and the catalog search a hand copy, which is the two-copies drift
 * this repo keeps refusing. Render the return value inside the live region and
 * the instant value outside it.
 */
export function useAnnouncedValue(value: string, delayMs = 600): string {
  const [announced, setAnnounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return announced;
}
