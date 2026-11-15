// The S4 runner driver's bookkeeping (investigation/runner/s4/harness/driver-core.mjs): a killed run leaves
// its finished steps, a wait with no answer stops by name, the deliberate crash and kill steps trip
// neither, and the derive step copies one object by pointer. No recorder and no browser run here.
// HARNESS may name a mutated copy of the harness folder.
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const H = process.env.HARNESS ?? fileURLToPath(new URL("../investigation/runner/s4/harness", import.meta.url));
const { createDriverCore } = await import(`${H}/driver-core.mjs`);
const { createRunControl } = await import(`${H}/run-control.mjs`);
const tmp = () => mkdtempSync(path.join(tmpdir(), "s4-d-"));

test("a run killed part way leaves its finished steps and names the running one", async () => {
  const work = tmp(), out = `${tmp()}/out`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./investigation-runner-progress-child.mjs", import.meta.url)), H, work, out]);
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(`${out}/progress.jsonl`) && readFileSync(`${out}/progress.jsonl`, "utf8").includes('"step":"B"')) break;
    await sleep(50);
  }
  child.kill("SIGKILL");
  await new Promise((r) => child.on("close", r));
  const lines = readFileSync(`${out}/progress.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.step}:${l.event}`), ["A:begin", "A:end", "B:begin"]);
  assert.ok(existsSync(`${out}/results/A.stdout.json`));
});

test("a driver wait with no answer stops the run by name within its deadline", async () => {
  const control = createRunControl({ workDir: tmp() });
  const core = createDriverCore({ workDir: tmp(), outDir: tmp(), control, waitMs: 200 });
  core.setStep("07-x");
  const ws = { send() {}, close() {} };
  const client = core.cdpClient(ws);
  client.opened.catch(() => {});
  ws.onopen();
  await client.opened;
  const t0 = Date.now();
  await assert.rejects(client.send("Page.enable"));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(control.state.stopped?.reason, "driver-wait-timeout");
  assert.match(control.state.stopped.detail, /07-x: CDP Page\.enable/);
});

test("the crash and kill-browser steps trip neither the deadline nor the crash counter", async () => {
  const control = createRunControl({ workDir: tmp() });
  const core = createDriverCore({ workDir: tmp(), outDir: tmp(), control, waitMs: 200 });
  const sent = [];
  const ws = { send: (m) => sent.push(JSON.parse(m).method), close() {} };
  const client = core.cdpClient(ws);
  ws.onopen(); await client.opened;
  client.fire("Page.crash");
  await sleep(400);
  assert.deepEqual(sent, ["Page.crash"]);
  assert.equal(control.state.stopped, null);
  // The browser is gone after each deliberate step; neither counts, and each asks for a fresh browser.
  assert.equal(core.afterStep({ name: "10", signal: { kind: "crash" } }, false).freshBrowserNext, true);
  assert.equal(core.afterStep({ name: "11", signal: { kind: "kill-browser" } }, false).freshBrowserNext, true);
  // The next ordinary step runs on the fresh browser, alive afterwards.
  assert.equal(core.afterStep({ name: "12" }, true).freshBrowserNext, false);
  assert.equal(control.state.stopped, null);
  assert.equal(control.state.unexpectedBrowserExits, 0);
  // An ordinary step that loses its browser still counts.
  core.afterStep({ name: "13" }, false);
  assert.equal(control.state.unexpectedBrowserExits, 1);
});

test("derive takes the object at a pointer, and records a missing pointer or an oversized input", async () => {
  const { deriveJsonFile } = await import(`${H}/driver-core.mjs`);
  const { writeFileSync } = await import("node:fs");
  const d = tmp();
  writeFileSync(`${d}/in.json`, JSON.stringify({ normalized_result: { artifact: { sha256: "a", bytes: 1 } } }));
  assert.deepEqual(deriveJsonFile({ from: `${d}/in.json`, pointer: "/normalized_result/artifact", to: `${d}/out.json` }), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(`${d}/out.json`, "utf8")), { sha256: "a", bytes: 1 });
  const missing = deriveJsonFile({ from: `${d}/in.json`, pointer: "/normalized_result/nothing", to: `${d}/x.json` });
  assert.equal(missing.ok, false); assert.ok(!existsSync(`${d}/x.json`));
  assert.equal(deriveJsonFile({ from: `${d}/in.json`, pointer: "/normalized_result", to: `${d}/y.json`, cap: 5 }).ok, false);
});
