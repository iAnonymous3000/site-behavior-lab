// The S5c container tests, run by hand under the machine lock on the host's Node, as S4's were. Never
// part of an npm stage, a gate lane, a required FV suite or a register row. Hosted CI does not run it.
//
// It starts only these commands: one sealed `docker run` per plan (each one attempt in one fresh
// container, with the arguments in dockerRunArgs and nothing else), the kill run's `docker kill`, and
// `docker ps -a` and `docker image inspect` reads. It reads what each run left in its own folder as bounded text and JSON. Nothing a run wrote
// is executed or opened in a browser.
//
// Usage: node run-container-tests.mjs --tag <image> --runs <empty folder> --references <host reference set>
//        [--only <plan,plan>] [--expect-fail <test,test>]
// --references is the reference set built on the host from the same commit, by steps/reference-set.cjs; its
// digest must equal the one each capture record carries, so the texts test 19 looks for are the image's.
// With --expect-fail (a mutant image), the run passes only if each named test fails.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CONTAINMENT_MAX_EXCESS } from "./runner/labels.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []));
const TAG = args.tag;
const RUNS = args.runs;
const PLANS = JSON.parse(readFileSync(new URL("./plans/plans.json", import.meta.url), "utf8"));
const TOKEN = PLANS.defaults.standin.token;
const MARKER = "investigationSeamVisit";
const KILL_WAIT_MS = 120_000;
const HOST_LIMIT_MS = 960_000;
const FILE_CAP = 64 * 1024 * 1024;
if (!TAG || !RUNS || !args.references) { console.error("usage: --tag <image> --runs <folder> --references <file>"); process.exit(64); }
const references = JSON.parse(readFileSync(args.references, "utf8"));
const sha256Of = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const require = createRequire(import.meta.url);
const shapes = require("../../../.investigation-test-dist/investigation/core/recorder-shapes-6-8-0.js");
const baseShapes = require("../../../.investigation-test-dist/investigation/core/recorder-shapes.js");

const only = args.only ? args.only.split(",") : null;
const expectFail = args["expect-fail"] ? args["expect-fail"].split(",") : null;
const runs = {};
const log = [];
const load = () => loadavg().map((n) => Number(n.toFixed(2)));

function dockerRunArgs(plan, name, out) {
  return ["run", "--rm", "--name", name, "--pull=never", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--tmpfs", "/work:rw,size=512m,mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1001:1001",
    "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "1024", "--shm-size", "256m",
    "-v", `${out}:/out:rw`, TAG, plan];
}

function gone(name) {
  const ps = spawnSync("docker", ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.trim() === "";
}

/** One sealed run. With kill, docker kill once the stand-in holds capture-began. */
async function run(plan, { kill = false } = {}) {
  const name = `s5c-${plan}`;
  const out = join(RUNS, plan);
  if (existsSync(out)) throw new Error(`${out} exists: each run needs a new, empty folder`);
  mkdirSync(out);
  const started = new Date();
  const loadAtStart = load();
  const console_ = [];
  const child = spawn("docker", dockerRunArgs(plan, name, out), { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => console_.push(d));
  child.stderr.on("data", (d) => console_.push(d));
  const limit = setTimeout(() => spawnSync("docker", ["kill", name]), HOST_LIMIT_MS);
  let killedAt = null;
  if (kill) {
    const until = Date.now() + KILL_WAIT_MS;
    while (Date.now() < until && killedAt === null) {
      await new Promise((r) => setTimeout(r, 1000));
      if (readCalls(out).some((c) => c.event?.type === "capture-began" && c.answer?.ok === true)) {
        spawnSync("docker", ["kill", name]);
        killedAt = new Date();
      }
    }
  }
  const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(limit);
  writeFileSync(`${out}.console.txt`, Buffer.concat(console_));
  const record = { plan, started: started.toISOString(), ended: new Date().toISOString(), loadAtStart, loadAtEnd: load(), exit, killedAt: killedAt?.toISOString() ?? null, containerGone: gone(name) };
  log.push(record);
  runs[plan] = { ...record, out };
  console.log(JSON.stringify(record));
  return runs[plan];
}

const readText = (file) => (existsSync(file) && statSync(file).size <= FILE_CAP ? readFileSync(file, "utf8") : null);
const readJson = (file) => { const t = readText(file); try { return t === null ? null : JSON.parse(t); } catch { return null; } };
function readCalls(out) {
  const text = readText(join(out, "standin", "calls.jsonl"));
  if (text === null) return [];
  return text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
const accepted = (r) => readCalls(r.out).filter((c) => c.call === "runner" && c.answer?.ok === true).map((c) => c.event);
const objectFiles = (r) => { const d = join(r.out, "standin", "objects"); return existsSync(d) ? readdirSync(d) : []; };
const objectJson = (r, digest) => readJson(join(r.out, "standin", "objects", digest));
const rowsOf = (r) => accepted(r).filter((e) => e.type === "evidence-recorded").map((e) => e.data.row);
const rowOf = (r, instrument) => rowsOf(r).find((row) => row.instrument === instrument) ?? null;
const summary = (r) => readJson(join(r.out, "runner", "summary.json"));
const complete = (r) => readJson(join(r.out, "runner", "COMPLETE"))?.complete === true;
/** The runs that end without a whole result, by design: the marker must be absent from each. */
const CUT_SHORT = ["kill", "crash", "large-post"];
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile());
}
function leaves(value, path, outMap) {
  if (value !== null && typeof value === "object") {
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value).sort();
    if (keys.length === 0) outMap.set(path, Array.isArray(value) ? "[]" : "{}");
    for (const k of keys) leaves(value[k], `${path}/${k}`, outMap);
    return outMap;
  }
  outMap.set(path, JSON.stringify(value));
  return outMap;
}
function diffPaths(a, b) {
  const l = leaves(a, "", new Map());
  const r = leaves(b, "", new Map());
  return [...new Set([...l.keys(), ...r.keys()])].filter((p) => l.get(p) !== r.get(p)).sort();
}

// ---- the tests ---------------------------------------------------------------------------------
const results = [];
function check(id, title, body) {
  try {
    const detail = body();
    results.push({ id, title, ok: true, detail: detail ?? null });
  } catch (error) {
    results.push({ id, title, ok: false, detail: String(error?.message ?? error).slice(0, 2000) });
  }
}
function must(condition, message) { if (!condition) throw new Error(message); }
/** One instrument's stored object, read only through an assertion that names a missing row or object. */
function stored(r, instrument) {
  const row = rowOf(r, instrument);
  must(row, `${r.plan}: no ${instrument} row, so no ${instrument === "runner" ? "capture record" : `${instrument} object`} for this plan`);
  const value = objectJson(r, row.digest);
  must(value !== null && value !== undefined, `${r.plan}: the ${instrument} row names ${row.digest}, which is not stored or not JSON`);
  return value;
}
const captureRecord = (r) => stored(r, "runner");
function nonEmpty(list, what) { must(Array.isArray(list) && list.length > 0, `${what}: the set is empty`); return list; }
const have = (...plans) => plans.every((p) => runs[p]);
const types = (r) => accepted(r).map((e) => e.type);

const INSTRUMENTED_CLEAN = ["s3-page-instrumented", "s3-reads-seam-instrumented", "ref-default", "ref-gpc", "ref-consent", "overlap-instrumented", "retried-start", "stale-head"];
const BASELINE_CLEAN = ["s3-page-baseline", "s3-reads-seam-baseline", "standin-host", "overlap-baseline-a", "overlap-baseline-b", "d3-empty-a", "d3-empty-b", "d3-no-seam"];
const clean = () => [...INSTRUMENTED_CLEAN, ...BASELINE_CLEAN].filter((p) => runs[p]);
const instrumentedClean = () => INSTRUMENTED_CLEAN.filter((p) => runs[p]);

function cleanShape(r) {
  must(r.exit === 0, `${r.plan}: exit ${r.exit}`);
  must(complete(r), `${r.plan}: no completion marker, so the run may have been cut short`);
  const t = types(r);
  must(t[t.length - 1] === "cleanup-confirmed", `${r.plan}: last event ${t[t.length - 1]}`);
  const fin = accepted(r).find((e) => e.type === "attempt-finished");
  must(fin?.data.outcome === "usable", `${r.plan}: outcome ${fin?.data.outcome}`);
}
function breakShape(r, reason) {
  must(r.exit === 4, `${r.plan}: exit ${r.exit}, not the break's 4`);
  must(JSON.stringify(types(r)) === JSON.stringify(["capture-began", "source-recorded", "attempt-finished", "cleanup-unconfirmed"]), `${r.plan}: events ${types(r).join(",")}`);
  const fin = accepted(r).find((e) => e.type === "attempt-finished");
  must(fin.data.outcome === "failed" && fin.data.reason === reason, `${r.plan}: ${fin.data.outcome} ${fin.data.reason}`);
  must(objectFiles(r).length === 0, `${r.plan}: ${objectFiles(r).length} objects stored`);
  must(!readCalls(r.out).some((c) => c.call === "runner-object"), `${r.plan}: a runner-object call reached the stand-in`);
  must(r.containerGone, `${r.plan}: the container is still there`);
  must(readCalls(r.out).filter((c) => c.call === "runner-token").length === 1, `${r.plan}: a second attempt asked for a token`);
}

function runTests() {
  check(1, "a baseline and an instrumented visit of each S3 fixture page", () => {
    const plans = nonEmpty(["s3-page-baseline", "s3-page-instrumented", "s3-reads-seam-baseline", "s3-reads-seam-instrumented"].filter((p) => runs[p]), "S3 runs");
    must(plans.length === 4, `only ${plans.length} of the 4 S3 runs ran`);
    for (const p of plans) {
      cleanShape(runs[p]);
      const want = p.endsWith("instrumented") ? ["scanner", "rea-observe", "rea-inspect", "runner"] : ["scanner", "runner"];
      must(JSON.stringify(rowsOf(runs[p]).map((r) => r.instrument).sort()) === JSON.stringify([...want].sort()), `${p}: rows ${rowsOf(runs[p]).map((r) => r.instrument)}`);
    }
  });
  check(2, "the recorder's outputs are read by recorder-shapes-6-8-0.ts, raw inside the container and stored here", () => {
    const seen = [];
    for (const p of nonEmpty(instrumentedClean(), "instrumented runs")) {
      const s = summary(runs[p]);
      must(s?.visit?.recorder?.observe?.read === true && s.visit.recorder.inspect?.read === true, `${p}: the raw outputs were not read in the container`);
      const observe = shapes.readObserveOutput680("observe.json", stored(runs[p], "rea-observe"));
      const inspect = shapes.readInspectOutput680("inspect.json", stored(runs[p], "rea-inspect"));
      must(!baseShapes.isShapeRefusal(observe), `${p}: stored observe copy refused: ${JSON.stringify(observe)}`);
      must(!baseShapes.isShapeRefusal(inspect), `${p}: stored inspect copy refused: ${JSON.stringify(inspect)}`);
      seen.push(p);
    }
    return { read: seen.length };
  });
  check(3, "the large-POST attempt: failed, cleanup unconfirmed, no object, no row, the container gone, no second attempt", () => {
    must(runs["large-post"], "large-post did not run");
    breakShape(runs["large-post"], "observation-ended");
  });
  check(4, "a page crash writes failed then cleanup-unconfirmed; a kill leaves nothing after it, no row, no outcome, the container gone", () => {
    must(runs.crash && runs.kill, "crash or kill did not run");
    breakShape(runs.crash, "page-crashed");
    const k = runs.kill;
    must(k.killedAt !== null, "the kill was never sent: no capture-began within the wait");
    const calls = readCalls(k.out);
    must(calls.every((c) => c.t <= k.killedAt), "a call reached the stand-in after the kill");
    must(!types(k).includes("attempt-finished") && rowsOf(k).length === 0 && objectFiles(k).length === 0, `kill: events ${types(k)}`);
    must(k.containerGone, "kill: the container is still there");
  });
  check(5, "a page request to the stand-in's host is refused by the scanner's guard, by its own sentence; the stand-in's request log is a reading fixture mode cannot falsify", () => {
    const r = runs["standin-host"];
    must(r, "standin-host did not run");
    cleanShape(r);
    // A reading, not a guard (the 2026-11-16T00:31:09Z ruling): in fixture mode the
    // scanner's connectProxyUpstreamForTests sends every upstream connection to the fixture origin, so
    // no page request can reach the stand-in whatever the guard does, and no assertion on this log can
    // fail. It is recorded in the detail. The real check is S5e's, where a handler exists.
    const requestsAtStandin = (readText(join(r.out, "standin", "requests.jsonl")) ?? "").split("\n").filter(Boolean).length;
    // The scanner redacts a non-public target's URL in its result, so the refusal is read from its own
    // guard's sentence (lib/scanner.ts, a non-public-address block at connection time), which a run
    // whose page asks for no local host does not carry.
    const GUARD = "Blocked one or more requests that resolved to local or private network addresses at connection time.";
    const result = stored(r, "scanner");
    must(Array.isArray(result.warnings) && result.warnings.includes(GUARD), "the scanner's result does not say its guard blocked a local address");
    const control = runs["d3-empty-a"];
    must(control && !stored(control, "scanner").warnings.includes(GUARD), "the control run carries the guard's sentence too, so it does not tell this run's refusal apart");
    const failed = result.requests.filter((q) => q.status === null && q.url === "{invalid-url}");
    must(failed.length === 2, `${failed.length} page requests with no status, not the two the page made`);
    return { guardSentence: true, requestsWithNoStatus: failed.map((q) => q.resourceType), requestsAtStandin, requestsAtStandinIs: "a reading fixture mode cannot falsify" };
  });
  check(6, "the token canary is absent from every output, error and progress file", () => {
    let files = 0;
    for (const r of nonEmpty(Object.values(runs), "runs")) {
      for (const f of [...filesUnder(r.out), `${r.out}.console.txt`]) {
        files += 1;
        const text = readFileSync(f).toString("latin1");
        must(!text.includes(TOKEN), `the canary is in ${f}`);
      }
    }
    must(files > 0, "no file was read");
    return { files };
  });
  check(7, "no storage credential in any environment; the token in no environment variable", () => {
    let checked = 0;
    for (const p of nonEmpty(clean(), "clean runs")) {
      const env = captureRecord(runs[p]).environment;
      must(env, `${p}: no environment reading`);
      const readable = env.processes.filter((x) => x.readable);
      must(readable.some((x) => x.kind === "runner") && readable.some((x) => x.kind === "browser"), `${p}: the runner's or the browser's environment was not read`);
      for (const x of readable) { must(x.tokenPresent === false, `${p}: the token is in a ${x.kind} environment`); must(x.credentialNames.length === 0, `${p}: ${x.kind} has ${x.credentialNames}`); checked += 1; }
      must(env.recorderCredentialNames.length === 0, `${p}: the recorder's environment names ${env.recorderCredentialNames}`);
    }
    const image = spawnSync("docker", ["image", "inspect", TAG, "--format", "{{json .Config.Env}}"], { encoding: "utf8" });
    const names = JSON.parse(image.stdout).map((e) => e.split("=")[0]);
    must(!names.some((n) => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^AWS_|^R2_|^CLOUDFLARE_|^CF_/i.test(n)), `the image environment names ${names}`);
    return { environmentsChecked: checked, imageEnvironment: names };
  });
  check(8, "R-b's overlap test: the scanner's published result with the recorder attached during its measurement, against two baselines", () => {
    must(have("overlap-baseline-a", "overlap-instrumented", "overlap-baseline-b"), "an overlap run is missing");
    const [a, i, b] = ["overlap-baseline-a", "overlap-instrumented", "overlap-baseline-b"].map((p) => { cleanShape(runs[p]); return stored(runs[p], "scanner"); });
    const armed = captureRecord(runs["overlap-instrumented"]).times.recorder["recorder reported armed"];
    must(armed && armed.absent !== true && armed.fromEnvelopeMs < 0, `the recorder reported armed ${armed?.fromEnvelopeMs} ms from the envelope: not attached while the scanner measured, so this run tests no overlap`);
    const noise = diffPaths(a, b);
    const beyond = diffPaths(a, i).filter((p) => !noise.includes(p));
    must(beyond.length === 0, `STOP (R-b): ${beyond.length} paths beyond baseline noise differ: ${beyond.slice(0, 40).join(", ")}`);
    return { noisePaths: noise, armedFromEnvelopeMs: armed.fromEnvelopeMs };
  });
  check(9, "the three reference-set visits, with what stays unidentified by count; their wrapped scanner scripts are still the scanner's under the containment bound, with the excess reported (L-1)", () => {
    must(have("ref-default", "ref-gpc", "ref-consent"), "a reference visit is missing");
    const texts = nonEmpty(references.references.filter((r) => r.length >= references.minChars), "reference texts");
    const out = {};
    for (const p of ["ref-default", "ref-gpc", "ref-consent"]) {
      cleanShape(runs[p]);
      const s = captureRecord(runs[p]).scripts.observe;
      must(s.sources > 0 && s.counts.scanner > 0, `${p}: ${JSON.stringify(s.counts)}`);
      const contained = nonEmpty(s.rows.filter((r) => r.method === "containment"), `${p}: scripts the scanner's by containment`);
      for (const r of contained) must(r.label === "scanner" && Number.isInteger(r.excess) && r.excess > 0 && r.excess <= CONTAINMENT_MAX_EXCESS, `${p}: ${r.scriptId} ${r.reference} excess ${r.excess}`);
      // From the stored output itself, row by row (the rows follow the sources in order): every
      // empty-URL script that holds a reference text is labelled the scanner's. One that is not is a
      // real wrapper the image's bound refused, and its excess is reported.
      const sources = stored(runs[p], "rea-observe")?.normalized_result?.sources;
      must(Array.isArray(sources) && sources.length === s.rows.length, `${p}: the stored observe output's sources do not match the rows`);
      const refused = [];
      let holders = 0;
      sources.forEach((source, i) => {
        const text = source?.source?.text;
        if ((typeof source?.url === "string" ? source.url : "") !== "" || typeof text !== "string") return;
        const holder = texts.find((r) => text.includes(r.text));
        if (!holder) return;
        holders += 1;
        if (s.rows[i].label !== "scanner" || s.rows[i].sha256 !== sha256Of(text)) refused.push(`${holder.name} excess ${text.length - holder.length} labelled ${s.rows[i].label}`);
      });
      must(holders > 0, `${p}: no empty-URL script in the stored output holds a reference text`);
      must(refused.length === 0, `STOP (L-1): a real wrapped script is not labelled the scanner's: ${refused.join(", ")}`);
      out[p] = {
        counts: s.counts,
        identifiedBy: [...new Set(s.rows.filter((r) => r.reference).map((r) => `${r.method} ${r.reference}`))],
        containmentExcess: Object.fromEntries([...new Set(contained.map((r) => r.reference))].map((name) => [name, contained.filter((r) => r.reference === name).map((r) => r.excess)])),
        unidentifiedLengths: s.rows.filter((r) => r.label === "origin-not-identified").map((r) => r.length)
      };
    }
    return out;
  });
  check(10, "D-3: an empty-seam visit records what a no-seam visit records, apart from the mark", () => {
    must(have("d3-empty-a", "d3-empty-b", "d3-no-seam"), "a D-3 run is missing");
    const [a, b, n] = ["d3-empty-a", "d3-empty-b", "d3-no-seam"].map((p) => { cleanShape(runs[p]); return stored(runs[p], "scanner"); });
    must(a[MARKER] !== undefined && b[MARKER] !== undefined && n[MARKER] === undefined, "the mark is not where it should be");
    const noise = diffPaths(a, b);
    const beyond = diffPaths(a, n).filter((p) => !noise.includes(p));
    must(JSON.stringify(beyond) === JSON.stringify([`/${MARKER}`]), `beyond noise: ${beyond.join(", ")}`);
    return { noisePaths: noise };
  });
  check(11, "the P2 route: the port from the browser's own argv in every instrumented visit", () => {
    for (const p of nonEmpty(instrumentedClean(), "instrumented runs")) {
      const p2 = captureRecord(runs[p]).p2;
      must(p2 && p2.method === "P2" && Number.isInteger(p2.port) && p2.argvPort === p2.port && p2.browserProcesses === 1 && p2.fileCheck === "agrees", `${p}: ${JSON.stringify(p2)}`);
    }
  });
  check(12, "a refused token request: no browser, nothing written, exit non-zero", () => {
    const r = runs["token-refused"];
    must(r, "token-refused did not run");
    must(r.exit === 2, `exit ${r.exit}`);
    const calls = readCalls(r.out);
    must(calls.length === 1 && calls[0].call === "runner-token" && calls[0].answer.ok === false, `calls: ${calls.map((c) => c.call)}`);
    const progress = readText(join(r.out, "runner", "progress.jsonl")) ?? "";
    must(/"token-refused"/.test(progress) && !/pageReady|visit-|main-frame/.test(progress), "the runner went past the refusal");
  });
  check(17, "R-a as amended (Q-2): every capture record carries \"recorder started\" and \"recorder reported armed\", each relative to navigation start and to the envelope", () => {
    const out = {};
    for (const p of nonEmpty(instrumentedClean(), "instrumented runs")) {
      const t = captureRecord(runs[p]).times.recorder;
      const started = t["recorder started"];
      const armed = t["recorder reported armed"];
      must(started && Number.isFinite(started.fromNavigationStartMs) && Number.isFinite(started.fromEnvelopeMs), `${p}: recorder started ${JSON.stringify(started)}`);
      must(armed && (armed.absent === true || (Number.isFinite(armed.fromNavigationStartMs) && Number.isFinite(armed.fromEnvelopeMs))), `${p}: recorder reported armed ${JSON.stringify(armed)}`);
      out[p] = { started: [started.fromNavigationStartMs, started.fromEnvelopeMs], armed: armed.absent ? "absent" : [armed.fromNavigationStartMs, armed.fromEnvelopeMs] };
    }
    return out;
  });
  check(18, "R-c: every empty-URL script is scanner or not identified; every HTTP(S) script has its URL and mark; counts sum", () => {
    for (const p of nonEmpty(instrumentedClean(), "instrumented runs")) for (const which of ["observe", "inspect"]) {
      const s = captureRecord(runs[p]).scripts[which];
      nonEmpty(s.rows, `${p} ${which} rows`);
      for (const row of s.rows) {
        if (row.url === null) must(row.label === "scanner" || row.label === "origin-not-identified", `${p}: ${row.scriptId} ${row.label}`);
        else must(row.label === "page-loaded" && /^https?:/.test(row.url) && (row.scope === "inside" || row.scope === "outside"), `${p}: ${row.scriptId}`);
      }
      must(Object.values(s.counts).reduce((x, y) => x + y, 0) === s.sources && s.rows.length === s.sources, `${p}: counts ${JSON.stringify(s.counts)} sources ${s.sources}`);
      must(s.rows.some((row) => row.label === "page-loaded" && row.scope === "inside"), `${p} ${which}: no page script inside the scope`);
    }
  });
  check(19, "no script text in the capture record, any event or any row field; scanner text at the stand-in only inside a stored recorder output; every empty-URL script listed by sha256 with its label", () => {
    const texts = nonEmpty(references.references.filter((r) => r.length >= references.minChars), "reference texts");
    let scanned = 0;
    let listed = 0;
    const inText = (text, t) => text.includes(t) || text.includes(JSON.stringify(t).slice(1, -1));
    for (const p of nonEmpty(instrumentedClean(), "instrumented runs")) {
      const r = runs[p];
      const record = captureRecord(r);
      must(record.scripts.referenceSetSha256 === references.sha256, `${p}: the capture record's reference set is not the host's`);
      const recorderDigests = new Set(["rea-observe", "rea-inspect"].map((i) => { stored(r, i); return rowOf(r, i).digest; }));
      // What the runner writes of its own: the capture record, every event and row (in calls.jsonl).
      const own = [JSON.stringify(record), readText(join(r.out, "standin", "calls.jsonl")) ?? ""];
      // The texts the stored recorder outputs hold, from the outputs themselves.
      const scriptTexts = [];
      for (const which of ["rea-observe", "rea-inspect"]) {
        const value = stored(r, which);
        const walk = (v) => { if (v && typeof v === "object") { if (typeof v.text === "string" && v.text.length >= 40) scriptTexts.push(v.text); for (const c of Object.values(v)) walk(c); } };
        walk(value);
      }
      nonEmpty(scriptTexts, `${p}: script texts in the stored outputs`);
      for (const text of own) {
        scanned += 1;
        for (const t of [...texts.map((x) => x.text), ...scriptTexts]) must(!inText(text, t), `${p}: a script text is in what the runner wrote`);
      }
      for (const f of filesUnder(join(r.out, "standin"))) {
        const base = f.split("/").pop();
        if (recorderDigests.has(base)) continue;
        scanned += 1;
        const text = readFileSync(f, "utf8");
        for (const x of texts) must(!inText(text, x.text), `${p}: ${x.name} is in ${f}, which is not a stored recorder output`);
      }
      const observe = stored(r, "rea-observe");
      const labelled = new Map(record.scripts.observe.rows.map((row) => [row.scriptId, row]));
      for (const source of observe.normalized_result.sources.filter((x) => x.url === "")) {
        const row = labelled.get(String(source.script_id));
        must(row && row.sha256 !== null && (row.label === "scanner" || row.label === "origin-not-identified"), `${p}: empty-URL script ${source.script_id} is not listed with a sha256 and a label`);
        listed += 1;
      }
    }
    must(listed > 0, "no empty-URL script was listed");
    return { scanned, emptyUrlScriptsListed: listed, references: texts.length };
  });
  check("complete", "every whole run ends with its completion marker; the three cut-short runs have none", () => {
    const out = {};
    for (const r of nonEmpty(Object.values(runs), "runs")) {
      if (CUT_SHORT.includes(r.plan)) {
        must(!complete(r), `${r.plan}: a completion marker in a run that should have none`);
        const calls = readCalls(r.out);
        out[r.plan] = { lastWholeRecord: calls.length ? { n: calls[calls.length - 1].n, call: calls[calls.length - 1].call, type: calls[calls.length - 1].event?.type ?? null } : null };
      } else must(complete(r), `${r.plan}: no completion marker`);
    }
    return out;
  });
  check(20, "one instrument-recorded per instrument; the capture record is one bundled object with one row", () => {
    for (const p of nonEmpty(clean(), "clean runs")) {
      const inst = accepted(runs[p]).filter((e) => e.type === "instrument-recorded").map((e) => e.data.instrument);
      const rows = rowsOf(runs[p]);
      must(new Set(inst).size === inst.length && JSON.stringify([...inst].sort()) === JSON.stringify(rows.map((r) => r.instrument).sort()), `${p}: instruments ${inst} rows ${rows.map((r) => r.instrument)}`);
      must(rows.filter((r) => r.instrument === "runner").length === 1, `${p}: capture record rows`);
    }
  });
  check(21, "a retried start stays in one runner process and asks for the token once", () => {
    const r = runs["retried-start"];
    must(r, "retried-start did not run");
    cleanShape(r);
    must(readCalls(r.out).filter((c) => c.call === "runner-token").length === 1, "the token was asked for more than once");
    const t = types(r);
    must(t[0] === "attempt-start-retried" && t[1] === "capture-began", `events ${t.slice(0, 3)}`);
  });
  check(22, "one container run makes one attempt in one browser", () => {
    for (const r of nonEmpty(Object.values(runs), "runs")) {
      must(readCalls(r.out).filter((c) => c.call === "runner-token").length <= 1, `${r.plan}: two token requests`);
      must(types(r).filter((t) => t === "capture-began").length <= 1, `${r.plan}: two captures`);
      must(r.containerGone, `${r.plan}: the container is still there`);
    }
    for (const p of instrumentedClean()) must(captureRecord(runs[p]).p2.browserProcesses === 1, `${p}: browser processes`);
  });
  check(23, "O-1: each write uses the head the last answer gave; a stale head is refused as a conflict", () => {
    let chains = 0;
    for (const r of nonEmpty(Object.values(runs), "runs")) {
      let head = null;
      for (const c of readCalls(r.out)) {
        if (c.call === "runner-token" && c.answer.ok) head = c.answer.head;
        else if (c.call === "owner-write") continue;
        else if (c.call === "runner") {
          must(c.viewedHead === head, `${r.plan} call ${c.n}: viewed ${c.viewedHead} where the last answer gave ${head}`);
          if (typeof c.answer.head === "string") head = c.answer.head;
          chains += 1;
        }
      }
    }
    const s = readCalls(runs["stale-head"]?.out ?? "/nonexistent");
    const i = s.findIndex((c) => c.call === "owner-write");
    must(i >= 0 && s[i + 1]?.answer?.refusal === "conflict" && s[i + 2]?.answer?.ok === true && s[i + 2].viewedHead === s[i + 1].answer.head && JSON.stringify(s[i + 2].event) === JSON.stringify(s[i + 1].event), "stale-head: no conflict and resend on the new head");
    return { writesChecked: chains };
  });
  check(24, "every object is stored before a row names it; exactly one source-recorded an attempt", () => {
    for (const r of nonEmpty(Object.values(runs).filter((x) => types(x).includes("capture-began")), "runs that began")) {
      const calls = readCalls(r.out);
      must(types(r).filter((t) => t === "source-recorded").length === 1, `${r.plan}: source-recorded count`);
      calls.forEach((c, i) => {
        if (c.call !== "runner" || c.event?.type !== "evidence-recorded") return;
        const d = c.event.data.row.digest;
        must(calls.slice(0, i).some((o) => o.call === "runner-object" && o.answer.digest === d) && existsSync(join(r.out, "standin", "objects", d)), `${r.plan}: row ${c.event.data.row.id} names an object not stored before it`);
      });
    }
  });
  check("decode", "every event the stand-in took decodes with core's decodeEvent", () => {
    let n = 0;
    for (const r of nonEmpty(Object.values(runs), "runs")) for (const c of readCalls(r.out)) if (c.call === "runner") { must(c.decoded === "ok", `${r.plan} call ${c.n}: ${c.decoded}`); n += 1; }
    must(n > 0, "no event was read");
    return { events: n };
  });
}

const ORDER = ["s3-page-baseline", "s3-page-instrumented", "s3-reads-seam-baseline", "s3-reads-seam-instrumented", "large-post", "crash", "standin-host", "token-refused", "ref-default", "ref-gpc", "ref-consent", "overlap-baseline-a", "overlap-instrumented", "overlap-baseline-b", "d3-empty-a", "d3-empty-b", "d3-no-seam", "retried-start", "stale-head"];
for (const plan of ORDER) if (!only || only.includes(plan)) await run(plan);
if (!only || only.includes("kill")) await run("kill", { kill: true });
runTests();
const wanted = only ? results.filter((r) => !expectFail || expectFail.includes(String(r.id))) : results;
const verdict = expectFail ? expectFail.every((id) => results.find((r) => String(r.id) === id)?.ok === false) : wanted.every((r) => r.ok);
writeFileSync(join(RUNS, "results.json"), JSON.stringify({ tag: TAG, runs: log, results, expectFail, verdict }, null, 1));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.title}${r.ok ? "" : `: ${r.detail}`}`);
console.log(verdict ? "VERDICT pass" : "VERDICT fail");
process.exit(verdict ? 0 : 1);
