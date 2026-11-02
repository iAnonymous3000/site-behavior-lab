import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant } from "../../lib/finite-check";
import { aggregate } from "../core/aggregates";
import { isSlug, MAX_SLUG_CHARS, MAX_TEXT_CHARS } from "../core/case-events";
import { appendCommand, putEvidence } from "../core/case-log";
import type * as caseServiceModule from "../core/case-service";
import { caseServiceOver } from "../core/case-service";
import { aggregateRowsOfCase, type CaseState } from "../core/case-store";
import type { RowReading } from "../core/evidence-model";
import { ADAPTER_NOTE, aggregatesPage, CANNOT_ANSWER, casePage, evidencePage, factPage, formRefusalPage, readingMarkup, refusalPage, rowPage } from "../core/viewer-pages";
import type * as viewerRoutesModule from "../core/viewer-routes";
import { MAX_FORM_BYTES, VIEWER_ROUTES } from "../core/viewer-routes";
import type * as viewerTextModule from "../core/viewer-text";
import { attribute, escapeAttribute, escapeText, hiddenField, html, Markup, MAX_INDENT } from "../core/viewer-text";
import type * as gateModule from "../core/workspace-gate";
import type * as responseModule from "../core/workspace-response";
import { BASE_POLICY, responseHeaders, VIEWER_STYLE, VIEWER_STYLE_HASH } from "../core/workspace-response";
import { ATTEMPT_IDS, CASE_SCRIPT, CONTROL_RUN_ID, digestOfRaw, IDENTITY_ALDER, IDENTITY_BIRCH, logEvent, PLAN_DIGEST, type ScriptCommand } from "./case-fixture";
import { VIEWER_ORIGIN } from "./memory-case-world";
import { NOW_MS } from "./token-fixture";
import { ALPHA_RUN, BLANK_POINTS, blankBits, CODE_RUN, headOf, OWNER_CANARY, OWNER_FIELDS, ownerActorAt, PRIVATE_POINTS, SCRIPT_CANARY, SCRIPT_DIGEST, textOf, UNASSIGNED_POINTS, VIEWER_CASE, viewerWorld, worldWith, type ViewerWorld, type WorldOptions } from "./viewer-fixture";

/**
 * The viewer behind the gate, in this process, over W2's fixture case with escaping canaries
 * planted in every field that holds text. Each ruling W3 was built to is held here by name, and
 * each guard by a variant of the production code it must catch, read from the unmutated bytes.
 * The real-browser walk is viewer-browser.test.ts, and the production entry's own bundle is
 * workspace-entry-workerd.test.ts.
 */

const CASE = `/cases/${VIEWER_CASE}`;

const SAMPLE: Readonly<Record<string, string>> = { case: VIEWER_CASE, slot: "B1", row: "row-b1-coverage", fact: "fact-lantern-host", assertion: "said-thimble-clear", interpretation: "reading-host", digest: SCRIPT_DIGEST };

function concrete(pattern: string): string {
  return pattern.replace(/:([a-z]+)/g, (_, name: string) => SAMPLE[name]);
}

/** Fields each write route accepts on the fixture case, beside the head. */
const FIELDS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "record-fact": [["id", "fact-new"], ["statement", "A new fact."], ["evidence", "row-b1-network"]],
  "supersede-fact": [["statement", "The lantern script's URL names a host the first party serves."], ["reason", "Sharper."]],
  "retract-fact": [["reason", "Withdrawn."]],
  "record-assertion": [["id", "said-new"], ["statement", "Said in passing."]],
  "retract-assertion": [["reason", "Wrong."], ["unknown-id", "unknown-new"], ["unknown-question", "What ran?"], ["unknown-reason", "Nothing showed."]],
  "record-interpretation": [["id", "reading-new"], ["statement", "Reads so."], ["cite", "fact-lantern-ran:1"]],
  "reaffirm-interpretation": [["cite", "fact-lantern-host:2"]]
};

const WRITES = VIEWER_ROUTES.filter(({ method }) => method === "POST");
const READS = VIEWER_ROUTES.filter(({ method }) => method === "GET");

async function headNow(world: ViewerWorld): Promise<string> {
  return headOf(await (await world.send(CASE)).text());
}

function storedHead(world: ViewerWorld): string | null {
  return world.stores.get(VIEWER_CASE)?.head.value ?? null;
}

/** The owner's canary as a page must show it: escaped, with every unseen character a token. Written out by hand. */
const OWNER_ESCAPED = 'CANARY-OWNER &lt;script&gt;window.ownerRan = 1&lt;/script&gt;&lt;/textarea&gt;&quot;&#39;&gt;&lt;b id=&quot;broke-owner&quot;&gt;bold&lt;/b&gt; <span class="ctl">U+202E</span>txet<span class="ctl">U+2069</span> nul<span class="ctl">U+0000</span>end';

const ROUTE_TABLE = [
  "GET /cases/:case",
  "GET /cases/:case/attempts/:slot",
  "GET /cases/:case/attempts/:slot/rows/:row",
  "GET /cases/:case/facts/:fact",
  "GET /cases/:case/aggregates",
  "GET /cases/:case/evidence/:digest",
  "POST /cases/:case/facts",
  "POST /cases/:case/facts/:fact/supersede",
  "POST /cases/:case/facts/:fact/retract",
  "POST /cases/:case/assertions",
  "POST /cases/:case/assertions/:assertion/retract",
  "POST /cases/:case/interpretations",
  "POST /cases/:case/interpretations/:interpretation/reaffirm"
];

/** Addresses no route may answer: what drives the machine, purges, approves, publishes, exports or downloads, and malformed ids. */
const NOT_ROUTES = [
  "/",
  "/cases",
  `${CASE}/`,
  `${CASE}/approve`,
  `${CASE}/publish`,
  `${CASE}/export`,
  `${CASE}/download`,
  `${CASE}/purge`,
  `${CASE}/manifest`,
  `${CASE}/summary`,
  `${CASE}/log`,
  `${CASE}/head`,
  `${CASE}/plan`,
  `${CASE}/start`,
  `${CASE}/attempts/B1/start`,
  `${CASE}/attempts/B1/deadline`,
  `${CASE}/deadline`,
  `${CASE}/cancel`,
  `${CASE}/exception`,
  `${CASE}/rule`,
  `${CASE}/control`,
  `${CASE}/unknowns`,
  `${CASE}/claims`,
  `${CASE}/facts/fact-lantern-ran/approve`,
  `${CASE}/interpretations/reading-host/approve`,
  `${CASE}/interpretations/reading-host/revise`,
  `${CASE}/interpretations/reading-host/withdraw`,
  `${CASE}/evidence/${SCRIPT_DIGEST}/download`,
  `${CASE}/evidence/${SCRIPT_DIGEST}/raw`,
  "/cases/CASE-VIEWER",
  `${CASE}/attempts/B9`,
  `${CASE}/attempts/b1`,
  `${CASE}/facts/Fact-One`,
  `${CASE}/facts/fact%2Done`,
  `${CASE}/evidence/ABC`,
  `${CASE}/evidence/${SCRIPT_DIGEST.toUpperCase()}`
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

const CLOSED = "the viewer answers exactly its route table, by the method each route names, and nothing that approves, publishes, exports, downloads, purges or drives the machine";

async function checkRouteSet(routes: typeof VIEWER_ROUTES, options: WorldOptions): Promise<void> {
  holds(CLOSED, JSON.stringify(routes.map(({ method, path }) => `${method} ${path}`)) === JSON.stringify(ROUTE_TABLE), () => routes);
  const world = await viewerWorld(options);
  const head = await headNow(world);
  for (const path of NOT_ROUTES) {
    for (const method of ["GET", "POST"]) {
      const response = method === "GET" ? await world.send(path) : await world.post(path, [["head", head], ["id", "said-probe"], ["statement", "Probe."]]);
      holds(CLOSED, response.status === 404, () => ({ method, path, status: response.status }));
    }
  }
  // Every other method on every route's own path, from the workspace's own origin, so only the dispatcher can refuse it.
  for (const route of VIEWER_ROUTES) {
    for (const method of METHODS.filter((candidate) => candidate !== route.method)) {
      const body = method === "GET" || method === "HEAD" ? undefined : new URLSearchParams([["head", head], ...(FIELDS[route.name] ?? FIELDS["record-assertion"])] as [string, string][]).toString();
      const response = await world.send(concrete(route.path), { method, origin: VIEWER_ORIGIN, contentType: "application/x-www-form-urlencoded", body });
      holds(CLOSED, response.status === 405 && response.headers.get("allow") === route.method, () => ({ route: route.name, method, status: response.status, allow: response.headers.get("allow") }));
    }
  }
  holds(CLOSED, storedHead(world) === head, () => "a probe wrote to the log");
}

test("ruling 2: the route table is exactly these, served by its own methods, and nothing approves, publishes, exports, downloads, purges or drives the machine", async () => {
  await checkRouteSet(VIEWER_ROUTES, {});
  const routesPath = require.resolve("../core/viewer-routes");
  const added = (route: string) => loadVariant<typeof viewerRoutesModule>(routesPath, [{ find: '    { name: "case", method: "GET", path: "/cases/:case" },', replace: `    { name: "case", method: "GET", path: "/cases/:case" },\n    ${route},` }]);
  for (const [name, route] of [
    ["an approve route", '{ name: "reaffirm-interpretation", method: "POST", path: "/cases/:case/interpretations/:interpretation/approve" }'],
    ["an export by another name", '{ name: "evidence", method: "GET", path: "/cases/:case/evidence/:digest/download" }']
  ] as const) {
    const variant = added(route);
    await assertCaughtBy(name, CLOSED, () => checkRouteSet(variant.VIEWER_ROUTES, { routesOf: variant.viewerRoutes }));
  }
  // The pin alone is not the check: a dispatcher that answers outside its table, or by another method, is caught by the probes.
  const match = "const match = matches.find(({ route }) => route.method === request.method);";
  for (const [name, find, replace] of [
    ["a dispatcher answering a path its table does not list", "if (matches.length === 0)", 'if (url.pathname.endsWith("/approve")) return HANDLERS["case"]({ request, url, params: { case: url.pathname.split("/")[2] }, service, assertion, caseId: url.pathname.split("/")[2] });\n        if (matches.length === 0)'],
    ["PUT served as POST", match, 'const match = matches.find(({ route }) => route.method === (request.method === "PUT" ? "POST" : request.method));'],
    ["HEAD served as GET", match, 'const match = matches.find(({ route }) => route.method === (request.method === "HEAD" ? "GET" : request.method));'],
    ["POST to a read served as the read", match, 'const match = matches.find(({ route }) => route.method === request.method) ?? (request.method === "POST" ? matches.find(({ route }) => route.method === "GET") : undefined);'],
    ["an Allow that names methods the path does not take", '{ allow: [...new Set(matches.map(({ route }) => route.method))].join(", ") }', '{ allow: "GET, POST" }']
  ] as const) {
    const variant = loadVariant<typeof viewerRoutesModule>(routesPath, [{ find, replace }]);
    await assertCaughtBy(name, CLOSED, () => checkRouteSet(VIEWER_ROUTES, { routesOf: variant.viewerRoutes }));
  }
});

test("ruling 2: each route answers the owner, reads with 200 and writes with a 303 to what was written", async () => {
  for (const route of READS) {
    const world = await viewerWorld();
    const response = await world.send(concrete(route.path));
    assert.equal(response.status, 200, route.path);
  }
  const expected: Readonly<Record<string, string>> = {
    "record-fact": `${CASE}/facts/fact-new`,
    "supersede-fact": `${CASE}/facts/fact-lantern-host`,
    "retract-fact": `${CASE}/facts/fact-lantern-host`,
    "record-assertion": CASE,
    "retract-assertion": CASE,
    "record-interpretation": CASE,
    "reaffirm-interpretation": CASE
  };
  for (const route of WRITES) {
    const world = await viewerWorld();
    const before = await headNow(world);
    const response = await world.post(concrete(route.path), [["head", before], ...FIELDS[route.name]]);
    assert.equal(response.status, 303, `${route.name}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("location"), expected[route.name], route.name);
    assert.notEqual(storedHead(world), before, route.name);
  }
});

const REACHES_NONE = "a request the gate refuses reaches no route and no case";

async function checkAccess(options: WorldOptions): Promise<void> {
  const world = await viewerWorld(options);
  const head = await headNow(world);
  const callsBefore = world.calls();
  const tokens = { "no token": null, "a forged token": world.forgedToken, "another person": world.otherPersonToken, "a service token": world.serviceToken, "a malformed token": "not.a.token" };
  for (const route of VIEWER_ROUTES) {
    for (const [who, token] of Object.entries(tokens)) {
      const response = route.method === "GET" ? await world.send(concrete(route.path), { token }) : await world.post(concrete(route.path), [["head", head], ...FIELDS[route.name]], { token });
      holds(REACHES_NONE, response.status === 401 && (await response.text()) === '{"error":"access-refused"}', () => ({ route: route.name, who, status: response.status }));
    }
  }
  holds(REACHES_NONE, world.calls() === callsBefore, () => ({ calls: world.calls() - callsBefore }));
  holds(REACHES_NONE, storedHead(world) === head, () => "a refused request wrote");
}

test("ruling 3: no token, a forged token, another person and a service token each get 401 on every route, and reach no case", async () => {
  await checkAccess({});
  const gatePath = require.resolve("../core/workspace-gate");
  const serviceTokenThrough = loadVariant<typeof gateModule>(gatePath, [{ find: 'if (decision.identity.kind === "health-service" && !isHealthRead(request))', replace: "if (false)" }]);
  // The service verifies again, so this variant still answers 401. What catches it is that the service was reached at all.
  await assertCaughtBy("a service token let past the gate", REACHES_NONE, () => checkAccess({ gate: serviceTokenThrough.handleWorkspaceRequest }));
});

const EXPIRED_BETWEEN = "a token the service refuses after the gate admitted it answers as a refused token, not as an outage";

async function checkExpiredBetween(routesOf?: WorldOptions["routesOf"]): Promise<void> {
  // The service's clock runs ten hours ahead of the gate's, so the token expires between the two.
  const later = { caseServiceOver: (world: Parameters<typeof caseServiceOver>[0]) => caseServiceOver({ ...world, now: () => world.now() + 36_000_000 }) };
  const world = await viewerWorld({ serviceModule: later, routesOf });
  for (const path of [CASE, `${CASE}/evidence/${SCRIPT_DIGEST}`]) {
    const response = await world.send(path);
    holds(EXPIRED_BETWEEN, response.status === 401 && (await response.text()) === '{"error":"access-refused"}', () => ({ path, status: response.status }));
  }
  const write = await world.post(`${CASE}/assertions`, [["head", "0".repeat(64)], ...FIELDS["record-assertion"]]);
  holds(EXPIRED_BETWEEN, write.status === 401, () => ({ write: write.status }));
}

test("ruling 3: a token that expires between the gate and the service is refused as access-refused, not as an outage", async () => {
  await checkExpiredBetween();
  const swapped = loadVariant<typeof viewerRoutesModule>(require.resolve("../core/viewer-routes"), [{ find: 'refusalResponse)(answer.refusal === "unavailable" ? 503 : 401)', replace: 'refusalResponse)(answer.refusal === "unavailable" ? 401 : 503)' }]);
  await assertCaughtBy("the two refusals swapped", EXPIRED_BETWEEN, () => checkExpiredBetween(swapped.viewerRoutes));
});

const SAME_ORIGIN = "a write from anywhere but this workspace's own origin is refused, and writes nothing";

const FOREIGN_ORIGINS: readonly (string | null)[] = [
  null,
  "null",
  "https://attacker.example",
  "http://workspace.example",
  "https://workspace.example:8443",
  "https://sub.workspace.example",
  "https://workspace.example.",
  "https://WORKSPACE.example",
  "https://workspace.example/",
  "https://workspace.example.attacker.example",
  `${VIEWER_ORIGIN}, https://attacker.example`,
  `${VIEWER_ORIGIN} https://attacker.example`
];

async function checkOrigin(options: WorldOptions): Promise<void> {
  const world = await viewerWorld(options);
  const head = await headNow(world);
  const callsBefore = world.calls();
  for (const route of WRITES) {
    for (const origin of FOREIGN_ORIGINS) {
      const response = await world.post(concrete(route.path), [["head", head], ...FIELDS[route.name]], { origin });
      holds(SAME_ORIGIN, response.status === 403 && (await response.text()) === '{"error":"origin-refused"}', () => ({ route: route.name, origin, status: response.status }));
    }
  }
  // Every method but GET, on any path, carries the same rule. Only a HEAD of health itself is let through, as the service token sends it.
  for (const [method, path] of [["HEAD", CASE], ["PUT", CASE], ["DELETE", CASE], ["PATCH", CASE], ["patch", CASE], ["OPTIONS", CASE], ["HEAD", "/health.json"], ["HEAD", "/healthz"], ["HEAD", "/health/"], ["POST", "/health"]] as const) {
    const response = await world.send(path, { method, body: method === "OPTIONS" || method === "HEAD" ? undefined : "x" });
    holds(SAME_ORIGIN, response.status === 403, () => ({ method, path, status: response.status }));
  }
  const healthHead = await world.send("/health", { method: "HEAD", token: world.serviceToken });
  holds(SAME_ORIGIN, healthHead.status === 200, () => ({ healthHead: healthHead.status }));
  holds(SAME_ORIGIN, world.calls() === callsBefore, () => "a refused write reached the service");
  holds(SAME_ORIGIN, storedHead(world) === head, () => "a refused write wrote");
  // The one origin that is this workspace's gets through.
  const allowed = await world.post(`${CASE}/assertions`, [["head", head], ...FIELDS["record-assertion"]], { origin: VIEWER_ORIGIN });
  holds(SAME_ORIGIN, allowed.status === 303, () => ({ allowed: allowed.status }));
}

test("ruling 4: every write needs this workspace's own Origin, and a missing, null, listed or foreign one writes nothing", async () => {
  await checkOrigin({});
  const gatePath = require.resolve("../core/workspace-gate");
  const ORIGIN_TEST = 'request.headers.get("origin") !== `https://${config.hostname}`';
  for (const [name, find, replace] of [
    ["the Origin check gone", `request.method !== "GET" && !isHealthRead(request) && ${ORIGIN_TEST}`, "false"],
    ["a missing Origin let through", ORIGIN_TEST, `request.headers.get("origin") !== null && ${ORIGIN_TEST}`],
    ["a host compared loosely", ORIGIN_TEST, '!String(request.headers.get("origin")).includes(config.hostname)'],
    ["the first of a list of origins taken", ORIGIN_TEST, 'String(request.headers.get("origin")).split(",")[0].trim() !== `https://${config.hostname}`'],
    ["only POST held to it", 'request.method !== "GET" && !isHealthRead(request)', 'request.method === "POST"'],
    ["HEAD let through anywhere", 'request.method !== "GET" && !isHealthRead(request)', 'request.method !== "GET" && request.method !== "HEAD"'],
    ["HEAD let through under any path that starts like health", 'request.method !== "GET" && !isHealthRead(request)', 'request.method !== "GET" && !(request.method === "HEAD" && new URL(request.url).pathname.startsWith(exports.HEALTH_PATH))']
  ] as const) {
    const variant = loadVariant<typeof gateModule>(gatePath, [{ find, replace }]);
    await assertCaughtBy(name, SAME_ORIGIN, () => checkOrigin({ gate: variant.handleWorkspaceRequest }));
  }
});

const SAME_SITE = "a load another site's page makes is refused, unless it navigates the top-level window here";

async function checkCrossSite(options: WorldOptions): Promise<void> {
  const world = await viewerWorld(options);
  const marked = (site: string, mode: string, dest: string | null) => ({ "sec-fetch-site": site, "sec-fetch-mode": mode, ...(dest === null ? {} : { "sec-fetch-dest": dest }) });
  for (const [what, headers, status] of [
    ["an image another site loads", marked("cross-site", "no-cors", "image"), 403],
    ["a script another site loads", marked("cross-site", "no-cors", "script"), 403],
    ["a fetch from a sibling subdomain", marked("same-site", "cors", "empty"), 403],
    ["a frame another site navigates", marked("cross-site", "navigate", "iframe"), 403],
    ["a link the owner follows from elsewhere", marked("cross-site", "navigate", "document"), 200],
    ["Access sending the owner back after a login", marked("cross-site", "navigate", "document"), 200],
    ["a navigation marked with no destination", marked("cross-site", "navigate", null), 200],
    ["a page of this origin", marked("same-origin", "navigate", "document"), 200],
    ["an address the owner typed", marked("none", "navigate", "document"), 200],
    ["a request no browser marked", {}, 200],
    ["a no-cors load marked with no destination", marked("cross-site", "no-cors", null), 403],
    ["a cors fetch marked with no destination", marked("cross-site", "cors", null), 403]
  ] as const) {
    const response = await world.send(CASE, { headers });
    holds(SAME_SITE, response.status === status, () => ({ what, status: response.status }));
  }
  // Identity first: with no token, a marked load is refused as any request with no token is.
  const anonymous = await world.send(CASE, { token: null, headers: marked("cross-site", "no-cors", "image") });
  holds(SAME_SITE, anonymous.status === 401, () => ({ anonymous: anonymous.status }));
  // Health is under the rule too, for the owner and the health service alike.
  for (const token of [world.ownerToken, world.serviceToken]) {
    const health = await world.send("/health", { token, headers: marked("cross-site", "no-cors", "image") });
    holds(SAME_SITE, health.status === 403, () => ({ health: health.status }));
  }
  // A cross-site form, even with this workspace's Origin, is no navigation by GET.
  const post = await world.post(`${CASE}/assertions`, [["head", await headNow(world)], ...FIELDS["record-assertion"]], { headers: marked("cross-site", "navigate", "document") });
  holds(SAME_SITE, post.status === 403, () => ({ post: post.status }));
}

test("ruling 5 hardening: a cross-site or same-site load of a case page is refused unless it is a top-level GET navigation", async () => {
  await checkCrossSite({});
  const gatePath = require.resolve("../core/workspace-gate");
  for (const [name, find, replace] of [
    ["the rule gone", '(site === "cross-site" || site === "same-site") && !isTopLevelNavigation(request)', "false"],
    ["same-site let through", '(site === "cross-site" || site === "same-site")', 'site === "cross-site"'],
    ["any navigation let through, a frame's included", ' && (dest === null || dest === "document")', ""],
    ["a navigation by any method let through", 'return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate"', 'return request.headers.get("sec-fetch-mode") === "navigate"'],
    ["any mode but cors taken as a navigation", 'request.headers.get("sec-fetch-mode") === "navigate"', 'request.headers.get("sec-fetch-mode") !== "cors"'],
    ["the mode not read", 'request.headers.get("sec-fetch-mode") === "navigate" && ', ""],
    ["health let past the rule", '(site === "cross-site" || site === "same-site") && !isTopLevelNavigation(request)', '(site === "cross-site" || site === "same-site") && !isTopLevelNavigation(request) && !isHealthRead(request)']
  ] as const) {
    const variant = loadVariant<typeof gateModule>(gatePath, [{ find, replace }]);
    await assertCaughtBy(name, SAME_SITE, () => checkCrossSite({ gate: variant.handleWorkspaceRequest }));
  }
});

const STALE = "a write whose head moved since it was viewed writes nothing, and shows the case as it now stands";

async function checkStaleHead(options: WorldOptions, routes: typeof WRITES = WRITES): Promise<void> {
  for (const route of routes) {
    const world = await viewerWorld(options);
    const viewed = await headNow(world);
    // An unrelated write lands from elsewhere, so what the form names stays valid and only the head says the page is stale.
    const between = await world.post(`${CASE}/assertions`, [["head", viewed], ["id", "said-in-between"], ["statement", "A note from another tab."]]);
    holds(STALE, between.status === 303, () => ({ route: route.name, between: between.status }));
    const moved = storedHead(world);
    const response = await world.post(concrete(route.path), [["head", viewed], ...FIELDS[route.name]]);
    const page = await response.text();
    holds(STALE, response.status === 409, () => ({ route: route.name, status: response.status }));
    holds(STALE, storedHead(world) === moved, () => ({ route: route.name, wrote: true }));
    holds(STALE, page.includes("Nothing was written.") && page.includes("said-in-between") && headOf(page) === moved, () => ({ route: route.name, page: "not the case as it stands" }));
  }
}

test("ruling 4: a write of every claim kind whose head moved is refused as a conflict, shows the current state and writes nothing", async () => {
  await checkStaleHead({});
  const servicePath = require.resolve("../core/case-service");
  const variant = loadVariant<typeof caseServiceModule>(servicePath, [{ find: "if (result.case.head !== viewedHead)", replace: "if (false)" }]);
  await assertCaughtBy("the head check gone", STALE, () => checkStaleHead({ serviceModule: variant }));
  // The check held for one claim kind but not another is caught on that kind.
  for (const route of WRITES) {
    const type = ({ "record-fact": "fact-recorded", "supersede-fact": "fact-superseded", "retract-fact": "fact-retracted", "record-assertion": "assertion-recorded", "retract-assertion": "assertion-retracted", "record-interpretation": "interpretation-recorded", "reaffirm-interpretation": "interpretation-reaffirmed" } as Readonly<Record<string, string>>)[route.name];
    const skipping = loadVariant<typeof caseServiceModule>(servicePath, [{ find: "if (result.case.head !== viewedHead)", replace: `if (event.type !== "${type}" && result.case.head !== viewedHead)` }]);
    await assertCaughtBy(`the head check skipped for ${type}`, STALE, () => checkStaleHead({ serviceModule: skipping }, [route]));
  }
});

test("ruling 4 and the spec: a reaffirm binds the versions its form names, and a later supersede flags it again", async () => {
  const world = await viewerWorld();
  const page = await (await world.send(CASE)).text();
  // The form names the version the page showed, from the page.
  assert.ok(page.includes('name="cite" value="fact-lantern-host:2"'));
  // A version the page did not show is refused by the model, and nothing is written.
  const before = storedHead(world);
  const old = await world.post(`${CASE}/interpretations/reading-host/reaffirm`, [["head", headOf(page)], ["cite", "fact-lantern-host:1"]]);
  assert.equal(old.status, 422);
  assert.match(textOf(await old.text()), /refused it: cite-not-current at cites/);
  assert.equal(storedHead(world), before);
  const reaffirmed = await world.post(`${CASE}/interpretations/reading-host/reaffirm`, [["head", headOf(page)], ["cite", "fact-lantern-host:2"]]);
  assert.equal(reaffirmed.status, 303);
  const after = textOf(await (await world.send(CASE)).text());
  assert.match(after, /reading-host The host is the first party's own\. Current\. Reaffirmed 1 times\. Cites: fact-lantern-host at version 2 \(now version 2\)/);
  const superseded = await world.post(`${CASE}/facts/fact-lantern-host/supersede`, [["head", await headNow(world)], ...FIELDS["supersede-fact"]]);
  assert.equal(superseded.status, 303);
  const flagged = textOf(await (await world.send(CASE)).text());
  assert.match(flagged, /reading-host The host is the first party's own\. Needs review\. Reaffirmed 1 times\. Cites: fact-lantern-host at version 2 \(now version 3\)/);
  assert.match(flagged, /fact-lantern-host was superseded from version 2, at entry \d+\./);
  // One resting on a retracted fact offers no reaffirm at all.
  assert.equal((await world.post(`${CASE}/facts/fact-lantern-host/retract`, [["head", await headNow(world)], ["reason", "Withdrawn."]])).status, 303);
  const retracted = await (await world.send(CASE)).text();
  assert.ok(!retracted.includes(`action="${CASE}/interpretations/reading-host/reaffirm"`));
  assert.match(textOf(retracted), /reading-host[^]*It rests on a retracted fact, so it cannot be reaffirmed\./);
});

const HEADERS = "every response carries the stated headers, refusals and redirects included";

type Probe = Readonly<{ name: string; status: number; kind: "json" | "html"; extra: Readonly<Record<string, string | null>>; response: () => Promise<Response> }>;

async function probes(world: ViewerWorld, refusing: ViewerWorld, absent: ViewerWorld): Promise<readonly Probe[]> {
  const head = await headNow(world);
  const fresh = () => headNow(world);
  const loose = await putEvidence(world.stores.get(VIEWER_CASE) as NonNullable<ReturnType<ViewerWorld["stores"]["get"]>>, new TextEncoder().encode("named by nothing"));
  return [
    ...READS.map((route): Probe => ({ name: `GET ${route.name}`, status: 200, kind: "html", extra: {}, response: () => world.send(concrete(route.path)) })),
    { name: "a write", status: 303, kind: "html", extra: { location: CASE }, response: async () => world.post(`${CASE}/assertions`, [["head", await fresh()], ...FIELDS["record-assertion"]]) },
    { name: "a form with no head", status: 400, kind: "html", extra: {}, response: () => world.post(`${CASE}/assertions`, FIELDS["record-assertion"]) },
    { name: "a malformed offset", status: 400, kind: "html", extra: {}, response: () => world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=-1`) },
    { name: "no token", status: 401, kind: "json", extra: {}, response: () => world.send(CASE, { token: null }) },
    { name: "a foreign origin", status: 403, kind: "json", extra: {}, response: () => world.post(`${CASE}/assertions`, [["head", head]], { origin: "https://attacker.example" }) },
    { name: "a cross-site image", status: 403, kind: "json", extra: {}, response: () => world.send(CASE, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }) },
    { name: "no such page", status: 404, kind: "html", extra: {}, response: () => world.send(`${CASE}/approve`) },
    { name: "no such fact", status: 404, kind: "html", extra: {}, response: () => world.send(`${CASE}/facts/fact-nobody`) },
    { name: "evidence the case does not name", status: 404, kind: "html", extra: {}, response: () => world.send(`${CASE}/evidence/${loose.ok ? loose.digest : ""}`) },
    { name: "a read of a write's address", status: 405, kind: "html", extra: { allow: "POST" }, response: () => world.send(`${CASE}/facts`) },
    { name: "a write to a read's address", status: 405, kind: "html", extra: { allow: "GET" }, response: () => world.post(`${CASE}/aggregates`, [["head", head]]) },
    { name: "a post to health", status: 405, kind: "json", extra: { allow: "GET, HEAD" }, response: () => world.post("/health", []) },
    { name: "a stale head", status: 409, kind: "html", extra: {}, response: () => world.post(`${CASE}/interpretations/reading-host/reaffirm`, [["head", "0".repeat(64)], ["cite", "fact-lantern-host:2"]]) },
    { name: "a case that will not open", status: 409, kind: "html", extra: {}, response: () => refusing.send(CASE) },
    { name: "a form too large", status: 413, kind: "html", extra: {}, response: () => world.post(`${CASE}/assertions`, [["head", head], ["statement", "x".repeat(MAX_FORM_BYTES)]]) },
    { name: "not a form", status: 415, kind: "html", extra: {}, response: () => world.post(`${CASE}/assertions`, [], { contentType: "application/json", body: "{}" }) },
    { name: "a claim the model refuses", status: 422, kind: "html", extra: {}, response: async () => world.post(`${CASE}/assertions`, [["head", await fresh()], ["id", "fact-lantern-ran"], ["statement", "Taken."]]) },
    { name: "no case service", status: 503, kind: "json", extra: {}, response: () => absent.send(CASE) },
    { name: "health", status: 200, kind: "json", extra: {}, response: () => world.send("/health") }
  ];
}

async function checkHeaders(list: readonly Probe[], expected: (kind: "json" | "html") => Record<string, string>): Promise<void> {
  for (const probe of list) {
    const response = await probe.response();
    holds(HEADERS, response.status === probe.status, () => ({ probe: probe.name, status: response.status }));
    const names = [...response.headers.keys()].sort();
    const wanted = [...Object.keys(expected(probe.kind)), ...Object.keys(probe.extra)].sort();
    holds(HEADERS, JSON.stringify(names) === JSON.stringify(wanted), () => ({ probe: probe.name, names }));
    for (const [name, value] of Object.entries({ ...expected(probe.kind), ...probe.extra })) holds(HEADERS, response.headers.get(name) === value, () => ({ probe: probe.name, name, value: response.headers.get(name) }));
  }
}

/** The headers ruling 5 states, with the two hardening headers, written out here rather than read from the module that makes them. */
function statedHeaders(kind: "json" | "html"): Record<string, string> {
  const policy = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  return {
    "cache-control": "no-store",
    "content-security-policy": kind === "html" ? `${policy}; style-src '${VIEWER_STYLE_HASH}'` : policy,
    "content-type": kind === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff"
  };
}

const POLICY_RULE = "no response allows script, framing, a base element, a form to another origin, or a window or load from another origin";

function checkPolicy(headersOf: typeof responseHeaders): void {
  for (const kind of ["json", "html"] as const) {
    const headers = headersOf(kind);
    const directives = headers["content-security-policy"].split(";").map((part) => part.trim());
    for (const required of ["default-src 'none'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) holds(POLICY_RULE, directives.includes(required), () => ({ kind, required }));
    holds(POLICY_RULE, !/script-src|unsafe-|\*|data:|http/.test(headers["content-security-policy"]), () => ({ kind, policy: headers["content-security-policy"] }));
    holds(POLICY_RULE, directives.every((directive) => /^(default-src|form-action|frame-ancestors|base-uri|style-src) /.test(directive)), () => ({ kind, directives }));
    holds(POLICY_RULE, headers["x-content-type-options"] === "nosniff" && headers["cache-control"] === "no-store" && headers["referrer-policy"] === "same-origin", () => ({ kind, headers }));
    holds(POLICY_RULE, headers["cross-origin-opener-policy"] === "same-origin" && headers["cross-origin-resource-policy"] === "same-origin", () => ({ kind, headers }));
  }
}

test("ruling 5: every response carries the stated headers, on every route and every refusal", async () => {
  const world = await viewerWorld();
  const refusing = await viewerWorld();
  const stores = refusing.stores.get(VIEWER_CASE);
  stores?.evidence.objects.set(digestOfRaw("raw-b1-network"), new TextEncoder().encode("CANARY-HELD-VALUE changed bytes"));
  const absent = await viewerWorld({ noService: true });
  const list = await probes(world, refusing, absent);
  assert.deepEqual([...new Set(list.map(({ status }) => status))].sort(), [200, 303, 400, 401, 403, 404, 405, 409, 413, 415, 422, 503]);
  await checkHeaders(list, statedHeaders);
  // The header builder itself, and variants of it that must not pass.
  checkPolicy(responseHeaders);
  const responsePath = require.resolve("../core/workspace-response");
  for (const [name, find, replace] of [
    ["inline script allowed", `exports.BASE_POLICY = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";`, `exports.BASE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";`],
    ["framing allowed", "frame-ancestors 'none'; base-uri", "base-uri"],
    ["forms to anywhere", "form-action 'self'; ", ""],
    ["no-referrer, which makes a browser send its own posts with no origin", '"referrer-policy": "same-origin"', '"referrer-policy": "no-referrer"'],
    ["sniffing allowed", '"x-content-type-options": "nosniff"', '"x-content-type-options": "none"'],
    ["another origin's window kept", '"cross-origin-opener-policy": "same-origin",', ""],
    ["a load from another origin allowed", '"cross-origin-resource-policy": "same-origin",', '"cross-origin-resource-policy": "cross-origin",']
  ] as const) {
    const variant = loadVariant<typeof responseModule>(responsePath, [{ find, replace }]);
    await assertCaughtBy(name, POLICY_RULE, () => checkPolicy(variant.responseHeaders));
  }
});

test("ruling 5: the style source is the hash of the one style element", async () => {
  assert.equal(VIEWER_STYLE_HASH, `sha256-${createHash("sha256").update(VIEWER_STYLE, "utf8").digest("base64")}`);
  assert.equal(BASE_POLICY, "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
});

/** Every page of the fixture case a link reaches: the case, each attempt, each row, each fact, the counts and every evidence page a row names. */
async function everyPage(world: ViewerWorld): Promise<readonly { path: string; text: string }[]> {
  const paths = [CASE, `${CASE}/aggregates`];
  const casePage = await (await world.send(CASE)).text();
  for (const match of casePage.matchAll(/href="(\/cases\/[^"]+)"/g)) paths.push(match[1]);
  for (const slot of ["B1", "B2", "B3", "I1", "I2", "I3"]) {
    const attempt = await (await world.send(`${CASE}/attempts/${slot}`)).text();
    for (const match of attempt.matchAll(/href="(\/cases\/[^"]+)"/g)) paths.push(match[1]);
  }
  const rows = [...new Set(paths)].filter((path) => path.includes("/rows/"));
  for (const row of rows) {
    const page = await (await world.send(row)).text();
    for (const match of page.matchAll(/href="(\/cases\/[^"]+)"/g)) paths.push(match[1]);
  }
  const unique = [...new Set(paths.map((path) => path.replace(/&amp;/g, "&").replace(/&#61;/g, "=")))];
  const pages: { path: string; text: string }[] = [];
  for (const path of unique) {
    const response = await world.send(path);
    assert.equal(response.status, 200, path);
    pages.push({ path, text: await response.text() });
  }
  assert.ok(pages.some(({ path }) => path.includes("/evidence/")) && pages.some(({ path }) => path.includes("/rows/")) && pages.some(({ path }) => path.includes("/facts/")), "the walk reached every kind of page");
  return pages;
}

/** Every page, and every page that is no page of a case: refusals, notices, a 404, a 405, a refused form, refused evidence, and a case with no plan. */
async function everyKindOfPage(): Promise<readonly { path: string; text: string }[]> {
  const world = await viewerWorld();
  const pages = [...(await everyPage(world))];
  const refusing = await viewerWorld();
  refusing.stores.get(VIEWER_CASE)?.evidence.objects.set(digestOfRaw("raw-b1-network"), new TextEncoder().encode("changed"));
  const noPlan = await worldWith([]);
  const add = async (path: string, response: Promise<Response>) => pages.push({ path, text: await (await response).text() });
  await add("404", world.send(`${CASE}/approve`));
  await add("405", world.send(`${CASE}/facts`));
  await add("conflict", world.post(`${CASE}/assertions`, [["head", "0".repeat(64)], ...FIELDS["record-assertion"]]));
  await add("a refused claim", world.post(`${CASE}/assertions`, [["head", await headNow(world)], ["id", "fact-lantern-ran"], ["statement", "Taken."]]));
  await add("a refused form", world.post(`${CASE}/assertions`, FIELDS["record-assertion"]));
  await add("a form too large", world.post(`${CASE}/assertions`, [["statement", "x".repeat(MAX_FORM_BYTES)]]));
  await add("refused evidence", world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=x`));
  await add("evidence past its end", world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=99999999`));
  await add("a case that will not open", refusing.send(CASE));
  await add("no log", world.send("/cases/case-nobody"));
  await add("no plan", noPlan.send(CASE));
  assert.ok(pages.find(({ path }) => path === "no plan")?.text.includes("no plan yet"), "the case with no plan was reached");
  return pages;
}

const ALLOWED_TAGS = new Set(["html", "head", "meta", "title", "style", "body", "header", "nav", "main", "aside", "section", "h1", "h2", "h3", "p", "a", "ul", "li", "table", "tr", "th", "td", "code", "pre", "div", "span", "strong", "form", "input", "label", "textarea", "button", "fieldset", "legend"]);
const ALLOWED_ATTRIBUTES = new Set(["lang", "charset", "name", "content", "href", "class", "role", "method", "action", "type", "value", "required"]);

const PAGE_RULES = "every page has only the tags and attributes a page may have, links only to the workspace, states what it cannot answer, and says nothing caused anything";

function checkPage(path: string, text: string): void {
  const styles = [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  holds(PAGE_RULES, styles.length === 1 && styles[0][1] === VIEWER_STYLE, () => ({ path, styles: styles.length }));
  // Escaped text holds no tag, so every tag here is the page's own.
  const markup = text.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const [, name, attributes] of markup.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    holds(PAGE_RULES, ALLOWED_TAGS.has(name.toLowerCase()), () => ({ path, tag: name }));
    for (const [, attribute, value] of attributes.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      holds(PAGE_RULES, ALLOWED_ATTRIBUTES.has(attribute), () => ({ path, tag: name, attribute }));
      if (attribute === "href" || attribute === "action") holds(PAGE_RULES, value !== undefined && value.startsWith("/cases/"), () => ({ path, attribute, value }));
    }
  }
  holds(PAGE_RULES, !/id="broke-|onerror="|onload="/.test(markup), () => ({ path, broke: true }));
  const visible = textOf(text);
  for (const line of [...CANNOT_ANSWER, ADAPTER_NOTE]) holds(PAGE_RULES, visible.includes(line), () => ({ path, missing: line }));
  holds(PAGE_RULES, !/\bcaus/i.test(visible), () => ({ path, caus: visible.match(/[^.]*\bcaus[^.]*/i)?.[0] }));
}

test("rulings 6, 7 and 8: every page of every kind, refusals and notices included, has the allowed markup, the disclosure, and no word of cause", async () => {
  const pages = await everyKindOfPage();
  for (const { path, text } of pages) checkPage(path, text);
  // The check can see each thing it is for, on a page the walk alone would not reach.
  const refusal = pages.find(({ path }) => path === "a case that will not open")?.text ?? "";
  for (const [name, planted] of [
    ["an image on a refusal", refusal.replace("<main>", '<main><img src="/cases/x.png">')],
    ["a link off the workspace on a 404", refusal.replace("<main>", '<main><a href="https://help.example/">Help</a>')],
    ["a refusal with no disclosure", refusal.replace(/<aside>[\s\S]*<\/aside>/, "")],
    ["a notice that says what caused it", refusal.replace("<main>", "<main><p>Another write caused this.</p>")]
  ] as const) {
    await assertCaughtBy(name, PAGE_RULES, () => checkPage("planted", planted));
  }
});

const AS_TEXT = "what a capture held and what the owner wrote reach a page only as text";

/**
 * Default_Ignorable_Code_Point, written out from the Unicode data (DerivedCoreProperties.txt), and
 * the general category Cf (UnicodeData.txt), as code point ranges. Each is held to the engine's own
 * property over every code point below, so the module's pattern and these lists are two sources
 * that must agree, and a Unicode version that moves either one fails here.
 */
const DEFAULT_IGNORABLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
];
const FORMAT: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f]
];
/** The space separators, Zs, the plain space among them. Every one but the plain space draws no ink. */
const SPACE_SEPARATORS: readonly (readonly [number, number])[] = [
  [0x0020, 0x0020],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000]
];
/** The private-use areas, Co: the BMP's, and planes 15 and 16 but their last two code points, which are noncharacters. */
const PRIVATE_USE: readonly (readonly [number, number])[] = [
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd]
];
/** The controls, Cc, but tab and line feed, which show as themselves. */
const CONTROLS: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f]
];
/** The line separator, Zl, and the paragraph separator, Zp. */
const LINE_SEPARATORS: readonly (readonly [number, number])[] = [[0x2028, 0x2028]];
const PARAGRAPH_SEPARATORS: readonly (readonly [number, number])[] = [[0x2029, 0x2029]];
/** Bidi_Control. */
const BIDI_CONTROLS: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069]
];
/** The surrogates, Cs, which a string holds alone only when it is not well formed. */
const SURROGATES: readonly (readonly [number, number])[] = [[0xd800, 0xdfff]];
/** Noncharacter_Code_Point: a block in Arabic Presentation Forms-A, and the last two code points of every plane. */
const NONCHARACTERS: readonly (readonly [number, number])[] = [
  [0xfdd0, 0xfdef],
  ...Array.from({ length: 17 }, (_, plane) => [plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff] as const)
];
/** Two additions made on purpose, outside every property the class names: the braille blank and the object replacement character, which draw no ink. */
const DELIBERATE: readonly (readonly [number, number])[] = [
  [0x2800, 0x2800],
  [0xfffc, 0xfffc]
];
const OTHERS: readonly (readonly [number, number])[] = [...CONTROLS, ...LINE_SEPARATORS, ...PARAGRAPH_SEPARATORS, ...BIDI_CONTROLS, ...SURROGATES, ...NONCHARACTERS, ...DELIBERATE];

const within = (ranges: readonly (readonly [number, number])[], point: number): boolean => ranges.some(([low, high]) => point >= low && point <= high);
/** Unassigned code points, Cn, are the engine's own by design: no list here could follow its Unicode version. Every noncharacter in OTHERS is one. */
const isUnassigned = (point: number): boolean => /\p{Cn}/u.test(characterOf(point));
const isUnseen = (point: number): boolean => within(DEFAULT_IGNORABLE, point) || within(FORMAT, point) || within(PRIVATE_USE, point) || within(OTHERS, point) || (within(SPACE_SEPARATORS, point) && point !== 0x20) || isUnassigned(point);
const characterOf = (point: number): string => (point >= 0xd800 && point <= 0xdfff ? String.fromCharCode(point) : String.fromCodePoint(point));
const ENTITY: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Every property the class names, as the engine reads it. */
const NAMED_PROPERTIES = ["Cc", "Cf", "Zs", "Zl", "Zp", "Cs", "Co", "Cn", "Default_Ignorable_Code_Point", "Bidi_Control", "Noncharacter_Code_Point"].map((name) => new RegExp(`\\p{${name}}`, "u"));

test("every hand-written Unicode range agrees with the engine's own property at every code point, and the two deliberate additions lie outside them all", () => {
  for (let point = 0; point <= 0x10ffff; point += 1) {
    const character = characterOf(point);
    assert.equal(within(CONTROLS, point) || point === 0x09 || point === 0x0a, /\p{Cc}/u.test(character), `Cc at U+${point.toString(16)}`);
    assert.equal(within(LINE_SEPARATORS, point), /\p{Zl}/u.test(character), `Zl at U+${point.toString(16)}`);
    assert.equal(within(PARAGRAPH_SEPARATORS, point), /\p{Zp}/u.test(character), `Zp at U+${point.toString(16)}`);
    assert.equal(within(BIDI_CONTROLS, point), /\p{Bidi_Control}/u.test(character), `Bidi_Control at U+${point.toString(16)}`);
    assert.equal(within(SURROGATES, point), /\p{Cs}/u.test(character), `Cs at U+${point.toString(16)}`);
    assert.equal(within(NONCHARACTERS, point), /\p{Noncharacter_Code_Point}/u.test(character), `Noncharacter_Code_Point at U+${point.toString(16)}`);
    if (within(DELIBERATE, point)) assert.ok(!NAMED_PROPERTIES.some((property) => property.test(character)), `a deliberate addition a named property holds, at U+${point.toString(16)}`);
    assert.equal(within(DEFAULT_IGNORABLE, point), /\p{Default_Ignorable_Code_Point}/u.test(character), `Default_Ignorable at U+${point.toString(16)}`);
    assert.equal(within(FORMAT, point), /\p{Cf}/u.test(character), `Cf at U+${point.toString(16)}`);
    assert.equal(within(SPACE_SEPARATORS, point), /\p{Zs}/u.test(character), `Zs at U+${point.toString(16)}`);
    assert.equal(within(PRIVATE_USE, point), /\p{Co}/u.test(character), `Co at U+${point.toString(16)}`);
    if (/\p{Noncharacter_Code_Point}/u.test(character)) assert.ok(isUnassigned(point), `a noncharacter the engine assigns, at U+${point.toString(16)}`);
  }
});

/** A run of spaces and tabs as a count, counted here apart from the module. */
function counted(run: string): string {
  let spaces = 0;
  let tabs = 0;
  for (const blank of run) {
    if (blank === " ") spaces += 1;
    else tabs += 1;
  }
  return [spaces > 0 ? `${spaces} ${spaces === 1 ? "space" : "spaces"}` : null, tabs > 0 ? `${tabs} ${tabs === 1 ? "tab" : "tabs"}` : null].filter((part) => part !== null).join(" ");
}

/**
 * The blank rule, written apart from the module: each line judged on its own. A run shows as itself
 * only when text follows it on its line and it is one blank, or it starts the line, is spaces alone
 * or tabs alone, and is at most 64 long. Every other run is a count.
 */
function blanksAsShown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let shown = "";
      let index = 0;
      while (index < line.length) {
        if (line[index] !== " " && line[index] !== "\t") {
          shown += line[index];
          index += 1;
          continue;
        }
        let end = index;
        while (end < line.length && (line[end] === " " || line[end] === "\t")) end += 1;
        const run = line.slice(index, end);
        const oneKind = run === " ".repeat(run.length) || run === "\t".repeat(run.length);
        const itself = end < line.length && (run.length === 1 || (index === 0 && oneKind && run.length <= 64));
        shown += itself ? run : `<span class="ctl">${counted(run)}</span>`;
        index = end;
      }
      return shown;
    })
    .join("\n");
}

/** Every string up to this length over a letter, a space, a tab and a line feed. */
function blankStrings(longest: number): string[] {
  const all = [""];
  for (let from = 0, length = 1; length <= longest; length += 1) {
    const to = all.length;
    for (let index = from; index < to; index += 1) for (const piece of ["a", " ", "\t", "\n"]) all.push(all[index] + piece);
    from = to;
  }
  return all;
}
const BLANK_STRINGS = blankStrings(8);

function checkEscaping(escape: typeof escapeText, quoted: typeof escapeAttribute, template: typeof html, makeAttribute: typeof attribute): void {
  for (const canary of ["</pre>", "</textarea>", '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>", "<!--", "]]>", "&amp;"]) {
    holds(AS_TEXT, !escape(canary).includes("<") && !escape(canary).includes(">") && !escape(canary).includes('"'), () => canary);
    holds(AS_TEXT, template`<p>${canary}</p>`.source === `<p>${escape(canary)}</p>`, () => canary);
  }
  // The tag reads where each value lands. Inside a tag only the whole of a quoted value, made by attribute(), is taken.
  const refuses = (build: () => unknown): boolean => {
    try {
      build();
      return false;
    } catch {
      return true;
    }
  };
  const hidden = "a\u{202E}b";
  const refused: Readonly<Record<string, () => unknown>> = {
    "a string as a double-quoted value": () => template`<input value="${hidden}">`,
    "a string as a single-quoted value": () => template`<input value='${hidden}'>`,
    "a string after a space before the quote": () => template`<input value= "${hidden}">`,
    "an unquoted value": () => template`<input value=${hidden}>`,
    "attribute() unquoted": () => template`<input value=${makeAttribute(hidden)}>`,
    "a value later inside a quoted value": () => template`<a href="/cases/${makeAttribute("x")}">`,
    "a second value in one attribute": () => template`<a href="${makeAttribute("x")}${makeAttribute("y")}">`,
    "a value in a quoted value of a later attribute": () => template`<input type="text" name="n${makeAttribute("x")}">`,
    "a string where an attribute's name goes": () => template`<input ${"autofocus onfocus=alert(1) x"}>`,
    "attribute() where an attribute's name goes": () => template`<input ${makeAttribute("x")}>`,
    "markup where an attribute's name goes": () => template`<input ${new Markup("required")}>`,
    "markup as a quoted value": () => template`<input value="${new Markup('"><b id="broke">')}">`,
    "a value as a tag's name": () => template`<${"script"}>`,
    "a value as a closing tag's name": () => template`<p>x</${"script"}>`,
    "attribute() in text": () => template`<p>${makeAttribute("x")}</p>`,
    "a string partway into a quoted value": () => template`<a href="/cases/${"a\u{202E} b onmouseover=alert(1) x"}">`,
    "attribute() not followed by its closing quote": () => template`<a href="${makeAttribute("/cases/x")}?q=1">`,
    "an unquoted value in a later literal, after attribute()": () => template`<a href="${makeAttribute("/cases/x")}" title=${"y onfocus=alert(1) autofocus"}>`
  };
  for (const [name, build] of Object.entries(refused)) holds(AS_TEXT, refuses(build), () => ({ accepted: name }));
  const built = (build: () => { source: string }): string | null => {
    try {
      return build().source;
    } catch {
      return null;
    }
  };
  holds(AS_TEXT, built(() => template`<input value="${makeAttribute(hidden)}">`) === '<input value="a\u{FFFD}b">', () => "attribute() in an attribute");
  holds(AS_TEXT, built(() => template`<input value= "${makeAttribute("x")}">`) === '<input value= "x">', () => "attribute() after a space before the quote");
  holds(AS_TEXT, built(() => template`<input value='${makeAttribute("x")}'>`) === "<input value='x'>", () => "attribute() in a single-quoted attribute");
  holds(AS_TEXT, built(() => template`<p>n = ${3}, m == ${"<b>"}</p>`) === "<p>n = 3, m == &lt;b&gt;</p>", () => "an equals sign in prose");
  holds(AS_TEXT, built(() => template`<p>${new Markup("<b>")}</p><input name="${makeAttribute("n")}" required><p>after = ${"x"}</p>`) === '<p><b></p><input name="n" required><p>after = x</p>', () => "text after a tag reads as text");
  // A space or tab shows as itself alone inside a line, or as indentation of one kind up to the bound; every other run is a count.
  const ctl = (inside: string): string => `<span class="ctl">${inside}</span>`;
  for (const [given, wanted] of [
    ["a b\tc", "a b\tc"],
    ["a  ", `a${ctl("2 spaces")}`],
    ["a \t\nb", `a${ctl("1 space 1 tab")}\nb`],
    [" \t  \n", `${ctl("3 spaces 1 tab")}\n`],
    ["\t", ctl("1 tab")],
    ["a \t b \t", `a${ctl("2 spaces 1 tab")}b${ctl("1 space 1 tab")}`],
    ["a \r\n", `a ${ctl("U+000D")}\n`],
    ["a  b", `a${ctl("2 spaces")}b`],
    ["a\t\tb", `a${ctl("2 tabs")}b`],
    ["  a  b", `  a${ctl("2 spaces")}b`],
    [" a", " a"],
    ["\t\ta", "\t\ta"],
    ["x\n    y", "x\n    y"],
    ["x\r  y", `x${ctl("U+000D")}${ctl("2 spaces")}y`],
    [" \tx", `${ctl("1 space 1 tab")}x`],
    ["y\n\t x", `y\n${ctl("1 space 1 tab")}x`],
    [`${" ".repeat(64)}x`, `${" ".repeat(64)}x`],
    [`${" ".repeat(65)}x`, `${ctl("65 spaces")}x`],
    [`y\n${"\t".repeat(64)}x`, `y\n${"\t".repeat(64)}x`],
    [`y\n${"\t".repeat(65)}x`, `y\n${ctl("65 tabs")}x`],
    [`alpha${ALPHA_RUN}omega`, `alpha${ctl(counted(ALPHA_RUN))}omega`],
    [`const ok = 1;${CODE_RUN}// end of line`, `const ok = 1;${ctl(counted(CODE_RUN))}// end of line`],
    [`const ok = 1;${CODE_RUN}`, `const ok = 1;${ctl(counted(CODE_RUN))}`]
  ] as const) {
    holds(AS_TEXT, escape(given) === wanted, () => ({ given, out: escape(given) }));
    // The rule written apart agrees on every case it can read: it knows no carriage return.
    if (!given.includes("\r")) holds(AS_TEXT, blanksAsShown(given) === wanted, () => ({ oracle: given }));
  }
  // Only a line feed starts a line. After a line or paragraph separator, a next-line control or a lone
  // carriage return, each shown as its token, a run of two blanks, or of 64, is inside the line and a count.
  for (const [breaker, name] of [["\u{2028}", "U+2028"], ["\u{2029}", "U+2029"], ["\u{0085}", "U+0085"], ["\r", "U+000D"]] as const) {
    for (const [blank, word] of [[" ", "spaces"], ["\t", "tabs"]] as const) {
      for (const length of [2, 64]) {
        const given = `x${breaker}${blank.repeat(length)}y`;
        holds(AS_TEXT, escape(given) === `x${ctl(name)}${ctl(`${length} ${word}`)}y`, () => ({ given, out: escape(given) }));
      }
    }
  }
  // Unassigned code points the system fonts on macOS draw with no ink, and others, are tokens.
  for (const point of [...UNASSIGNED_POINTS, 0xfdd0, 0x1fffe]) holds(AS_TEXT, isUnassigned(point) && escape(`a${String.fromCodePoint(point)}b`) === `a${ctl(`U+${point.toString(16).toUpperCase().padStart(4, "0")}`)}b`, () => ({ unassigned: point.toString(16) }));
  holds(AS_TEXT, ALPHA_RUN.length === 104 && CODE_RUN.length === 328 && blankBits("A") === " \t     \t", () => "the payloads' lengths");
  // Every string of up to eight letters, spaces, tabs and line feeds shows as the rule written apart says.
  for (const given of BLANK_STRINGS) holds(AS_TEXT, escape(given) === blanksAsShown(given), () => ({ given, out: escape(given), wanted: blanksAsShown(given) }));
  const long = "<".repeat(200_000);
  holds(AS_TEXT, escape(long) === "&lt;".repeat(200_000), () => "a very long line");
  // Every code point: a markup character as its entity, an unseen one as its token, and every other one exactly as it was.
  for (let point = 0; point <= 0x10ffff; point += 1) {
    const character = characterOf(point);
    const out = escape(`a${character}b`);
    const token = `<span class="ctl">U+${point.toString(16).toUpperCase().padStart(4, "0")}</span>`;
    const wanted = ENTITY[character] ?? (isUnseen(point) ? token : character);
    holds(AS_TEXT, out === `a${wanted}b`, () => ({ point: point.toString(16), out }));
    const attributeOut = quoted(`a${character}b`);
    holds(AS_TEXT, !/[<>"'`=]/.test(attributeOut) && ![...attributeOut].some((piece) => isUnseen(piece.codePointAt(0) as number)), () => ({ point: point.toString(16), attributeOut }));
    if (!isUnseen(point) && !/[&<>"'`=]/.test(character)) holds(AS_TEXT, attributeOut === `a${character}b`, () => ({ point: point.toString(16), attributeOut }));
  }
}

test("ruling 6: escapeText leaves no markup, shows every character a browser would draw as nothing as its code point, and leaves every other character as it was", async () => {
  checkEscaping(escapeText, escapeAttribute, html, attribute);
  const textPath = require.resolve("../core/viewer-text");
  for (const [name, find, replace] of [
    ["default-ignorable code points let through, variation selectors among them", "|\\p{Default_Ignorable_Code_Point}", ""],
    ["format characters let through", "|\\p{Cf}|", "|"],
    ["unassigned code points, the noncharacters among them, let through", "|\\p{Cn}", ""],
    ["control characters let through", "(?![\\t\\n])\\p{Cc}|", ""],
    ["a separator let through", "|\\p{Zl}", ""],
    ["quotes left raw", "${BLANKS.source}|[&<>\"']|", "${BLANKS.source}|[&<>]|"],
    ["a lone surrogate let through", "|\\p{Cs}", ""],
    ["tab marked too", "(?![\\t\\n])\\p{Cc}", "(?![\\n])\\p{Cc}"],
    ["the template inserting a value raw", "return escapeText(String(value));", "return String(value);"],
    ["the template taking a value anywhere inside a tag", 'throw new Error("html: a value inside a tag, outside a quoted attribute value");', "source += render(value);"],
    ["the template taking part of a quoted value", "const whole = OPENS[context].test(strings[index]) && after.startsWith(context);", "const whole = true;"],
    ["the template taking markup as a quoted value", "if (!(value instanceof AttributeValue) || !whole)", "if (!(value instanceof AttributeValue || value instanceof Markup) || !whole)"],
    ["the template taking an attribute's value in text", 'if (value instanceof AttributeValue)\n                throw new Error("html: an attribute\'s value outside an attribute");', ""],
    ["the template refusing a space before the quote", "{ '\"': /=\\s*\"$/, \"'\": /=\\s*'$/ }", "{ '\"': /=\"$/, \"'\": /='$/ }"],
    ["every run of blanks shown as itself", "${BLANKS.source}|", ""],
    ["a run that ends a line shown as itself", 'if (end === whole.length || whole[end] === "\\n")\n        return false;', ""],
    ["a run counted only at the very end", 'if (end === whole.length || whole[end] === "\\n")', "if (end === whole.length)"],
    ["a run counted only before a line feed", 'if (end === whole.length || whole[end] === "\\n")', 'if (whole[end] === "\\n")'],
    ["one blank inside a line counted", "if (run.length === 1)\n        return true;", ""],
    ["a run inside a line taken as indentation", 'const startsLine = at === 0 || whole[at - 1] === "\\n";', "const startsLine = true;"],
    ["indentation only at the very start", 'const startsLine = at === 0 || whole[at - 1] === "\\n";', "const startsLine = at === 0;"],
    ["indentation of any length", "run.length <= exports.MAX_INDENT && ", ""],
    ["the bound one more", "exports.MAX_INDENT = 64;", "exports.MAX_INDENT = 65;"],
    ["the bound one less", "exports.MAX_INDENT = 64;", "exports.MAX_INDENT = 63;"],
    ["mixed indentation shown as itself", '(!run.includes(" ") || !run.includes("\\t"))', "true"],
    ["tabs counted as spaces", 'const spaces = run.split(" ").length - 1;', "const spaces = run.length;"],
    ["private-use characters let through", "|\\p{Co}", ""],
    ["a value right after a literal's last < read as text", "index + 1 === literal.length || ", ""],
    ["blank separators let through", "|(?! )\\p{Zs}", ""],
    ["the braille blank and object replacement let through", "|[\\u{2800}\\u{FFFC}]", ""],
    ["an attribute's equals sign left raw", "const ATTRIBUTE_SPECIALS = new RegExp(`[&<>\"'\\`=]|", "const ATTRIBUTE_SPECIALS = new RegExp(`[&<>\"'\\`]|"]
  ] as const) {
    const variant = loadVariant<typeof viewerTextModule>(textPath, [{ find, replace }]);
    await assertCaughtBy(name, AS_TEXT, () => checkEscaping(variant.escapeText, variant.escapeAttribute, variant.html, variant.attribute));
  }
});

const ONE_RUN = "one long run of blanks is escaped within its bound";
const ONE_RUN_BOUND_MS = 100;

/**
 * The security review's input: one run of 32,767 spaces and a letter, which a lookahead in the
 * global match made quadratic, at about a second here, where the match as written takes well under
 * a millisecond. The fastest of three runs is held to the bound, so one pause of the machine does
 * not read as quadratic work. The variant below must stay above the bound for the check to prove
 * anything: it takes between about half a second and a second here, so a CPU about five times
 * faster would trip this self-check, not an honest build.
 */
function checkOneRun(escape: typeof escapeText): void {
  const given = `${" ".repeat(32_767)}x`;
  let out = "";
  let fastest = Infinity;
  for (let trial = 0; trial < 3; trial += 1) {
    const started = performance.now();
    out = escape(given);
    fastest = Math.min(fastest, performance.now() - started);
  }
  holds(ONE_RUN, out === '<span class="ctl">32767 spaces</span>x', () => ({ out: out.slice(0, 80) }));
  holds(ONE_RUN, fastest < ONE_RUN_BOUND_MS, () => ({ fastestMs: Math.round(fastest) }));
}

test("ruling 6: one run of 32,767 spaces escapes to its count, the fastest of three within 100 ms", async () => {
  checkOneRun(escapeText);
  // The same count, reached by a match that looks ahead from every blank to the end of its run.
  const variant = loadVariant<typeof viewerTextModule>(require.resolve("../core/viewer-text"), [{ find: "const BLANKS = /[ \\t]+/;", replace: "const BLANKS = /(?:[ \\t](?![ \\t]*\\n))+/;" }]);
  await assertCaughtBy("a run matched with a lookahead from every blank", ONE_RUN, () => checkOneRun(variant.escapeText));
});

const MANY_RUNS = "many short runs of blanks on one long line are escaped within their bound";
const MANY_RUNS_BOUND_MS = 250;

/**
 * Lines of 256 KiB, past any one evidence page, since escapeText is handed whole strings: one of
 * letters each followed by two blanks, every run a count, and one of letters each followed by one
 * blank, every blank itself but the last, which ends the line. The fastest of three escapes of
 * each is held to the bound. Here the escaper takes about 15 ms and 5 ms; a rule that reads back
 * along the line for each run, by lastIndexOf or a lookahead to the line's end, takes seconds.
 */
function checkManyRuns(escape: typeof escapeText): void {
  const ctl = (inside: string): string => `<span class="ctl">${inside}</span>`;
  for (const [unit, count, wanted] of [
    ["a  ", 87_382, `a${ctl("2 spaces")}`.repeat(87_382)],
    ["a ", 131_072, `${"a ".repeat(131_071)}a${ctl("1 space")}`]
  ] as const) {
    const given = unit.repeat(count);
    let out = "";
    let fastest = Infinity;
    for (let trial = 0; trial < 3; trial += 1) {
      const started = performance.now();
      out = escape(given);
      fastest = Math.min(fastest, performance.now() - started);
    }
    holds(MANY_RUNS, given.length >= 262_144 && out === wanted, () => ({ unit, length: given.length, out: out.slice(0, 80) }));
    holds(MANY_RUNS, fastest < MANY_RUNS_BOUND_MS, () => ({ unit, fastestMs: Math.round(fastest) }));
  }
}

test("ruling 6: a 256 KiB line of two-blank runs and one of single blanks each escape, the fastest of three within 250 ms", async () => {
  checkManyRuns(escapeText);
  // The same output, with each run's line start found by reading back along the line, about 4 s here.
  const variant = loadVariant<typeof viewerTextModule>(require.resolve("../core/viewer-text"), [{ find: 'const startsLine = at === 0 || whole[at - 1] === "\\n";', replace: 'const startsLine = whole.lastIndexOf("\\n", at - 1) + 1 === at;' }]);
  await assertCaughtBy("each run's line start found by reading back along the line", MANY_RUNS, () => checkManyRuns(variant.escapeText));
});

test("ruling 6: captured script text and the owner's words, in every field that holds them, render as text", async () => {
  const world = await viewerWorld();
  const pages = await everyPage(world);
  const evidence = pages.find(({ path }) => path === `${CASE}/evidence/${SCRIPT_DIGEST}`)?.text ?? "";
  for (const escaped of ["&lt;script&gt;window.canaryRan = 1&lt;/script&gt;", "&quot;&gt;&lt;img src=x onerror=&quot;window.canaryRan = 2&quot;&gt;", "&lt;/pre&gt;&lt;b id=&quot;broke-pre&quot;&gt;", "&lt;/textarea&gt;", 'bidi <span class="ctl">U+202E</span>desrever<span class="ctl">U+2069</span>', 'nul<span class="ctl">U+0000</span>byte', '<span class="ctl">U+FEFF</span>// CANARY-SCRIPT-MARKUP', "https://tracker.example/pixel?id=CANARY-URL-QUERY", `trailing: code();<span class="ctl">3 spaces 3 tabs</span>\n<span class="ctl">3 spaces 1 tab</span>\n`]) {
    assert.ok(evidence.includes(escaped), escaped);
  }
  // Every blank that draws no ink is a token, and so is every private-use character.
  const token = (point: number): string => `<span class="ctl">U+${point.toString(16).toUpperCase().padStart(4, "0")}</span>`;
  assert.ok(evidence.includes(`blanks: ${BLANK_POINTS.map((point) => `a${token(point)}b`).join(" ")}`));
  assert.ok(evidence.includes(`private use: ${PRIVATE_POINTS.map((point) => `a${token(point)}b`).join(" ")}\n`));
  assert.ok(evidence.includes(`unassigned: ${UNASSIGNED_POINTS.map((point) => `a${token(point)}b`).join(" ")}\n`));
  // A payload in blanks inside a line is a count; indentation of one kind up to the bound is itself, and past it, or mixed, a count.
  for (const line of [
    `\nalpha<span class="ctl">${counted(ALPHA_RUN)}</span>omega\n`,
    `\nconst ok = 1;<span class="ctl">${counted(CODE_RUN)}</span>// end of line\n`,
    "\nfunction lantern() {\n  if (ready) {\n\t\treturn 1;\n  }\n",
    `\n${" ".repeat(64)}deep();\n<span class="ctl">65 spaces</span>deeper();\n${"\t".repeat(64)}deepTab();\n<span class="ctl">1 space 1 tab</span>mixed();\n}\n`
  ]) {
    assert.ok(evidence.includes(line), JSON.stringify(line.slice(0, 60)));
  }
  // The page says the rule, with the bound the module uses, and so does every page's header.
  assert.ok(evidence.includes(`in indentation of spaces alone or tabs alone, at most ${MAX_INDENT}, at the start of a line or of the page`));
  for (const { path, text } of pages) assert.ok(text.includes(`in indentation of spaces alone or tabs alone, at most ${MAX_INDENT}, with text after it on its line; any other run of them shows as a count`), path);
  for (const [field, page] of Object.entries(OWNER_FIELDS)) {
    const path = page === "" ? CASE : `${CASE}/${page}`;
    const shown = pages.find((candidate) => candidate.path === path)?.text ?? "";
    assert.ok(shown.includes(`${OWNER_ESCAPED} [${field}]`), `${field} on ${path}`);
  }
  assert.ok(OWNER_CANARY.startsWith("CANARY-OWNER"));
});

test("ruling 6: a page escapes even ids and values the decoder would never pass, in its title, its text and its hidden fields", async () => {
  // A view whose ids hold markup, which no decoded log could: the pages still show them only as text.
  const world = await viewerWorld();
  const opened = await world.service.open(world.ownerToken, VIEWER_CASE);
  assert.ok(opened.ok && opened.case.state !== null);
  const marked = "id-<b>x</b>\"'";
  const view = structuredClone(opened.case) as unknown as { caseId: string; state: { record: { facts: { id: string; links: { evidence: string }[] }[]; rows: { id: string }[] } } };
  view.caseId = marked;
  view.state.record.facts[0].id = marked;
  view.state.record.facts[0].links[0].evidence = marked;
  view.state.record.rows.find(({ id }) => id === "row-b1-coverage")!.id = marked;
  const pages = [
    casePage(view as never),
    factPage(view as never, marked) ?? assert.fail("no fact page"),
    rowPage(view as never, "B1", marked) ?? assert.fail("no row page"),
    refusalPage(marked, "evidence-changed", null),
    formRefusalPage(marked, "malformed-form", "id"),
    evidencePage(marked, { digest: SCRIPT_DIGEST, offset: 0, end: 1, total: 1, previous: null, leadingBytes: [], leadingEndsCharacter: false, text: "a", trailingBytes: [], validUtf8: true })
  ];
  for (const page of pages) {
    assert.ok(!page.includes("<b>x</b>"), "raw markup from an id");
    assert.ok(page.includes("id-&lt;b&gt;x&lt;/b&gt;&quot;&#39;"), "the id as text");
    assert.match(page, /<title>[^<]*&lt;b&gt;[^<]*<\/title>/, "the title holds the id as text");
  }
  // A hidden field's value cannot leave its attribute, whatever it holds.
  assert.equal(hiddenField("head", '"><img src=x>\u{202E}').source, '<input type="hidden" name="head" value="&quot;&gt;&lt;img src&#61;x&gt;\u{FFFD}">');
});

test("a service that answers a claim as not a claim, which the viewer never sends, gets a form refusal and a 400", async () => {
  const notAClaim = { caseServiceOver: (world: Parameters<typeof caseServiceOver>[0]) => ({ ...caseServiceOver(world), claim: async () => ({ ok: false as const, refusal: "not-a-claim" as const }) }) };
  const world = await viewerWorld({ serviceModule: notAClaim });
  const response = await world.post(`${CASE}/assertions`, [["head", await headNow(world)], ...FIELDS["record-assertion"]]);
  assert.equal(response.status, 400);
  assert.match(textOf(await response.text()), /That form could not be read not-a-claim\. Nothing was written\./);
});

test("ruling 6: a refusal page names the refusal by its shape, and shows nothing else it was handed", () => {
  const page = refusalPage("case-x", "<b>not-a-refusal</b>", "a/b?c=CANARY-HELD-VALUE");
  assert.ok(!page.includes("CANARY") && !page.includes("<b>not-a-refusal"));
  assert.match(textOf(page), /The log refused it: unrecognized at a place not shown\./);
  assert.match(textOf(refusalPage("case-x", "evidence-changed", "ab".repeat(32))), new RegExp(`The log refused it: evidence-changed at ${"ab".repeat(32)}\\.`));
});

const READINGS: readonly RowReading[] = [
  { reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] },
  { reading: "observed", count: 2, granularity: "function", windowEnd: "truncated", complete: false, limits: ["window_not_closed", "function_only", "late"] },
  { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_walled"] },
  { reading: "unknown", reason: "truncated", complete: false, limits: ["window_not_closed"] },
  { reading: "unknown", reason: "operation_failed", complete: false, limits: ["operation_failed"] },
  { reading: "unknown", reason: "no_record", complete: false },
  { reading: "unknown", reason: "late", complete: false },
  { reading: "recorded" }
];

test("ruling 7: a reading says what readRow says, with the limits a count reads it under, and unknown never carries a count", () => {
  for (const reading of READINGS) {
    const text = textOf(readingMarkup(reading).source).trim();
    if (reading.reading === "unknown") {
      assert.match(text, /^unknown, for [a-z_]+\. Limits: /, text);
      assert.doesNotMatch(text, /[0-9]/, text);
      // A row read unknown for its own state names that state as its limit, as a count across attempts does.
      assert.ok(text.endsWith(`Limits: ${"limits" in reading ? reading.limits.join(" ") : reading.reason}`), text);
    }
    if ("limits" in reading) for (const limit of reading.limits) assert.ok(text.includes(limit), `${text} lacks ${limit}`);
    if (reading.reading === "observed") assert.match(text, new RegExp(`^observed: ${reading.count} counted at ${reading.granularity} granularity, window ended ${reading.windowEnd}, ${reading.complete ? "complete" : "not complete"}\\.`));
    if (reading.reading === "zero_in_window") assert.match(text, /^zero in this window at block granularity, window ended window_closed, not complete\. It speaks for this window only\./);
    if (reading.reading === "recorded") assert.equal(text, "recorded, with no observation to read.");
  }
});

/** The cells of the data row, one with no header cell, whose first cell starts with this text. */
function rowCells(page: string, first: string): readonly string[] {
  for (const [, row] of page.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    if (row.includes("<th>")) continue;
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell).trim());
    if (cells.length > 0 && cells[0].startsWith(first)) return cells;
  }
  return assert.fail(`no row starting ${first}`);
}

/** The value beside a header in a two-column table, such as the row page's. */
function besides(page: string, header: string): string {
  const match = new RegExp(`<tr><th>${header}</th><td>([\\s\\S]*?)</td></tr>`).exec(page);
  return match === null ? assert.fail(`no ${header}`) : textOf(match[1]).trim();
}

test("ruling 7: a fact shows each link's limits as a snapshot when it was recorded, beside the row's reading now, and the row page shows both apart", async () => {
  const world = await viewerWorld();
  const fact = await (await world.send(`${CASE}/facts/fact-early`)).text();
  assert.ok(textOf(fact).includes("The limits beside it are a snapshot taken when this fact was recorded. The reading beside that is the row's reading now."));
  const early = rowCells(fact, "B1 row-b1-coverage");
  assert.deepEqual(early[3].split(" ").sort(), ["cleanup_unresolved", "coverage_not_complete", "main-frame-only"]);
  assert.equal(early[4], "observed: 12 counted at block granularity, window ended window_closed, complete. Limits: no limits");
  // A link whose row reads with limits of its own shows them in the reading now.
  const ran = await (await world.send(`${CASE}/facts/fact-lantern-ran`)).text();
  assert.equal(rowCells(ran, "B3 row-b3-coverage")[4], "observed: 3 counted at block granularity, window ended window_closed, not complete. Limits: coverage_not_complete");
  // The row page: its reading now, and each fact resting on it with that fact's snapshot.
  const row = await (await world.send(`${CASE}/attempts/B1/rows/row-b1-coverage`)).text();
  assert.equal(besides(row, "Reading now"), "observed: 12 counted at block granularity, window ended window_closed, complete. Limits: no limits");
  assert.deepEqual(rowCells(row, "fact-early")[1].split(" ").sort(), ["cleanup_unresolved", "coverage_not_complete", "main-frame-only"]);
  assert.deepEqual(rowCells(row, "fact-lantern-ran")[1].split(" ").sort(), ["main-frame-only"]);
  // A row is shown only inside its own attempt.
  assert.equal((await world.send(`${CASE}/attempts/B2/rows/row-b1-coverage`)).status, 404);
  // A row not present reads unknown for its own state, and the late positive keeps late as a limit, on its page and its attempt's.
  assert.equal(besides(await (await world.send(`${CASE}/attempts/I2/rows/row-i2-nothing`)).text(), "Reading now"), "unknown, for no_record. Limits: no_record");
  assert.equal(besides(await (await world.send(`${CASE}/attempts/I1/rows/row-i1-late`)).text(), "Reading now"), "observed: 2 counted at block granularity, window ended window_closed, not complete. Limits: coverage_not_complete attempt_incomplete late");
  assert.equal(rowCells(await (await world.send(`${CASE}/attempts/I2`)).text(), "row-i2-nothing")[5], "unknown, for no_record. Limits: no_record");
  const attempt = await (await world.send(`${CASE}/attempts/I1`)).text();
  assert.equal(rowCells(attempt, "row-i1-late")[5], "observed: 2 counted at block granularity, window ended window_closed, not complete. Limits: coverage_not_complete attempt_incomplete late");
  assert.deepEqual(rowCells(attempt, "row-i1-coverage")[4], "main-frame-only");
  assert.ok(!textOf(attempt).includes("row-b1-coverage"), "another attempt's row");
});

test("ruling 7: counts across attempts say so, with every denominator, every limit and both labels, and unknown is never counted as zero", async () => {
  const world = await viewerWorld();
  const page = await (await world.send(`${CASE}/aggregates`)).text();
  assert.ok(textOf(page).includes("Each count is an aggregate across attempts, not one execution."));
  assert.ok(textOf(page).includes("ordinary, for visits on the met control and for slots no visit reached"));
  // Each group's row, held to what aggregate itself returns for this case, cell by cell.
  const opened = await world.service.open(world.ownerToken, VIEWER_CASE);
  assert.ok(opened.ok && opened.case.state !== null);
  const state = opened.case.state as CaseState;
  const result = aggregate(aggregateRowsOfCase(state), { id: "by-arm", subject: "subject-lantern", population: null, keys: { heldEqual: ["arm", "commit", "configuration", "release"], allowedToVary: [], unknown: [] } });
  assert.ok(result.ok);
  const rows = [...page.matchAll(/<tr><td><code>(baseline|instrumented)<\/code>([\s\S]*?)<\/tr>/g)].map(([, arm, rest]) => [arm, ...[...rest.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell).trim())]);
  assert.equal(rows.length, result.groups.length);
  for (const group of result.groups) {
    const cells = rows.find((row) => row[0] === group.group.arm && row[2] === group.group.commit && row[5 - 1].startsWith(group.group.basis as string)) ?? assert.fail(`no row for ${JSON.stringify(group.group)}`);
    assert.deepEqual(cells.slice(5, 11).map(Number), [group.n, group.zero, group.unknown, group.of, group.notStarted, group.failed], JSON.stringify(group.group));
    assert.equal(group.n + group.zero + group.unknown, group.of);
    const limits = (["observed", "zero_in_window", "unknown"] as const)
      .filter((reading) => Object.keys(group.limits[reading]).length > 0)
      .map((reading) => `${reading}: ${Object.entries(group.limits[reading]).map(([limit, count]) => `${limit} on ${count}`).join(", ")}`)
      .join(" ");
    assert.equal(cells[11], limits, JSON.stringify(group.group));
    assert.equal(cells[12], "aggregate across attempts, not one execution");
  }
  // The same case had I3 failed rather than never started: the not-started and failed columns each say their own count.
  const failed = structuredClone(state) as unknown as { machine: { attempts: { slot: string; phase: string }[] } };
  (failed.machine.attempts.find(({ slot }) => slot === "I3") as { phase: string }).phase = "failed";
  const other = aggregatesPage({ ...opened.case, state: failed as unknown as CaseState });
  const instrumented = [...other.matchAll(/<tr><td><code>instrumented<\/code>([\s\S]*?)<\/tr>/g)].map(([, rest]) => [...rest.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell).trim()));
  assert.deepEqual(instrumented.map((cells) => cells.slice(8, 10).join(" ")), ["0 2"]);
});

test("the attempt page says when a slot never started, and the exception line says what the model records", async () => {
  const world = await viewerWorld();
  assert.match(textOf(await (await world.send(`${CASE}/attempts/I3`)).text()), /No visit began in this slot, so there was no execution and there is no evidence to show\./);
  assert.match(textOf(await (await world.send(`${CASE}/attempts/B1`)).text()), /One attempt's evidence, from one execution\./);
  const planned = (slots: readonly ("B1" | "B2" | "B3")[]): readonly ScriptCommand[] => [
    { as: "owner", event: logEvent("case-planned", { slots: slots.map((slot) => ({ slot, attemptId: ATTEMPT_IDS[slot] })), controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER as never }) },
    { as: "owner", event: logEvent("plan-frozen", { planDigest: PLAN_DIGEST }) }
  ];
  // An exception recorded, and the case cancelled before any visit: the mark stands, and no visit rested on it.
  const cancelled = await worldWith([...planned(["B1", "B2", "B3"]), { as: "owner", event: logEvent("exception-recorded", { slot: "B1", reason: "Trying ahead." }) }, { as: "owner", event: logEvent("case-cancelled") }]);
  const first = await (await cancelled.send(CASE)).text();
  assert.equal(besides(first, "Exception"), "recorded: the case is marked exploratory, and nothing clears the mark");
  assert.equal(besides(first, "Visits on an exception"), "none");
  assert.equal(rowCells(first, "B1")[5], "no visit");
  // An exception recorded, spent by a configuration change, and B1 visiting on the control: the mark stands, B1 rested on the control.
  const spent = await worldWith([
    ...planned(["B1", "B2", "B3"]),
    { as: "owner", event: logEvent("exception-recorded", { slot: "B1", reason: "Trying ahead." }) },
    { as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_BIRCH as never }) },
    { as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_BIRCH as never, result: "met" }) },
    { as: "owner", event: logEvent("attempt-started", { slot: "B1" }) },
    { as: "B1", event: logEvent("capture-began", { slot: "B1" }) },
    { as: "B1", event: logEvent("capture-finished", { slot: "B1" }) },
    { as: "B1", event: logEvent("attempt-finished", { slot: "B1", outcome: "usable", reason: null }) },
    { as: "owner", event: logEvent("cleanup-confirmed", { slot: "B1" }) }
  ]);
  const second = await (await spent.send(CASE)).text();
  assert.equal(besides(second, "Exception"), "recorded: the case is marked exploratory, and nothing clears the mark");
  assert.equal(besides(second, "Visits on an exception"), "none");
  assert.equal(rowCells(second, "B1")[5], "control");
  assert.equal(rowCells(second, "B2")[5], "no visit yet; if a visit began here, it would rest on control");
  assert.equal(besides(await (await spent.send(`${CASE}/attempts/B1`)).text(), "Visit rested on"), "control");
  // An exception waiting for B1, with no control met: B1 would rest on the exception, B2 on nothing.
  const pending = await worldWith([...planned(["B1", "B2", "B3"]), { as: "owner", event: logEvent("exception-recorded", { slot: "B1", reason: "Trying ahead." }) }]);
  const third = await (await pending.send(CASE)).text();
  assert.equal(rowCells(third, "B1")[5], "no visit yet; if a visit began here, it would rest on exception");
  assert.equal(rowCells(third, "B2")[5], "no visit yet; if a visit began here, nothing would cover it");
  // The fixture's B2 did rest on its exception, and the overview names it.
  const fixture = await (await world.send(CASE)).text();
  assert.equal(besides(fixture, "Visits on an exception"), "B2");
  assert.equal(rowCells(fixture, "B2")[5], "exception");
});

test("ruling 8: the four cases the workspace cannot answer, and that REA limits arrive with W4, are what every page states", () => {
  assert.equal(CANNOT_ANSWER.length, 4);
  assert.match(CANNOT_ANSWER[0], /child frames and in workers/);
  assert.match(CANNOT_ANSWER[1], /negative-column defect/);
  assert.match(CANNOT_ANSWER[2], /before arming.*signed in.*payloads/);
  assert.match(CANNOT_ANSWER[3], /Authorship, purpose, and whether a backend received anything/);
  assert.match(ADAPTER_NOTE, /adapter batch \(W4\)/);
});

const TYPED = "a case that will not open gets a typed refusal page that shows nothing it held";

async function checkRefusal(world: ViewerWorld, expected: RegExp, canary: string | null): Promise<void> {
  const head = storedHead(world);
  for (const route of VIEWER_ROUTES) {
    const response = route.method === "GET" ? await world.send(concrete(route.path)) : await world.post(concrete(route.path), [["head", head ?? "0".repeat(64)], ...FIELDS[route.name]]);
    const page = await response.text();
    holds(TYPED, response.status === 409, () => ({ route: route.name, status: response.status }));
    holds(TYPED, expected.test(textOf(page)), () => ({ route: route.name, text: textOf(page).slice(0, 300) }));
    holds(TYPED, canary === null || !page.includes(canary), () => ({ route: route.name, canary }));
  }
  holds(TYPED, storedHead(world) === head, () => "a refused case was written to");
}

test("ruling 9: a case that will not open gets a typed refusal page, by name and place, that shows nothing it held", async () => {
  // Evidence changed under the log, to bytes holding a value.
  const changed = await viewerWorld();
  const digest = digestOfRaw("raw-b1-network");
  changed.stores.get(VIEWER_CASE)?.evidence.objects.set(digest, new TextEncoder().encode("CANARY-HELD-VALUE in changed bytes"));
  await checkRefusal(changed, new RegExp(`Case ${VIEWER_CASE} will not open The log refused it: evidence-changed at ${digest}\\.`), "CANARY-HELD-VALUE");
  // An entry the fold cannot apply, holding a value, appended past the store's own checks.
  const folded = await viewerWorld();
  const stores = folded.stores.get(VIEWER_CASE);
  assert.ok(stores);
  const owner = await ownerActorAt(folded.signing, NOW_MS);
  const appended = await appendCommand(stores, { caseId: VIEWER_CASE, actor: owner, events: [logEvent("claim-approved", { text: "CANARY-HELD-VALUE in an entry" })], evidence: [], expectedHead: stores.head.value as string, now: () => NOW_MS });
  assert.ok(appended.ok);
  await checkRefusal(folded, /will not open The log refused it: unknown-event-type at type\./, "CANARY-HELD-VALUE");
  // A case with no log.
  const none = await viewerWorld({ seeded: false });
  await checkRefusal(none, /will not open The log refused it: head-missing\./, null);
  // A page that showed the case anyway, or dropped the refusal's name, is caught.
  const routesPath = require.resolve("../core/viewer-routes");
  const untyped = loadVariant<typeof viewerRoutesModule>(routesPath, [{ find: "return (0, workspace_response_1.htmlResponse)(409, (0, viewer_pages_1.refusalPage)(caseId, answer.refusal, answer.at));", replace: 'return (0, workspace_response_1.htmlResponse)(500, "<p>Something went wrong.</p>");' }]);
  const broken = await viewerWorld({ routesOf: untyped.viewerRoutes });
  broken.stores.get(VIEWER_CASE)?.evidence.objects.set(digest, new TextEncoder().encode("changed"));
  await assertCaughtBy("an untyped refusal", TYPED, () => checkRefusal(broken, /evidence-changed/, null));
});

test("ruling 1: with no case service, every case route answers 503 as a missing configuration does, and health says no case is served", async () => {
  const world = await viewerWorld({ noService: true });
  for (const route of VIEWER_ROUTES) {
    for (const method of ["GET", "POST"]) {
      const response = method === "GET" ? await world.send(concrete(route.path)) : await world.post(concrete(route.path), [["head", "0".repeat(64)]]);
      assert.deepEqual([response.status, await response.text()], [503, '{"error":"unavailable"}'], `${method} ${route.path}`);
    }
  }
  assert.equal(((await (await world.send("/health")).json()) as { status: string }).status, "deny-all");
  assert.equal((await world.send(`${CASE}/approve`)).status, 404);
  assert.equal(world.calls(), 0);
  const serving = await viewerWorld();
  assert.equal(((await (await serving.send("/health")).json()) as { status: string }).status, "serving-cases");
});

test("a form that cannot be read is refused by the field it failed at, or for its size or kind by name, shows nothing it held, and writes nothing", async () => {
  const world = await viewerWorld();
  const head = await headNow(world);
  for (const [name, status, init, fields, expected] of [
    ["not a form", 415, { contentType: "text/plain", body: "head=x" }, [], /not-a-form\. A claim is posted as an HTML form, application\/x-www-form-urlencoded\./],
    ["a form past the bound", 413, {}, [["head", head], ["statement", `CANARY-HELD-VALUE${"x".repeat(MAX_FORM_BYTES)}`]], new RegExp(`form-too-large\\. A form may hold at most ${MAX_FORM_BYTES} bytes`)],
    ["no head", 400, {}, [["id", "said-x"], ["statement", "CANARY-HELD-VALUE"]], /malformed-form at head\./],
    ["a head that is not a digest", 400, {}, [["head", "CANARY-HELD-VALUE"], ["id", "said-x"], ["statement", "x"]], /malformed-form at head\./],
    ["a repeated id", 400, {}, [["head", head], ["id", "said-x"], ["id", "CANARY-HELD-VALUE"], ["statement", "x"]], /malformed-form at id\./]
  ] as const) {
    const response = await world.post(`${CASE}/assertions`, fields, init);
    const page = await response.text();
    assert.equal(response.status, status, name);
    assert.match(textOf(page), expected, name);
    assert.ok(!page.includes("CANARY-HELD-VALUE"), name);
  }
  const badCite = await world.post(`${CASE}/interpretations`, [["head", head], ["id", "reading-x"], ["statement", "x"], ["cite", "fact-lantern-ran:one"]]);
  assert.equal(badCite.status, 400);
  assert.match(textOf(await badCite.text()), /malformed-form at cite\./);
  // Text the model refuses is refused by the model, by field or by the event's type, and not repeated.
  const blank = await world.post(`${CASE}/assertions`, [["head", head], ["id", "CANARY-HELD-VALUE"], ["statement", "x"]]);
  assert.equal(blank.status, 422);
  const blankPage = await blank.text();
  assert.match(textOf(blankPage), /refused it: malformed-event at assertion-recorded\./);
  assert.ok(!blankPage.includes("CANARY-HELD-VALUE"));
  assert.equal(storedHead(world), head);
});

test("the largest claim of each kind the model accepts fits the form bound, through the page", async () => {
  const text = (mark: string) => `${mark}${"\u{6F22}".repeat(MAX_TEXT_CHARS - mark.length)}`;
  const slug = (stem: string) => `${stem}${"a".repeat(MAX_SLUG_CHARS - stem.length)}`;
  assert.ok(isSlug(slug("said-")) && !isSlug(`${slug("said-")}a`), "MAX_SLUG_CHARS is the slug's own bound");
  const unknown = (stem: string): readonly (readonly [string, string])[] => [["unknown-id", slug(stem)], ["unknown-question", text("q")], ["unknown-reason", text("r")], ["unknown-detail", text("d")], ["unknown-would-resolve", text("w")]];
  const largest: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
    "record-fact": [["id", slug("fact-")], ["statement", text("s")], ...["row-b1-coverage", "row-b1-network", "row-b1-script", "row-b2-coverage", "row-b3-coverage", "row-i1-coverage", "row-i1-late"].map((row) => ["evidence", row] as const)],
    "supersede-fact": [["statement", text("s")], ["reason", text("r")]],
    "retract-fact": [["reason", text("r")], ...unknown("unknown-f")],
    "record-assertion": [["id", slug("said-")], ["statement", text("s")]],
    "retract-assertion": [["reason", text("r")], ...unknown("unknown-a")],
    "record-interpretation": [["id", slug("reading-")], ["statement", text("s")], ["cite", "fact-lantern-ran:1"], ["cite", "fact-lantern-host:2"], ["cite", "fact-early:1"], ["cite", "fact-markup:2"]],
    "reaffirm-interpretation": [["cite", "fact-lantern-host:2"]]
  };
  for (const route of WRITES) {
    const world = await viewerWorld();
    const fields: readonly (readonly [string, string])[] = [["head", await headNow(world)], ...largest[route.name]];
    const bytes = new URLSearchParams(fields as [string, string][]).toString().length;
    assert.ok(bytes <= MAX_FORM_BYTES, `${route.name}: ${bytes}`);
    const response = await world.post(concrete(route.path), fields);
    assert.equal(response.status, 303, `${route.name} at ${bytes} bytes: ${textOf(await response.clone().text()).slice(0, 200)}`);
  }
});

test("a textarea's CR LF is read as the line feed the owner typed, and a lone CR still shows", async () => {
  const world = await viewerWorld();
  const response = await world.post(`${CASE}/assertions`, [["head", await headNow(world)], ["id", "said-lines"], ["statement", "line one\r\nline two\rlone"]]);
  assert.equal(response.status, 303);
  const page = await (await world.send(CASE)).text();
  assert.ok(page.includes('line one\nline two<span class="ctl">U+000D</span>lone'));
  const opened = await world.service.open(world.ownerToken, VIEWER_CASE);
  assert.ok(opened.ok && opened.case.state?.record.assertions.some(({ statement }) => statement === "line one\nline two\rlone"));
});

/** The href of a link by its label on a page, as a browser would read it. */
function hrefOf(page: string, label: string): string | null {
  const match = new RegExp(`<a href="([^"]*)">${label}</a>`).exec(page);
  return match === null ? null : match[1].replace(/&#61;/g, "=").replace(/&amp;/g, "&");
}

test("evidence is shown only for objects this case names, a page at a time by byte offset, with links that go to the pages that are there", async () => {
  const world = await viewerWorld();
  const stores = world.stores.get(VIEWER_CASE);
  assert.ok(stores);
  // Stored beside the case, named by nothing it holds.
  const loose = await putEvidence(stores, new TextEncoder().encode("CANARY-HELD-VALUE named by no entry"));
  assert.ok(loose.ok);
  const unnamed = await world.send(`${CASE}/evidence/${loose.digest}`);
  assert.equal(unnamed.status, 404);
  const unnamedPage = await unnamed.text();
  assert.match(textOf(unnamedPage), /not-named-by-this-case/);
  assert.ok(!unnamedPage.includes("CANARY-HELD-VALUE"));
  // What the case keeps is readable as well as what its rows name.
  assert.equal((await world.send(`${CASE}/evidence/${digestOfRaw("raw-plan")}`)).status, 200);
  const total = new TextEncoder().encode(SCRIPT_CANARY).length;
  const first = await (await world.send(`${CASE}/evidence/${SCRIPT_DIGEST}`)).text();
  assert.match(textOf(first), new RegExp(`Bytes 0 to 32768 of ${total}, decoded as UTF-8\\.`));
  assert.equal(hrefOf(first, "Previous page"), null);
  const second = await (await world.send(hrefOf(first, "Next page") ?? assert.fail("no next page"))).text();
  assert.match(textOf(second), new RegExp(`Bytes 32768 to ${total} of ${total}`));
  assert.equal(hrefOf(second, "Next page"), null, "no Next page on the last page");
  assert.equal(hrefOf(second, "Previous page"), `${CASE}/evidence/${SCRIPT_DIGEST}?offset=0`);
  // The byte order mark is three bytes, so offset 1 starts inside it, and those bytes show as bytes.
  const inside = await (await world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=1`)).text();
  assert.match(textOf(inside), /This page starts inside a character: its first 2 bytes end a character the page before holds, and show as bytes\./);
  assert.ok(inside.includes('<pre>\n<span class="ctl">byte 0xBB</span><span class="ctl">byte 0xBF</span>// CANARY-SCRIPT-MARKUP'));
  assert.ok(!textOf(inside).includes("not all UTF-8"), "the object is UTF-8, whichever page is shown");
  for (const offset of ["-1", "01", "x", "1e3", ""]) assert.equal((await world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=${offset}`)).status, 400, offset);
  assert.equal((await world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=${total}`)).status, 404);
  assert.equal((await world.send(`${CASE}/evidence/${SCRIPT_DIGEST}?offset=${total + 1}`)).status, 404);
});

test("an evidence page keeps a leading line feed, links back to where each page began, and shows bytes cut short as bytes", async () => {
  const euros = new TextEncoder().encode(`x${"\u{20AC}".repeat(40_000)}`);
  const leading = new TextEncoder().encode("\nfirst line\nsecond line");
  const cut = new Uint8Array([0x61, 0xe2, 0x82]);
  const digests = await Promise.all([euros, leading, cut].map(async (bytes) => createHash("sha256").update(bytes).digest("hex")));
  const start = CASE_SCRIPT.findIndex(({ event }) => event.type === "capture-began");
  const row = (index: number): ScriptCommand => ({ as: "B1", event: logEvent("evidence-recorded", { row: { id: `row-object-${index}`, slot: "B1", instrument: "inspect", state: "present", window: { clock: "harness", startMs: 1, endMs: 2 }, limits: [], digest: digests[index], observation: null } }) });
  const world = await worldWith([...CASE_SCRIPT.slice(0, start + 1), row(0), row(1), row(2)], [euros, leading, cut]);
  // The parser drops one line feed right after <pre>, so the page writes one for it to drop.
  const leadingPage = await (await world.send(`${CASE}/evidence/${digests[1]}`)).text();
  assert.ok(leadingPage.includes("<pre>\n\nfirst line\nsecond line</pre>"));
  // Forward by each page's Next, then back by each page's Previous, through pages of valid three-byte characters.
  const visited: string[] = [`${CASE}/evidence/${digests[0]}`];
  let page = await (await world.send(visited[0])).text();
  for (let next = hrefOf(page, "Next page"); next !== null; next = hrefOf(page, "Next page")) {
    visited.push(next);
    page = await (await world.send(next)).text();
    assert.ok(!textOf(page).includes("not all UTF-8") && !textOf(page).includes("inside a character"), next);
  }
  assert.ok(visited.length >= 4);
  for (let index = visited.length - 1; index > 0; index -= 1) {
    const at = await (await world.send(visited[index])).text();
    assert.equal(hrefOf(at, "Previous page"), visited[index - 1].includes("?") ? visited[index - 1] : `${visited[index - 1]}?offset=0`, `back from ${visited[index]}`);
  }
  const cutPage = await (await world.send(`${CASE}/evidence/${digests[2]}`)).text();
  assert.match(textOf(cutPage), /This object is not all UTF-8[^.]*\. This page ends inside a character: its last 2 bytes begin one it does not hold, and show as bytes\./);
  assert.ok(cutPage.includes('<pre>\na<span class="ctl">byte 0xE2</span><span class="ctl">byte 0x82</span></pre>'));
});

test("the form bound is the value its formula gives from the model's bounds, and a form one byte past it is refused", async () => {
  // Five text fields, each MAX_TEXT_CHARS units and a 32-unit name; MAX_LIST_ITEMS items, each a slug, a version and a name; eight more fields, each a slug and a name; nine bytes a unit.
  assert.equal(MAX_FORM_BYTES, 9 * (5 * (MAX_TEXT_CHARS + 32) + 64 * (MAX_SLUG_CHARS + 48) + 8 * (MAX_SLUG_CHARS + 32)));
  assert.equal(MAX_FORM_BYTES, 257_184);
  const world = await viewerWorld();
  const head = await headNow(world);
  const prefix = `head=${head}&id=said-at-bound&statement=`;
  const body = (length: number) => prefix + "x".repeat(length - prefix.length);
  const contentType = "application/x-www-form-urlencoded";
  const at = await world.send(`${CASE}/assertions`, { method: "POST", origin: VIEWER_ORIGIN, contentType, body: body(MAX_FORM_BYTES) });
  assert.equal(at.status, 422, "a form at the bound is read, and the model refuses its overlong statement");
  const past = await world.send(`${CASE}/assertions`, { method: "POST", origin: VIEWER_ORIGIN, contentType, body: body(MAX_FORM_BYTES + 1) });
  assert.equal(past.status, 413);
});

test("CR LF is read as a line feed in every field the owner writes, and a form whose bytes are not UTF-8 is refused with that reason", async () => {
  const world = await viewerWorld();
  const lines = (field: string) => `${field} one\r\n${field} two`;
  assert.equal((await world.post(`${CASE}/facts/fact-lantern-host/supersede`, [["head", await headNow(world)], ["statement", lines("statement")], ["reason", lines("reason")]])).status, 303);
  assert.equal((await world.post(`${CASE}/assertions/said-thimble-clear/retract`, [["head", await headNow(world)], ["reason", lines("why")], ["unknown-id", "unknown-lines"], ["unknown-question", lines("question")], ["unknown-reason", lines("because")], ["unknown-detail", lines("detail")], ["unknown-would-resolve", lines("resolve")]])).status, 303);
  const opened = await world.service.open(world.ownerToken, VIEWER_CASE);
  assert.ok(opened.ok && opened.case.state !== null);
  const { record } = opened.case.state;
  const fact = record.facts.find(({ id }) => id === "fact-lantern-host");
  const said = record.assertions.find(({ id }) => id === "said-thimble-clear");
  const unknown = record.unknowns.find(({ id }) => id === "unknown-lines");
  const written = [fact?.statement, fact?.history.at(-1)?.reason, said?.retraction?.reason, unknown?.question, unknown?.reason, unknown?.detail, unknown?.wouldResolve];
  assert.deepEqual(written, ["statement one\nstatement two", "reason one\nreason two", "why one\nwhy two", "question one\nquestion two", "because one\nbecause two", "detail one\ndetail two", "resolve one\nresolve two"]);
  const garbled = await world.send(`${CASE}/assertions`, { method: "POST", origin: VIEWER_ORIGIN, contentType: "application/x-www-form-urlencoded", body: new Uint8Array([0x68, 0x65, 0x61, 0x64, 0x3d, 0xff]) });
  assert.equal(garbled.status, 400);
  assert.match(textOf(await garbled.text()), /malformed-form\. The form's bytes are not UTF-8\. Nothing was written\./);
});

test("an evidence page names stray continuation bytes as stray, and says they end a character only when the page before holds its start", async () => {
  const objects = [
    new Uint8Array([0x9f, 0x98, 0x61]),
    new TextEncoder().encode("\u{1F600}z"),
    // A lead of four bytes then a letter, a letter before a stray byte, and a two-letter object.
    new Uint8Array([0xf0, 0x9f, 0x61]),
    new Uint8Array([0x61, 0x80, 0x62]),
    new TextEncoder().encode("ab")
  ];
  const digests = objects.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  const start = CASE_SCRIPT.findIndex(({ event }) => event.type === "capture-began");
  const row = (index: number): ScriptCommand => ({ as: "B1", event: logEvent("evidence-recorded", { row: { id: `row-object-${index}`, slot: "B1", instrument: "inspect", state: "present", window: { clock: "harness", startMs: 1, endMs: 2 }, limits: [], digest: digests[index], observation: null } }) });
  const world = await worldWith([...CASE_SCRIPT.slice(0, start + 1), ...objects.map((_, index) => row(index))], objects);
  const pageAt = async (index: number, offset: number): Promise<string> => textOf(await (await world.send(`${CASE}/evidence/${digests[index]}${offset === 0 ? "" : `?offset=${offset}`}`)).text());
  const strayNote = (count: number): RegExp => new RegExp(`This page starts with ${count} stray continuation bytes that finish no character, shown as bytes\\.`);
  const insideNote = (count: number): RegExp => new RegExp(`This page starts inside a character: its first ${count} bytes end a character the page before holds, and show as bytes\\.`);
  const first = await pageAt(0, 0);
  assert.match(first, strayNote(2));
  assert.doesNotMatch(first, /end a character the page before holds/);
  // Inside the emoji after its first byte, and after its third, the lead three bytes back.
  assert.match(await pageAt(1, 1), insideNote(3));
  assert.match(await pageAt(1, 3), insideNote(1));
  // A lead that needs more bytes than follow it, and a letter, lead no stray byte; a page between two letters says nothing of bytes.
  for (const [index, offset] of [[2, 1], [3, 1]] as const) {
    const shown = await pageAt(index, offset);
    assert.match(shown, strayNote(1), `object ${index}`);
    assert.doesNotMatch(shown, /end a character the page before holds/, `object ${index}`);
  }
  assert.doesNotMatch(await pageAt(4, 1), /This page starts/);
});

test("a case with a log and no plan says so, and offers nothing to write", async () => {
  const world = await worldWith([]);
  const response = await world.send(CASE);
  const page = await response.text();
  assert.equal(response.status, 200);
  assert.match(textOf(page), /This case has a log and no plan yet, so there is nothing to read\./);
  assert.ok(!page.includes("<form"));
});
