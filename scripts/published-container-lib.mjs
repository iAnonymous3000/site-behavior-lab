import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const REPOSITORY = "iAnonymous3000/site-behavior-lab";
export const ACCOUNT_ID = "dea2502fea1fef952043925374196ae9";
export const IMAGE_REPOSITORY = `registry.cloudflare.com/${ACCOUNT_ID}/site-behavior-lab-scanner`;
export const PUBLISHED_EVIDENCE = "site-behavior-lab-published-container-evidence.json";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertRegistryManifest(manifest, reference, imageId) {
  assert.equal(manifest?.Descriptor?.digest, reference.split("@")[1], "Registry returned a different manifest");
  const body = manifest.SchemaV2Manifest ?? manifest.OCIManifest;
  assert.equal(body?.schemaVersion, 2);
  assert.equal(body?.config?.digest, imageId, "Registry manifest does not address the tested image configuration");
  assert.ok(Array.isArray(body?.layers) && body.layers.length > 0);
}

// Also executed verbatim in CI's isolated attestation job, which must not
// checkout or execute candidate code. Tests compare the two function bodies.
export function assertPublishedImageIdentity(published, tested) {
  const prefix = "registry.cloudflare.com/dea2502fea1fef952043925374196ae9/site-behavior-lab-scanner@sha256:";
  const image = published?.artifacts?.[0];
  if (published?.artifacts?.length !== 1 || image?.name !== "container-image" ||
      image?.kind !== "docker-image-inspection" || image.os !== "linux" || image.architecture !== "amd64" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.imageId) || image.repoDigests?.length !== 1 ||
      typeof image.repoDigests[0] !== "string" || !image.repoDigests[0].startsWith(prefix) ||
      !/^[0-9a-f]{64}$/.test(image.repoDigests[0].slice(prefix.length))) {
    throw new Error("Published container must identify one immutable production registry image");
  }
  const original = structuredClone(tested);
  const copy = structuredClone(published);
  if (original?.artifacts?.length !== 1 || original.artifacts[0].repoDigests?.length !== 0) {
    throw new Error("Expected the original, unpushed CI image receipt");
  }
  copy.artifacts[0].repoDigests = [];
  if (JSON.stringify(copy) !== JSON.stringify(original)) {
    throw new Error("Registry publication changed the tested image or its evidence");
  }
  return image.repoDigests[0];
}

export function validatePublishedContainer(receipt, { commit, tree, configBytes }) {
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.evidenceKind, "exact-source-and-tested-artifact-manifest");
  assert.equal(receipt.source?.repository, `https://github.com/${REPOSITORY}`);
  assert.equal(receipt.source?.commit, commit, "Image source differs from the deployment checkout");
  assert.equal(receipt.source?.tree, tree, "Image source tree differs from the deployment checkout");
  const config = receipt.inputs?.productionContainerConfig;
  assert.equal(config?.path, "wrangler.container.jsonc");
  assert.equal(config?.sha256, sha256(configBytes), "Production configuration differs from the tested configuration");
  assert.equal(config?.bytes, Buffer.byteLength(configBytes));
  const tested = structuredClone(receipt);
  assert.equal(tested.artifacts?.length, 1);
  tested.artifacts[0].repoDigests = [];
  const reference = assertPublishedImageIdentity(receipt, tested);
  assert.equal(receipt.artifacts[0].sourceCommit, commit);
  return reference;
}

export function validMainRun(run, commit) {
  return Number.isSafeInteger(run?.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
    run.head_sha === commit && run.head_branch === "main" &&
    run.path === ".github/workflows/ci.yml" &&
    ["push", "workflow_dispatch"].includes(run.event);
}

export function attestationArgs(file, commit) {
  return ["attestation", "verify", file, "--repo", REPOSITORY,
    "--signer-workflow", `${REPOSITORY}/.github/workflows/ci.yml`,
    "--source-ref", "refs/heads/main", "--source-digest", commit,
    "--signer-digest", commit, "--deny-self-hosted-runners", "--format", "json"];
}
