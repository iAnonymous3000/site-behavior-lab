import { evidenceZip } from "./report-export-bundle";
import { sha256Hex, sha256BytesHex } from "./sha256";

/** An export receipt records the rendering separately from the immutable measurement. */
export function reportDocumentBundle(input: {
  id: string; pdf: Uint8Array; wire: string; corrections: string; provenanceWire?: string;
  exportedAt: string; rendererCommit: string | null; reportUrl: string;
}): Uint8Array {
  const reportName = `${input.id}.json`;
  const files: [string, string | Uint8Array][] = [
    ["report.pdf", input.pdf], [reportName, input.wire], ["corrections.json", input.corrections]
  ];
  if (input.provenanceWire !== undefined) files.push([`${input.id}.provenance.json`, input.provenanceWire]);
  const fileHashes = Object.fromEntries(files.map(([name, bytes]) => [name, {
    sha256: typeof bytes === "string" ? sha256Hex(bytes) : sha256BytesHex(bytes)
  }]));
  const hashes = files.map(([name, bytes]) => `${(typeof bytes === "string" ? sha256Hex(bytes) : sha256BytesHex(bytes))}  ${name}`).join("\n") + "\n";
  files.push(["SHA256SUMS", hashes]);
  files.push(["export.json", JSON.stringify({
    reportId: input.id, reportUrl: input.reportUrl, exportedAt: input.exportedAt,
    rendererCommit: input.rendererCommit,
    files: fileHashes,
    meaning: "File hashes establish byte consistency, not measurement accuracy or a signed attestation. Corrections describe the export-time review context."
  }, null, 2) + "\n"]);
  files.push(["README.txt", `SITE BEHAVIOR LAB — SAVED REPORT\n\nOpen report.pdf to read the findings, limits, and evidence for every recorded visit.\n${reportName} contains the exact public source bytes hashed in the PDF. Keep it unchanged.\ncorrections.json contains the review context used when this document was exported.\nexport.json identifies the renderer separately from the original scanner.\n\nVerify the files after extracting this ZIP:\n  macOS: shasum -a 256 -c SHA256SUMS\n  Linux: sha256sum -c SHA256SUMS\n  Windows PowerShell: Get-FileHash report.pdf,${reportName},corrections.json -Algorithm SHA256\nCompare Windows results with SHA256SUMS. Compare ${reportName}'s hash with the PDF footer too.\n\n${input.provenanceWire !== undefined ? `The original ${input.id}.provenance.json sidecar is included.
From a trusted checkout of github.com/iAnonymous3000/site-behavior-lab, verify the
committed report against publication history with:
  npm run verify:report -- ${input.id} --from <extracted-directory>

` : "This runtime share has no committed publication sidecar or external publication chain.\n\n"}These checks detect changed bytes relative to this package. They do not prove who created it,\nthat the observations are independently accurate, or that the site always behaves this way.\nThe PDF is a rendering; preserve the JSON and correction context alongside it.\nCheck the report's public review record for later corrections before relying on it:\n${input.reportUrl}\nhttps://sitebehavior.org/corrections/\n`]);
  return evidenceZip(files);
}
