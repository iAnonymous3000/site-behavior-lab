import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  buildPageGraphReportFromUpload,
  configuredClientBuildCommit
} from "./pagegraph-client-import";
import {
  MAX_PAGEGRAPH_METADATA_BYTES,
  MAX_PAGEGRAPH_UPLOAD_BYTES,
  pageGraphUploadSelection
} from "./pagegraph-upload-selection";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";

type PublicBuildCommitModule = {
  resolvePublicBuildCommit(environment: Record<string, string | undefined>): string;
};
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<PublicBuildCommitModule>;

const FIXTURE_DIR = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
const GRAPH = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml")));
const META = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "real-wikipedia-2026-07-19.meta.json")));

function uploadFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes)
  } as File;
}

function selection() {
  return {
    graphml: uploadFile("real-wikipedia-2026-07-19.graphml", GRAPH),
    metadata: uploadFile("real-wikipedia-2026-07-19.meta.json", META)
  };
}

test("paired browser import produces r2 and never publishes a local artifact digest", async () => {
  const report = await buildPageGraphReportFromUpload(selection(), {
    buildCommit: "a".repeat(40),
    runId: "pagegraph-client-test-0001"
  });
  assert.equal(isPublicScanReportV2R2(report), true);
  assert.equal(report.run.provenance.sourceArtifactDigest, undefined);
  assert.equal(report.run.evidence.requests.length, 5);
});

test("pair selection requires same-stem bounded GraphML and metadata files", () => {
  const pair = selection();
  assert.deepEqual(pageGraphUploadSelection([pair.metadata, pair.graphml]), pair);
  assert.throws(() => pageGraphUploadSelection([pair.graphml]), /exactly two files/);
  assert.throws(
    () => pageGraphUploadSelection([pair.graphml, uploadFile("other.meta.json", META)]),
    /same base filename/
  );
  assert.throws(
    () =>
      pageGraphUploadSelection([
        pair.graphml,
        { ...pair.metadata, size: MAX_PAGEGRAPH_METADATA_BYTES + 1 } as File
      ]),
    /metadata must be between/
  );
});

test("oversized PageGraph pairs fail before either browser file is allocated", async () => {
  let graphReads = 0;
  let metadataReads = 0;
  const graphml = {
    name: "capture.graphml",
    size: MAX_PAGEGRAPH_UPLOAD_BYTES + 1,
    arrayBuffer: async () => {
      graphReads += 1;
      return new ArrayBuffer(0);
    }
  } as File;
  const metadata = {
    name: "capture.meta.json",
    size: META.byteLength,
    text: async () => {
      metadataReads += 1;
      return new TextDecoder().decode(META);
    }
  } as File;

  await assert.rejects(
    buildPageGraphReportFromUpload(
      { graphml, metadata },
      { buildCommit: "a".repeat(40), runId: "pagegraph-client-test-oversized" }
    ),
    /captures must be between/
  );
  assert.equal(graphReads, 0);
  assert.equal(metadataReads, 0);
});

test("client orchestration fails closed on missing build identity and malformed metadata", async () => {
  assert.throws(() => configuredClientBuildCommit(""), /cannot identify its source commit/);
  assert.equal(configuredClientBuildCommit("A".repeat(40)), "a".repeat(40));
  await assert.rejects(
    buildPageGraphReportFromUpload(selection(), { buildCommit: "main", runId: "pagegraph-client-test-0002" }),
    /cannot identify its source commit/
  );

  const bad = selection();
  bad.metadata = uploadFile("real-wikipedia-2026-07-19.meta.json", new TextEncoder().encode("{"));
  await assert.rejects(
    buildPageGraphReportFromUpload(bad, {
      buildCommit: "a".repeat(40),
      runId: "pagegraph-client-test-0003"
    }),
    /not valid JSON/
  );

  const duplicate = selection();
  const metadataText = new TextDecoder().decode(META);
  duplicate.metadata = uploadFile(
    "real-wikipedia-2026-07-19.meta.json",
    new TextEncoder().encode(metadataText.replace(/\{\s*/, '{"capture":{},'))
  );
  await assert.rejects(
    buildPageGraphReportFromUpload(duplicate, {
      buildCommit: "a".repeat(40),
      runId: "pagegraph-client-test-duplicate-key"
    }),
    /not valid JSON/
  );
});

test("compile-time public build provenance rejects invalid and conflicting sources", async () => {
  const configSource = readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8");
  const pagesBuildSource = readFileSync(path.join(process.cwd(), "scripts", "build-github-pages.mjs"), "utf8");
  const uploadButtonSource = readFileSync(
    path.join(process.cwd(), "app", "_components", "file-upload-button.tsx"),
    "utf8"
  );
  assert.match(configSource, /resolvePublicBuildCommit\(\)/);
  assert.match(configSource, /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT: publicBuildCommit/);
  assert.match(
    pagesBuildSource,
    /runCommand\(nextBin, \["build"\],[\s\S]*SITE_BEHAVIOR_LAB_BUILD_COMMIT: deployment/
  );
  assert.doesNotMatch(uploadButtonSource, /export function PageGraphUploadButton/);
  assert.match(uploadButtonSource, /export function PageGraphR2UploadButton/);
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts", "public-build-commit.mjs")).href;
  const { resolvePublicBuildCommit } = await nativeImport(moduleUrl);
  assert.equal(resolvePublicBuildCommit({}), "");
  assert.equal(resolvePublicBuildCommit({ CF_PAGES_COMMIT_SHA: "A".repeat(40) }), "a".repeat(40));
  assert.throws(() => resolvePublicBuildCommit({ GITHUB_SHA: "main" }), /full 40-character Git commit/);
  assert.throws(
    () =>
      resolvePublicBuildCommit({
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40),
        GITHUB_SHA: "b".repeat(40)
      }),
    /Conflicting build commits/
  );
});
