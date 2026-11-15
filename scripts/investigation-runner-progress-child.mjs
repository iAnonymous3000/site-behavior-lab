// Used by scripts/investigation-runner-driver-core.test.mjs. Stand-in for a driver run that is killed part way: finishes step A, begins step B, then hangs.
import { mkdirSync, writeFileSync } from "node:fs";
const [, , harness, work, out] = process.argv;
const { createDriverCore } = await import(`${harness}/driver-core.mjs`);
mkdirSync(`${work}/results`, { recursive: true }); mkdirSync(out, { recursive: true });
const core = createDriverCore({ workDir: work, outDir: out, control: { stop() {} }, waitMs: 1000 });
core.setStep("A"); core.progress("begin");
writeFileSync(`${work}/results/A.stdout.json`, "{}");
core.progress("end");
core.setStep("B"); core.progress("begin");
setInterval(() => {}, 1000);
