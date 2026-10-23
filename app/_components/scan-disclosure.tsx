import {
  SCAN_DISCLOSURE,
  SCAN_DISCLOSURE_VISIT,
  SCAN_DISCLOSURE_VISIT_REST,
  SCROLL_CHECK_DISCLOSURE_VISIT
} from "@/lib/scan-disclosure";

/**
 * What a scan does to the page, under the URL field.
 *
 * A server component on purpose: the homepage's server page renders it and
 * hands the element to the client scan form, so the copy travels as HTML and
 * flight data and never as homepage JavaScript, which runs within a few
 * kilobytes of its budget. No "use client" module may import this file;
 * lib/scan-disclosure.test.ts walks the client import graph to hold that.
 *
 * The first sentence comes in two forms: a single scan's, and a check's,
 * which the form shows instead while a "Check after scrolling" arrival holds
 * (the form's data-scroll-check state, app/globals.css). Every other
 * sentence is the same for both.
 */
export function ScanDisclosure() {
  const [, ...others] = SCAN_DISCLOSURE;
  return (
    <div className="scan-disclosure" id="scan-disclosure">
      <p>
        <span className="scan-disclosure-visit">{SCAN_DISCLOSURE_VISIT}</span>
        <span className="scan-disclosure-check-visit">{SCROLL_CHECK_DISCLOSURE_VISIT}</span>{" "}
        {SCAN_DISCLOSURE_VISIT_REST}
      </p>
      {others.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  );
}
