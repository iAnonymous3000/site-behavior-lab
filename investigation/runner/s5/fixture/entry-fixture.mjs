// The fixture entry (G-6): the only entry this image holds. It reads one plan baked into the image,
// starts the stand-in and the fixture origin inside the container, gives the runner the scanner's
// test options that route the visit to that origin, and runs one attempt. It alone may set the
// scanner's ForTests options, and it alone holds the stand-in.
//
// The token is the plan's canary and comes to the runner only through the stand-in's hand-out: it is
// in no environment variable and in no argument.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { EXIT, runAttempt } from "../runner/core.mjs";
import { handlerClient } from "../runner/handler-client.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { startStandIn } from "./standin.mjs";
import { resolvePublicHost } from "./stub-resolver.mjs";

const OUT = "/out";
const FIXTURE_PORT = 8081;
const STANDIN_PORT = 8790;
const GUARD_PORT = 8899;
const SCAN_ORIGIN = "http://www.example.com";
const BROWSER = "/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux-arm64/chrome-headless-shell";

const name = process.argv[2] ?? "";
mkdirSync(`${OUT}/runner`, { recursive: true });
mkdirSync("/tmp/home", { recursive: true });
const progressFile = `${OUT}/runner/progress.jsonl`;
writeFileSync(progressFile, "");
const progress = (line) => appendFileSync(progressFile, JSON.stringify(line) + "\n");
// The last file of a whole run (the 21:13:44Z ruling): written only after every other file under /out
// is flushed to disk, so a run cut short never reads as a short but whole one. A break is not a whole
// result and writes none; a killed container cannot write it.
const COMPLETE = `${OUT}/runner/COMPLETE`;
const flushAll = (dir) => {
  let files = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = `${dir}/${entry}`;
    if (!statSync(file).isFile()) continue;
    const fd = openSync(file, "r+");
    fsyncSync(fd);
    closeSync(fd);
    files += 1;
  }
  return files;
};
const finish = (summary) => {
  writeFileSync(`${OUT}/runner/summary.json`, JSON.stringify({ plan: name, ...summary }, null, 1));
  if (summary.exit !== EXIT.broken) {
    const files = flushAll(OUT);
    const fd = openSync(COMPLETE, "w");
    writeFileSync(fd, JSON.stringify({ complete: true, filesBefore: files }) + "\n");
    fsyncSync(fd);
    closeSync(fd);
  }
  process.exit(summary.exit);
};

const all = JSON.parse(readFileSync("/opt/s5/plans/plans.json", "utf8"));
if (!/^[a-z0-9-]{1,64}$/.test(name) || !Object.hasOwn(all.plans, name)) finish({ exit: 64, error: "no such plan" });
const raw = { ...all.defaults, ...all.plans[name] };
const build = JSON.parse(readFileSync("/opt/s5/build.json", "utf8"));

const require = createRequire("/opt/scanner/package.json");
const scanner = require("/opt/scanner/dist/lib/scanner.js");
const { partyKey } = require("/opt/scanner/dist/lib/domain-utils.js");
const { decodeEvent } = require("/opt/scanner/dist/investigation/core/case-events.js");
const { RUNNER_EVENT_TYPES, CLEANUP_EVENT_TYPES } = require("/opt/scanner/dist/investigation/core/case-runner.js");
const shapes680 = require("/opt/scanner/dist/investigation/core/recorder-shapes-6-8-0.js");
const shapes = require("/opt/scanner/dist/investigation/core/recorder-shapes.js");

const url = `${SCAN_ORIGIN}${raw.path}`;
const plan = {
  caseId: raw.caseId,
  attemptId: raw.attemptId,
  slot: raw.slot,
  arm: raw.arm,
  origin: SCAN_ORIGIN,
  observeMs: raw.observeMs,
  visitDeadlineMs: raw.visitDeadlineMs,
  // In fixture mode the plan's identity is the image's own build argument (O-4).
  identity: build.identityDigest,
  payload: { url, device: raw.device, gpcEnabled: raw.gpcEnabled, consentMode: raw.consentMode },
  standin: raw.standin
};

await startStandIn({ port: STANDIN_PORT, outDir: `${OUT}/standin`, plan, core: { decodeEvent, RUNNER_EVENT_TYPES, CLEANUP_EVENT_TYPES } });
const { startGuardProxy } = await import("/opt/harness/guard-proxy.mjs");

let fixtureStarted = false;
const result = await runAttempt({
  plan,
  build,
  client: handlerClient(`http://127.0.0.1:${STANDIN_PORT}`),
  scanner,
  partyKey,
  siteKey: partyKey(new URL(url).hostname),
  references: JSON.parse(readFileSync("/opt/s5/reference-set.json", "utf8")),
  domains: JSON.parse(readFileSync("/opt/s5/recorder-domains-6.8.0.json", "utf8")),
  shapes: { readObserveOutput680: shapes680.readObserveOutput680, readInspectOutput680: shapes680.readInspectOutput680, readRecorderFailure: shapes680.readRecorderFailure, isShapeRefusal: shapes.isShapeRefusal },
  browserExecutable: BROWSER,
  progress,
  withoutSeam: raw.arm === "no-seam",
  start: async (tries) => {
    if (raw.failFirstStart === true && tries === 1) throw new Error("the plan makes the first start fail");
    if (!fixtureStarted) { await startFixtureServer({ port: FIXTURE_PORT, standInPort: STANDIN_PORT }); fixtureStarted = true; }
  },
  atCommit: raw.crashAtCommit !== true ? undefined : async (page) => {
    // A page crash, from the browser's own protocol: sent, and nothing waits on its reply.
    const session = await page.context().newCDPSession(page);
    session.send("Page.crash").catch(() => undefined);
  },
  startRecorderGuard: async ({ cdpPort, onRefusal }) => {
    const server = await startGuardProxy({ port: GUARD_PORT, allowedOrigins: [`http://127.0.0.1:${cdpPort}`], logPath: `${OUT}/runner/recorder-guard.jsonl`, onRefusal });
    return { port: GUARD_PORT, close: () => server.close() };
  },
  visitOptions: {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost,
    resolveCnameChain: async () => [],
    connectProxyUpstreamForTests: () => connect(FIXTURE_PORT, "127.0.0.1")
  }
});
finish(result);
