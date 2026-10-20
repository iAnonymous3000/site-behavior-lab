import { SCAN_DISCLOSURE } from "@/lib/scan-disclosure";

/**
 * What a scan does to the page, under the URL field.
 *
 * A server component on purpose: the homepage's server page renders it and
 * hands the element to the client scan form, so the copy travels as HTML and
 * flight data and never as homepage JavaScript, which runs within a few
 * kilobytes of its budget. No "use client" module may import this file;
 * lib/scan-disclosure.test.ts walks the client import graph to hold that.
 */
export function ScanDisclosure() {
  return (
    <div className="scan-disclosure" id="scan-disclosure">
      {SCAN_DISCLOSURE.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  );
}
