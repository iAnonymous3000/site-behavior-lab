"use client";

import { useEffect, useRef, useState } from "react";

export type ReportSection = { id: string; label: string };

/**
 * Wayfinding for the evidence explorer.
 *
 * An opened report is around six thousand pixels of continuous scroll -- the
 * findings board, a comparison panel, metric tiles, a request timeline, visit
 * phases, the measurement limits, five rail cards, a domain table and a request
 * log -- and it had no navigation of any kind. Reaching the cookie evidence or
 * the request log meant scrolling past everything before it and recognising it
 * on the way past, every time.
 *
 * Deliberately plain anchors. They work before hydration, they survive being
 * copied out of the address bar, and a reader with JavaScript disabled gets a
 * working table of contents rather than a row of dead buttons. The observer
 * only adds `aria-current` to whichever section is on screen.
 */
export function ReportSectionNav({ sections }: { sections: ReportSection[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which sections this report actually rendered. Several explorer sections
  // return null on their own internal evidence check -- the attribution map when
  // provenance produces no edges, visit phases when the run records none --
  // and no predicate the caller can write outside those components is exactly
  // equal to their guard. Rather than approximate them and risk an anchor that
  // scrolls nowhere, the nav asks the document. Starts as everything so the
  // pre-hydration markup is a complete table of contents, then drops whatever
  // is not there.
  const [missing, setMissing] = useState<readonly string[]>([]);
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMissing(sections.filter((section) => !document.getElementById(section.id)).map((s) => s.id));
  }, [sections]);

  const present = sections.filter((section) => !missing.includes(section.id));

  useEffect(() => {
    if (sections.length === 0) return;
    // Reduced-motion readers get an instant jump from the browser's default
    // anchor behaviour; nothing here animates.
    const targets = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null);
    if (targets.length === 0) return;

    // Track every section's intersection state rather than reacting to one
    // entry at a time: a fast scroll can deliver several entries in one
    // callback, and the last one in the batch is not necessarily the topmost
    // section on screen.
    const onScreen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target.id);
          else onScreen.delete(entry.target.id);
        }
        const topmost = targets.find((target) => onScreen.has(target.id));
        // No section intersecting means the reader is between two of them
        // (a tall table, say). Keeping the last mark beats clearing it and
        // leaving the nav with nothing current.
        if (topmost) setActiveId(topmost.id);
      },
      // The band is the top third of the viewport, under the sticky chrome, so
      // "current" means the section a reader is actually reading rather than
      // whichever one happens to touch the bottom edge.
      { rootMargin: "-96px 0px -67% 0px", threshold: 0 }
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [sections]);

  // Keep the marked link in view in the horizontally scrolling nav, so the
  // reader can see where they are without dragging the strip.
  useEffect(() => {
    if (!activeId || !navRef.current) return;
    const link = navRef.current.querySelector<HTMLElement>(`[href="#${CSS.escape(activeId)}"]`);
    link?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  if (present.length === 0) return null;

  return (
    <nav className="report-section-nav" aria-label="Report sections" ref={navRef}>
      <ul>
        {present.map((section) => (
          <li key={section.id}>
            <a aria-current={section.id === activeId ? "true" : undefined} href={`#${section.id}`}>
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
