import { CLAIM_BOUNDARY, claimBoundaryParagraph } from "@/lib/claim-boundary";
import { COVERAGE_BOUNDARY_URL, coverageBoundarySentence } from "@/lib/detector-coverage-boundary";

/**
 * Print-only evidence footer for a saved report.
 *
 * Screen readers and screen viewers never see this: `.print-evidence-footer` is
 * `display: none` outside `@media print`. It exists because a printed page is
 * where evidence most easily detaches from its provenance, so the paper has to
 * carry the digest of the bytes it renders and say plainly that it is a
 * rendering rather than the evidence.
 *
 * Every report route that can be printed renders this one component. A second
 * copy of these sentences would be a contract restated in two files, and this
 * is the one surface where a divergence reaches a reader with no way to
 * correct it. `lib/print-contract.test.ts` pins the strings.
 */
export function PrintEvidenceFooter({
  committed,
  id,
  reportUrl,
  wireSha256
}: {
  /** Committed corpus reports have an external chain; time-limited shares do not. */
  committed: boolean;
  id: string;
  reportUrl: string;
  /** SHA-256 of the exact stored wire bytes, not of this rendering. */
  wireSha256: string;
}) {
  return (
    <footer className="print-evidence-footer">
      <p>
        Printed copy of {reportUrl}. This print is a rendering, not the evidence; the JSON wire is
        canonical. Exact evidence bytes: SHA-256 <code>{wireSha256}</code>.
      </p>
      {committed ? (
        <p>
          Verify independently: in github.com/iAnonymous3000/site-behavior-lab run{" "}
          <code>npm run verify:report -- {id}</code> to check the bytes this site serves, or add{" "}
          <code>--from &lt;dir&gt;</code> to check a copy you saved yourself. This publication is
          chained into the append-only transparency log at
          sitebehavior.org/transparency-log.json.
        </p>
      ) : (
        <p>
          This report is a time-limited share and expires on its retention schedule. If you rely on
          this print, save the JSON evidence and its digest now; after expiry the digest above is
          the only way to authenticate a retained copy.
        </p>
      )}
      {/* Paper is the surface where a reader is most likely to treat silence as
          absence, because there is nothing to click and no boundary page in
          sight. The sentence is derived from the same entries the catalog page
          lists, so the paper and the site cannot drift apart. */}
      <p>
        {coverageBoundarySentence()} The full list is published at {COVERAGE_BOUNDARY_URL}.
      </p>
      {CLAIM_BOUNDARY && <p>Approved use: {claimBoundaryParagraph(CLAIM_BOUNDARY)}</p>}
    </footer>
  );
}
