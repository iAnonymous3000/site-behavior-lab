import { parseEvidenceHash, type EvidenceTarget } from "./report-evidence-navigation";

/*
 * A module of its own, so that only the report page's client and the lazy
 * renderer carry it: lib/report-evidence-navigation.ts is in the homepage's
 * initial script, and these lines measured 27 gzip bytes there.
 */

/** How many of a finding's matching rows open under its claim. */
export const CLAIM_ROWS_SHOWN = 8;

/**
 * The finding evidence link a click landed on, when that link's target is the
 * request log: the control that opens the claim's rows in place. Null for any
 * other click, including a Look closer view (its sentence says it opens the
 * log) and the link from a claim's rows to the full log.
 */
export function claimRowsLink(
  clicked: EventTarget | null
): { anchor: HTMLAnchorElement; target: EvidenceTarget } | null {
  if (!(clicked instanceof Element)) return null;
  const anchor = clicked.closest<HTMLAnchorElement>('.finding-meta > a[href^="#evidence="]');
  if (!anchor) return null;
  const target = parseEvidenceHash(anchor.getAttribute("href") ?? "");
  return target?.section === "requests" ? { anchor, target } : null;
}

