// The viewer's routes, behind the gate. The table below is the whole of them: the dispatcher
// matches only what it lists, and investigation/test/viewer.test.ts pins it, so a route cannot
// be added without that test changing on purpose.
//
// Reads: a case, one attempt, one row inside its attempt, one fact, the counts across attempts,
// and one page of an evidence object the case names. Writes: claims, and nothing else, each
// through the case service, which takes only claim events. There is no route that starts,
// deadlines, cancels, excepts, rules or plans anything, which belongs with the runner; none that
// purges or lists a manifest, which W2's open items block; and none that approves, publishes,
// exports or downloads anything. Revising or withdrawing an interpretation is not in W2's model,
// so it is not here either.
//
// The gate has already verified the owner, refused a service token, and refused a write from any
// origin but this one. With no case service configured, as in the production entry, every case
// route answers 503, as a missing configuration does, and nothing else is reachable but health.

import { isSlug, MAX_LIST_ITEMS, MAX_SLUG_CHARS, MAX_TEXT_CHARS } from "./case-events";
import { isCaseId, isDigest, type LogEvent } from "./case-log";
import { SLOT_NAMES } from "./case-machine";
import type { AccessAnswer, CaseRefusal, CaseService } from "./case-service";
import { aggregatesPage, attemptPage, casePage, evidencePage, evidenceRefusalPage, factPage, formRefusalPage, methodPage, notFoundPage, refusalPage, rowPage } from "./viewer-pages";
import { pathOf } from "./viewer-text";
import { HEALTH_PATH, healthResponse, type WorkspaceEnv, type WorkspaceRoutes } from "./workspace-gate";
import { htmlResponse, refusalResponse } from "./workspace-response";

type Param = "case" | "slot" | "row" | "fact" | "assertion" | "interpretation" | "digest";

/** Every route the viewer answers, beside health. Nothing else is matched. */
export const VIEWER_ROUTES = [
  { name: "case", method: "GET", path: "/cases/:case" },
  { name: "attempt", method: "GET", path: "/cases/:case/attempts/:slot" },
  { name: "row", method: "GET", path: "/cases/:case/attempts/:slot/rows/:row" },
  { name: "fact", method: "GET", path: "/cases/:case/facts/:fact" },
  { name: "aggregates", method: "GET", path: "/cases/:case/aggregates" },
  { name: "evidence", method: "GET", path: "/cases/:case/evidence/:digest" },
  { name: "record-fact", method: "POST", path: "/cases/:case/facts" },
  { name: "supersede-fact", method: "POST", path: "/cases/:case/facts/:fact/supersede" },
  { name: "retract-fact", method: "POST", path: "/cases/:case/facts/:fact/retract" },
  { name: "record-assertion", method: "POST", path: "/cases/:case/assertions" },
  { name: "retract-assertion", method: "POST", path: "/cases/:case/assertions/:assertion/retract" },
  { name: "record-interpretation", method: "POST", path: "/cases/:case/interpretations" },
  { name: "reaffirm-interpretation", method: "POST", path: "/cases/:case/interpretations/:interpretation/reaffirm" }
] as const;

type RouteName = (typeof VIEWER_ROUTES)[number]["name"];

/** What a path may carry in each place. The log's own shapes, so a path names only what could exist. */
const PARAMS: Readonly<Record<Param, (segment: string) => boolean>> = {
  case: isCaseId,
  slot: (segment) => (SLOT_NAMES as readonly string[]).includes(segment),
  row: isSlug,
  fact: isSlug,
  assertion: isSlug,
  interpretation: isSlug,
  digest: isDigest
};

/**
 * The largest form body read, worked out from the model's own bounds so the largest claim of each
 * kind it accepts fits. The most free text a claim holds is five fields, a retraction's reason and
 * the four of the unknown it leaves, each MAX_TEXT_CHARS UTF-16 units. Lists hold MAX_LIST_ITEMS
 * cites or row ids, each a slug and a version. A few more fields hold a slug or the head. A unit can
 * be three UTF-8 bytes, each sent as a three-character escape, so every unit is counted as nine
 * bytes. A browser sends a textarea's line breaks as CR LF, two units the form reader makes one,
 * which is six bytes for that one unit and so inside the same nine. Field names are counted with
 * the fields.
 */
const TEXT_FIELDS = 5;
const OTHER_FIELDS = 8;
const FIELD_NAME_UNITS = 32;
const BYTES_PER_UNIT = 9;
export const MAX_FORM_BYTES = BYTES_PER_UNIT * (TEXT_FIELDS * (MAX_TEXT_CHARS + FIELD_NAME_UNITS) + MAX_LIST_ITEMS * (MAX_SLUG_CHARS + 16 + FIELD_NAME_UNITS) + OTHER_FIELDS * (MAX_SLUG_CHARS + FIELD_NAME_UNITS));
const OFFSET = /^(?:0|[1-9][0-9]{0,15})$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

type Params = Readonly<Partial<Record<Param, string>>>;
type Context = Readonly<{ request: Request; url: URL; params: Params; service: CaseService; assertion: string; caseId: string }>;
type Handler = (context: Context) => Promise<Response>;

function matchPath(pattern: string, pathname: string): Params | null {
  const wanted = pattern.split("/");
  const given = pathname.split("/");
  if (wanted.length !== given.length) return null;
  const params: Partial<Record<Param, string>> = {};
  for (const [index, part] of wanted.entries()) {
    const segment = given[index];
    if (part.startsWith(":")) {
      const name = part.slice(1) as Param;
      if (!PARAMS[name](segment)) return null;
      params[name] = segment;
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}

function answerRefused(caseId: string, answer: AccessAnswer | CaseRefusal): Response {
  // The gate verified this token a moment ago, so these come only from a token that expired since, or keys gone.
  if (!("at" in answer)) return refusalResponse(answer.refusal === "unavailable" ? 503 : 401);
  return htmlResponse(409, refusalPage(caseId, answer.refusal, answer.at));
}

async function withCase(context: Context, render: (view: Parameters<typeof casePage>[0]) => string | null): Promise<Response> {
  const answer = await context.service.open(context.assertion, context.caseId);
  if (!answer.ok) return answerRefused(context.caseId, answer);
  const page = render(answer.case);
  return page === null ? htmlResponse(404, notFoundPage()) : htmlResponse(200, page);
}

/** A form field that could not be read, by its name. What it held is never repeated. */
class FormFault {
  constructor(
    readonly refusal: "malformed-form" | "form-too-large" | "not-a-form",
    readonly field: string | null,
    readonly status: 400 | 413 | 415,
    readonly why: string | null = null
  ) {}
}

const TOO_LARGE = `A form may hold at most ${MAX_FORM_BYTES} bytes, which the largest claim of each kind fits.`;
const NOT_A_FORM = "A claim is posted as an HTML form, application/x-www-form-urlencoded.";

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new FormFault("not-a-form", null, 415, NOT_A_FORM);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) throw new FormFault("form-too-large", null, 413, TOO_LARGE);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORM_BYTES) {
        await reader.cancel();
        throw new FormFault("form-too-large", null, 413, TOO_LARGE);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: URLSearchParams;
  try {
    parsed = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FormFault("malformed-form", null, 400, "The form's bytes are not UTF-8.");
  }
  // A browser sends a textarea's line breaks as CR LF. Each is read as the line feed the owner
  // typed, so no page shows a carriage return on every line of their words. A lone CR stays, and shows.
  const form = new URLSearchParams();
  for (const [name, value] of parsed) form.append(name, value.replaceAll("\r\n", "\n"));
  return form;
}

/** Exactly one value for this field. */
function one(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1) throw new FormFault("malformed-form", name, 400);
  return values[0];
}

/** At most one value, and a blank one is none. */
function optional(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1) throw new FormFault("malformed-form", name, 400);
  return values.length === 0 || values[0].trim() === "" ? null : values[0];
}

/** Each cite as the form names it, fact and version, as the page showed them. Never worked out again here. */
function citesOf(form: URLSearchParams): { fact: string; version: number }[] {
  return form.getAll("cite").map((value) => {
    const split = value.lastIndexOf(":");
    const version = value.slice(split + 1);
    if (split <= 0 || !VERSION.test(version)) throw new FormFault("malformed-form", "cite", 400);
    return { fact: value.slice(0, split), version: Number(version) };
  });
}

const UNKNOWN_FIELDS = ["unknown-id", "unknown-question", "unknown-reason", "unknown-detail", "unknown-would-resolve"];

/** The unknown a retraction leaves. Where it may leave none, five blank fields are none. */
function unknownOf(form: URLSearchParams, required: boolean): { id: string; question: string; reason: string; detail: string | null; wouldResolve: string | null } | null {
  if (!required && UNKNOWN_FIELDS.every((name) => optional(form, name) === null)) return null;
  return { id: one(form, "unknown-id"), question: one(form, "unknown-question"), reason: one(form, "unknown-reason"), detail: optional(form, "unknown-detail"), wouldResolve: optional(form, "unknown-would-resolve") };
}

/** One claim from one form, with the page to go to once it is written. */
type ClaimForm = Readonly<{ event: LogEvent; then: readonly string[] }>;

function claimRoute(build: (form: URLSearchParams, params: Params, caseId: string) => ClaimForm): Handler {
  return async (context) => {
    let claim: ClaimForm;
    let head: string;
    try {
      const form = await readForm(context.request);
      head = one(form, "head");
      if (!isDigest(head)) throw new FormFault("malformed-form", "head", 400);
      claim = build(form, context.params, context.caseId);
    } catch (error) {
      if (error instanceof FormFault) return htmlResponse(error.status, formRefusalPage(context.caseId, error.refusal, error.field, error.why));
      throw error;
    }
    const answer = await context.service.claim(context.assertion, context.caseId, head, claim.event);
    if (answer.ok) return htmlResponse(303, "", { location: pathOf(claim.then) });
    if (answer.refusal === "not-a-claim") return htmlResponse(400, formRefusalPage(context.caseId, answer.refusal, null));
    if (!("case" in answer)) return answerRefused(context.caseId, answer);
    // Nothing was written. The page is the case as it stands, with why.
    if (answer.refusal === "conflict") return htmlResponse(409, casePage(answer.case, { kind: "conflict" }));
    return htmlResponse(422, casePage(answer.case, { kind: "refused", refusal: answer.refusal, at: answer.at }));
  };
}

const event = (type: string, data: Record<string, unknown>): LogEvent => ({ type, data }) as unknown as LogEvent;

const HANDLERS: Readonly<Record<RouteName, Handler>> = {
  case: (context) => withCase(context, (view) => casePage(view)),
  attempt: (context) => withCase(context, (view) => attemptPage(view, context.params.slot as string)),
  row: (context) => withCase(context, (view) => rowPage(view, context.params.slot as string, context.params.row as string)),
  fact: (context) => withCase(context, (view) => factPage(view, context.params.fact as string)),
  aggregates: (context) => withCase(context, (view) => aggregatesPage(view)),
  evidence: async (context) => {
    const given = context.url.searchParams.get("offset") ?? "0";
    if (!OFFSET.test(given)) return htmlResponse(400, evidenceRefusalPage(context.caseId, "malformed-offset"));
    const answer = await context.service.evidence(context.assertion, context.caseId, context.params.digest as string, Number(given));
    if (answer.ok) return htmlResponse(200, evidencePage(context.caseId, answer.page));
    if (answer.refusal === "not-named-by-this-case" || answer.refusal === "offset-past-end") return htmlResponse(404, evidenceRefusalPage(context.caseId, answer.refusal));
    return answerRefused(context.caseId, answer as AccessAnswer | CaseRefusal);
  },
  "record-fact": claimRoute((form, _params, caseId) => {
    const id = one(form, "id");
    return { event: event("fact-recorded", { id, statement: one(form, "statement"), evidence: form.getAll("evidence") }), then: ["cases", caseId, "facts", id] };
  }),
  "supersede-fact": claimRoute((form, params, caseId) => ({
    event: event("fact-superseded", { fact: params.fact, statement: one(form, "statement"), reason: one(form, "reason") }),
    then: ["cases", caseId, "facts", params.fact as string]
  })),
  "retract-fact": claimRoute((form, params, caseId) => ({
    event: event("fact-retracted", { fact: params.fact, reason: one(form, "reason"), unknown: unknownOf(form, false) }),
    then: ["cases", caseId, "facts", params.fact as string]
  })),
  "record-assertion": claimRoute((form, _params, caseId) => ({ event: event("assertion-recorded", { id: one(form, "id"), statement: one(form, "statement") }), then: ["cases", caseId] })),
  "retract-assertion": claimRoute((form, params, caseId) => ({
    event: event("assertion-retracted", { assertion: params.assertion, reason: one(form, "reason"), unknown: unknownOf(form, true) }),
    then: ["cases", caseId]
  })),
  "record-interpretation": claimRoute((form, _params, caseId) => ({ event: event("interpretation-recorded", { id: one(form, "id"), statement: one(form, "statement"), cites: citesOf(form) }), then: ["cases", caseId] })),
  "reaffirm-interpretation": claimRoute((form, params, caseId) => ({ event: event("interpretation-reaffirmed", { interpretation: params.interpretation, cites: citesOf(form) }), then: ["cases", caseId] }))
};

export type ViewerOptions = Readonly<{ env: WorkspaceEnv; service: CaseService | null }>;

/** The viewer's route table as the gate calls it. With no service, every case route fails closed. */
export function viewerRoutes({ env, service }: ViewerOptions): WorkspaceRoutes {
  return async (request, _identity, assertion) => {
    const url = new URL(request.url);
    // Health says whether any case can be reached: deny-all with no service, as the production entry has.
    if (url.pathname === HEALTH_PATH) return healthResponse(request, env, service === null ? "deny-all" : "serving-cases");
    const matches = VIEWER_ROUTES.flatMap((route) => {
      const params = matchPath(route.path, url.pathname);
      return params === null ? [] : [{ route, params }];
    });
    if (matches.length === 0) return htmlResponse(404, notFoundPage());
    if (service === null) return refusalResponse(503);
    const match = matches.find(({ route }) => route.method === request.method);
    if (match === undefined) return htmlResponse(405, methodPage(), { allow: [...new Set(matches.map(({ route }) => route.method))].join(", ") });
    return HANDLERS[match.route.name]({ request, url, params: match.params, service, assertion, caseId: match.params.case as string });
  };
}
