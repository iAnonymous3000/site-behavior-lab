import { SiteChrome } from "@/app/_components/site-chrome";
import { publicPageMetadata } from "@/lib/seo-metadata";
import Link from "next/link";

export const dynamic = "force-static";
export const metadata = publicPageMetadata({
  title: "Reports replaced for privacy",
  description: "Why two committed reports were replaced with redacted copies under new IDs on September 25, 2026.",
  path: "/corrections/privacy-replacement/"
});

export default function PrivacyReplacementCorrectionPage() {
  return <SiteChrome><div className="legal-page"><section className="legal-section">
    <h1>Reports replaced for privacy</h1>
    <p>Correction SBL-CORR-2026-004 replaced two committed reports with redacted copies under new report IDs and removed the originals. The <Link href="/corrections/">public ledger</Link> names both IDs of each replacement.</p>
    <h2>What the reports published</h2>
    <p>Both are Brave-list blocking comparisons of one site. Each unblocked run recorded two requests to a performance-monitoring provider whose host names were a tenant label under the provider&apos;s shared suffix. Those labels encoded the scanner&apos;s own egress network address, a visit timestamp and per-visit tokens, and publication redaction kept a tenant label under a shared suffix verbatim. The September 1, 2026 critical-use audit confirmed the gap.</p>
    <h2>What changed</h2>
    <p>Publication redaction now generalizes a tenant label shaped like a network address, a timestamp or a token to <code>{"{label}"}</code>, under the public-string policy <code>public-string-policy-v4</code>. Each redacted copy is the current redaction of its original with only its report ID moved. Its two hosts merge into one generalized row, so its unblocked run counts one fewer third-party domain and the comparison lists one fewer removed domain; the comparison&apos;s overall and per-family results do not change. Every earlier correction event about an original applies to its copy.</p>
    <h2>What remains</h2>
    <p>The replacement reduces what this site serves. Git history and earlier release archives still hold the original bytes, and the release receipts and the publication transparency log keep their digests, which is how a saved copy of an original can still be matched to what was published.</p>
  </section></div></SiteChrome>;
}
