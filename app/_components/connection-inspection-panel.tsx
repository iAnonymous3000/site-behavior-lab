"use client";

import { useEffect, useRef } from "react";
import type { ConnectionInspectionEvidence } from "@/lib/connection-inspection-evidence";
import { inspectionPanelCopy } from "@/lib/connection-inspection-copy";
import { EARLIER_RESULT_LINK } from "@/lib/finding-look-closer";

/**
 * Inspections whose panel has already been brought into view, so a re-render
 * or a remount while the reader works through the result never pulls them
 * back to its top.
 */
const shownOnArrival = new WeakSet<ConnectionInspectionEvidence>();

/**
 * What an "Inspect this connection" visit recorded, at the top of that
 * visit's own result on the homepage: which scripts were on the call stack
 * of its requests to the address, group by group, or that it made none. It
 * renders only from the result the tab's own submit received, never on a
 * resume, a restore, a reload, a share permalink, an export or paper, and it
 * claims nothing about the report the visitor came from.
 */
export function ConnectionInspectionPanel({
  evidence,
  earlierResultHref
}: {
  evidence: ConnectionInspectionEvidence;
  /** The earlier result's share permalink, when the inspection's link named one this runtime can open. */
  earlierResultHref: string | null;
}) {
  const copy = inspectionPanelCopy(evidence);
  const panelRef = useRef<HTMLElement | null>(null);
  // The result region takes focus when a result arrives
  // (app/site-behavior-app.tsx), and focus scrolls only when none of that
  // region is on screen, so an inspection that replaces an earlier result at
  // phone width arrives with this panel, the answer the visit was for,
  // above the viewport or under the sticky strips. Once per inspection, a
  // frame after that focus, its top is brought just below the strips (the
  // anchor margin the shell gives every id). Focus stays where it is.
  useEffect(() => {
    if (shownOnArrival.has(evidence)) return;
    const frame = window.requestAnimationFrame(() => {
      shownOnArrival.add(evidence);
      panelRef.current?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [evidence]);
  return (
    <section
      className="connection-inspection"
      id="connection-inspection"
      ref={panelRef}
      aria-labelledby="connection-inspection-heading"
    >
      <h2 id="connection-inspection-heading">{copy.heading}</h2>
      {copy.didNotRecur !== null ? (
        <p className="connection-inspection-none">{copy.didNotRecur}</p>
      ) : (
        <ul className="connection-inspection-lines">
          {copy.lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {copy.caveat && <p className="connection-inspection-caveat">{copy.caveat}</p>}
      {copy.unobserved && <p className="connection-inspection-caveat">{copy.unobserved}</p>}
      <p className="connection-inspection-separation" id="connection-inspection-separation">
        {copy.separation}
      </p>
      {earlierResultHref && (
        <a className="earlier-result-link" href={earlierResultHref} aria-describedby="connection-inspection-separation">
          {EARLIER_RESULT_LINK.label}
        </a>
      )}
    </section>
  );
}
