# Downloadable reports

The primary document download is a ZIP containing `report.pdf`, the exact public
`<report-id>.json` bytes, the original provenance sidecar for committed reports, the export-time `corrections.json` context, `export.json`,
`SHA256SUMS`, and a short verification guide. Committed reports use the original
filenames so `npm run verify:report -- <report-id> --from <extracted-directory>`
works from a trusted repository checkout. Runtime shares claim no such publication chain. A separate **Open PDF** control
retains browser preview. The package adds no PDF-writing dependency or hosted
service: it preserves Chromium's tagged PDF and bookmarks without rewriting it.

The PDF starts with the findings and limits, followed by evidence for every
recorded visit and the provenance receipt. Comparisons print both arms in source
order. Request tables use landscape pages and 9-point text. References such as
`B:R0001` identify the baseline's first retained request; `V` means variant and
`S` means single. These are presentation references, not new recorded facts.
The JSON array order defines them. The scanner's collection limits still apply.

Saved pages retain their verified source bytes so JSON and CSV downloads still
work after the remote share expires. Other managed views retrieve the source
bytes and refuse if that source no longer matches the open report. Local imports still cross the public
projection boundary and cannot fetch an imported share URL. Existing published
JSON, schemas, corrections, and provenance history are not rewritten.

The saved-page export URL binds the expected source hash. A renderer holding a
different measurement answers 409 rather than exporting the wrong evidence.
The PDF binds the report and correction-context hashes; the package records the
renderer commit separately from the scanner identity. Package hashes establish
byte consistency. They are not a signature, independent verification of the
measurement, or proof of legal compliance. Check for later public corrections
before relying on an old download.

Static builds advertise PDF capability only when
`NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PDF_EXPORT_ENABLED=1` and a public HTTPS
`NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` identify a full container renderer.
Static sites without a renderer and API-only deployments keep the control hidden.
The renderer retains its independent browser, concurrency limit, deadlines,
cancellation handling and PDF size ceiling. A failed export never truncates a
PDF to fit the byte ceiling.

## Release validation

The existing Docker CI smoke now runs `scripts/report-export-acceptance.mjs`
against single, r2 comparison, request-capped comparison, and corrected legacy
comparison witnesses. Their expected request populations are fixed independently
of the rendering code. The checks use PDF.js, standard unzip, and Node's SHA-256
to verify every request reference once, recorded timing and resource type,
portable links, document tags and bookmarks, minimum request-reference text size,
source/correction hashes, and every packaged file. Browser checks cover the
ordinary JSON download and distinct anchors for both printed visits. Source
mismatches must refuse export. Existing scanner, CI and promotion gates remain.

Run against a local production server:

```sh
node scripts/report-export-acceptance.mjs http://127.0.0.1:3000
```

Visual inspection remains necessary for changed layout: text extraction does not
establish legible columns, sensible page breaks, or correct reading order in every
PDF reader. Passing this suite establishes the exercised export behavior, not
real-world detector accuracy. Independent report qualification and formal
error-rate calibration retain their separate evidence requirements.
