import { readFile } from "node:fs/promises";
import path from "node:path";
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
  | { readonly kind: "submit"; readonly calendars: readonly string[] }
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

    const appended: TransparencyLogAnchor[] = [];
    const failures: string[] = [];
    for (const calendar of mode.calendars) {
      const existing = log.anchors.find(
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

    const rebuilt = buildTransparencyLog(log.entries, [...log.anchors, ...appended]);
    verifyTransparencyLogChain(rebuilt);
    await replaceUtf8FileAtomically(logPath, `${JSON.stringify(rebuilt, null, 2)}\n`, TRANSPARENCY_LOG_JSON_MAX_BYTES);
    console.log(
      `Transparency log written: ${rebuilt.anchors.length} external anchor${rebuilt.anchors.length === 1 ? "" : "s"} ` +
        `(${appended.length} appended). Commit the result; upgrade to a Bitcoin attestation later via --status instructions.`
    );
  } finally {
    await lock.release();
  }
}

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args[0] === "--status" && args.length === 1) return { kind: "status" };
  if (args[0] === "--submit") {
    const calendars: string[] = [];
    for (let index = 1; index < args.length; index += 2) {
      if (args[index] !== "--calendar" || typeof args[index + 1] !== "string") {
        throw new Error("Usage: transparency-log-anchor-cli [--submit [--calendar <url>]... | --status]");
      }
      const url = new URL(args[index + 1]);
      // Local calendars exist only in tests; production aggregation is https.
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
        throw new Error(`Calendar ${url.host} must be reached over https.`);
      }
      calendars.push(url.origin);
    }
    return { kind: "submit", calendars: calendars.length > 0 ? calendars : [...DEFAULT_CALENDARS] };
  }
  throw new Error("Usage: transparency-log-anchor-cli [--submit [--calendar <url>]... | --status]");
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
