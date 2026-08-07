import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendTransparencyLogEntries,
  buildTransparencyLog,
  parseTransparencyLog,
  verifyTransparencyLogChain
} from "./publication-transparency-log";
import {
  MAX_CALENDAR_RESPONSE_BYTES,
  OTS_HEADER_MAGIC,
  anchorFromCalendarTimestamp,
  buildDetachedOtsProof,
  digestHexToBytes,
  inspectOtsProof,
  proofMentionsCalendar
} from "./transparency-log-anchoring";

const PENDING_TAG = Uint8Array.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const BITCOIN_TAG = Uint8Array.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

function fakeCalendarTimestamp(
  extra: Uint8Array = PENDING_TAG,
  calendarUri = "https://alice.btc.calendar.opentimestamps.org"
): Uint8Array {
  // A plausible pending reply: an append op, then the attestation tag and a
  // URI payload, byte-shaped like real calendar replies without claiming to be
  // one. The structural inspector only requires the tag to be present. Real
  // calendars embed their own URI, which is what re-run attribution reads, so
  // a fake that names somebody else breaks idempotence exactly as it should.
  const uri = new TextEncoder().encode(calendarUri);
  const joined = new Uint8Array(2 + extra.length + 1 + uri.length);
  joined.set([0xf0, 0x10], 0);
  joined.set(extra, 2);
  joined[2 + extra.length] = uri.length;
  joined.set(uri, 3 + extra.length);
  return joined;
}

function chainedEntries(count: number) {
  return appendTransparencyLogEntries(
    [],
    Array.from({ length: count }, (_, index) => ({
      reportId: `20260601-${String(index).padStart(2, "0").repeat(16)}`,
      reportWireSha256: "a".repeat(64),
      publicDigest: "b".repeat(64)
    }))
  );
}

test("a detached proof is exact byte concatenation over the head digest", () => {
  const head = "cd".repeat(32);
  const timestamp = fakeCalendarTimestamp();
  const proof = buildDetachedOtsProof(head, timestamp);

  assert.deepEqual(proof.subarray(0, OTS_HEADER_MAGIC.length), OTS_HEADER_MAGIC);
  assert.equal(proof[OTS_HEADER_MAGIC.length], 0x01, "format version");
  assert.equal(proof[OTS_HEADER_MAGIC.length + 1], 0x08, "sha256 hash op");
  assert.deepEqual(proof.subarray(OTS_HEADER_MAGIC.length + 2, OTS_HEADER_MAGIC.length + 34), digestHexToBytes(head));
  assert.deepEqual(proof.subarray(OTS_HEADER_MAGIC.length + 34), timestamp);

  const inspection = inspectOtsProof(proof, head);
  assert.equal(inspection.pendingAttestations, 1);
  assert.equal(inspection.bitcoinAttestations, 0);
});

test("inspection refuses proofs that do not commit to the claimed head", () => {
  const head = "cd".repeat(32);
  const other = "ef".repeat(32);
  const proof = buildDetachedOtsProof(head, fakeCalendarTimestamp());
  assert.throws(() => inspectOtsProof(proof, other), /different digest/);
});

test("inspection refuses malformed headers, versions, algorithms, and attestation-free proofs", () => {
  const head = "cd".repeat(32);
  const good = buildDetachedOtsProof(head, fakeCalendarTimestamp());

  const badMagic = Uint8Array.from(good);
  badMagic[3] ^= 0xff;
  assert.throws(() => inspectOtsProof(badMagic, head), /header/);

  const badVersion = Uint8Array.from(good);
  badVersion[OTS_HEADER_MAGIC.length] = 0x02;
  assert.throws(() => inspectOtsProof(badVersion, head), /version/);

  const badAlgorithm = Uint8Array.from(good);
  badAlgorithm[OTS_HEADER_MAGIC.length + 1] = 0x02;
  assert.throws(() => inspectOtsProof(badAlgorithm, head), /sha256/);

  assert.throws(() => inspectOtsProof(good.subarray(0, 20), head), /too small/);
  assert.throws(
    () => inspectOtsProof(buildDetachedOtsProof(head, Uint8Array.from([0xf0, 0x10, 0x00])), head),
    /no calendar or Bitcoin attestation/
  );
});

test("a Bitcoin attestation is recognized and reported distinctly from a pending one", () => {
  const head = "cd".repeat(32);
  const proof = buildDetachedOtsProof(head, fakeCalendarTimestamp(BITCOIN_TAG));
  const inspection = inspectOtsProof(proof, head);
  assert.equal(inspection.bitcoinAttestations, 1);
  assert.equal(inspection.pendingAttestations, 0);
});

test("size ceilings hold on both sides of the base64 boundary", () => {
  const head = "cd".repeat(32);
  assert.throws(() => buildDetachedOtsProof(head, new Uint8Array(0)), /empty/);
  assert.throws(
    () => buildDetachedOtsProof(head, new Uint8Array(MAX_CALENDAR_RESPONSE_BYTES + 1)),
    /size ceiling/
  );
});

test("an anchor minted from a calendar reply survives the log's own validator", () => {
  const entries = chainedEntries(3);
  const head = entries[entries.length - 1].entryDigest;
  const anchor = anchorFromCalendarTimestamp(entries.length, head, fakeCalendarTimestamp());

  const log = buildTransparencyLog(entries, [anchor]);
  const parsed = parseTransparencyLog(JSON.parse(JSON.stringify(log)));
  verifyTransparencyLogChain(parsed);
  assert.equal(parsed.anchors.length, 1);

  // Extending the chain keeps the anchor valid: it witnesses a prefix, and
  // prefixes are immutable. This is load-bearing, not a convenience.
  const extended = buildTransparencyLog(chainedEntries(4), [anchor]);
  verifyTransparencyLogChain(parseTransparencyLog(JSON.parse(JSON.stringify(extended))));

  // A REWRITTEN chain is another matter: the same anchor against different
  // bytes at its entry count is rejected by the consumer side that shipped in
  // the log module. The witness cannot be re-pointed.
  const rewrittenEntries = appendTransparencyLogEntries(
    [],
    Array.from({ length: 3 }, (_, index) => ({
      reportId: `20260601-${String(index).padStart(2, "0").repeat(16)}`,
      reportWireSha256: "c".repeat(64),
      publicDigest: "b".repeat(64)
    }))
  );
  const rewritten = buildTransparencyLog(rewrittenEntries, [anchor]);
  assert.throws(() => verifyTransparencyLogChain(parseTransparencyLog(JSON.parse(JSON.stringify(rewritten)))), /attests to/);
});

test("calendar attribution reads the URI out of the pending proof and never invents one", () => {
  const entries = chainedEntries(2);
  const head = entries[entries.length - 1].entryDigest;
  const anchor = anchorFromCalendarTimestamp(entries.length, head, fakeCalendarTimestamp());
  assert.equal(proofMentionsCalendar(anchor, "https://alice.btc.calendar.opentimestamps.org"), true);
  assert.equal(proofMentionsCalendar(anchor, "https://bob.btc.calendar.opentimestamps.org"), false);
});

// ---------------------------------------------------------------------------
// CLI, against a local calendar.

const CLI = path.join(process.cwd(), ".unit-test-dist", "lib", "transparency-log-anchor-cli.js");

async function cliWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-anchor-"));
  await mkdir(path.join(dir, "public", "reports"), { recursive: true });
  const entries = chainedEntries(3);
  const log = buildTransparencyLog(entries, []);
  await writeFile(path.join(dir, "public", "transparency-log.json"), `${JSON.stringify(log, null, 2)}\n`);
  return dir;
}

function runCli(cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

/**
 * The fake calendar lives in THIS process, so the CLI must run asynchronously:
 * a synchronous spawn blocks the event loop and the server can never answer,
 * which deadlocks until the CLI's own network deadline. That deadlock was
 * observed, not theorized, in this test's first draft.
 */
function runCliAsync(
  cwd: string,
  args: readonly string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withCalendar(
  handler: (body: Uint8Array, origin: string) => { status: number; body: Uint8Array },
  run: (origin: string) => Promise<void>
): Promise<void> {
  let origin = "";
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const result = handler(new Uint8Array(Buffer.concat(chunks)), origin);
      response.statusCode = result.status;
      response.end(Buffer.from(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the CLI submits the exact head digest and commits a validated anchor", async () => {
  const dir = await cliWorkspace();
  const logBefore = parseTransparencyLog(JSON.parse(await readFile(path.join(dir, "public", "transparency-log.json"), "utf8")));
  let received: Uint8Array | null = null;

  await withCalendar(
    (body, origin) => {
      received = body;
      return { status: 200, body: fakeCalendarTimestamp(PENDING_TAG, origin) };
    },
    async (origin) => {
      const first = await runCliAsync(dir, ["--submit", "--calendar", origin]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /1 appended/);

      // The calendar received the raw 32-byte head, nothing else.
      assert.deepEqual(received, digestHexToBytes(logBefore.head ?? ""));

      const written = parseTransparencyLog(
        JSON.parse(await readFile(path.join(dir, "public", "transparency-log.json"), "utf8"))
      );
      verifyTransparencyLogChain(written);
      assert.equal(written.anchors.length, 1);
      assert.equal(written.anchors[0].head, logBefore.head);
      assert.equal(written.anchors[0].entryCount, logBefore.entryCount);

      // Idempotent per calendar and head: a re-run appends nothing.
      const second = await runCliAsync(dir, ["--submit", "--calendar", origin]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Already anchored|nothing to do/);
      const unchanged = parseTransparencyLog(
        JSON.parse(await readFile(path.join(dir, "public", "transparency-log.json"), "utf8"))
      );
      assert.equal(unchanged.anchors.length, 1);

      // And status reads it back offline.
      const status = runCli(dir, ["--status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /pending calendar aggregation/);
      assert.match(status.stdout, /ots verify/);
    }
  );
});

test("a failing or oversized calendar changes nothing and the CLI says so", async () => {
  const dir = await cliWorkspace();

  await withCalendar(
    () => ({ status: 500, body: new Uint8Array(0) }),
    async (origin) => {
      const run = await runCliAsync(dir, ["--submit", "--calendar", origin]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /HTTP 500/);
      assert.match(run.stderr, /log is unchanged/);
    }
  );

  await withCalendar(
    () => ({ status: 200, body: new Uint8Array(MAX_CALENDAR_RESPONSE_BYTES + 1) }),
    async (origin) => {
      const run = await runCliAsync(dir, ["--submit", "--calendar", origin]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /size ceiling/);
    }
  );

  const untouched = parseTransparencyLog(
    JSON.parse(await readFile(path.join(dir, "public", "transparency-log.json"), "utf8"))
  );
  assert.equal(untouched.anchors.length, 0);
});

test("the CLI refuses unknown arguments, plaintext calendars, and an empty log", async () => {
  const dir = await cliWorkspace();
  assert.equal(runCli(dir, ["--frobnicate"]).status, 1);
  assert.equal(runCli(dir, ["--submit", "--calendar", "http://calendar.example"]).status, 1);
  assert.match(runCli(dir, ["--submit", "--calendar", "http://calendar.example"]).stderr, /https/);

  const empty = await mkdtemp(path.join(tmpdir(), "sbl-anchor-empty-"));
  await mkdir(path.join(empty, "public", "reports"), { recursive: true });
  await writeFile(
    path.join(empty, "public", "transparency-log.json"),
    `${JSON.stringify(buildTransparencyLog([], []), null, 2)}\n`
  );
  const run = runCli(empty, ["--submit", "--calendar", "https://unused.example"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no head to anchor/);
});
