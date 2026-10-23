import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionInspectionRecorder } from "./connection-inspection";
import { isConnectionInspectionEvidence, type ConnectionInspectionEvidence } from "./connection-inspection-evidence";

/**
 * The readers' validator, held against what the real builder writes: every
 * case starts from a recorder's own output and changes one thing.
 */

const ADDRESS = "https://pixel.example.net/{seg}";
const PIXEL = "https://pixel.example.net/p.gif";

function payload(url: string, type: string, frames?: string[], redirect = false): Record<string, unknown> {
  return {
    request: { url },
    type,
    initiator: frames
      ? { type: "script", stack: { callFrames: frames.map((frameUrl) => ({ url: frameUrl, functionName: "f", scriptId: "1", lineNumber: 1, columnNumber: 1 })) } }
      : { type: "parser", url: "https://www.example.com/" },
    ...(redirect ? { redirectResponse: { status: 302 } } : {})
  };
}

/** A real recorder's evidence for a visit with every kind of count. */
function builtEvidence(): ConnectionInspectionEvidence {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const recorder = new ConnectionInspectionRecorder(ADDRESS);
  const both = (value: Record<string, unknown>) => {
    recorder.observe(value);
    recorder.notePageRequest((value.request as { url: string }).url);
  };
  both(payload("https://www.example.com/", "Document"));
  both(payload(tag, "Script"));
  both(payload(loader, "Script"));
  both(payload(`${PIXEL}?a`, "Image", [tag, loader]));
  both(payload(`${PIXEL}?b`, "Image", [tag, loader]));
  both(payload(`${PIXEL}?c`, "Image", [loader]));
  both(payload(`${PIXEL}?d`, "Image"));
  both(payload(`${PIXEL}?e`, "Image", [""]));
  both(payload(`${PIXEL}?f`, "Image", [tag], true));
  recorder.notePageRequest(`${PIXEL}?worker`);
  const evidence = recorder.evidence();
  assert.ok(evidence);
  return evidence;
}

function mutated(apply: (draft: Record<string, any>) => void): unknown {
  const draft = structuredClone(builtEvidence()) as Record<string, any>;
  apply(draft);
  return draft;
}

test("the validator accepts what the builder writes, and a visit with no match", () => {
  const evidence = builtEvidence();
  assert.equal(evidence.groups.length, 2);
  assert.equal(isConnectionInspectionEvidence(evidence), true);
  const none = new ConnectionInspectionRecorder(ADDRESS).evidence();
  assert.equal(isConnectionInspectionEvidence(none), true);
  // As a reader receives it: parsed from the wire.
  assert.equal(isConnectionInspectionEvidence(JSON.parse(JSON.stringify(evidence))), true);
});

test("the validator refuses every change to the closed shape or its arithmetic", () => {
  const cases: Array<[string, unknown]> = [
    ["an extra key", mutated((draft) => (draft.stackDepth = 3))],
    ["a missing key", mutated((draft) => delete draft.unobserved)],
    ["an extra group key", mutated((draft) => (draft.groups[0].functionNames = ["f"]))],
    ["a missing group key", mutated((draft) => delete draft.groups[0].namedScripts)],
    ["counts that do not add up", mutated((draft) => (draft.matched += 1))],
    ["a group count that does not add up", mutated((draft) => (draft.groups[1].count += 1))],
    ["a negative count", mutated((draft) => { draft.withoutStack = -1; draft.matched -= 2; })],
    ["a fractional count", mutated((draft) => { draft.unobserved = 0.5; draft.matched -= 0.5; })],
    ["a count as a string", mutated((draft) => (draft.matched = String(draft.matched)))],
    ["an empty group", mutated((draft) => { draft.groups[1].count = 0; draft.withoutStack += 1; })],
    ["five hosts", mutated((draft) => (draft.groups[0].hosts = ["a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com"]))],
    ["no host", mutated((draft) => (draft.groups[0].hosts = []))],
    ["a repeated consecutive host", mutated((draft) => (draft.groups[0].hosts = ["static.example.org", "static.example.org"]))],
    ["a raw IP host", mutated((draft) => (draft.groups[0].hosts = ["203.0.113.9"]))],
    ["a host with a port", mutated((draft) => (draft.groups[0].hosts = ["cdn.example.net:8443"]))],
    ["an uppercase host", mutated((draft) => (draft.groups[0].hosts = ["CDN.example.net"]))],
    ["a raw URL as a host", mutated((draft) => (draft.groups[0].hosts = ["https://cdn.example.net/loader.js"]))],
    ["a named script with a query", mutated((draft) => (draft.groups[0].namedScripts = ["https://cdn.example.net/{seg}?session="]))],
    ["a raw named script", mutated((draft) => (draft.groups[0].namedScripts = ["https://cdn.example.net/loader.js"]))],
    ["a repeated named script", mutated((draft) => (draft.groups[0].namedScripts = ["https://cdn.example.net/{seg}", "https://cdn.example.net/{seg}"]))],
    ["nine named scripts", mutated((draft) => (draft.groups[0].namedScripts = Array.from({ length: 9 }, (_, index) => `https://cdn${index}.example.net/{seg}`)))],
    ["two groups that publish the same stack", mutated((draft) => { draft.groups[1].hosts = draft.groups[0].hosts; draft.groups[1].namedScripts = draft.groups[0].namedScripts; })],
    ["groups listed smallest first", mutated((draft) => draft.groups.reverse())],
    ["twenty-one groups", mutated((draft) => {
      draft.groups = Array.from({ length: 21 }, (_, index) => ({ count: 1, hosts: [`cdn${index}.example.net`], namedScripts: [] }));
      draft.matched = 21 + draft.redirected + draft.withoutStack + draft.withoutNamedScript + draft.notListed + draft.unobserved;
    })],
    ["an address with a query", mutated((draft) => (draft.address = `${ADDRESS}?id=`))],
    ["a raw address", mutated((draft) => (draft.address = PIXEL))],
    ["groups that are not an array", mutated((draft) => (draft.groups = {}))],
    ["an array", [builtEvidence()]],
    ["null", null]
  ];
  for (const [name, value] of cases) {
    assert.equal(isConnectionInspectionEvidence(value), false, name);
  }
});
