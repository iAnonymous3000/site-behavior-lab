import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import workerThreads, { type Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import {
  extractPolicyTextFromPdf,
  MAX_POLICY_PDF_BYTES,
  MAX_POLICY_PDF_PAGES,
  MAX_POLICY_PDF_PARSE_MEMORY_MB,
  MAX_POLICY_PDF_PARSE_MS,
  parsePolicyPdf,
  POLICY_PDF_MEMORY_MONITOR,
  type PolicyPdfParse
} from "./policy-pdf";
import { extractPolicyClaims } from "./privacy-policy";

// Taken before any test mocks them, so a test can still reach the real ones.
const ParseThread = workerThreads.Worker;
const readThreadMemory = ParseThread.prototype.getHeapStatistics;
const MEMORY_LIMIT_BYTES = MAX_POLICY_PDF_PARSE_MEMORY_MB * 1024 * 1024;

test("extractPolicyTextFromPdf reads a bounded text policy", async () => {
  const policyText =
    "Privacy Policy. We collect information and use cookies for analytics. ".repeat(12);
  const extracted = await extractPolicyTextFromPdf(pdfWithText(policyText), 10_000);

  assert.ok(extracted?.startsWith("Privacy Policy."));
  assert.ok((extracted?.length ?? 0) >= 500);
});

test("extractPolicyTextFromPdf reads a CID-keyed TrebuchetMS with no font program by its Mac glyph order", async () => {
  // A composite TrebuchetMS that embeds no font program and no ToUnicode map
  // can only be read by guessing its glyph order. pdf.js 6.3, which
  // policy-text-cross-check@8 reads with, takes the Macintosh order the font
  // follows; 6.2 took the standard fonts' order, which reads glyph 183 (a
  // right single quote) as a middle dot. That dot cost this sentence the
  // "don't" that makes it a no-cookies claim.
  const sentence = "We don\u2019t use cookies.";
  const glyphIds = Array.from(sentence, (character) => (character === "\u2019" ? 183 : character.charCodeAt(0) - 29));
  const extracted = await extractPolicyTextFromPdf(pdfWithCidFont("TrebuchetMS", glyphIds), 10_000);

  // pdf.js gives the first word gap an item of its own, which the reader joins
  // with spaces, in both versions; the claim matcher collapses whitespace.
  assert.equal(extracted?.replace(/\s+/g, " "), sentence);
  assert.deepEqual(extractPolicyClaims(extracted ?? "").map((claim) => claim.kind), ["no-cookies"]);
});

test("extractPolicyTextFromPdf fails closed on malformed and truncated inputs", async () => {
  const policy = pdfWithText("Privacy Policy. ".repeat(40));

  assert.equal(await extractPolicyTextFromPdf(policy, 20), null);
  assert.equal(await extractPolicyTextFromPdf(new TextEncoder().encode("not a pdf"), 10_000), null);
  assert.equal(
    await extractPolicyTextFromPdf(new Uint8Array(MAX_POLICY_PDF_BYTES + 1), 10_000),
    null
  );
});

test(
  "extractPolicyTextFromPdf reads a policy of the maximum page count inside the parse bounds",
  { timeout: 60_000 },
  async () => {
    const pageText =
      "We collect information and use cookies for analytics and advertising purposes. ".repeat(40);
    const pages = Array.from({ length: MAX_POLICY_PDF_PAGES }, (_, index) =>
      contentStream(`Page ${index + 1}. ${pageText}`)
    );
    const started = Date.now();
    const extracted = await extractPolicyTextFromPdf(flatePdf(pages), 400_000);
    const elapsedMs = Date.now() - started;

    assert.ok(extracted?.startsWith("Page 1. We collect"));
    assert.equal(extracted?.split("\n").length, MAX_POLICY_PDF_PAGES);
    assert.ok(elapsedMs < MAX_POLICY_PDF_PARSE_MS / 2, `a full-size text policy took ${elapsedMs}ms`);
    // The page cap is enforced on the parse thread, where the count is known.
    assert.equal(await extractPolicyTextFromPdf(flatePdf([...pages, pages[0]]), 400_000), null);
  }
);

test(
  "extractPolicyTextFromPdf ends a document that decompresses to hundreds of MB at the memory bound, without stalling the event loop",
  { timeout: 60_000 },
  async (context) => {
    // Under 1 MB on the wire, 192 MB once FlateDecode expands it: three 64 MB
    // string operands on a single page, so neither the byte cap nor the page
    // cap refuses it and the text ceiling is only consulted after the whole
    // page has decoded. Parsed on the main thread this froze the process for
    // longer than a scan is allowed to run, no deadline could interrupt it,
    // and resident memory grew by gigabytes.
    const operand = Buffer.concat([
      Buffer.from("(", "latin1"),
      Buffer.alloc(64 * 1024 * 1024, 0x61),
      Buffer.from(") Tj\n0 -14 Td\n", "latin1")
    ]);
    const bomb = flatePdf([
      Buffer.concat([
        Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n", "latin1"),
        operand,
        operand,
        operand,
        Buffer.from("ET\n", "latin1")
      ])
    ]);
    assert.ok(bomb.byteLength < 1024 * 1024, `the document is ${bomb.byteLength} bytes on the wire`);

    const parseThreads = context.mock.method(workerThreads, "Worker");
    const watch = watchProcess();
    const started = Date.now();
    let extracted: string | null;
    try {
      extracted = await extractPolicyTextFromPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = Date.now() - started;

    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(extracted, null);
    assert.ok(elapsedMs < 10_000, `the memory bound, not the 20s deadline, should have ended it; it took ${elapsedMs}ms`);
    assert.ok(
      watch.peakRssGrowthMb < 3 * MAX_POLICY_PDF_PARSE_MEMORY_MB,
      `resident memory grew by ${watch.peakRssGrowthMb} MB during the parse`
    );
    await assertParseThreadStopped(parseThreads.mock.calls);
  }
);

test(
  "extractPolicyTextFromPdf ends a stream of no-op operators at the memory bound before its decode buffer can keep doubling",
  { timeout: 60_000 },
  async (context) => {
    // What the scanner calls, with the monitor it gets. The heap-heavy shape
    // above is also caught by V8's own heap limit; this one only by the memory
    // poll, so the parse must have taken a reading over the bound and ended in
    // null well inside the 20s deadline. A wrapper that polled late or not at
    // all would let this document run on to text. The test below asserts the
    // reason itself, through parsePolicyPdf.
    const bomb = noOpOperatorPdf(384);
    const readings: number[] = [];
    context.mock.method(ParseThread.prototype, "getHeapStatistics", function (this: Worker) {
      const read = readThreadMemory.call(this);
      read.then(
        (stats) => {
          readings.push(stats.used_heap_size + stats.external_memory);
        },
        () => undefined
      );
      return read;
    });
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = Date.now();
    let extracted: string | null;
    try {
      extracted = await extractPolicyTextFromPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = Date.now() - started;
    const last = readings.at(-1);
    context.diagnostic(
      `ended after ${elapsedMs}ms with ${readings.length} readings, the last ${last === undefined ? "none" : `${Math.round(last / 1024 / 1024)} MB`}, event loop gap ${watch.maxGapMs}ms, resident growth ${watch.peakRssGrowthMb} MB`
    );

    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(extracted, null);
    assert.ok(
      readings.some((bytes) => bytes > MEMORY_LIMIT_BYTES),
      `no reading over the bound was taken in ${readings.length} readings`
    );
    assert.ok(elapsedMs < 10_000, `the memory bound, not the 20s deadline, should have ended it; it took ${elapsedMs}ms`);
    assert.ok(
      watch.peakRssGrowthMb < 3 * MAX_POLICY_PDF_PARSE_MEMORY_MB,
      `resident memory grew by ${watch.peakRssGrowthMb} MB during the parse`
    );
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf ends a stream of no-op operators at the memory bound before its decode buffer can keep doubling, and says the memory limit ended it",
  { timeout: 60_000 },
  async (context) => {
    // The heap-heavy shape above is also caught by V8's own heap limit on the
    // parse thread. This one is not: 384 MB of text-positioning operators
    // produce no text items and almost no heap, while the decoded stream is a
    // typed array outside the heap that pdf.js grows by doubling. Only reading
    // the thread's external memory from outside ends it; the deadline alone
    // would let it reach a gigabyte first. The parse must say the memory limit
    // ended it: a null alone, or an end inside the time, could also be the
    // deadline or a bound that gave up on measuring it.
    const bomb = noOpOperatorPdf(384);
    assert.ok(bomb.byteLength < 2 * 1024 * 1024, `the document is ${bomb.byteLength} bytes on the wire`);

    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = Date.now();
    let parse: PolicyPdfParse;
    try {
      parse = await parsePolicyPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = Date.now() - started;
    reportParse(context, parse, elapsedMs, watch);

    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryLimit", "the memory limit must be what ended this parse");
    assert.ok((parse.memoryBytes ?? 0) > MEMORY_LIMIT_BYTES, `the reading that ended it was ${parse.memoryBytes} bytes`);
    assert.ok(elapsedMs < 10_000, `the memory bound, not the 20s deadline, should have ended it; it took ${elapsedMs}ms`);
    assert.ok(
      watch.peakRssGrowthMb < 3 * MAX_POLICY_PDF_PARSE_MEMORY_MB,
      `resident memory grew by ${watch.peakRssGrowthMb} MB during the parse`
    );
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf reads again after memory reads Node refuses before the parse thread runs, and still ends a stream of no-op operators at the memory bound",
  { timeout: 60_000 },
  async (context) => {
    // Node refuses a read of a thread that is not running yet with
    // ERR_WORKER_NOT_RUNNING. A refused read used to stop every later read, so
    // a thread slower to start than the first poll was never measured again:
    // this document then ran for about 8 s and returned text. Here the polls come
    // every millisecond, so the first reads land before the thread runs and
    // Node itself refuses them, and one refusal once the thread is online
    // would end the parse. The parse must still end at the memory limit.
    const bomb = noOpOperatorPdf(384);
    let refused = 0;
    context.mock.method(ParseThread.prototype, "getHeapStatistics", function (this: Worker) {
      const read = readThreadMemory.call(this);
      read.catch((error: unknown) => {
        if ((error as { code?: unknown }).code === "ERR_WORKER_NOT_RUNNING") refused += 1;
      });
      return read;
    });
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = performance.now();
    let parse: PolicyPdfParse;
    try {
      parse = await parsePolicyPdf(bomb, 400_000, 20_000, { pollMs: 1, stallPolls: 5_000, refusedReads: 1 });
    } finally {
      watch.stop();
    }
    const elapsedMs = performance.now() - started;
    reportParse(context, parse, elapsedMs, watch, `${refused} reads refused by Node`);

    assert.ok(refused >= 1, "Node refused no read before the thread ran, so this run did not test the refusal");
    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryLimit", "the memory limit must still end the parse after refused reads");
    assert.ok((parse.memoryBytes ?? 0) > MEMORY_LIMIT_BYTES, `the reading that ended it was ${parse.memoryBytes} bytes`);
    assert.ok(elapsedMs < 10_000, `the parse ended after ${elapsedMs}ms against a 20s deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf still ends a stream of no-op operators at the memory bound when two memory reads are refused while the thread runs",
  { timeout: 60_000 },
  async (context) => {
    // The two reads after the first one the thread answers get Node's own
    // refusal, so the thread is running when they are refused, and every
    // other read is real, with the default monitor. The next test shows such
    // refusals are counted.
    const bomb = noOpOperatorPdf(384);
    const reader = refusingTwoAfterAnAnswer(await nodeRefusal());
    context.mock.method(ParseThread.prototype, "getHeapStatistics", reader.read);
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = performance.now();
    let parse: PolicyPdfParse;
    try {
      parse = await parsePolicyPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = performance.now() - started;
    reportParse(context, parse, elapsedMs, watch, `${reader.reads} reads, ${reader.refused} refused after the thread answered one`);

    assert.equal(reader.refused, 2, `the parse ended after ${reader.reads} reads, before both refusals`);
    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryLimit", "the memory limit must still end the parse after refused reads");
    assert.ok((parse.memoryBytes ?? 0) > MEMORY_LIMIT_BYTES, `the reading that ended it was ${parse.memoryBytes} bytes`);
    assert.ok(elapsedMs < 10_000, `the parse ended after ${elapsedMs}ms against a 20s deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf counts memory reads refused after the thread has answered one: with a bound of two, they end the parse as refused",
  { timeout: 60_000 },
  async (context) => {
    // The test above shows two such refusals do not end a parse under the
    // default bound of five. This one shows they count towards it: with a
    // bound of two they end the parse. The document is the 48 MB walk, which
    // stays inside the memory bound for over a second, so no other bound can
    // end it first.
    const slow = noOpOperatorPdf(48);
    const reader = refusingTwoAfterAnAnswer(await nodeRefusal());
    context.mock.method(ParseThread.prototype, "getHeapStatistics", reader.read);
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const started = performance.now();
    const parse = await parsePolicyPdf(slow, 400_000, 20_000, { ...POLICY_PDF_MEMORY_MONITOR, refusedReads: 2 });
    const elapsedMs = performance.now() - started;
    reportParse(context, parse, elapsedMs, undefined, `${reader.reads} reads, ${reader.refused} refused after the thread answered one`);

    assert.equal(reader.refused, 2, `the parse ended after ${reader.reads} reads, before both refusals`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryReadsRefused", "two refusals after an answered read must count against a bound of two");
    assert.ok(elapsedMs < 10_000, `the parse ended after ${elapsedMs}ms against a 20s deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf ends a parse whose memory read never settles as stalled, well before the deadline",
  { timeout: 60_000 },
  async (context) => {
    // A read that never settles used to stop every later read for the rest
    // of the parse. With the default monitor it must end the parse once it
    // has stayed unanswered for its 20 polls of 100 ms, and not before.
    assert.deepEqual(POLICY_PDF_MEMORY_MONITOR, { pollMs: 100, stallPolls: 20, refusedReads: 5 });
    const bomb = noOpOperatorPdf(384);
    let reads = 0;
    context.mock.method(ParseThread.prototype, "getHeapStatistics", () => {
      reads += 1;
      return new Promise<never>(() => undefined);
    });
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = performance.now();
    let parse: PolicyPdfParse;
    try {
      parse = await parsePolicyPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = performance.now() - started;
    reportParse(context, parse, elapsedMs, watch, `${reads} reads`);

    assert.equal(reads, 1, "a read still pending must not be followed by another");
    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryReadStalled", "the unanswered read must be what ended this parse");
    const stallMs = POLICY_PDF_MEMORY_MONITOR.stallPolls * POLICY_PDF_MEMORY_MONITOR.pollMs;
    assert.ok(elapsedMs >= stallMs * 0.75, `the parse ended after ${elapsedMs}ms, before a ${stallMs}ms stall`);
    assert.ok(elapsedMs < 10_000, `the parse ended after ${elapsedMs}ms against a 20s deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test(
  "parsePolicyPdf ends a parse whose memory reads keep being refused while the thread runs, well before the deadline",
  { timeout: 60_000 },
  async (context) => {
    // Every read gets Node's own refusal. Refusals before the thread is online
    // are expected; once it is, five of them must end the parse, with the
    // default monitor, and not before.
    assert.deepEqual(POLICY_PDF_MEMORY_MONITOR, { pollMs: 100, stallPolls: 20, refusedReads: 5 });
    const bomb = noOpOperatorPdf(384);
    const refuse = await nodeRefusal();
    let reads = 0;
    context.mock.method(ParseThread.prototype, "getHeapStatistics", () => {
      reads += 1;
      return refuse();
    });
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const terminations = context.mock.method(ParseThread.prototype, "terminate");
    const watch = watchProcess();
    const started = performance.now();
    let parse: PolicyPdfParse;
    try {
      parse = await parsePolicyPdf(bomb, 400_000, 20_000);
    } finally {
      watch.stop();
    }
    const elapsedMs = performance.now() - started;
    reportParse(context, parse, elapsedMs, watch, `${reads} reads, all refused`);

    assert.ok(reads >= POLICY_PDF_MEMORY_MONITOR.refusedReads, `only ${reads} reads were taken`);
    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(parse.text, null);
    assert.equal(parse.end, "memoryReadsRefused", "the refused reads must be what ended this parse");
    const refusalsMs = POLICY_PDF_MEMORY_MONITOR.refusedReads * POLICY_PDF_MEMORY_MONITOR.pollMs;
    assert.ok(elapsedMs >= refusalsMs * 0.75, `the parse ended after ${elapsedMs}ms, before ${refusalsMs}ms of refusals`);
    assert.ok(elapsedMs < 10_000, `the parse ended after ${elapsedMs}ms against a 20s deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
  }
);

test("parsePolicyPdf returns a small policy's text as the parse thread's answer, and stops the thread", { timeout: 60_000 }, async (context) => {
  const policyText = "Privacy Policy. We collect information and use cookies for analytics. ".repeat(12);
  const parseThreads = context.mock.method(workerThreads, "Worker");
  const terminations = context.mock.method(ParseThread.prototype, "terminate");
  const started = performance.now();
  const parse = await parsePolicyPdf(pdfWithText(policyText), 10_000);
  reportParse(context, parse, performance.now() - started);

  assert.equal(parse.end, "answered");
  assert.ok(parse.text?.startsWith("Privacy Policy."));
  assert.ok((parse.text?.length ?? 0) >= 500);
  await assertParseThreadStopped(parseThreads.mock.calls, terminations.mock.calls);
});

test(
  "extractPolicyTextFromPdf ends a parse that outlives its deadline at the deadline, without stalling the event loop",
  { timeout: 60_000 },
  async (context) => {
    // Cheap on memory and slow on CPU: 48 MB of text-positioning operators
    // that pdf.js walks one by one for over a second while the decoded stream
    // stays well inside the memory bound. Only the deadline can end it, and a
    // deadline that merely abandoned the awaiter would leave the walk running
    // on a core the next scan needs.
    const slow = flatePdf([
      Buffer.concat([
        Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n(Privacy) Tj\n", "latin1"),
        Buffer.alloc(48 * 1024 * 1024, "0 0 Td\n", "latin1"),
        Buffer.from("ET\n", "latin1")
      ])
    ]);

    // Observe the actual deadline instead of requiring a coarse wall clock to
    // read at least 500ms. Node timer scheduling can cross that clock's tick
    // boundary at 499ms; that does not mean the parser escaped its deadline.
    const originalSetTimeout = globalThis.setTimeout;
    let deadlineFired = false;
    context.mock.method(globalThis, "setTimeout", (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => originalSetTimeout(() => {
      if (delay === 500) deadlineFired = true;
      callback(...args);
    }, delay));
    const parseThreads = context.mock.method(workerThreads, "Worker");
    const watch = watchProcess();
    const started = performance.now();
    let extracted: string | null;
    try {
      extracted = await extractPolicyTextFromPdf(slow, 400_000, 500);
    } finally {
      watch.stop();
    }
    const elapsedMs = performance.now() - started;

    assert.ok(watch.maxGapMs < 250, `the event loop stalled for ${watch.maxGapMs}ms during the parse`);
    assert.equal(extracted, null);
    assert.equal(deadlineFired, true, "the deadline must end this parse, not an unrelated refusal");
    assert.ok(elapsedMs < 2_000, `the parse returned after ${elapsedMs}ms against a 500ms deadline`);
    await assertParseThreadStopped(parseThreads.mock.calls);
  }
);

test(
  "the stopped-parse check counts the parse thread's own work, not other work in the process",
  { timeout: 60_000 },
  async (context) => {
    // A thread that is not the parse keeps a core busy for the whole check,
    // as teardown, garbage collection and other work in the process can on a
    // loaded host. Charging it to the parse failed a correctly stopped parse.
    const busy = new workerThreads.Worker("for (;;);", { eval: true });
    try {
      const parseThreads = context.mock.method(workerThreads, "Worker");
      const slow = flatePdf([
        Buffer.concat([
          Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n(Privacy) Tj\n", "latin1"),
          Buffer.alloc(48 * 1024 * 1024, "0 0 Td\n", "latin1"),
          Buffer.from("ET\n", "latin1")
        ])
      ]);
      assert.equal(await extractPolicyTextFromPdf(slow, 400_000, 500), null);
      await assertParseThreadStopped(parseThreads.mock.calls);
    } finally {
      await busy.terminate();
    }

    // A thread that keeps working after the parse returns still fails it,
    // however slowly a loaded host lets it run.
    const abandoned = new workerThreads.Worker("for (;;);", { eval: true });
    try {
      await assert.rejects(
        assertParseThreadStopped([{ result: abandoned }]),
        /of its own work after the parse ended/
      );
    } finally {
      await abandoned.terminate();
    }
  }
);

/** A page of 7-byte no-op text-positioning operators, `megabytes` of them once decompressed. */
function noOpOperatorPdf(megabytes: number): Uint8Array {
  return flatePdf([
    Buffer.concat([
      Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n(Privacy) Tj\n", "latin1"),
      Buffer.alloc(megabytes * 1024 * 1024, "0 0 Td\n", "latin1"),
      Buffer.from("ET\n", "latin1")
    ])
  ]);
}

/**
 * Node's own refusal of a memory read, ERR_WORKER_NOT_RUNNING, which it gives
 * for any thread that is not running: here one that has exited.
 */
async function nodeRefusal(): Promise<() => ReturnType<Worker["getHeapStatistics"]>> {
  const stopped = new ParseThread("", { eval: true });
  await once(stopped, "exit");
  const refuse = () => readThreadMemory.call(stopped);
  await assert.rejects(refuse(), { code: "ERR_WORKER_NOT_RUNNING" });
  return refuse;
}

/**
 * A memory reader that refuses the two reads after the first one the thread
 * answers, with Node's own refusal, and reads the thread for real otherwise.
 */
function refusingTwoAfterAnAnswer(refuse: () => ReturnType<Worker["getHeapStatistics"]>): {
  readonly read: (this: Worker) => ReturnType<Worker["getHeapStatistics"]>;
  readonly reads: number;
  readonly refused: number;
} {
  let reads = 0;
  let answered = 0;
  let refused = 0;
  return {
    read(this: Worker) {
      reads += 1;
      if (answered > 0 && refused < 2) {
        refused += 1;
        return refuse();
      }
      const read = readThreadMemory.call(this);
      read.then(
        () => {
          answered += 1;
        },
        () => undefined
      );
      return read;
    },
    get reads() {
      return reads;
    },
    get refused() {
      return refused;
    }
  };
}

/** Writes why and when the parse ended into the test's output, for runs on other hosts. */
function reportParse(
  context: TestContext,
  parse: PolicyPdfParse,
  elapsedMs: number,
  watch?: { readonly maxGapMs: number; readonly peakRssGrowthMb: number },
  note?: string
): void {
  const memory = parse.memoryBytes === null ? "none" : `${Math.round(parse.memoryBytes / 1024 / 1024)} MB`;
  const watched = watch ? `, event loop gap ${watch.maxGapMs}ms, resident growth ${watch.peakRssGrowthMb} MB` : "";
  context.diagnostic(
    `parse ended by ${parse.end} after ${Math.round(elapsedMs)}ms, last memory reading ${memory}${watched}${note ? `, ${note}` : ""}`
  );
}

/** Samples event-loop gaps and resident-memory growth every 10ms until stopped. */
function watchProcess(): { stop: () => void; readonly maxGapMs: number; readonly peakRssGrowthMb: number } {
  const rssAtStart = process.memoryUsage.rss();
  let last = Date.now();
  let maxGapMs = 0;
  let peakRssGrowth = 0;
  const probe = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    peakRssGrowth = Math.max(peakRssGrowth, process.memoryUsage.rss() - rssAtStart);
  }, 10);
  return {
    stop: () => clearInterval(probe),
    get maxGapMs() {
      return maxGapMs;
    },
    get peakRssGrowthMb() {
      return Math.round(peakRssGrowth / 1024 / 1024);
    }
  };
}

/**
 * Stopped, not abandoned. The bound is on the work the parse thread itself
 * does after the call returns, read on that thread, so the teardown of what it
 * decoded, garbage collection on other threads and a loaded host cannot count
 * against it, while a thread left decoding fails however slowly the host lets
 * it run. The check ends when that thread has exited; a thread that neither
 * works nor exits fails at the test's timeout.
 */
async function assertParseThreadStopped(
  calls: ReadonlyArray<{ result: Worker | undefined }>,
  terminations?: ReadonlyArray<{ this: unknown }>
): Promise<void> {
  assert.equal(calls.length, 1, "the parse must run on exactly one thread this test observes");
  const thread = calls[0].result;
  assert.ok(thread, "the parse thread was never constructed");
  if (terminations) {
    assert.equal(
      terminations.filter((call) => call.this === thread).length,
      1,
      "the parse must terminate its thread exactly once"
    );
  }
  if (thread.threadId === -1) return;
  let exited = false;
  const exit = new Promise<undefined>((resolve) =>
    thread.once("exit", () => {
      exited = true;
      resolve(undefined);
    })
  );
  let first: NodeJS.CpuUsage | undefined;
  while (!exited) {
    // Read on the parse thread; a reading asked for as it stops is refused,
    // and one still in flight at exit gives way to the exit.
    const reading: NodeJS.CpuUsage | undefined = await Promise.race([
      thread.cpuUsage().catch((error: unknown) => {
        if (exited || (error as { code?: unknown }).code === "ERR_WORKER_NOT_RUNNING") return undefined;
        throw error;
      }),
      exit
    ]);
    if (reading) {
      const baseline: NodeJS.CpuUsage = first ?? reading;
      first = baseline;
      const workMs: number = (reading.user - baseline.user + reading.system - baseline.system) / 1000;
      assert.ok(workMs < 250, `the parse thread did ${workMs}ms of its own work after the parse ended`);
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 10)), exit]);
  }
}

function contentStream(text: string): Buffer {
  const textCommands = (text.match(/.{1,60}(?:\s|$)/g) ?? [text])
    .map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"))
    .map((line) => `(${line}) Tj\n0 -14 Td`)
    .join("\n");
  return Buffer.from(`BT\n/F1 12 Tf\n72 720 Td\n${textCommands}\nET\n`, "latin1");
}

/** One page per content stream, every stream FlateDecode-compressed. */
function flatePdf(contentStreams: Buffer[]): Uint8Array {
  const objects: string[] = [];
  const streams = new Map<number, Buffer>();
  const kids: string[] = [];
  let next = 4;
  for (const content of contentStreams) {
    const pageNumber = next++;
    const contentNumber = next++;
    kids.push(`${pageNumber} 0 R`);
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    const body = deflateSync(content);
    streams.set(contentNumber, body);
    objects[contentNumber] = `<< /Length ${body.byteLength} /Filter /FlateDecode >>`;
  }
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${contentStreams.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const total = next - 1;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n", "latin1")];
  const offsets = [0];
  let byteLength = parts[0].byteLength;
  for (let index = 1; index <= total; index += 1) {
    offsets.push(byteLength);
    const head = Buffer.from(`${index} 0 obj\n${objects[index]}\n`, "latin1");
    parts.push(head);
    byteLength += head.byteLength;
    const body = streams.get(index);
    if (body) {
      const streamHead = Buffer.from("stream\n", "latin1");
      const streamTail = Buffer.from("\nendstream\n", "latin1");
      parts.push(streamHead, body, streamTail);
      byteLength += streamHead.byteLength + body.byteLength + streamTail.byteLength;
    }
    const tail = Buffer.from("endobj\n", "latin1");
    parts.push(tail);
    byteLength += tail.byteLength;
  }
  const xrefOffset = byteLength;
  const xref = [
    `xref\n0 ${total + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * One line of glyph ids in a composite (Type0, Identity-H) font whose
 * CIDFontType2 descendant embeds no font program and has no ToUnicode map, so
 * the reader has to infer each glyph's character from the font's name.
 */
function pdfWithCidFont(baseFont: string, glyphIds: number[]): Uint8Array {
  const glyphs = glyphIds.map((glyphId) => glyphId.toString(16).padStart(4, "0")).join("");
  const content = `BT\n/F1 12 Tf\n72 720 Td\n<${glyphs}> Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [5 0 R] >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 600 >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>`
  ];
  return pdfWithObjects(objects);
}

function pdfWithText(text: string): Uint8Array {
  const textCommands = (text.match(/.{1,60}(?:\s|$)/g) ?? [text])
    .map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"))
    .map((line) => `(${line}) Tj\n0 -14 Td`)
    .join("\n");
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${textCommands}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`
  ];
  return pdfWithObjects(objects);
}

/** Serializes objects 1..n, in order, with a classic cross-reference table. */
function pdfWithObjects(objects: string[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n", "latin1")];
  const offsets = [0];
  let byteLength = parts[0].byteLength;
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    parts.push(bytes);
    byteLength += bytes.byteLength;
  });
  const xrefOffset = byteLength;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}
