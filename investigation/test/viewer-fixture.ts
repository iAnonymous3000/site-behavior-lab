import { createHash } from "node:crypto";
import { AccessKeySet, ACCESS_TOKEN_HEADER, verifyAccessToken } from "../core/access-token";
import { ownerActorFrom, type OwnerActor } from "../core/actor";
import { caseServiceOver, type CaseService } from "../core/case-service";
import { createLog, putEvidence } from "../core/case-log";
import { viewerRoutes } from "../core/viewer-routes";
import { handleWorkspaceRequest, type WorkspaceEnv } from "../core/workspace-gate";
import { actorsFor, CASE_SCRIPT, continueScript, logEvent, risingClock, storeRawObjects, SUPERSEDE_COMMAND, type ScriptCommand } from "./case-fixture";
import { acrossABoundary, VIEWER_HOSTNAME, VIEWER_ORIGIN } from "./memory-case-world";
import { copyOfStores, memoryStores, type MemoryStores } from "./memory-log-store";
import { AUDIENCE, certsFor, generateSigningKey, HEALTH_AUDIENCE, HEALTH_CLIENT, ISSUER, NOW_MS, OWNER, OWNER_EMAIL, ownerClaims, POLICY, serviceClaims, signToken, type SigningKey } from "./token-fixture";

/**
 * The viewer's synthetic world: W2's whole fixture case, with escaping canaries planted where a
 * capture and the owner can each put text, carried behind the gate and the viewer's routes. Every
 * name is invented and every address reserved. Characters that act unseen are built from their
 * code points here, so no source file holds one.
 */

export const VIEWER_CASE = "case-viewer";

const at = (point: number): string => String.fromCodePoint(point);
export const RLO = at(0x202e);
export const PDI = at(0x2069);
export const ZERO_WIDTH = at(0x200b);
export const NUL = at(0);
export const ESCAPE = at(0x1b);
export const BOM = at(0xfeff);
export const LINE_SEPARATOR = at(0x2028);
/** Two Hebrew letters, which reorder the code around them in a browser's default layout. */
export const HEBREW = at(0x05d0) + at(0x05d1);
/** The blank characters, beside the plain space and tab, a browser draws with no ink: every other space separator, the braille blank and the object replacement character. */
export const BLANK_POINTS: readonly number[] = [0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0x2800, 0xfffc];

/** Private-use code points, which a font may draw as nothing: the first and last of each area, and two the system font on macOS draws with no ink. */
export const PRIVATE_POINTS: readonly number[] = [0xe000, 0xf860, 0xf861, 0xf8ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd];

/** Code points no Unicode version yet assigns, five of which the system fonts on macOS draw with no ink. */
export const UNASSIGNED_POINTS: readonly number[] = [0x0378, 0x0e00, 0x181a, 0x187f, 0xa48d, 0xfb0f, 0x2fffd];

/** Text written as blanks, one per bit, a tab for 1 and a space for 0: a payload a line can carry in what looks like nothing. */
export const blankBits = (text: string): string => [...new TextEncoder().encode(text)].flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => ((byte >> shift) & 1 ? "\t" : " "))).join("");
/** The security review's two payloads: 104 blanks between two words, and 328 between a statement and its comment. */
export const ALPHA_RUN = blankBits("HIDDEN-MARKER");
export const CODE_RUN = blankBits("HIDDEN-MARKER-0123456789-ABCDEFGHIJKLMNOP");
/** Ordinary indented code, then indentation at the bound, one past it, and mixed. */
export const INDENTED = ["function lantern() {", "  if (ready) {", "\t\treturn 1;", "  }", `${" ".repeat(64)}deep();`, `${" ".repeat(65)}deeper();`, `${"\t".repeat(64)}deepTab();`, " \tmixed();", "}"];

/** What a captured script could hold to break a page, ending in a line longer than one page. */
export const SCRIPT_CANARY = [
  `${BOM}// CANARY-SCRIPT-MARKUP`,
  "<script>window.canaryRan = 1</script>",
  '"><img src=x onerror="window.canaryRan = 2">',
  "</pre><b id=\"broke-pre\">out of the pre</b>",
  "</textarea><i id=\"broke-textarea\">out of a textarea</i>",
  "<style>body{display:none}</style>",
  "javascript:alert(1)",
  "https://tracker.example/pixel?id=CANARY-URL-QUERY",
  `bidi ${RLO}desrever${PDI} end, zero${ZERO_WIDTH}width, nul${NUL}byte, escape${ESCAPE}[31m, separator${LINE_SEPARATOR}here`,
  `blanks: ${BLANK_POINTS.map((point) => `a${at(point)}b`).join(" ")}`,
  `trailing: code();${" \t".repeat(3)}`,
  " \t  ",
  `rtl: limit = "${HEBREW}" + 10 + 99;`,
  `alpha${ALPHA_RUN}omega`,
  `const ok = 1;${CODE_RUN}// end of line`,
  ...INDENTED,
  `private use: ${PRIVATE_POINTS.map((point) => `a${at(point)}b`).join(" ")}`,
  `unassigned: ${UNASSIGNED_POINTS.map((point) => `a${at(point)}b`).join(" ")}`,
  `${"x".repeat(40_000)}END-OF-LONG-LINE`
].join("\n");

/** An owner statement holding right-to-left letters among code, laid out on the case page. */
export const OWNER_RTL = `owner-rtl: limit = "${HEBREW}" + 10 + 99;`;

/** What the owner could type that a page must still show as text. */
export const OWNER_CANARY = `CANARY-OWNER <script>window.ownerRan = 1</script></textarea>"'><b id="broke-owner">bold</b> ${RLO}txet${PDI} nul${NUL}end`;

export const SCRIPT_DIGEST = createHash("sha256").update(SCRIPT_CANARY, "utf8").digest("hex");

/** The owner's canary, tagged with the field it is planted in, so a page that shows one shows which. */
export const ownerCanary = (field: string): string => `${OWNER_CANARY} [${field}]`;

/** Every free-text field the owner writes, with the page that shows it. */
export const OWNER_FIELDS: Readonly<Record<string, string>> = {
  "fact-statement": "facts/fact-markup",
  "fact-earlier-statement": "facts/fact-markup",
  "supersede-reason": "facts/fact-markup",
  "fact-retraction": "facts/fact-markup-two",
  "interpretation": "",
  "assertion": "",
  "assertion-retraction": "",
  "unknown-question": "",
  "unknown-reason": "",
  "unknown-detail": "",
  "unknown-would-resolve": "",
  "fact-unknown-question": "",
  "fact-unknown-reason": "",
  "fact-unknown-detail": "",
  "fact-unknown-would-resolve": ""
};

/**
 * W2's case, with a row holding the canary script, a fact recorded while B1 still captured (so its
 * snapshot of limits differs from the row's reading once B1 ends clean), the owner's canary words in
 * every free-text field a claim has, each tagged with its field, a supersede that flags two
 * readings, and last an assertion whose words hold right-to-left letters among code.
 */
export const VIEWER_SCRIPT: readonly ScriptCommand[] = (() => {
  const index = CASE_SCRIPT.findIndex(({ event }) => event.type === "evidence-recorded" && (event.data.row as { id: string }).id === "row-b1-network");
  const scriptRow: ScriptCommand = {
    as: "B1",
    event: logEvent("evidence-recorded", {
      row: { id: "row-b1-script", slot: "B1", instrument: "inspect", state: "present", window: { clock: "harness", startMs: 60, endMs: 880 }, limits: ["main-frame-only"], digest: SCRIPT_DIGEST, observation: null }
    })
  };
  return [
    ...CASE_SCRIPT.slice(0, index + 1),
    scriptRow,
    { as: "owner", event: logEvent("fact-recorded", { id: "fact-early", statement: "The lantern routine ran while the first visit was still capturing.", evidence: ["row-b1-coverage"] }) },
    ...CASE_SCRIPT.slice(index + 1),
    { as: "owner", event: logEvent("fact-recorded", { id: "fact-markup", statement: ownerCanary("fact-earlier-statement"), evidence: ["row-b1-script"] }) },
    { as: "owner", event: logEvent("interpretation-recorded", { id: "reading-markup", statement: ownerCanary("interpretation"), cites: [{ fact: "fact-markup", version: 1 }] }) },
    { as: "owner", event: logEvent("fact-superseded", { fact: "fact-markup", statement: ownerCanary("fact-statement"), reason: ownerCanary("supersede-reason") }) },
    { as: "owner", event: logEvent("fact-recorded", { id: "fact-markup-two", statement: "A second fact about the script row, to retract.", evidence: ["row-b1-script"] }) },
    {
      as: "owner",
      event: logEvent("fact-retracted", {
        fact: "fact-markup-two",
        reason: ownerCanary("fact-retraction"),
        unknown: { id: "unknown-fact-markup", question: ownerCanary("fact-unknown-question"), reason: ownerCanary("fact-unknown-reason"), detail: ownerCanary("fact-unknown-detail"), wouldResolve: ownerCanary("fact-unknown-would-resolve") }
      })
    },
    { as: "owner", event: logEvent("assertion-recorded", { id: "said-markup", statement: ownerCanary("assertion") }) },
    {
      as: "owner",
      event: logEvent("assertion-retracted", {
        assertion: "said-markup",
        reason: ownerCanary("assertion-retraction"),
        unknown: { id: "unknown-markup", question: ownerCanary("unknown-question"), reason: ownerCanary("unknown-reason"), detail: ownerCanary("unknown-detail"), wouldResolve: ownerCanary("unknown-would-resolve") }
      })
    },
    SUPERSEDE_COMMAND,
    { as: "owner", event: logEvent("assertion-recorded", { id: "said-in-hebrew", statement: OWNER_RTL }) }
  ];
})();

/** The owner's actor at a given time, by the only route there is: a token signed and verified at that time. */
export async function ownerActorAt(signing: SigningKey, nowMs: number): Promise<OwnerActor> {
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => nowMs);
  const decision = await verifyAccessToken(await signToken(signing, claimsAt(nowMs)), POLICY, keySet, () => nowMs);
  if (!decision.ok) throw new Error(`The fixture token was refused: ${decision.refusal}`);
  return ownerActorFrom(decision.identity) as OwnerActor;
}

/** The owner's claims for a token valid for an hour from this time. */
export function claimsAt(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(nowMs / 1000);
  return ownerClaims({ iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...overrides });
}

/** W2's case and the canaries, on fresh memory stores, entries an hour before `nowMs`. */
export async function seededStores(signing: SigningKey, nowMs: number): Promise<MemoryStores> {
  const stores = memoryStores();
  const created = await createLog(stores);
  if (!created.ok) throw new Error("The fixture's log exists already");
  await storeRawObjects(stores);
  const put = await putEvidence(stores, new TextEncoder().encode(SCRIPT_CANARY));
  if (!put.ok || put.digest !== SCRIPT_DIGEST) throw new Error("The canary script was not stored at its digest");
  const owner = await ownerActorAt(signing, nowMs);
  await continueScript({ stores, caseId: VIEWER_CASE, actorOf: actorsFor(owner), now: risingClock(nowMs - 3_600_000), commands: VIEWER_SCRIPT });
  return stores;
}

export const VIEWER_ENV: WorkspaceEnv = {
  INVESTIGATION_ACCESS_ISSUER: ISSUER,
  INVESTIGATION_ACCESS_AUDIENCE: AUDIENCE,
  INVESTIGATION_OWNER_SUBJECT: OWNER,
  INVESTIGATION_OWNER_EMAIL: OWNER_EMAIL,
  INVESTIGATION_HEALTH_CLIENT_ID: HEALTH_CLIENT,
  INVESTIGATION_HEALTH_ACCESS_AUDIENCE: HEALTH_AUDIENCE,
  INVESTIGATION_WORKSPACE_HOSTNAME: VIEWER_HOSTNAME,
  SITE_BEHAVIOR_LAB_BUILD_COMMIT: "c".repeat(40)
};

export type Send = Readonly<{ method?: string; token?: string | null; origin?: string | null; body?: string | Uint8Array<ArrayBuffer>; contentType?: string; headers?: Record<string, string> }>;

export type ViewerWorld = Readonly<{
  signing: SigningKey;
  stores: Map<string, MemoryStores>;
  service: CaseService;
  /** How many times each call reached the service, so a test can hold that a refused request reached none. */
  calls: () => number;
  ownerToken: string;
  serviceToken: string;
  forgedToken: string;
  otherPersonToken: string;
  send: (path: string, init?: Send) => Promise<Response>;
  /** A form post from the workspace's own origin, with the owner's token, unless the caller says otherwise. */
  post: (path: string, fields: readonly (readonly [string, string])[], init?: Send) => Promise<Response>;
  now: () => number;
}>;

let seededTemplate: Promise<MemoryStores> | null = null;

export type WorldOptions = Readonly<{
  seeded?: boolean;
  /** Null for the production entry's shape, with no service at all. */
  noService?: boolean;
  /** A variant of the service module, the gate or the routes, to show a check can see what it is for. */
  serviceModule?: Pick<typeof import("../core/case-service"), "caseServiceOver">;
  gate?: typeof handleWorkspaceRequest;
  routesOf?: typeof viewerRoutes;
  /** Fetches the team's keys. The default answers with the world's key. */
  fetcher?: (signing: SigningKey) => ReturnType<typeof certsFor>["fetcher"];
}>;

/**
 * The gate and the viewer in this process, over memory stores, at the fixture's time. The service
 * is reached across a structured copy, as a Durable Object would be.
 */
export async function viewerWorld(options: WorldOptions = {}): Promise<ViewerWorld> {
  const signing = await generateSigningKey("key-1");
  const forger = await generateSigningKey("key-1");
  const stores = new Map<string, MemoryStores>();
  // The seeded case names its owner by the token's claims, not by the key, so one build serves every world as a copy.
  if (options.seeded !== false) stores.set(VIEWER_CASE, copyOfStores(await (seededTemplate ??= generateSigningKey("seed").then((key) => seededStores(key, NOW_MS)))));
  let clock = NOW_MS;
  const now = () => {
    clock += 1;
    return clock;
  };
  const keySet = new AccessKeySet(ISSUER, (options.fetcher ?? ((key) => certsFor(key).fetcher))(signing), now);
  const keySetFor = () => keySet;
  const inner = acrossABoundary((options.serviceModule ?? { caseServiceOver }).caseServiceOver({ policy: POLICY, keySetFor, now, storesFor: (caseId) => stores.get(caseId) ?? null }));
  let calls = 0;
  const service: CaseService = {
    open: (...args) => ((calls += 1), inner.open(...args)),
    evidence: (...args) => ((calls += 1), inner.evidence(...args)),
    claim: (...args) => ((calls += 1), inner.claim(...args))
  };
  const gate = options.gate ?? handleWorkspaceRequest;
  const routesOf = options.routesOf ?? viewerRoutes;
  const ownerToken = await signToken(signing, ownerClaims());
  const send = async (path: string, init: Send = {}) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? ownerToken : init.token;
    if (token !== null) headers.set(ACCESS_TOKEN_HEADER, token);
    if (init.origin !== undefined && init.origin !== null) headers.set("origin", init.origin);
    if (init.contentType !== undefined) headers.set("content-type", init.contentType);
    const request = new Request(`${VIEWER_ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body });
    return gate(request, VIEWER_ENV, { keySetFor, now, routes: routesOf({ env: VIEWER_ENV, service: options.noService === true ? null : service }) });
  };
  return {
    signing,
    stores,
    service,
    calls: () => calls,
    ownerToken,
    serviceToken: await signToken(signing, serviceClaims()),
    forgedToken: await signToken(forger, ownerClaims()),
    otherPersonToken: await signToken(signing, ownerClaims({ sub: "11111111-61da-459d-899c-0a01c76a2f94" })),
    send,
    post: (path, fields, init = {}) =>
      send(path, { method: "POST", origin: VIEWER_ORIGIN, contentType: "application/x-www-form-urlencoded", body: new URLSearchParams(fields as [string, string][]).toString(), ...init }),
    now
  };
}

/** A world whose one case is built from these commands, over the fixture's objects and any others given, entries an hour before the fixture's time. */
export async function worldWith(commands: readonly ScriptCommand[], objects: readonly Uint8Array[] = [], options: WorldOptions = {}): Promise<ViewerWorld> {
  const world = await viewerWorld({ ...options, seeded: false });
  const stores = memoryStores();
  const created = await createLog(stores);
  if (!created.ok) throw new Error("The fixture's log exists already");
  await storeRawObjects(stores);
  for (const bytes of objects) {
    const put = await putEvidence(stores, bytes);
    if (!put.ok) throw new Error(`An object was refused: ${put.refusal}`);
  }
  if (commands.length > 0) await continueScript({ stores, caseId: VIEWER_CASE, actorOf: actorsFor(await ownerActorAt(world.signing, NOW_MS)), now: risingClock(NOW_MS - 3_600_000), commands });
  world.stores.set(VIEWER_CASE, stores);
  return world;
}

/** The head a page's forms carry. Every form on a page carries the same one. */
export function headOf(page: string): string {
  const heads = [...page.matchAll(/name="head" value="([0-9a-f]{64})"/g)].map((match) => match[1]);
  if (heads.length === 0 || new Set(heads).size !== 1) throw new Error(`A page carried ${heads.length} heads, not one`);
  return heads[0];
}

/** The visible text of a page, roughly as a reader sees it: tags dropped and entities read. Used only to look for words. */
export function textOf(page: string): string {
  return page
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    // Inline elements run on with their neighbors, as a browser shows them. Every other tag breaks the text.
    .replace(/<\/?(?:a|code|span|strong)\b[^>]*>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, "`")
    .replace(/&#61;/g, "=")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
