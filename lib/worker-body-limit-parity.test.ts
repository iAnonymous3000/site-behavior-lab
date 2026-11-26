import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MAX_BODY_BYTES } from "./scan-limits";

// The public Worker reads each scan and watch body itself and then forwards it
// to the container, which reads it again under lib/scan-limits.ts. The Worker
// cannot import that module (lib/runtime-boundaries.test.ts keeps it
// Node-only), so it holds its own copy of the limit. If the copies drift, the
// edge accepts bodies the container refuses after Turnstile and admission work
// are spent, or the README's published limit (pinned to lib's value by
// lib/readme-truth-contract.test.ts) overstates what the edge accepts.

const WORKER = "cloudflare/container-worker.ts";
const worker = readFileSync(path.join(process.cwd(), ...WORKER.split("/")), "utf8");

/** The limit argument of each `readRequestBodyWithinLimit(request, <limit>` call. */
function bodyReadLimits(source: string): Array<{ index: number; limit: string }> {
  return [...source.matchAll(/readRequestBodyWithinLimit\(\s*request,\s*([^,)]+?)\s*[,)]/g)].map((match) => ({
    index: match.index ?? -1,
    limit: match[1]
  }));
}

test("the Worker's public body limit equals the container's", () => {
  // Anywhere in the file, so a shadowing declaration in some scope counts.
  const declarations = [...worker.matchAll(/\b(?:const|let|var)\s+MAX_BODY_BYTES\b/g)];
  assert.equal(declarations.length, 1, `${WORKER} must declare MAX_BODY_BYTES exactly once`);
  const literal = worker.match(/^const MAX_BODY_BYTES = ([0-9][0-9_]*);$/m);
  assert.ok(literal, `${WORKER} must declare MAX_BODY_BYTES as one top-level numeric constant`);
  assert.equal(Number(literal[1].replaceAll("_", "")), MAX_BODY_BYTES, `${WORKER} MAX_BODY_BYTES differs from lib/scan-limits.ts`);
});

test("every public scan and watch body read in the Worker uses that limit", () => {
  const reads = bodyReadLimits(worker);
  // The internal coordinator wire has its own larger limit; every other body
  // read is a public one and must use the shared limit.
  assert.deepEqual(
    reads.map((read) => read.limit).sort(),
    ["MAX_BODY_BYTES", "MAX_BODY_BYTES", "MAX_BODY_BYTES", "MAX_BODY_BYTES", "MAX_COORDINATOR_BODY_BYTES"],
    `${WORKER} body reads changed; each public read must use MAX_BODY_BYTES`
  );
  // Each public path, named by the code that leads to its read: v3 scan,
  // durable admission, the phase 1 compatibility path, and watch creation.
  const anchors: Array<[string, string]> = [
    ["v3 scan", 'if (request.method === "POST" && decodedPathname === "/api/v3/scan") {'],
    ["durable admission", "return await withDurableScanJobAdmissionDeadline(async (signal, commitNotAfter) => {"],
    ["phase 1 scan", "// Phase 1 remains a separate compatibility path, but its public body read"],
    ["watch creation", 'if (encryptedWatchesFlagState(env[ENCRYPTED_WATCHES_ENV]) !== "enabled") {\n    return encryptedWatchNotFoundResponse(request, env);\n  }\n\n  const body = await readRequestBodyWithinLimit(']
  ];
  for (const [label, anchor] of anchors) {
    const at = worker.indexOf(anchor);
    assert.notEqual(at, -1, `${WORKER}: the ${label} path could not be located`);
    assert.equal(worker.indexOf(anchor, at + 1), -1, `${WORKER}: the ${label} anchor is not unique`);
    const next = reads.find((read) => read.index > at);
    assert.ok(next, `${WORKER}: the ${label} path has no body read after it`);
    assert.equal(next.limit, "MAX_BODY_BYTES", `${WORKER}: the ${label} body read must use MAX_BODY_BYTES`);
  }
});
