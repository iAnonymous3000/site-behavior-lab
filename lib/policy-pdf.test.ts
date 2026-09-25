import assert from "node:assert/strict";
import { test } from "node:test";
import workerThreads, { type Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import {
  extractPolicyTextFromPdf,
  MAX_POLICY_PDF_BYTES,
  MAX_POLICY_PDF_PAGES,
  MAX_POLICY_PDF_PARSE_MEMORY_MB,
  MAX_POLICY_PDF_PARSE_MS
} from "./policy-pdf";

test("extractPolicyTextFromPdf reads a bounded text policy", async () => {
  const policyText =
    "Privacy Policy. We collect information and use cookies for analytics. ".repeat(12);
  const extracted = await extractPolicyTextFromPdf(pdfWithText(policyText), 10_000);

  assert.ok(extracted?.startsWith("Privacy Policy."));
  assert.ok((extracted?.length ?? 0) >= 500);
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
    // The heap-heavy shape above is also caught by V8's own heap limit on the
    // parse thread. This one is not: 384 MB of text-positioning operators
    // produce no text items and almost no heap, while the decoded stream is a
    // typed array outside the heap that pdf.js grows by doubling. Only reading
    // the thread's external memory from outside ends it; the deadline alone
    // would let it reach a gigabyte first.
    const bomb = flatePdf([
      Buffer.concat([
        Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n(Privacy) Tj\n", "latin1"),
        Buffer.alloc(384 * 1024 * 1024, "0 0 Td\n", "latin1"),
        Buffer.from("ET\n", "latin1")
      ])
    ]);
    assert.ok(bomb.byteLength < 2 * 1024 * 1024, `the document is ${bomb.byteLength} bytes on the wire`);

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
async function assertParseThreadStopped(calls: ReadonlyArray<{ result: Worker | undefined }>): Promise<void> {
  assert.equal(calls.length, 1, "the parse must run on exactly one thread this test observes");
  const thread = calls[0].result;
  assert.ok(thread, "the parse thread was never constructed");
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
