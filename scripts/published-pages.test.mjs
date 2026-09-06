import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { validatePagesReceipt, verifyPagesArtifact, assertPagesProject,
  assertPagesDeployment, waitForPagesDeployment } from "./published-pages-lib.mjs";
import { buildDeploymentReceipt } from "./static-deployment-provenance.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Docker deliberately omits the checkout's .git directory. The provenance
// contract needs real Git history, so own that history instead of borrowing it.
const sourceFixture = await mkdtemp(path.join(tmpdir(), "sbl-pages-source-"));
after(() => rm(sourceFixture, { recursive: true, force: true }));
const sourceGit = (...args) => execFileSync("git", args, { cwd: sourceFixture, encoding: "utf8", env: {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
} }).trim();
sourceGit("init", "-q");
sourceGit("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
  "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
const commit = sourceGit("rev-parse", "HEAD");
const tree = sourceGit("rev-parse", "HEAD^{tree}");
const deployment = buildDeploymentReceipt(commit, { cwd: sourceFixture });
const contents = {
  ".nojekyll": "", "_headers": "/*\n  X-Content-Type-Options: nosniff\n",
  "_next/static/fixture.js": "console.log(1);", "deployment.json": JSON.stringify(deployment),
  "index.html": "<!doctype html><title>Test</title>", "reports/index.json": "{}",
  "scan-report.schema.json": "{}"
};
function receipt() {
  // Independently enumerate expected bytes, without the production walker.
  const files = Object.keys(contents).sort().map((file) => ({
    path: file, bytes: Buffer.byteLength(contents[file]), sha256: digest(contents[file])
  }));
  return { schemaVersion: 1, evidenceKind: "exact-source-and-tested-artifact-manifest",
    source: { repository: "https://github.com/iAnonymous3000/site-behavior-lab", commit, tree },
    artifacts: [{ name: "static-pages", kind: "directory-manifest", path: "out", deployment,
      digestAlgorithm: "sha256", manifestSha256: digest(JSON.stringify(files)),
      fileCount: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0), files }]
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-pages-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes);
  }
  return directory;
}
function project() {
  return { name: "site-behavior-lab", production_branch: "production", domains: ["sitebehavior.org"],
    source: { config: { production_deployments_enabled: false, preview_deployment_setting: "none" } },
    canonical_deployment: { id: "12345678-1234-1234-1234-123456789abc", environment: "production",
      latest_stage: { status: "success" }, deployment_trigger: { metadata: { commit_hash: commit } } }
  };
}

test("the complete static artifact, including dotfiles, matches independent byte expectations", async (t) => {
  const directory = await fixture(t);
  const artifact = validatePagesReceipt(receipt(), { commit, tree });
  await verifyPagesArtifact(directory, artifact, { commit, cwd: sourceFixture });
});

test("extra, missing, changed and symlinked files cannot accompany a genuine receipt", async (t) => {
  for (const mutate of [
    (dir) => writeFile(path.join(dir, "extra.txt"), "unexpected"),
    (dir) => rm(path.join(dir, ".nojekyll")),
    (dir) => writeFile(path.join(dir, "index.html"), "changed"),
    async (dir) => { await rm(path.join(dir, "index.html")); await symlink("deployment.json", path.join(dir, "index.html")); }
  ]) {
    const directory = await fixture(t);
    await mutate(directory);
    await assert.rejects(verifyPagesArtifact(directory, receipt().artifacts[0], { commit, cwd: sourceFixture }));
  }
});

test("another source, malformed manifest, traversal or executable Pages content is refused", () => {
  for (const mutate of [
    (r) => r.source.commit = "a".repeat(40), (r) => r.source.tree = "b".repeat(40),
    (r) => r.source.repository = "https://github.com/attacker/fork",
    (r) => r.artifacts[0].path = "elsewhere", (r) => r.artifacts[0].fileCount++,
    (r) => r.artifacts[0].bytes++, (r) => r.artifacts[0].manifestSha256 = "f".repeat(64),
    (r) => r.artifacts[0].deployment = { deployment: "c".repeat(40) },
    ...["../outside", "/absolute", "a//b", "a/./b", "_worker.js", "functions/handler.js"].map((name) => (r) => {
      r.artifacts[0].files[0].path = name;
      r.artifacts[0].files.sort((a,b) => a.path < b.path ? -1 : 1);
      r.artifacts[0].manifestSha256 = digest(JSON.stringify(r.artifacts[0].files));
    })
  ]) {
    const r = receipt(); mutate(r);
    assert.throws(() => validatePagesReceipt(r, { commit, tree }));
  }
});

test("the provider must identify the right project, source and production branch with one writer", () => {
  assert.equal(assertPagesDeployment(project(), commit), project().canonical_deployment.id);
  for (const mutate of [
    (p) => p.name = "another-project", (p) => p.production_branch = "main", (p) => p.domains = [],
    (p) => p.source.config.production_deployments_enabled = true,
    (p) => p.source.config.preview_deployment_setting = "all"
  ]) { const p = project(); mutate(p); assert.throws(() => assertPagesProject(p)); }
  for (const mutate of [
    (p) => p.canonical_deployment.environment = "preview",
    (p) => p.canonical_deployment.latest_stage.status = "active",
    (p) => p.canonical_deployment.deployment_trigger.metadata.commit_hash = "d".repeat(40)
  ]) { const p = project(); mutate(p); assert.throws(() => assertPagesDeployment(p, commit)); }
});

test("rollout requires provider and all sampled live bytes to match during one attempt", async () => {
  let reads = 0;
  const result = await waitForPagesDeployment({ artifact: receipt().artifacts[0], commit, timeoutMs: 1000, pollMs: 1,
    project: async () => { const p = project(); if (++reads === 1) p.canonical_deployment.latest_stage.status = "active"; return p; },
    readLiveFile: async (file) => Buffer.from(contents[file.path]), onPending: () => {}
  });
  assert.equal(reads, 2);
  assert.equal(result.verifiedLivePaths.length, 4);
  assert.equal(result.deploymentId, project().canonical_deployment.id);
});

test("wrong bytes, stale provider state and late responses never produce a success receipt", async () => {
  for (const overrides of [
    { readLiveFile: async () => Buffer.from("wrong") },
    { project: async () => { const p = project(); p.canonical_deployment.latest_stage.status = "active"; return p; } },
    { project: async () => { await delay(50); return project(); } }
  ]) {
    await assert.rejects(waitForPagesDeployment({ artifact: receipt().artifacts[0], commit, timeoutMs: 20, pollMs: 1,
      project: async () => project(), readLiveFile: async (file) => Buffer.from(contents[file.path]),
      onPending: () => {}, ...overrides
    }));
  }
});

test("the deployment CLI refuses failed signatures and substituted artifacts before any provider request", async (t) => {
  const { copyFile, chmod } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(tmpdir(), "sbl-pages-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, ".github"));
  await mkdir(path.join(root, "lib"));
  await copyFile("lib/strict-json.ts", path.join(root, "lib/strict-json.ts"));
  await mkdir(path.join(root, "ignored"));
  for (const file of ["deploy-pages.mjs", "production-ci-lib.mjs", "verify-required-ci-jobs.mjs",
    "published-pages-lib.mjs", "published-container-lib.mjs", "release-evidence.mjs",
    "static-deployment-provenance.mjs", "http-response.mjs"]) {
    await copyFile(path.join("scripts", file), path.join(root, "scripts", file));
  }
  await copyFile(".github/required-ci-jobs.json", path.join(root, ".github/required-ci-jobs.json"));
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  const fakeGh = path.join(root, "ignored/gh");
  await writeFile(path.join(root, "scripts/ensure-gh-attestation-verifier.mjs"), `console.log(${JSON.stringify(fakeGh)});\n`);
  await writeFile(fakeGh, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), base=process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(base,'ignored/calls'), JSON.stringify(args)+'\\n');
if(args[0]==='attestation') { if(process.env.FAIL_SIGNATURE==='1')process.exit(1); console.log('[{}]'); }
else if(args[0]==='api') {
 const endpoint=args.at(-1),commit=process.env.GITHUB_SHA;
 if(endpoint.includes('/git/ref/')) console.log(JSON.stringify({object:{sha:commit}}));
 else if(endpoint.includes('/attempts/')) console.log(JSON.stringify([{jobs:JSON.parse(fs.readFileSync(path.join(base,'.github/required-ci-jobs.json'))).jobs.map(name=>({name,conclusion:'success'}))}]));
 else console.log(JSON.stringify({workflow_runs:[{id:123,run_attempt:1,repository:{full_name:process.env.GITHUB_REPOSITORY},head_repository:{full_name:process.env.GITHUB_REPOSITORY},head_sha:commit,head_branch:'main',path:'.github/workflows/ci.yml',event:'push'}]}));
} else if(args[0]==='run' && args[1]==='download') {
 const dir=args[args.indexOf('--dir')+1],name=args[args.indexOf('--name')+1];fs.mkdirSync(dir,{recursive:true});
 if(name.startsWith('exact-sha-'))fs.copyFileSync(path.join(base,'ignored/receipt.json'),path.join(dir,'site-behavior-lab-static-release-evidence.json'));
 else {fs.cpSync(path.join(base,'ignored/out'),dir,{recursive:true});if(process.env.SUBSTITUTE==='1')fs.writeFileSync(path.join(dir,'index.html'),'substituted');}
} else process.exit(2);
`);
  await chmod(fakeGh, 0o755);
  await writeFile(path.join(root, "ignored/no-provider.cjs"), "global.fetch=async()=>{throw new Error('PROVIDER_BOUNDARY_REACHED')};\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
  } }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const localCommit = git("rev-parse", "HEAD"), localTree = git("rev-parse", "HEAD^{tree}");
  const localContents = { ...contents, "deployment.json": JSON.stringify(buildDeploymentReceipt(localCommit, { cwd: root })) };
  for (const [file, bytes] of Object.entries(localContents)) {
    await mkdir(path.dirname(path.join(root, "ignored/out", file)), { recursive: true });
    await writeFile(path.join(root, "ignored/out", file), bytes);
  }
  const r = receipt(); r.source.commit = localCommit; r.source.tree = localTree;
  const a = r.artifacts[0]; a.deployment = JSON.parse(localContents["deployment.json"]);
  a.files = Object.keys(localContents).sort().map(file => ({path:file,bytes:Buffer.byteLength(localContents[file]),sha256:digest(localContents[file])}));
  a.bytes = a.files.reduce((sum,f)=>sum+f.bytes,0); a.manifestSha256=digest(JSON.stringify(a.files));
  await writeFile(path.join(root, "ignored/receipt.json"), JSON.stringify(r));
  for (const mode of ["signature", "bytes", "valid"]) {
    await writeFile(path.join(root, "ignored/calls"), "");
    const result = spawnSync(process.execPath, ["scripts/deploy-pages.mjs"], { cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${path.join(root,"ignored")}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require=${path.join(root,"ignored/no-provider.cjs")}`,
      FIXTURE_ROOT:root, GITHUB_REPOSITORY:"iAnonymous3000/site-behavior-lab", GITHUB_REF:"refs/heads/production",
      GITHUB_EVENT_NAME:"push", GITHUB_SHA:localCommit, RUNNER_TEMP:path.join(root,"ignored"),
      GITHUB_OUTPUT:path.join(root,"ignored/output"), CLOUDFLARE_API_TOKEN:"fixture-only",
      FAIL_SIGNATURE:mode==="signature"?"1":"", SUBSTITUTE:mode==="bytes"?"1":"",
      SITE_BEHAVIOR_LAB_BUILD_COMMIT:"", CF_PAGES_COMMIT_SHA:""
    }});
    assert.notEqual(result.status,0);
    const calls=await readFile(path.join(root,"ignored/calls"),"utf8");
    assert.match(calls,/attestation/, result.stderr);
    if(mode==="signature") assert.doesNotMatch(calls,/"--name","tested-pages-/);
    if(mode==="valid") assert.match(result.stderr,/PROVIDER_BOUNDARY_REACHED/);
    else assert.doesNotMatch(result.stderr,/PROVIDER_BOUNDARY_REACHED/);
    if(mode==="bytes") assert.match(result.stderr,/AssertionError/);
  }
});
