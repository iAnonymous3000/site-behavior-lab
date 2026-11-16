// The production entry (G-6). Not copied into any image S5 builds: S5 builds a fixture image only,
// and the handler this entry calls is a later part's (S5e). It runs one attempt with the scanner's
// ordinary visit options and none of its test options, against the handler at the origin it is
// given. A test holds that this file and every runner module it reaches name no test option of the
// scanner and nothing of the stand-in.
//
// Arguments: the handler's origin, then the path of the attempt's plan, a JSON file the container is
// started with. The token is never an argument or an environment variable: the runner asks the
// handler for it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runAttempt } from "./runner/core.mjs";
import { handlerClient } from "./runner/handler-client.mjs";

const GUARD_PORT = 8899;
const BROWSER = "/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux-arm64/chrome-headless-shell";

const [handlerOrigin, planPath] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(handlerOrigin ?? "") || typeof planPath !== "string") {
  console.error("usage: entry-production.mjs <handler origin on loopback> <plan file>");
  process.exit(64);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const build = JSON.parse(readFileSync("/opt/s5/build.json", "utf8"));
const require = createRequire("/opt/scanner/package.json");
const scanner = require("/opt/scanner/dist/lib/scanner.js");
const { partyKey } = require("/opt/scanner/dist/lib/domain-utils.js");
const shapes680 = require("/opt/scanner/dist/investigation/core/recorder-shapes-6-8-0.js");
const shapes = require("/opt/scanner/dist/investigation/core/recorder-shapes.js");
const { startGuardProxy } = await import("/opt/harness/guard-proxy.mjs");

const result = await runAttempt({
  plan,
  build,
  client: handlerClient(handlerOrigin),
  scanner,
  partyKey,
  siteKey: partyKey(new URL(plan.payload.url).hostname),
  references: JSON.parse(readFileSync("/opt/s5/reference-set.json", "utf8")),
  domains: JSON.parse(readFileSync("/opt/s5/recorder-domains-6.8.0.json", "utf8")),
  shapes: { readObserveOutput680: shapes680.readObserveOutput680, readInspectOutput680: shapes680.readInspectOutput680, readRecorderFailure: shapes680.readRecorderFailure, isShapeRefusal: shapes.isShapeRefusal },
  browserExecutable: BROWSER,
  progress: (line) => console.log(JSON.stringify(line)),
  startRecorderGuard: async ({ cdpPort, onRefusal }) => {
    const server = await startGuardProxy({ port: GUARD_PORT, allowedOrigins: [`http://127.0.0.1:${cdpPort}`], logPath: "/tmp/recorder-guard.jsonl", onRefusal });
    return { port: GUARD_PORT, close: () => server.close() };
  },
  visitOptions: {}
});
process.exit(result.exit);
