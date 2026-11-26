import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { spawnSyncBounded } from "./bounded-spawn";

type Layout = { ociDigest: string; imageId: string; diffIds: string[] };
type SplitImage = {
  SPLIT_BUILD_SCHEMA: string;
  readLayout(layout: string): Layout;
  dockerSaveManifest(layout: string): unknown;
  sourceIsPrefix(source: Layout, compiled: Layout): boolean;
  splitBuildRecord(source: Layout, compiled: Layout, runnerImageId: string, commit: string): Record<string, string>;
};

const root = process.cwd();
const script = path.join(root, "scripts", "split-image.mjs");
// The compiled tests are CommonJS, where import() would become require(); a
// native import reaches the ES module itself.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
const load = async (): Promise<SplitImage> => (await nativeImport(pathToFileURL(script).href)) as SplitImage;
const layer = (n: number) => `sha256:${createHash("sha256").update(`layer ${n}`).digest("hex")}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// Writes an OCI layout as BuildKit does: index.json naming one image, whose
// manifest (or, with `nested`, an index of one platform) names the config
// that lists the layers. Blobs are stored under their real sha256.
// The image manifest lists layer blobs by digest; their bytes are not needed
// here. By default they are listed in an order that is not sorted.
const LAYER_BLOBS = [layer(103), layer(101), layer(102), layer(100)];
function writeLayout(dir: string, diffIds: string[], { nested = false, images = 1, layers = LAYER_BLOBS.slice(0, diffIds.length) } = {}): string {
  mkdirSync(path.join(dir, "blobs", "sha256"), { recursive: true });
  const put = (value: unknown): string => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(path.join(dir, "blobs", "sha256", digest.slice(7)), bytes);
    return digest;
  };
  const config = put({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: diffIds } });
  let top = put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: config }, layers: layers.map((digest) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest })) });
  if (nested) top = put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: top }] });
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: Array.from({ length: images }, () => ({ digest: top })) }));
  writeFileSync(path.join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  return dir;
}

test("a split build's layouts are read by digest, from a directory or a tar, and must hold one image", async (t) => {
  const { readLayout } = await load();
  const dir = mkdtempSync(path.join(os.tmpdir(), "split-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flat = readLayout(writeLayout(path.join(dir, "flat"), [layer(1), layer(2)]));
  assert.match(flat.ociDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(flat.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(flat.ociDigest, flat.imageId);
  assert.deepEqual(flat.diffIds, [layer(1), layer(2)]);
  // BuildKit may write an index of one platform; the image ID is still its config.
  const nested = readLayout(writeLayout(path.join(dir, "nested"), [layer(1), layer(2)], { nested: true }));
  assert.equal(nested.imageId, flat.imageId);
  assert.notEqual(nested.ociDigest, flat.ociDigest);
  // The same layout as a tar, packed as image-source packs the artifact: with
  // exact member names, since GNU tar finds index.json only under that name.
  const tar = path.join(dir, "flat.oci.tar");
  const packed = spawnSyncBounded("tar", ["-C", path.join(dir, "flat"), "-cf", tar, "index.json", "oci-layout", "blobs"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  assert.deepEqual(readLayout(tar), flat);
  assert.throws(() => readLayout(writeLayout(path.join(dir, "two"), [layer(1)], { images: 2 })), /exactly one image/);
  assert.throws(() => readLayout(path.join(dir, "absent")), /No OCI layout/);
  // A blob whose bytes no longer match its name is refused.
  const tampered = writeLayout(path.join(dir, "tampered"), [layer(1)]);
  const { imageId } = readLayout(tampered);
  writeFileSync(path.join(tampered, "blobs", "sha256", imageId.slice(7)), JSON.stringify({ rootfs: { diff_ids: [layer(9)] } }));
  assert.throws(() => readLayout(tampered), /does not match its digest/);
});

test("the compiled image must start with the source image's exact layers and add at least one", async () => {
  const { sourceIsPrefix } = await load();
  const image = (diffIds: string[]): Layout => ({ ociDigest: layer(100), imageId: layer(101), diffIds });
  const source = image([layer(1), layer(2)]);
  assert.equal(sourceIsPrefix(source, image([layer(1), layer(2), layer(3)])), true);
  assert.equal(sourceIsPrefix(source, image([layer(1), layer(2)])), false, "compiled must add a layer");
  assert.equal(sourceIsPrefix(source, image([layer(9), layer(2), layer(3)])), false, "a different first layer");
  assert.equal(sourceIsPrefix(source, image([layer(2), layer(1), layer(3)])), false, "the same layers out of order");
  assert.equal(sourceIsPrefix(source, image([layer(1)])), false);
});

test("the split build record binds the source, compiled and runner images to the commit, and refuses a broken chain", async () => {
  const { SPLIT_BUILD_SCHEMA, splitBuildRecord } = await load();
  const source: Layout = { ociDigest: layer(10), imageId: layer(11), diffIds: [layer(1)] };
  const compiled: Layout = { ociDigest: layer(20), imageId: layer(21), diffIds: [layer(1), layer(2)] };
  assert.deepEqual(splitBuildRecord(source, compiled, layer(30), COMMIT), {
    schema: SPLIT_BUILD_SCHEMA,
    buildPath: "split",
    commit: COMMIT,
    sourceOciDigest: layer(10),
    sourceImageId: layer(11),
    compiledOciDigest: layer(20),
    runnerImageId: layer(30)
  });
  assert.throws(() => splitBuildRecord(source, { ...compiled, diffIds: [layer(2), layer(3)] }, layer(30), COMMIT), /source image's layers/);
  assert.throws(() => splitBuildRecord(source, compiled, "site-behavior-lab:smoke", COMMIT), /Not an image ID/);
  assert.throws(() => splitBuildRecord(source, compiled, layer(30), "HEAD"), /Not a full commit/);
});

test("the split image commands print what CI reads and fail on a broken chain", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "split-image-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = writeLayout(path.join(dir, "source"), [layer(1), layer(2)]);
  const compiled = writeLayout(path.join(dir, "compiled"), [layer(1), layer(2), layer(3)]);
  const unrelated = writeLayout(path.join(dir, "unrelated"), [layer(7), layer(8), layer(9)]);
  const run = (...args: string[]) => spawnSyncBounded(process.execPath, [script, ...args], { encoding: "utf8" });
  const digests = run("digests", source);
  assert.equal(digests.status, 0, digests.stderr);
  assert.match(digests.stdout, /^oci_digest=sha256:[0-9a-f]{64}\nimage_id=sha256:[0-9a-f]{64}\n$/);
  const prefix = run("prefix", source, compiled);
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.match(prefix.stdout, /^oci_digest=sha256:[0-9a-f]{64}\n$/);
  const broken = run("prefix", source, unrelated);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /do not start with the source image's 2/);
  const output = path.join(dir, "split-build.json");
  assert.equal(run("record", source, compiled, layer(30), COMMIT, output).status, 0);
  assert.notEqual(run("record", source, unrelated, layer(30), COMMIT, path.join(dir, "no.json")).status, 0);
  assert.notEqual(run("digests").status, 0);
});

test("the docker load manifest names the config and layers of the one image, in the image manifest's order", async (t) => {
  const { dockerSaveManifest, readLayout } = await load();
  const dir = mkdtempSync(path.join(os.tmpdir(), "split-image-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blobPath = (digest: string) => `blobs/sha256/${digest.slice(7)}`;
  const order = LAYER_BLOBS.slice(0, 3);
  // The order checked is not the sorted one, so a sort would show.
  assert.notDeepEqual([...order].sort(), order);
  const flat = writeLayout(path.join(dir, "flat"), [layer(1), layer(2), layer(3)]);
  const expected = [{ Config: blobPath(readLayout(flat).imageId), RepoTags: null, Layers: order.map(blobPath) }];
  assert.deepEqual(dockerSaveManifest(flat), expected);
  // An index of one platform gives the same manifest.
  assert.deepEqual(dockerSaveManifest(writeLayout(path.join(dir, "nested"), [layer(1), layer(2), layer(3)], { nested: true })), expected);
  assert.throws(() => dockerSaveManifest(writeLayout(path.join(dir, "two"), [layer(1)], { images: 2 })), /exactly one image, not 2/);
  assert.throws(() => dockerSaveManifest(writeLayout(path.join(dir, "none"), [layer(1)], { images: 0 })), /exactly one image, not 0/);
  assert.throws(() => dockerSaveManifest(writeLayout(path.join(dir, "empty"), [layer(1)], { layers: [] })), /lists no layer/);
});

test("the docker-manifest command writes manifest.json beside an unchanged index.json, once, into a directory only", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "split-image-docker-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const layout = writeLayout(path.join(dir, "layout"), [layer(1), layer(2)]);
  const run = (...args: string[]) => spawnSyncBounded(process.execPath, [script, ...args], { encoding: "utf8" });
  const indexBefore = readFileSync(path.join(layout, "index.json"));
  const written = run("docker-manifest", layout);
  assert.equal(written.status, 0, written.stderr);
  const manifestBytes = readFileSync(path.join(layout, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestBytes) as { Config: string; RepoTags: null; Layers: string[] }[];
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].RepoTags, null);
  assert.deepEqual(manifest[0].Layers, LAYER_BLOBS.slice(0, 2).map((digest) => `blobs/sha256/${digest.slice(7)}`));
  assert.match(manifest[0].Config, /^blobs\/sha256\/[0-9a-f]{64}$/);
  assert.equal(manifestBytes, JSON.stringify(manifest));
  assert.deepEqual(readFileSync(path.join(layout, "index.json")), indexBefore, "index.json must not change");
  // A second run refuses rather than replace it.
  assert.notEqual(run("docker-manifest", layout).status, 0);
  assert.equal(readFileSync(path.join(layout, "manifest.json"), "utf8"), manifestBytes);
  // A tar is not a layout directory to write into.
  const tar = path.join(dir, "layout.oci.tar");
  writeFileSync(tar, "");
  const refused = run("docker-manifest", tar);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /needs a layout directory/);
});
