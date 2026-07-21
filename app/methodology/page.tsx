import Link from "next/link";
import { publicPageMetadata } from "@/lib/seo-metadata";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Methodology",
  description:
    "How a Site Behavior Lab scan works: what the automated visit does, what is recorded, how comparisons are paired, what the Brave-list blocking simulation means, and what the reports can and cannot claim.",
  path: "/methodology/"
});

export default function MethodologyPage() {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Methodology</p>
        <h1>How a scan works</h1>
        <p>
          Scanner-generated reports contain one measured run per condition: one run for a single report and two for a
          comparison. Every number is an observation from those runs, not a general claim about the site. This page
          describes what a run does, what is recorded, and where the honest limits are. Terms are defined in the{" "}
          <Link href="/glossary/">glossary</Link>; how scan data is handled is on the{" "}
          <Link href="/privacy/">privacy page</Link>.
        </p>
        <p>
          A measured run is not a promise of exactly one network navigation. Consent verification may perform one
          disclosed post-choice reload; the input probe may navigate to a blank page at the end to flush unload
          beacons; and policy analysis may open one separate, SSRF-guarded policy page after the primary request log is
          frozen. Reload- and policy-phase traffic is excluded from the main request counts, while unload beacons sent
          by the measured page during the active input probe remain included.
        </p>
        <p>
          A local PageGraph import is the disclosed exception: it adapts a paired GraphML capture and metadata
          sidecar produced outside this service. That path records request evidence from a self-reported headful
          Brave Nightly crawl; cookie, storage, fingerprinting, detector, and consent evidence are explicitly marked
          unsupported rather than shown as observed zeroes. The GraphML binds its schema, root URL, capture date, and
          duration, while browser, environment, tool, sanitizer, and quality declarations come from the sidecar and
          are not cryptographically attested.
        </p>
        <p className="legal-back">
          <Link href="/">&larr; Back to Site Behavior Lab</Link>
        </p>
      </header>

      <section className="legal-section">
        <h2>The visit</h2>
        <p>
          The controlled scanner loads the page in a headless Chromium browser with a fixed profile: en-US locale, UTC
          timezone, a desktop or mobile viewport, and a disclosed egress network. It does not scroll, click, or log
          in, with exactly two bounded exceptions described below. The visit ends after a capped duration, and the
          current Node report records the scan conditions (Playwright and browser versions, viewport, timezone, locale,
          GPC state, catalog version, egress) so the result is reproducible for that configuration. Historical reports
          that predate exact Playwright provenance show it as not recorded. Sites can behave differently for
          real users, regions, accounts, or network locations, so results are evidence to check, not a verdict.
        </p>
        <p>
          The scanner never disguises itself: it is an honest automated browser. Sites that block automation are
          reported as failed loads rather than being scanned through evasion, because a report gathered under a
          disguised identity would misdescribe its own conditions.
        </p>
        <p>
          Optional restart-safe execution uses a fenced lease with at most two attempts. If scanner execution,
          publication, or status coordination is lost, the first attempt can be abandoned and the same admitted job
          retried once. The site may therefore receive an extra automated visit that was partial or that completed
          before its result was lost. A report is built from one completed attempt per condition and never combines
          requests or other evidence across attempts. If a complete report had already reached storage before status
          was lost, the scanner reconciles that exact report instead of visiting the site again.
        </p>
      </section>

      <section className="legal-section">
        <h2>What is recorded</h2>
        <p>The controlled scanner can record the following families; each report discloses any family it did not capture.</p>
        <ul>
          <li>Network requests (URL, domain, method, resource type, status), classified first/third party.</li>
          <li>Curated service labels from a hand-maintained, US-biased catalog of recognizable services.</li>
          <li>
            Cookies and local/session storage keys as privacy-filtered snapshots. Current reports also retain changes
            between visit-phase boundaries; those are snapshot differences, not direct observations of browser write
            events. Unreviewed names are hidden and values are omitted.
          </li>
          <li>
            High-entropy browser API calls and behavioral fingerprinting heuristics (canvas, WebGL, audio, WebRTC,
            listener coverage).
          </li>
          <li>Advertising-pixel events (Meta, TikTok, X) and whether their identifier fields carried values.</li>
          <li>DNS CNAME-uncloaking of first-party subdomains that alias to known trackers.</li>
          <li>A privacy-policy cross-check: the site&apos;s own policy text compared against the observed evidence.</li>
        </ul>
        <p>
          Counts are lower bounds. Activity inside Web or Service Workers and WebSocket traffic is not observed,
          storage keys are read from the top frame only, and trackers that load only after interaction or consent
          are not seen by a passive visit.
        </p>
      </section>

      <section className="legal-section">
        <h2>The two bounded interactions</h2>
        <p>
          First, the input probe: the scanner types a synthetic, non-personal test value into up to a handful of
          visible form fields, never submits, and watches whether that value leaves to a third party in plain,
          encoded, or hashed form. Second, in consent comparison mode only, the scanner clicks one accept-all or
          reject-all control on the cookie banner&apos;s first layer (known consent-platform controls first, then a
          conservative whole-label match). Every report discloses exactly what was typed into or clicked, or that
          nothing was.
        </p>
        <p>
          Legacy v1 reports record only that a consent click was dispatched. R2 reports also record bounded
          consent-platform readbacks and distinguish a verified registered choice from a contradiction, weak signal,
          unavailable state, or failed check; one disclosed reload can re-read the state, and requests observed during
          that reload phase are excluded from the counts. Every visit&apos;s recorded requests still span before and
          after its click, so even verified r2 wording does not attribute every request to the choice.
        </p>
      </section>

      <section className="legal-section">
        <h2>Comparisons</h2>
        <p>
          A comparison is two sequential visits that differ in one declared condition: Global Privacy Control off
          versus on, no blocking versus Brave-list block simulation, or an accept-all versus reject-all consent
          click. From the July 13, 2026 randomization release onward, the two visits run in randomized order so
          time-ordered site behavior is not systematically assigned to the same arm across scans. Post-release v1
          report warnings name the visit that ran first; post-release v2 JSON records <code>AB</code> for baseline
          first or <code>BA</code> for variant first. Comparisons captured before that release used a fixed
          baseline-then-variant order and carry no randomized-order disclosure. A single two-visit report is not
          counterbalanced; only an aggregate containing independent AB and BA pairs can make that claim. Before any
          comparative wording is used, an eligibility gate checks that both visits completed, hit no recording caps,
          and held the non-compared conditions constant; ineligible pairs render as two independent visits with the
          reasons stated. Differences between two visits can still reflect timing, experiments, caching, consent
          state, or bot detection, so comparison wording stays descriptive: it reports what differed between the
          visits, never that the compared setting caused the difference.
        </p>
      </section>

      <section className="legal-section">
        <h2>The Brave-list blocking simulation</h2>
        <p>
          Blocking evidence uses Brave&apos;s own ad-block engine (the open-source adblock-rust crate compiled to
          WebAssembly) with the default-enabled Brave Shields filter lists, vendored as a pinned snapshot. Matching
          requests are aborted in this scanner&apos;s browser: a simulation of Brave&apos;s default list blocking,
          not a live Brave-browser visit. Each request is matched with its actual HTTP method against the document
          that initiated it, network rules only (no cosmetic rules). Blocked counts are a close lower-bound
          approximation of Brave&apos;s default Shields for that page load, and the report separately states
          filter-list matches, engine-blocked requests, and the total third-party reduction, which are three
          different measurements.
        </p>
      </section>

      <section className="legal-section">
        <h2>Publication and redaction</h2>
        <p>
          Reports cross a default-deny sanitizer before anything is stored or shared: query strings and fragments
          are stripped in the browser before a scan is even submitted, and stored reports keep only reviewed,
          exact literals for paths, query keys, subdomain labels, cookie names, and storage keys, generalizing
          everything else. Report warnings come from a closed scanner vocabulary, so page-controlled text cannot
          impersonate the scanner. Shared reports live behind unguessable IDs and expire; reports published into
          the versioned public corpus are retained under disclosed age, count, and cohort rules. Reports cited by
          the corrections ledger are pinned against automated corpus pruning.
        </p>
        <p>
          Restart-safe queue data, when explicitly enabled, is infrastructure state rather than report evidence. The
          application encrypts only the normalized scheme, host, and path plus scan options before committing the job;
          the active ciphertext is bounded to 75 minutes and deleted on every terminal outcome. It excludes client
          identifiers, verification and access tokens, headers, cookies, screenshots, observations, and results.
          Unencrypted scheduling metadata contains no target or client identity. Cloudflare recovery snapshots may
          retain application-encrypted copies after active deletion until their own retention window expires. This
          path stays disabled until its flag, encryption key, private coordinator authentication, privacy disclosure,
          and live lease-expiry test are all in place.
        </p>
        <p>
          An optional encrypted watch schedules one immediate single-mode visit and then independent visits every
          seven days, with a five-attempt/30-day ceiling. Failed pre-admission attempts still consume that bound. Every
          due attempt freshly resolves and validates the target in Node before the connect-time public-address guard
          performs the visit; an old public DNS decision is never reused.
          Each result is an ordinary r2 report with the conditions observed on that run. Because live report links
          follow the ordinary seven-day and count retention policy, a watch is a scheduled rescan convenience, not a
          permanent time series or a claim that an observed difference was caused by the passage of time.
        </p>
      </section>

      <section className="legal-section">
        <h2>The corpus and percentiles</h2>
        <p>
          Findings like &quot;at or above the 90th-percentile mark for third-party domains&quot; currently use a
          legacy-v1 cohort: one newest eligible passive lead run per distinct site. Failed or no-response loads,
          request-incomplete runs, accept/reject consent arms, reserved domains, and every v2 run are excluded from that
          distribution. Corpus coverage counts distinct sites with a successful single run or primary comparison arm,
          including capped recordings; two successful primary arms still count the site once. A site
          represented only by failed or block-page visits was attempted but is outside that loaded coverage count.
          The fully measured sample is narrower still. Percentile wording activates only after 50
          fully measured sites; v2 reports use fixed reference thresholds until a matching-methodology cohort exists.
          The wording is anchored to the stored percentile mark, not the percentage of sites strictly below a value,
          because ties can make those different. The corpus is curated, not a random sample of the web. Site history
          pages compare a site only against its own earlier reports with a compatible schema, method, browser, device,
          filter-list engine/source/count, and known snapshot dates. The dates may differ so the history can describe a
          list refresh; retention alone never makes two reports comparable.
        </p>
      </section>

      <section className="legal-section">
        <h2>Reproducibility</h2>
        <p>
          The scanner, catalog, eligibility gates, and report UI are open source (AGPL-3.0-or-later), every report
          embeds its scan conditions and methodology identity, and the evidence is exportable as sanitized JSON and
          CSV. The public corpus, its percentile statistics, and the researcher export are regenerated from the
          same committed report files this site renders, so the numbers cannot disagree with the evidence behind
          them.
        </p>
      </section>

      <section className="legal-section" id="schema-errata">
        <h2>Published schema errata</h2>
        <p>
          ScanReport v2 revisions r1 and r2 are immutable, so two wording corrections are published here instead of
          silently changing their JSON Schema bytes. E1: an advanced-matching identifier is recorded only when its
          parameter carries a non-empty value; the scanner inspects that value transiently for emptiness but never
          persists, exposes, interprets, or hash-validates it. E2: <code>AB</code> and <code>BA</code> describe which arm
          ran first in one randomized pair; one pair is not counterbalanced. The complete, versioned errata log is in
          the{" "}
          <a href="https://github.com/iAnonymous3000/site-behavior-lab/blob/main/docs/scan-report-v2-rfc.md#errata">
            ScanReport v2 RFC
          </a>
          .
        </p>
      </section>
    </main>
  );
}
