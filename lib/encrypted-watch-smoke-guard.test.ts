import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("the encrypted-watch canary proves open-scan coexistence and keeps an actual no-request window", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts/smoke-encrypted-watches.mjs"),
    "utf8"
  );
  assert.match(source, /I_ACKNOWLEDGE_THIS_CREATES_A_LIVE_SCHEDULED_RESCAN/);
  assert.match(source, /I_ACKNOWLEDGE_THIS_IS_AN_OPEN_TURNSTILE_STAGING_DEPLOYMENT/);
  assert.match(source, /normalizedHostname\(baseUrl\) === "scan\.sitebehavior\.org"/);
  assert.match(
    source,
    /health\.authenticated !== false \|\| health\.openAccess !== true \|\| health\.turnstile !== true/
  );
  assert.match(source, /watches\.readiness !== "ready"/);
  assert.match(source, /watches\.creationAuthorization !== "operator"/);
  assert.match(source, /health\.capabilities\?\.scheduledRescans !== false/);
  assert.match(source, /health\.deployment !== expectedDeployment/);
  assert.match(source, /const clientCredential = mintClientCredential\(\)/);
  assert.match(source, /ENCRYPTED_WATCH_SMOKE_WATCH_ACCESS_TOKEN/);
  assert.match(source, /ENCRYPTED_WATCH_SMOKE_TURNSTILE_TOKEN/);
  assert.match(source, /headers: creationHeaders\(clientCredential\.capability/);
  assert.match(source, /x-site-behavior-lab-watch-access-token/);
  assert.doesNotMatch(source, /ENCRYPTED_WATCH_SMOKE_ACCESS_TOKEN/);
  assert.match(source, /site-behavior-lab\/encrypted-watch\/id\/v1/);
  assert.match(source, /randomBytes\(32\)/);

  const waitStart = source.indexOf("await sleep(noRequestMs);");
  const firstStatus = source.indexOf("const initialStatusResponse = await guardedFetch", waitStart);
  assert.ok(waitStart > 0 && firstStatus > waitStart);
  const blindWindow = source.slice(waitStart, firstStatus);
  assert.doesNotMatch(blindWindow, /guardedFetch|\bfetch\(|readAttestedStagingHealth|readJson/);
});

test("the canary validates secret-free loggable URLs and one bounded status read", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts/smoke-encrypted-watches.mjs"),
    "utf8"
  );
  assert.match(source, /assertLoggableUrl\(new URL\(creation\.statusPath/);
  assert.match(source, /assertLoggableUrl\(new URL\(initialRun\.statusPath/);
  assert.match(source, /url\.search \|\| url\.hash/);
  assert.match(source, /raw\.includes\(secret\) \|\| decoded\.includes\(secret\)/);
  assert.match(source, /JSON\.stringify\(watchStatusPayload\)\.includes\(creation\.capability\)/);
  assert.match(source, /JSON\.stringify\(watchStatusPayload\)\.includes\(targetUrl\)/);
  assert.match(source, /the canary deliberately does not poll/i);
  assert.match(source, /const retryDelays = \[0, 1_000, 5_000, 15_000\]/);
  assert.match(source, /response\.status === 404/);
  assert.match(source, /cleanup could not be confirmed after four bounded attempts/i);
  assert.doesNotMatch(source, /retained in-memory capability/);
});

test("package.json exposes the gated encrypted-watch smoke command", async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  assert.equal(
    packageJson.scripts?.["test:smoke:encrypted-watches"],
    "node scripts/smoke-encrypted-watches.mjs"
  );
});
