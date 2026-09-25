import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { readBoundedUtf8File } from "./bounded-utf8-file";
import { replaceUtf8FileAtomically } from "./exact-atomic-file";
import {
  buildTransparencyLog,
  parseTransparencyLog,
  verifyTransparencyLogChain,
  type ParsedTransparencyLog,
  type TransparencyLogAnchor
} from "./publication-transparency-log";
import {
  MAX_CALENDAR_RESPONSE_BYTES,
  anchorFromCalendarTimestamp,
  digestHexToBytes,
  inspectOtsProof,
  proofMentionsCalendar,
  readBoundedCalendarResponse
} from "./transparency-log-anchoring";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import { TRANSPARENCY_LOG_JSON_MAX_BYTES } from "./report-resource-limits";

/**
 * Anchors the committed transparency log's chain head in Bitcoin through the
 * OpenTimestamps calendar network, and reports the state of existing anchors.
 *
 * `--submit` posts the current head digest to each calendar and appends one
 * validated anchor per successful reply. Anchoring is redundancy, so one
 * successful calendar is enough to commit; total failure changes nothing and
 * exits nonzero. Re-runs are idempotent per calendar for the current head.
 *
 * `--carry-anchors <path>` names the log on a still-open anchor proposal. Its
 * anchors that are not yet committed are validated against the committed
 * chain and kept ahead of anything this run appends, so a weekly re-run
 * extends the pending proposal instead of replacing it. An OpenTimestamps
 * proof only bounds a head from above, so the earlier pending proof is the
 * tighter bound and must survive; and a head the proposal already anchors is
 * not submitted again. When `$GITHUB_OUTPUT` is set, every submit appends
 * `carried_pending=true|false` to it, before any calendar is contacted: a
 * proposal branch can hold anchors main lacks while this run appends nothing,
 * and the workflow must still open its pull request.
 *
 * `--status` is offline: it revalidates every stored anchor against the
 * recomputed chain and reports its attestation kinds. A fresh anchor carries
 * a calendar's pending promise; the Bitcoin attestation appears after the
 * aggregation window (typically hours) by re-stamping through the standard
 * tooling. Full cryptographic verification is deliberately delegated to that
 * tooling, and this command prints the exact invocation.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */

const LOG_PATH = "public/transparency-log.json";
const CALENDAR_TIMEOUT_MS = 10_000;
const DEFAULT_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com"
] as const;

type Mode =
  | {
      readonly kind: "submit";
      readonly calendars: readonly string[];
      readonly carryAnchorsPath: string | null;
      readonly githubOutput: string | null;
    }
  | { readonly kind: "status" };

async function main(): Promise<void> {
  const mode = parseMode();
  const rootDir = process.cwd();
  const logPath = path.join(rootDir, LOG_PATH);

  if (mode.kind === "status") {
    reportStatus(await readCommittedLog(logPath));
    return;
  }

  const reportsDir = path.join(rootDir, "public", "reports");
  const lock = await acquireReportCorpusLock(reportsDir, "transparency-log-anchor");
  try {
    const log = await readCommittedLog(logPath);
    if (log.head === null || log.entryCount === 0) {
      throw new Error("The transparency log is empty; there is no head to anchor yet.");
    }
    const head = log.head;
    const entryCount = log.entryCount;
    const pending = mode.carryAnchorsPath === null ? [] : await readPendingAnchors(mode.carryAnchorsPath, log);
    const known = [...log.anchors, ...pending];
    if (mode.githubOutput !== null) await appendFile(mode.githubOutput, `carried_pending=${pending.length > 0}\n`);
    if (mode.carryAnchorsPath !== null) {
      console.log(
        `Carried ${pending.length} pending anchor${pending.length === 1 ? "" : "s"} from the open proposal ` +
          `(${pending.length === 0 ? "none beyond the committed log" : "kept ahead of anything appended now"}).`
      );
    }

    const appended: TransparencyLogAnchor[] = [];
    const failures: string[] = [];
    for (const calendar of mode.calendars) {
      const existing = known.find(
        (anchor) => anchor.entryCount === entryCount && anchor.head === head && proofMentionsCalendar(anchor, calendar)
      );
      if (existing) {
        console.log(`Already anchored at ${entryCount} entries by ${new URL(calendar).host}; skipping.`);
        continue;
      }
      try {
        const timestamp = await submitDigest(calendar, head);
        appended.push(anchorFromCalendarTimestamp(entryCount, head, timestamp));
        console.log(`Anchored head ${head.slice(0, 16)}... (${entryCount} entries) at ${new URL(calendar).host}.`);
      } catch (error) {
        failures.push(`${new URL(calendar).host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const failure of failures) console.error(`Calendar failed: ${failure}`);
    if (appended.length === 0) {
      if (failures.length === 0) {
        console.log("Every requested calendar has already anchored this head; nothing to do.");
        return;
      }
      throw new Error("No calendar produced a timestamp; the log is unchanged.");
    }

    const rebuilt = buildTransparencyLog(log.entries, [...known, ...appended]);
    verifyTransparencyLogChain(rebuilt);
    await replaceUtf8FileAtomically(logPath, `${JSON.stringify(rebuilt, null, 2)}\n`, TRANSPARENCY_LOG_JSON_MAX_BYTES);
    console.log(
      `Transparency log written: ${rebuilt.anchors.length} external anchor${rebuilt.anchors.length === 1 ? "" : "s"} ` +
        `(${pending.length} carried, ${appended.length} appended). Commit the result; upgrade to a Bitcoin attestation later via --status instructions.`
    );
  } finally {
    await lock.release();
  }
}

const USAGE =
  "Usage: transparency-log-anchor-cli [--submit [--calendar <url>]... [--carry-anchors <log path>] | --status]";

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args[0] === "--status" && args.length === 1) return { kind: "status" };
  if (args[0] === "--submit") {
    const calendars: string[] = [];
    let carryAnchorsPath: string | null = null;
    for (let index = 1; index < args.length; index += 2) {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0) throw new Error(USAGE);
      if (args[index] === "--carry-anchors" && carryAnchorsPath === null) {
        carryAnchorsPath = path.resolve(value);
        continue;
      }
      if (args[index] !== "--calendar") throw new Error(USAGE);
      const url = new URL(value);
      // Local calendars exist only in tests; production aggregation is https.
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
        throw new Error(`Calendar ${url.host} must be reached over https.`);
      }
      calendars.push(url.origin);
    }
    return {
      kind: "submit",
      calendars: calendars.length > 0 ? calendars : [...DEFAULT_CALENDARS],
      carryAnchorsPath,
      githubOutput: process.env.GITHUB_OUTPUT?.trim() || null
    };
  }
  throw new Error(USAGE);
}

async function readCommittedLog(logPath: string): Promise<ParsedTransparencyLog> {
  const wire = await readFile(logPath, "utf8").catch(() => {
    throw new Error(`${LOG_PATH} is missing; run \`npm run transparency:log\` first.`);
  });
  let value: unknown;
  try {
    value = JSON.parse(wire) as unknown;
  } catch {
    throw new Error(`${LOG_PATH} is not valid JSON.`);
  }
  const parsed = parseTransparencyLog(value);
  // Anchoring a broken chain would witness the breakage as history.
  verifyTransparencyLogChain(parsed);
  return parsed;
}

/**
 * The carried proposal's anchors that the committed log does not hold yet.
 * Everything is re-derived, never trusted: the carried file must parse as a
 * whole log with its own chain intact, every pending proof must commit to the
 * head it names, and the committed chain must reach each of those heads. A
 * pending anchor that would sort below a committed one (a newer anchor landed
 * on main by another route) cannot be appended without reordering committed
 * history, so the run refuses rather than silently dropping a proof.
 */
async function readPendingAnchors(
  carryPath: string,
  log: ParsedTransparencyLog
): Promise<TransparencyLogAnchor[]> {
  const label = "The carried proposal log";
  let value: unknown;
  try {
    value = JSON.parse((await readBoundedUtf8File(carryPath, TRANSPARENCY_LOG_JSON_MAX_BYTES)).contents) as unknown;
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const carried = parseTransparencyLog(value);
  verifyTransparencyLogChain(carried);

  const committed = new Set(log.anchors.map(anchorIdentity));
  const pending = carried.anchors.filter((anchor) => !committed.has(anchorIdentity(anchor)));
  for (const anchor of pending) inspectOtsProof(Buffer.from(anchor.proof, "base64"), anchor.head);
  const union = [...log.anchors, ...pending];
  for (let index = Math.max(1, log.anchors.length); index < union.length; index += 1) {
    if (union[index].entryCount < union[index - 1].entryCount) {
      throw new Error(
        `${label} holds an anchor for ${union[index].entryCount} entries that would follow one for ` +
          `${union[index - 1].entryCount}; anchors must not decrease. Review and delete the proposal branch to discard it.`
      );
    }
  }
  verifyTransparencyLogChain(buildTransparencyLog(log.entries, union));
  return pending;
}

function anchorIdentity(anchor: TransparencyLogAnchor): string {
  return JSON.stringify([anchor.entryCount, anchor.head, anchor.proofType, anchor.proof]);
}

async function submitDigest(calendar: string, headHex: string): Promise<Uint8Array> {
  // digestHexToBytes allocates a fresh 32-byte buffer, so handing fetch the
  // whole underlying ArrayBuffer is exact, not a view over something larger.
  const digest = digestHexToBytes(headHex);
  const response = await fetch(`${calendar}/digest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.opentimestamps.v1",
      Accept: "application/vnd.opentimestamps.v1"
    },
    body: digest.buffer as ArrayBuffer,
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    redirect: "error"
  });
  if (!response.ok) {
    cancelResponseBodyDetached(response);
    throw new Error(`calendar answered HTTP ${response.status}`);
  }
  return readBoundedCalendarResponse(response, MAX_CALENDAR_RESPONSE_BYTES);
}

function cancelResponseBodyDetached(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The HTTP refusal remains authoritative if cleanup is hostile.
  }
}

function reportStatus(log: ParsedTransparencyLog): void {
  if (log.anchors.length === 0) {
    console.log(
      `Transparency log has ${log.entryCount} entries and no external anchors yet. Run \`npm run transparency:log:anchor\`.`
    );
    return;
  }
  for (const [index, anchor] of log.anchors.entries()) {
    const inspection = inspectOtsProof(Buffer.from(anchor.proof, "base64"), anchor.head);
    const state =
      inspection.bitcoinAttestations > 0
        ? `bitcoin-attested (${inspection.bitcoinAttestations})`
        : `pending calendar aggregation (${inspection.pendingAttestations} promise${inspection.pendingAttestations === 1 ? "" : "s"})`;
    console.log(`anchors[${index}]: ${anchor.entryCount} entries, head ${anchor.head.slice(0, 16)}..., ${state}`);
  }
  const newestAnchor = log.anchors[log.anchors.length - 1];
  console.log(
    "Full verification uses the standard OpenTimestamps client: extract one anchor's proof with\n" +
      `  jq -r '.anchors[${log.anchors.length - 1}].proof' ${LOG_PATH} | base64 -d > head.ots\n` +
      `then \`ots upgrade head.ots\` once the Bitcoin attestation exists, and\n` +
      `  ots verify -d ${newestAnchor.head} head.ots\n` +
      "(the -d form is required: the proof anchors a digest, not a file on disk. The final header check needs a local Bitcoin node; without one, `ots info head.ots` still shows the full operation tree and attestations.)"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
