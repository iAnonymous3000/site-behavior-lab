import { readLoadedReport, asLocalReport } from "./client-report-reader";
import { readClientFileArrayBuffer, readClientFileText } from "./client-file-policy";
import { parseJsonTextWithPolicy } from "./client-fetch-policy";
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
  context: TrustedPageGraphClientContext,
  signal?: AbortSignal
): Promise<PublicSingleReportV2R2> {
  const selection = pageGraphUploadSelection([selectionValue.graphml, selectionValue.metadata]);
  if (!FULL_GIT_SHA.test(context.buildCommit)) {
    throw new Error("This app build cannot identify its source commit, so PageGraph r2 import is unavailable.");
  }

  const [artifactBuffer, metadataText] = await Promise.all([
    readClientFileArrayBuffer(selection.graphml, {
      label: "The PageGraph capture",
      maxBytes: MAX_PAGEGRAPH_UPLOAD_BYTES,
      signal
    }),
    readClientFileText(selection.metadata, {
      label: "The PageGraph metadata sidecar",
      maxBytes: MAX_PAGEGRAPH_METADATA_BYTES,
      signal
    })
  ]);

  let metadata: unknown;
  try {
    metadata = parseJsonTextWithPolicy(metadataText, "The PageGraph metadata sidecar");
  } catch {
    throw new Error("The PageGraph metadata sidecar is not valid JSON.");
  }

  signal?.throwIfAborted();
  const { buildPageGraphScanReportV2R2 } = await import("./pagegraph-v2-r2-builder");
  signal?.throwIfAborted();
  const report = buildPageGraphScanReportV2R2(new Uint8Array(artifactBuffer), metadata, {
    buildCommit: context.buildCommit,
    runId: context.runId,
    // Local uploads are intentionally unlinkable through public provenance.
    includeSourceArtifactDigest: false
  });
  signal?.throwIfAborted();
  return report;
}

/** Exact callback target for PageGraphR2UploadButton.onUploadPair. */
export async function readPageGraphUpload(
  selection: PageGraphUploadSelection,
  signal?: AbortSignal
): Promise<LoadedReport> {
  const report = await buildPageGraphReportFromUpload(
    selection,
    {
      buildCommit: configuredClientBuildCommit(),
      runId: newPageGraphRunId()
    },
    signal
  );
  signal?.throwIfAborted();
  const read = await readLoadedReport(report, "This PageGraph capture");
  signal?.throwIfAborted();
  if (!read.ok) throw new Error(read.message);
  return asLocalReport(read.loaded);
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
