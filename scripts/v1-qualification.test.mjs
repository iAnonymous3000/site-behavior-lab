import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { CASES, createQualificationOrigin, referenceProblems } from "./v1-qualification-lib.mjs";

const events = (arm, id) => [
  { arm, path: `/${id}`, status: 200, secGpc: null },
  { arm, path: "/control.js", status: 200, secGpc: null },
  { arm, path: "/pixel.gif", status: 200, secGpc: null }
];
const run = () => ({ qualityFacts: { status: 200 }, conditions: { gpc: false },
  phases: [{ phaseId: 4, kind: "active-probe" }], evidence: { requests: [
    { url: "http://{label}.example.com/{seg}", domain: "{label}.example.com", resourceType: "script", status: 200 },
    { url: "http://{label}.example.com/{seg}", domain: "{label}.example.com", resourceType: "image", status: 200 }
  ] } });
const pair = (axis) => ({ reportType: "comparison", baseline: run(), variant: run(), experiment: {
  axis, verification: { baseline: { outcome: "passed" }, variant: { outcome: "passed" } }
} });

test("reference server captures GPC and choices from incoming traffic, without a report", async (t) => {
  const origin = createQualificationOrigin();
  t.after(() => { origin.server.closeAllConnections(); origin.server.close(); });
  origin.server.listen(0, "127.0.0.1"); await once(origin.server, "listening");
  origin.setArm("variant");
  const response = await fetch(`http://127.0.0.1:${origin.server.address().port}/realm?gpc=true`, { headers: { "Sec-GPC": "1" } });
  assert.equal(await readResponseTextWithinLimit(response, { maxBytes: 1024, label: "qualification reference response" }), "observed");
  assert.equal(origin.events.length, 1);
  assert.equal(origin.events[0].realmGpc, "true"); assert.equal(origin.events[0].secGpc, "1");
  assert.equal(origin.events[0].arm, "variant");
});

test("single evidence must account for scanner-induced traffic in the active phase", () => {
  const report = { reportType: "single", run: run() };
  const oracle = [...events("single", "single-observation"), { arm: "single", path: "/input" }];
  report.run.evidence.requests.push({ url: "http://{label}.example.net/{seg}", domain: "{label}.example.net", method: "POST", phaseId: 4 });
  assert.deepEqual(referenceProblems("single-observation", report, oracle), []);
  report.run.evidence.requests.at(-1).phaseId = 0;
  assert.ok(referenceProblems("single-observation", report, oracle).some((p) => p.includes("active-probe")));
});

test("self-consistent GPC claims cannot replace server and realm evidence", () => {
  const report = pair("gpc"); report.variant.conditions.gpc = true;
  const oracle = ["baseline", "variant"].flatMap((arm) => [
    ...events(arm, "gpc-intervention").map((e) => ({ ...e, secGpc: arm === "variant" ? "1" : null })),
    { arm, path: "/realm", realmGpc: arm === "variant" ? "true" : "undefined", secGpc: arm === "variant" ? "1" : null }
  ]);
  assert.deepEqual(referenceProblems("gpc-intervention", report, oracle), []);
  oracle.at(-1).realmGpc = "false";
  assert.ok(referenceProblems("gpc-intervention", report, oracle).some((p) => p.includes("realm GPC")));
  assert.ok(referenceProblems("gpc-intervention", report, []).length);
});

test("blocking needs an actual prevented request and a surviving positive control", () => {
  const report = pair("shields");
  report.baseline.evidence.requests.push({ url: "http://{label}.example.org/{seg}/{seg}", domain: "{label}.example.org", resourceType: "script", status: 200, blockedByShields: true });
  report.baseline.verificationFacts = { shields: { requestsActuallyBlocked: 0 } };
  report.variant.verificationFacts = { shields: { requestsActuallyBlocked: 1 } };
  const oracle = [...events("baseline", "blocker-intervention"), ...events("variant", "blocker-intervention"),
    { arm: "baseline", host: "analytics.example.org", path: "/ads/banner.js" }];
  assert.deepEqual(referenceProblems("blocker-intervention", report, oracle), []);
  oracle.push({ arm: "variant", host: "analytics.example.org", path: "/ads/banner.js" });
  assert.ok(referenceProblems("blocker-intervention", report, oracle).some((p) => p.includes("delivery")));
  assert.ok(referenceProblems("blocker-intervention", report, oracle.filter((e) => e.path !== "/control.js")).some((p) => p.includes("positive control")));
});

test("consent must have actual opposed choices and verified arms", () => {
  const report = pair("consent");
  const oracle = [...events("baseline", "consent-intervention"), ...events("variant", "consent-intervention"),
    { arm: "baseline", path: "/realm", choice: "accepted" }, { arm: "variant", path: "/realm", choice: "rejected" },
    { arm: "baseline", path: "/choice", choice: "accepted" }, { arm: "variant", path: "/choice", choice: "rejected" }];
  assert.deepEqual(referenceProblems("consent-intervention", report, oracle), []);
  assert.ok(referenceProblems("consent-intervention", report, oracle.filter((event) => event.path !== "/realm")).some((p) => p.includes("after reload")));
  oracle.at(-1).choice = "accepted";
  assert.ok(referenceProblems("consent-intervention", report, oracle).some((p) => p.includes("contradictory")));
  report.experiment.verification.baseline.outcome = "unknown";
  assert.ok(referenceProblems("consent-intervention", report, oracle).some((p) => p.includes("not verified")));
});

test("a reported successful navigation contradicts the independently failed document", () => {
  const report = { reportType: "single", run: { qualityFacts: { status: 503 } } };
  const oracle = [{ arm: "single", path: "/incomplete-coverage", status: 503 }];
  assert.deepEqual(referenceProblems("incomplete-coverage", report, oracle), []);
  report.run.qualityFacts.status = 200;
  assert.ok(referenceProblems("incomplete-coverage", report, oracle).some((p) => p.includes("document status")));
  assert.equal(CASES.length, 5);
});

test("a missing semantic field cannot silently pass the failed-document presentation check", async () => {
  const { qualificationPresentationProblems } = await import('./v1-qualification-lib.mjs');
  assert.deepEqual(qualificationPresentationProblems('incomplete-coverage', { semantic: { story: 'load-failure', reassuring: false } }), []);
  for (const headline of [{}, {semantics: {reassuring: false}}, {semantic: {story: 'quiet', reassuring: true}}]) {
    assert.ok(qualificationPresentationProblems('incomplete-coverage', headline).length);
  }
});
