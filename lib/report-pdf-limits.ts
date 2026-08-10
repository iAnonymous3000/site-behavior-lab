/**
 * The PDF export's byte ceiling, alone in a module with no imports.
 *
 * Two callers need it and only one of them can load lib/report-pdf.ts: the
 * container smoke (scripts/smoke-docker.mjs) reads the response under this
 * bound, and pulling in the renderer would pull in Playwright with it. A second
 * hand-written copy is exactly the "one contract restated in two files" shape
 * this repository keeps finding, so the number lives here and both sides import
 * it.
 *
 * Sized against measurement, not taste: the largest document the committed
 * corpus renders is 1.38 MB, so this is roughly seventeen times the observed
 * worst case. A render above it is REFUSED, never clipped.
 */
export const REPORT_PDF_MAX_BYTES = 24 * 1024 * 1024;
