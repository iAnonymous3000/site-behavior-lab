import { SiteChrome } from "@/app/_components/site-chrome";
import { publicPageMetadata } from "@/lib/seo-metadata";
import Link from "next/link";

export const dynamic = "force-static";
export const metadata = publicPageMetadata({
  title: "Corrections to historical detector claims",
  description: "The input-probe, policy entity matcher, and X Purchase label corrections recorded on September 5, 2026.",
  path: "/corrections/v1-accuracy/"
});

export default function AccuracyCorrectionPage() {
  return <SiteChrome><div className="legal-page"><section className="legal-section">
    <h1>Corrections to historical detector claims</h1>
    <p>The September 5, 2026 audit reproduced these interpretation and coverage problems. The original reports and provenance remain unchanged. The <Link href="/corrections/">public ledger</Link> identifies every affected report.</p>
    <h2>Input-probe coverage</h2>
    <p>406 reports include a disclosure claiming unload beacons were captured. The pinned browser capture did not reliably record teardown-only requests. Focus and blur callbacks could also run, and failed field attempts were not fully accounted for. Retained positive observations remain evidence of those observations; a quiet result does not establish absence of transmission across untested fields or teardown.</p>
    <h2>Policy entity mentions</h2>
    <p>The matcher used Amazon and Oracle as alias keys, while the catalog emitted Amazon Ads and Oracle Advertising. A policy naming either parent could therefore be reported as not naming it. The ledger marks reports containing these unmentioned-entity results. Policy text was not retained, so this is a limitation notice rather than a claim that every result was wrong.</p>
    <h2>X Purchase labels</h2>
    <p>The decoder classified any populated sale amount or order quantity as Purchase, including zero and malformed values. Six archived WebMD reports contain this unsupported label. Those labels must not support purchase claims. The underlying pixel requests remain recorded observations.</p>
    <h2>Policy cookie statements</h2>
    <p>The matcher also borrowed negation from unrelated clauses, turning “We do not sell personal information, but we do use third-party cookies” into a no-cookies claim. No archived cookie-contradiction card was identified in the audit. The updated reader rechecks the scope of historical cookie quotes before comparing them with observations.</p>
  </section></div></SiteChrome>;
}
