import { readLoadedReport, withoutLoadedReportShare } from "./client-report-reader";
import {
  MAX_PAGEGRAPH_METADATA_BYTES,
  MAX_PAGEGRAPH_UPLOAD_BYTES,
  pageGraphUploadSelection,
  type PageGraphUploadSelection
} from "./pagegraph-upload-selection";
import type { PublicSingleReportV2R2 } from "./scan-report-v2-r2";
import type { LoadedReport } from "./scan-report-view";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type TrustedPageGraphClientContext = {
  buildCommit: string;
  runId: string;
};

/**
 * Browser-side orchestration over the code-split r2 producer. Kept separate
 * from the app shell so selecting files cannot accidentally fall back to the
 * permissive legacy v1 adapter.
 */
export async function buildPageGraphReportFromUpload(
  selectionValue: PageGraphUploadSelection,
  context: TrustedPageGraphClientContext
): Promise<PublicSingleReportV2R2> {
  const selection = pageGraphUploadSelection([selectionValue.graphml, selectionValue.metadata]);
  if (!FULL_GIT_SHA.test(context.buildCommit)) {
    throw new Error("This app build cannot identify its source commit, so PageGraph r2 import is unavailable.");
  }

  const [artifactBuffer, metadataText] = await Promise.all([
    selection.graphml.arrayBuffer(),
    selection.metadata.text()
  ]);
  if (artifactBuffer.byteLength <= 0 || artifactBuffer.byteLength > MAX_PAGEGRAPH_UPLOAD_BYTES) {
    throw new Error(`PageGraph captures must be between 1 byte and ${MAX_PAGEGRAPH_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  if (new TextEncoder().encode(metadataText).byteLength > MAX_PAGEGRAPH_METADATA_BYTES) {
    throw new Error(`PageGraph metadata must not exceed ${MAX_PAGEGRAPH_METADATA_BYTES / 1024} KB.`);
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText) as unknown;
  } catch {
    throw new Error("The PageGraph metadata sidecar is not valid JSON.");
  }

  const { buildPageGraphScanReportV2R2 } = await import("./pagegraph-v2-r2-builder");
  return buildPageGraphScanReportV2R2(new Uint8Array(artifactBuffer), metadata, {
    buildCommit: context.buildCommit,
    runId: context.runId,
    // Local uploads are intentionally unlinkable through public provenance.
    includeSourceArtifactDigest: false
  });
}

/** Exact callback target for PageGraphR2UploadButton.onUploadPair. */
export async function readPageGraphUpload(selection: PageGraphUploadSelection): Promise<LoadedReport> {
  const report = await buildPageGraphReportFromUpload(selection, {
    buildCommit: configuredClientBuildCommit(),
    runId: newPageGraphRunId()
  });
  const read = await readLoadedReport(report, "This PageGraph capture");
  if (!read.ok) throw new Error(read.message);
  return withoutLoadedReportShare(read.loaded);
}

export function configuredClientBuildCommit(
  value: string | undefined = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT
): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!FULL_GIT_SHA.test(normalized)) {
    throw new Error("This app build cannot identify its source commit, so PageGraph r2 import is unavailable.");
  }
  return normalized;
}

function newPageGraphRunId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) throw new Error("Secure randomness is unavailable, so PageGraph r2 import cannot mint a run id.");
  if (typeof cryptoApi.randomUUID === "function") return `pagegraph-${cryptoApi.randomUUID()}`;
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `pagegraph-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
