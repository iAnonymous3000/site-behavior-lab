import {
  buildEvidenceHash,
  findingCardDomId,
  type EvidenceArm,
  type EvidenceTarget
} from "./report-evidence-navigation";
import type { Finding } from "./report-findings";
import type { ComparisonRunMode } from "./run-mode-copy";
import { scanPrefillHref } from "./scan-prefill";

/**
 * "Look closer": one follow-up per findings card, a VIEW that opens recorded
 * rows, another card, or the site's history, and establishes nothing new
 * (journey audit gap 6, the next-step half). These are batch 1 of the owner's
 * approved draft, the reader-only views; a follow-up that starts a new visit
 * needs a scan-prefill change first and is not here.
 *
 * The rules, all binding:
 * - Keyed by card id and variant, never by level. The variant is the branch
 *   buildFindings took when it wrote the card, recorded on the card at that
 *   branch (Finding.lookCloser), so a severity decision moves no view. Nothing
 *   here reads a level or a title.
 * - At most one view per card: a card carries one key.
 * - A label of at most five words, then one sentence of at most 30 words that
 *   says what the link does. Host and vendor views over-match by design (the
 *   request log's free-text filter ORs one needle across eight row fields), so
 *   their sentences say "filtered to", never "the requests that carried".
 * - Never printed: the printable route and the PDF render no view, and a
 *   printed permalink hides the block (the print hide group in
 *   app/globals.css).
 * - None on the bottom line: it summarizes the cards, and nothing may sit
 *   between it and the visit summary.
 * - A view on a comparison carries the board's arm, as findingEvidenceLink
 *   does; the Reject-all and GPC views pin the visit they name.
 *
 * React-free and free of the scan form, so the permalink builds it on the
 * server and the explorer in its lazy chunk (lib/client-boundary.test.ts).
 *
 * A card may also offer one NEW VISIT (batch 2 of the draft, below): a link
 * that opens the scan form filled with the page and the comparison to run,
 * which never starts anything on its own. The same rules hold, but its
 * result is a separate pair of visits, so it can neither confirm nor refute
 * the card that offered it.
 */

/** What the group is called wherever a card renders its view. */
export const LOOK_CLOSER_NAME = "Look closer";

/**
 * The branch a card was written from, and the recorded host or name its view
 * filters to, already in the reader's form (displayHost: `*` for a hidden
 * label, never a sanitizer token).
 */
export type LookCloserKey =
  /** keystroke-exfiltration: the first recorded recipient. */
  | { variant: "keystroke-recipient"; host: string }
  /** consent-banner: tracking-related services before any choice. */
  | { variant: "consent-banner-catalog-matches" }
  /** consent-banner: a named consent platform, and no tracking-related service. */
  | { variant: "consent-banner-platform"; host: string }
  /** session-recording-input-monitoring, with the typing test's card on the board. */
  | { variant: "listener-typing-test" }
  /** session-recording-input-monitoring: a catalogued session-replay vendor. */
  | { variant: "listener-replay-vendor"; vendor: string }
  /** session-recording-input-monitoring: a listener script origin only. */
  | { variant: "listener-script-origin"; host: string }
  /** privacy-policy: tracking companies the policy does not appear to name. */
  | { variant: "policy-unnamed-companies" }
  /** consent-comparison: tracking-related services in the visit that clicked Reject all. */
  | { variant: "reject-all-visit-matches" }
  /** gpc-comparison: a conclusive pair whose tracker classification is comparable. */
  | { variant: "gpc-visit-matches" }
  /** third-party-cookies: present. */
  | { variant: "cookie-history" };

export type LookCloserVariant = LookCloserKey["variant"];

/** The card each variant belongs to. A key on any other card offers nothing. */
export const LOOK_CLOSER_CARD: Readonly<Record<LookCloserVariant, string>> = {
  "keystroke-recipient": "keystroke-exfiltration",
  "consent-banner-catalog-matches": "consent-banner",
  "consent-banner-platform": "consent-banner",
  "listener-typing-test": "session-recording-input-monitoring",
  "listener-replay-vendor": "session-recording-input-monitoring",
  "listener-script-origin": "session-recording-input-monitoring",
  "policy-unnamed-companies": "privacy-policy",
  "reject-all-visit-matches": "consent-comparison",
  "gpc-visit-matches": "gpc-comparison",
  "cookie-history": "third-party-cookies"
};

export type LookCloserContext = {
  /** The board's comparison arm (renderedEvidenceArm), which in-report views carry. */
  arm: EvidenceArm | undefined;
  /**
   * This site's history page at its report table, built on the server for a
   * committed report whose site lists at least one other retained report
   * (lib/report-site-history.ts), and handed unchanged to the explorer. Null
   * for a share, a homepage result, or a site with no other report.
   */
  siteHistoryHref: string | null;
};

export type FindingLookCloser = {
  variant: LookCloserVariant;
  label: string;
  /** One sentence, shown with the link, saying what the link does. */
  sentence: string;
  href: string;
};

/**
 * The card's view, or null when its branch offers none or what the view needs
 * is absent: the typing test's card is not on the board, or the report has no
 * site history to open.
 */
export function findingLookCloser(
  finding: Pick<Finding, "id" | "lookCloser">,
  board: readonly Pick<Finding, "id">[],
  context: LookCloserContext
): FindingLookCloser | null {
  const key = finding.lookCloser;
  if (!key || LOOK_CLOSER_CARD[key.variant] !== finding.id) return null;
  const inThisVisit = (target: EvidenceTarget) =>
    buildEvidenceHash(context.arm ? { ...target, arm: context.arm } : target);
  const inTheVariantVisit = (target: EvidenceTarget) => buildEvidenceHash({ ...target, arm: "variant" });
  const view = (label: string, sentence: string, href: string): FindingLookCloser => ({
    variant: key.variant,
    label,
    sentence,
    href
  });

  switch (key.variant) {
    case "keystroke-recipient":
      return view(
        `Show requests to ${key.host}`,
        `Opens this report's request log filtered to ${key.host}, without marking which of those requests carried the test value.`,
        inThisVisit({ section: "requests", query: key.host })
      );
    case "consent-banner-catalog-matches":
      return view(
        "Show catalog-matched requests",
        "Opens the request log at its catalog-matched rows, which include requests to the tracking-related services counted here; this visit never clicked the banner.",
        inThisVisit({ section: "requests", signal: "known-service" })
      );
    case "consent-banner-platform":
      return view(
        `Show requests to ${key.host}`,
        `Opens this report's request log filtered to ${key.host}, the consent platform's address.`,
        inThisVisit({ section: "requests", query: key.host })
      );
    case "listener-typing-test": {
      const typingCard = "keystroke-exfiltration";
      return board.some((card) => card.id === typingCard)
        ? view(
            "See the typing test result",
            "Moves to the card where this visit's typing test found its made-up value in a cross-site request.",
            `#${findingCardDomId(typingCard)}`
          )
        : null;
    }
    case "listener-replay-vendor":
      return view(
        `Show requests to ${key.vendor}`,
        `Opens this report's request log filtered to ${key.vendor}; listener registrations are not request rows, so the log cannot show what was observed.`,
        inThisVisit({ section: "requests", query: key.vendor })
      );
    case "listener-script-origin":
      return view(
        `Show requests involving ${key.host}`,
        `Opens this report's request log filtered to ${key.host}, a script origin recorded in the listener's call chain.`,
        inThisVisit({ section: "requests", query: key.host })
      );
    case "policy-unnamed-companies":
      return view(
        "Show catalog-matched requests",
        "Opens the request log at its catalog-matched rows, which include the requests to the companies this card names.",
        inThisVisit({ section: "requests", signal: "known-service" })
      );
    case "reject-all-visit-matches":
      return view(
        "Show the Reject-all visit's matches",
        "Opens the request log for the visit that clicked Reject all, at its catalog-matched rows, which can include requests made before the click.",
        inTheVariantVisit({ section: "requests", signal: "known-service" })
      );
    case "gpc-visit-matches":
      return view(
        "Show the GPC visit's matches",
        "Opens the request log for the visit configured with the GPC signal, at its catalog-matched rows.",
        inTheVariantVisit({ section: "requests", signal: "known-service" })
      );
    case "cookie-history":
      return context.siteHistoryHref
        ? view(
            "See other visits' cookie counts",
            "Opens this site's history page, which lists the third-party cookie count each of its retained reports recorded.",
            context.siteHistoryHref
          )
        : null;
  }
}

/**
 * The branch a card offers a new visit from. buildFindings records it at
 * that branch, and only where the draft's gates about the report and the
 * card's own visit pass (G1, G2, G3 and G5); whether the report is fresh, and
 * the page to visit again (G4), arrive in NewVisitContext. Only Blocker is
 * minted: the consent journey is parked, and GPC waits for its legal review
 * and the operator check.
 */
export type NewVisitKey =
  /** shields-blocked: requests matched Brave's lists on a normal, unblocked load. */
  { variant: "blocker-comparison" };

export type NewVisitVariant = NewVisitKey["variant"];

/** The card each new visit belongs to. A key on any other card offers nothing. */
export const NEW_VISIT_CARD: Readonly<Record<NewVisitVariant, string>> = {
  "blocker-comparison": "shields-blocked"
};

/** The comparison each new visit asks the scan form for. */
export const NEW_VISIT_MODE: Readonly<Record<NewVisitVariant, ComparisonRunMode>> = {
  "blocker-comparison": "shields"
};

export type NewVisitContext = {
  /**
   * The page a new visit would visit again (reportNewVisitTarget in
   * lib/report-rescan-targets.ts): a fresh result's rescan target, or null
   * for every report that is not fresh or fails G4. The permalink computes
   * it on the server and its explorer from the same view and freshness.
   */
  newVisitTarget: string | null;
  /**
   * The fresh result's share report id (reportNewVisitFrom), which the link
   * names so the comparison it opens can link back to this result; null
   * without one, and the link is then exactly the one it was.
   */
  newVisitFrom: string | null;
  /** The deployment's base path, which the scan form's address starts with. */
  basePath: string;
};

export type FindingNewVisit = {
  variant: NewVisitVariant;
  label: string;
  /** One sentence, shown with the link, saying what the link does. */
  sentence: string;
  href: string;
};

/**
 * The card's new visit, or null when its branch offers none or the report
 * has no page to visit again. The link fills the scan form through the
 * fragment prefill, address and mode both, and names this result's share
 * when it has one; the form submits nothing.
 */
export function findingNewVisit(
  finding: Pick<Finding, "id" | "newVisit">,
  context: NewVisitContext
): FindingNewVisit | null {
  const key = finding.newVisit;
  if (!key || NEW_VISIT_CARD[key.variant] !== finding.id || !context.newVisitTarget) return null;
  const prefill = scanPrefillHref(context.newVisitTarget, NEW_VISIT_MODE[key.variant], context.newVisitFrom);
  if (!prefill) return null;
  switch (key.variant) {
    case "blocker-comparison":
      return {
        variant: key.variant,
        label: "Compare with blocking on",
        sentence:
          "Opens the scan form ready to visit this page twice, once simulating Brave's default filter-list blocking; nothing runs until you press Compare.",
        href: `${context.basePath}${prefill}`
      };
  }
}
