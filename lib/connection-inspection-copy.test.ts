import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionInspectionRecorder } from "./connection-inspection";
import {
  INSPECT_CONNECTION_LINK,
  INSPECTION_CAVEAT,
  INSPECTION_SEPARATION,
  inspectionGroupSentence,
  inspectionNotListedSentence,
  inspectionPanelCopy,
  inspectionRedirectedSentence,
  inspectionUnobservedSentence,
  inspectionWithoutNamedScriptSentence,
  inspectionWithoutStackSentence
} from "./connection-inspection-copy";
import type { ConnectionInspectionEvidence } from "./connection-inspection-evidence";
import { shownConnectionInspection } from "./connection-inspection-result";
import type { LoadedReport } from "./scan-report-view";

const ADDRESS = "https://pixel.example.net/{seg}";
const PIXEL = "https://pixel.example.net/p.gif";
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const VERDICT_WORDS = /\b(?:caused|causes|proves?|honou?rs?|ignores?|complies|comply)\b/i;

/** The real recorder's evidence for a visit with every kind of count. */
function mixedEvidence(): ConnectionInspectionEvidence {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const recorder = new ConnectionInspectionRecorder(ADDRESS);
  const both = (url: string, type: string, frames: string[] | null, redirect = false) => {
    recorder.observe({
      request: { url },
      type,
      initiator: frames ? { type: "script", stack: { callFrames: frames.map((frame) => ({ url: frame })) } } : { type: "parser" },
      ...(redirect ? { redirectResponse: { status: 302 } } : {})
    });
    recorder.notePageRequest(url);
  };
  both(tag, "Script", null);
  both(loader, "Script", null);
  both(`${PIXEL}?a`, "Fetch", [tag, loader]);
  both(`${PIXEL}?b`, "Fetch", [tag, loader]);
  both(`${PIXEL}?c`, "Fetch", [loader]);
  both(`${PIXEL}?d`, "Image", null);
  both(`${PIXEL}?e`, "Image", null);
  both(`${PIXEL}?f`, "Fetch", [""]);
  both(`${PIXEL}?g`, "Fetch", [tag], true);
  recorder.notePageRequest(`${PIXEL}?worker`);
  const evidence = recorder.evidence();
  assert.ok(evidence);
  return evidence;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;])\s+(?=[A-Z0-9])/);
}

test("the result panel says what the approved copy and the rulings say, in order", () => {
  const copy = inspectionPanelCopy(mixedEvidence());
  assert.equal(copy.heading, "Which scripts asked for https://pixel.example.net/… in this new visit");
  assert.equal(copy.didNotRecur, null);
  assert.deepEqual(copy.lines, [
    "2 requests. Scripts on the call stack, innermost first: static.example.org then cdn.example.net.",
    "1 request. Scripts on the call stack, innermost first: cdn.example.net.",
    "1 of these requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it.",
    "2 requests came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates.",
    "1 request had no script on the call stack with an address this visit requested, so no script is named."
  ]);
  assert.equal(
    copy.caveat,
    "A call stack shows which scripts were running when a request was made, not which one decided to make it. Requests made by workers are not observed."
  );
  assert.equal(copy.unobserved, "1 of this visit's requests to this address was not observed, so nothing is shown for it.");
  assert.equal(
    copy.separation,
    "This new visit is a different observation from the report you came from, so it can neither confirm nor refute that report's row."
  );
});

test("a visit that made no request to the address says so, and nothing else about stacks", () => {
  const none = new ConnectionInspectionRecorder(ADDRESS).evidence();
  assert.ok(none);
  const copy = inspectionPanelCopy(none);
  assert.equal(
    copy.didNotRecur,
    "This new visit made no request to https://pixel.example.net/…. Connections can change between visits, so this does not show the earlier one did not happen."
  );
  assert.deepEqual(copy.lines, []);
  assert.equal(copy.caveat, null);
  assert.equal(copy.unobserved, null);
  assert.equal(copy.separation, INSPECTION_SEPARATION);
});

test("a worker-only connection is not the did-not-recur state", () => {
  const recorder = new ConnectionInspectionRecorder(ADDRESS);
  recorder.notePageRequest(`${PIXEL}?via=worker`);
  const evidence = recorder.evidence();
  assert.ok(evidence);
  const copy = inspectionPanelCopy(evidence);
  assert.equal(copy.didNotRecur, null);
  assert.deepEqual(copy.lines, []);
  assert.equal(copy.caveat, INSPECTION_CAVEAT);
  assert.equal(copy.unobserved, "1 of this visit's requests to this address was not observed, so nothing is shown for it.");
});

test("every count reads in the plural and in the singular, and hosts read as the report shows them", () => {
  assert.equal(
    inspectionGroupSentence({ count: 1_200, hosts: ["{label}.example.com", "{invalid-host}"] }),
    "1,200 requests. Scripts on the call stack, innermost first: *.example.com then host unavailable."
  );
  assert.equal(
    inspectionWithoutStackSentence(3),
    "3 requests came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates."
  );
  assert.equal(
    inspectionRedirectedSentence(4),
    "4 of these requests followed a redirect, so they carry the call stack of the request that started it, and no script is shown for them."
  );
  assert.equal(
    inspectionWithoutNamedScriptSentence(5),
    "5 requests had no script on the call stack with an address this visit requested, so no script is named."
  );
  assert.equal(
    inspectionNotListedSentence(6),
    "6 more requests to this address are not broken down here, because the inspection keeps a bounded number of them."
  );
  assert.equal(inspectionNotListedSentence(1), "1 more request to this address is not broken down here, because the inspection keeps a bounded number of them.");
  assert.equal(inspectionUnobservedSentence(7), "7 of this visit's requests to this address were not observed, so nothing is shown for them.");
  assert.equal(INSPECT_CONNECTION_LINK.label, "Inspect this connection");
  assert.equal(INSPECT_CONNECTION_LINK.name(ADDRESS), "Inspect this connection to https://pixel.example.net/…");
});

test("no sentence is longer than 30 words, holds a dash or a verdict word, or says a script was not involved", () => {
  const copy = inspectionPanelCopy(mixedEvidence());
  const none = inspectionPanelCopy(new ConnectionInspectionRecorder(ADDRESS).evidence()!);
  const texts = [
    copy.heading,
    ...copy.lines,
    copy.caveat ?? "",
    copy.unobserved ?? "",
    copy.separation,
    none.didNotRecur ?? "",
    inspectionNotListedSentence(2),
    // Every count's singular form, which the mixed visit above never reads.
    inspectionGroupSentence({ count: 1, hosts: ["static.example.org", "cdn.example.net"] }),
    inspectionRedirectedSentence(1),
    inspectionWithoutStackSentence(1),
    inspectionWithoutNamedScriptSentence(1),
    inspectionNotListedSentence(1),
    inspectionUnobservedSentence(1),
    INSPECT_CONNECTION_LINK.label
  ];
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
    }
    assert.equal(DASHES.test(text), false, text);
    assert.equal(VERDICT_WORDS.test(text), false, text);
    // Chromium reports a script-created image with no stack, so no line may
    // say a request without one was not started by a script.
    assert.equal(/not by a script/i.test(text), false, text);
  }
});

function shell(inspection?: ConnectionInspectionEvidence): LoadedReport {
  return {
    source: "v2-r2-ephemeral",
    wire: { reportType: "single", ephemeral: { screenshot: null, ...(inspection ? { inspection } : {}) } },
    public: {},
    view: {}
  } as unknown as LoadedReport;
}

test("a result shows the inspection its own scan asked about, and nothing else", () => {
  const evidence = mixedEvidence();
  const asked = { address: ADDRESS, from: "20261022-0123456789abcdef0123456789abcdef" };
  assert.deepEqual(shownConnectionInspection(shell(evidence), asked), { evidence, from: asked.from });
  // A scan that asked about none shows none, whatever the shell carries.
  assert.equal(shownConnectionInspection(shell(evidence), null), null);
  // A shell without the block is not a visit that made no request.
  assert.equal(shownConnectionInspection(shell(), asked), null);
  // Evidence about another address is not this inspection's.
  assert.equal(shownConnectionInspection(shell(evidence), { address: "https://cdn.example.net/{seg}", from: null }), null);
  // Only an r2 single shell carries one.
  assert.equal(shownConnectionInspection({ ...shell(evidence), source: "v2-r2-public" } as unknown as LoadedReport, asked), null);
});
