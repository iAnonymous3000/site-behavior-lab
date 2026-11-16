#!/usr/bin/env node

// Identities of the images hosted CI's split build passes between jobs, read
// from OCI image layouts (a directory, or a tar of one) as BuildKit writes
// them. The source image is tested by the image-Node legs and the release
// image is built from it, each by digest. This script prints those digests,
// checks that the compiled image sits on the exact source image's layers, and
// writes the record attest binds to the container receipt.
//
// Usage:
//   split-image.mjs digests <layout>                prints oci_digest= and image_id= lines
//   split-image.mjs prefix <source> <compiled>       fails unless source's layers start compiled's
//   split-image.mjs record <source> <compiled> <runner image id> <commit> <output>

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const SPLIT_BUILD_SCHEMA = "site-behavior-lab/split-build/v1";

function reader(layout) {
  if (!existsSync(layout)) throw new Error(`No OCI layout at ${layout}`);
  if (statSync(layout).isDirectory()) return (name) => readFileSync(path.join(layout, name));
  return (name) => execFileSync("tar", ["-xOf", layout, name], { maxBuffer: 64 * 1024 * 1024 });
}

const blobName = (digest) => {
  if (!DIGEST.test(digest ?? "")) throw new Error(`Not a sha256 digest: ${digest}`);
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
};

// The layout's one image: its index digest names it for a build context, its
// config digest is the image ID docker gives it, its diff ids are its layers.
export function readLayout(layout) {
  const read = reader(layout);
  // Each blob read here must hash to the digest that names it.
  const blob = (digest) => {
    const bytes = read(blobName(digest));
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new Error(`${layout}: blob ${digest} does not match its digest`);
    return JSON.parse(bytes);
  };
  const index = JSON.parse(read("index.json"));
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error(`${layout} must hold exactly one image, not ${index.manifests?.length ?? 0}`);
  }
  const ociDigest = index.manifests[0].digest;
  let manifest = blob(ociDigest);
  if (Array.isArray(manifest.manifests)) {
    if (manifest.manifests.length !== 1) throw new Error(`${layout} must hold one platform, not ${manifest.manifests.length}`);
    manifest = blob(manifest.manifests[0].digest);
  }
  const imageId = manifest.config?.digest;
  const config = blob(imageId);
  const diffIds = config.rootfs?.diff_ids;
  if (!Array.isArray(diffIds) || diffIds.length === 0 || !diffIds.every((id) => DIGEST.test(id))) {
    throw new Error(`${layout} has no layer list`);
  }
  return { ociDigest, imageId, diffIds };
}

// The compiled stage is FROM the source image, so the source image's layers
// must be the first layers of compiled, in order, and compiled must add some.
export function sourceIsPrefix(source, compiled) {
  return compiled.diffIds.length > source.diffIds.length && source.diffIds.every((id, index) => compiled.diffIds[index] === id);
}

export function splitBuildRecord(source, compiled, runnerImageId, commit) {
  if (!sourceIsPrefix(source, compiled)) throw new Error("The compiled image does not start with the source image's layers");
  if (!DIGEST.test(runnerImageId ?? "")) throw new Error(`Not an image ID: ${runnerImageId}`);
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Not a full commit: ${commit}`);
  return {
    schema: SPLIT_BUILD_SCHEMA,
    buildPath: "split",
    commit,
    sourceOciDigest: source.ociDigest,
    sourceImageId: source.imageId,
    compiledOciDigest: compiled.ociDigest,
    runnerImageId
  };
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "digests" && args.length === 1) {
    const { ociDigest, imageId } = readLayout(args[0]);
    console.log(`oci_digest=${ociDigest}\nimage_id=${imageId}`);
    return 0;
  }
  if (command === "prefix" && args.length === 2) {
    const [source, compiled] = args.map(readLayout);
    if (!sourceIsPrefix(source, compiled)) {
      console.error(`The compiled image's ${compiled.diffIds.length} layers do not start with the source image's ${source.diffIds.length}.`);
      return 1;
    }
    console.log(`oci_digest=${compiled.ociDigest}`);
    return 0;
  }
  if (command === "record" && args.length === 5) {
    const [source, compiled] = args.slice(0, 2).map(readLayout);
    writeFileSync(args[4], `${JSON.stringify(splitBuildRecord(source, compiled, args[2], args[3]), null, 2)}\n`);
    return 0;
  }
  throw new Error("Usage: split-image.mjs digests <layout> | prefix <source> <compiled> | record <source> <compiled> <runner image id> <commit> <output>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
