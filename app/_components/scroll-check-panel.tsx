"use client";

import { useEffect, useRef } from "react";
import { EARLIER_RESULT_LINK } from "@/lib/finding-look-closer";
import { scrollCheckPanelCopy, type ScrollCheckWindowCopy } from "@/lib/scroll-check-copy";
import type { ScrollCheckEvidence } from "@/lib/scroll-check-evidence";

/**
 * Checks whose panel has already been brought into view, so a re-render or a
 * remount while the reader works through the result never pulls them back to
 * its top.
 */
const shownOnArrival = new WeakSet<ScrollCheckEvidence>();

/** One window's line, its hosts by site, and what it counted and did not list. */
function ScrollCheckWindowLines({ copy, id }: { copy: ScrollCheckWindowCopy; id: string }) {
  return (
    <>
      <p id={id}>{copy.line}</p>
      {copy.sites.length > 0 && (
        <ul className="scroll-check-hosts" aria-labelledby={id}>
          {copy.sites.map((site) => (
            <li key={site}>{site}</li>
          ))}
        </ul>
      )}
      {copy.notListed && <p>{copy.notListed}</p>}
      {copy.further && <p>{copy.further}</p>}
    </>
  );
}

/**
 * What a "Check after scrolling" visit recorded, at the top of that visit's
 * own result on the homepage: the third-party hosts its page first contacted
 * in 10 seconds without input, then while the visit scrolled, how the check
 * ended, and what it cannot tell. It renders only from the result the tab's
 * own submit received, never on a resume, a restore, a reload, a share
 * permalink, an export or paper, and it claims nothing about the report the
 * visitor came from.
 */
export function ScrollCheckPanel({
  evidence,
  earlierResultHref
}: {
  evidence: ScrollCheckEvidence;
  /** The earlier result's share permalink, when the check's link named one this runtime can open. */
  earlierResultHref: string | null;
}) {
  const copy = scrollCheckPanelCopy(evidence);
  const panelRef = useRef<HTMLElement | null>(null);
  // As for an inspection (connection-inspection-panel.tsx): once per check, a
  // frame after the result region takes focus, the panel's top is brought
  // just below the sticky strips, so a check that replaces an earlier result
  // at phone width arrives with its answer on screen. Focus stays where it is.
  useEffect(() => {
    if (shownOnArrival.has(evidence)) return;
    const frame = window.requestAnimationFrame(() => {
      shownOnArrival.add(evidence);
      panelRef.current?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [evidence]);
  return (
    <section className="scroll-check" id="scroll-check" ref={panelRef} aria-labelledby="scroll-check-heading">
      <h2 id="scroll-check-heading">{copy.heading}</h2>
      {copy.control && <ScrollCheckWindowLines copy={copy.control} id="scroll-check-control" />}
      {copy.scroll && <ScrollCheckWindowLines copy={copy.scroll} id="scroll-check-scroll" />}
      {copy.traffic && <p>{copy.traffic}</p>}
      <p className="scroll-check-outcome">{copy.outcome}</p>
      {copy.addressChanged && <p>{copy.addressChanged}</p>}
      {copy.incomplete.map((line) => (
        <p className="scroll-check-caveat" key={line}>{line}</p>
      ))}
      {copy.caveats.map((line) => (
        <p className="scroll-check-caveat" key={line}>{line}</p>
      ))}
      <p className="scroll-check-caveat">{copy.notSaved}</p>
      <p className="scroll-check-separation" id="scroll-check-separation">
        {copy.separation}
      </p>
      {earlierResultHref && (
        <a className="earlier-result-link" href={earlierResultHref} aria-describedby="scroll-check-separation">
          {EARLIER_RESULT_LINK.label}
        </a>
      )}
    </section>
  );
}
