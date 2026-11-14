// Where cases live once the workspace is hosted: one Durable Object for each case, as its
// single writer, and one more that lists the cases this namespace holds.
//
// The front Worker reaches an object with a plain JSON call and gets plain JSON back. Every
// call carries the Access assertion the gate verified, as the raw token, and the object
// verifies it again with the same verifier and the same policy before it reads or writes
// anything. So an actor is derived inside the object that uses it and never crosses, and no
// folded case crosses either: case-service.ts says why neither can. A caller that reached an
// object without the gate gets what a forged token gets.
//
// A case object answers for one case: the one it is named for. Its name is the case id, and
// the id of a hosted case has the shape ids.ts mints, 32 lowercase hex digits. A call that
// names any other case reads as a log never created, and a new case under any other id is
// refused, so a typed slug cannot become a hosted case. The shape is all this checks: the hex
// of a short word fits it. What keeps ids unique is that the front Worker mints each one with
// mintCaseId and no route takes an id for a new case.
//
// A new case is made in three steps the front Worker orders: the list reserves the id, the
// case's own object writes the log and the plan, and the list marks the id created. A create
// the case refuses before any log exists gives its reservation back. A kill or a failing
// store part way leaves a reservation that is not marked created, and the list shows it as
// that, so nothing a create started is hidden. The list holds at most MAX_HOSTED_CASES ids
// and refuses a reservation past that. Nothing removes a created case from it.
//
// The plan's fixture and criterion arrive as text and are stored as this case's first two
// objects, at the digests the plan then names. Each is bounded as an owner's text is.
//
// There is no call here that plans a case after a kill, starts, deadlines, cancels, excepts,
// rules, purges or deletes, and no alarm.

import { sha256Hex } from "./canonical-json";
import { configurationKey, isConfigurationIdentity, MAX_TEXT_CHARS, type ConfigurationIdentity } from "./case-events";
import { MAX_HEAD_CHARS, putEvidence, type LogEvent } from "./case-log";
import { caseServiceOver, ownerFromAssertion, type AccessAnswer, type AccessWorld, type CaseRefusal, type CaseService, type CaseView, type ClaimAnswer, type EvidenceAnswer, type OpenAnswer } from "./case-service";
import { createCase, mintedSlots } from "./case-store";
import { hostedStores, isHostBucket, isHostStorage } from "./case-host-stores";
import { mintAttemptId, mintCaseId } from "./ids";
import { plannedState, SLOT_NAMES, type SlotName } from "./case-machine";
import { workspaceConfigFrom, type WorkspaceEnv } from "./workspace-config";
import { jsonResponse } from "./workspace-response";

/** The most cases one namespace lists. A reservation past it is refused, so the list is always one bounded page. */
export const MAX_HOSTED_CASES = 512;
/** The name of the one object that lists the namespace's cases. */
export const CASE_INDEX_NAME = "case-index";

const HOSTED_CASE_ID = /^[0-9a-f]{32}$/;
/** Never fetched from the network: a Durable Object's stub takes a URL and reads none of it here. */
const HOST_CALL_URL = "https://case-host.invalid/call";

/** The shape of an id ids.ts mints. A hosted case has no other. */
export function isHostedCaseId(value: unknown): value is string {
  return typeof value === "string" && HOSTED_CASE_ID.test(value);
}

/** The workspace's environment with the three bindings a hosted case needs. Each is read by its shape, never by a platform type. */
export type HostEnv = WorkspaceEnv & { INVESTIGATION_CASES?: unknown; INVESTIGATION_CASE_INDEX?: unknown; INVESTIGATION_OBJECTS?: unknown };

/** A configuration as the owner types it. Its two digests are worked out where the fixture and criterion are stored. */
export type PlannedConfiguration = Omit<ConfigurationIdentity, "fixtureDigest" | "criterionDigest">;

export type NewCasePlan = Readonly<{ slots: readonly string[]; configuration: PlannedConfiguration; fixture: string; criterion: string }>;

export type CreateAnswer = Readonly<{ ok: true; caseId: string }> | AccessAnswer | Readonly<{ ok: false; refusal: string; at: string | null }>;

/** One id the list holds. Created is false for a create that started and was never marked finished. */
export type ListedCase = Readonly<{ caseId: string; reservedAtMs: number; created: boolean }>;

export type ListAnswer = Readonly<{ ok: true; cases: readonly ListedCase[]; limit: number }> | AccessAnswer;

/** The seam for the two things no single case answers: making a new one, and listing those there are. */
export type CaseDirectory = Readonly<{
  create(assertion: string, plan: NewCasePlan): Promise<CreateAnswer>;
  list(assertion: string): Promise<ListAnswer>;
}>;

export type HostObjectWorld = Readonly<{
  /** The name this object was reached by. */
  name: string | undefined;
  /** The object's own storage. */
  storage: unknown;
  env: HostEnv;
  keySetFor: AccessWorld["keySetFor"];
  now: () => number;
}>;

export type HostObject = (request: Request) => Promise<Response>;

const UNAVAILABLE: AccessAnswer = Object.freeze({ ok: false, refusal: "unavailable" });
const NO_LOG: CaseRefusal = Object.freeze({ ok: false, refusal: "head-missing", at: null });

type Call = Readonly<Record<string, unknown>> & Readonly<{ call: string }>;

async function callOf(request: Request): Promise<Call | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as Call).call === "string" ? (body as Call) : null;
  } catch {
    return null;
  }
}

const MALFORMED_CALL = { ok: false, refusal: "malformed-call" } as const;

/** An object that cannot serve, because its configuration, its name, its storage or its bucket is not what it needs. */
const unavailableObject: HostObject = async () => jsonResponse(200, UNAVAILABLE);

type PlanRefusal = Readonly<{ ok: false; refusal: "malformed-plan"; at: string }>;

/** A plan's text as the bytes stored for it, or null when it is empty, past the bound, or would not be stored as written. */
function textBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_TEXT_CHARS) return null;
  const bytes = new Uint8Array(new TextEncoder().encode(value));
  // A lone surrogate is encoded as a replacement character, so the stored bytes would not be the text given.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value ? bytes : null;
}

/**
 * The plan's slots, its two objects and the whole configuration they give, or the field that is
 * wrong. Asked before anything is stored, so a plan that would be refused leaves no object behind.
 * The slots are put to the machine's own check of a plan, with ids minted for the question and
 * thrown away: createCase mints the ones the plan keeps.
 */
async function checkedPlan(plan: unknown): Promise<Readonly<{ ok: true; slots: readonly SlotName[]; configuration: ConfigurationIdentity; objects: readonly Uint8Array[] }> | PlanRefusal> {
  const malformed = (at: string): PlanRefusal => ({ ok: false, refusal: "malformed-plan", at });
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return malformed("plan");
  const { slots, configuration: planned, fixture, criterion } = plan as Partial<NewCasePlan>;
  if (!Array.isArray(slots) || !slots.every((slot): slot is SlotName => (SLOT_NAMES as readonly unknown[]).includes(slot))) return malformed("slots");
  const fixtureBytes = textBytes(fixture);
  if (fixtureBytes === null) return malformed("fixture");
  const criterionBytes = textBytes(criterion);
  if (criterionBytes === null) return malformed("criterion");
  if (typeof planned !== "object" || planned === null || Array.isArray(planned)) return malformed("configuration");
  const configuration = { ...planned, fixtureDigest: await sha256Hex(fixtureBytes), criterionDigest: await sha256Hex(criterionBytes) };
  if (!isConfigurationIdentity(configuration)) return malformed("configuration");
  if (!plannedState({ slots: mintedSlots(slots), controlRunId: mintAttemptId(), configuration: configurationKey(configuration) }).ok) return malformed("slots");
  return { ok: true, slots, configuration, objects: [fixtureBytes, criterionBytes] };
}

type CaseCreateAnswer = Readonly<{ ok: true; case: CaseView }> | AccessAnswer | Readonly<{ ok: false; refusal: string; at: string | null; logStarted: boolean }>;

/** One case's object: the three calls of the case service, and the one that makes this case. */
export function caseObject(world: HostObjectWorld): HostObject {
  const config = workspaceConfigFrom(world.env);
  const { name, storage } = world;
  const bucket = world.env.INVESTIGATION_OBJECTS;
  if (config === null || !isHostedCaseId(name) || !isHostStorage(storage) || !isHostBucket(bucket)) return unavailableObject;

  const named: string = name;
  const stores = hostedStores(storage, bucket, named);
  const access: AccessWorld = { policy: config.policy, keySetFor: world.keySetFor, now: world.now };
  // Only this object's own case has stores here. Any other id reads as a log never created.
  const service = caseServiceOver({ ...access, storesFor: (caseId) => (caseId === name ? stores : null) });
  const logStarted = async (): Promise<boolean> => (await stores.head.read(MAX_HEAD_CHARS)) !== null;

  async function create(assertion: unknown, caseId: unknown, plan: unknown): Promise<CaseCreateAnswer> {
    const owner = await ownerFromAssertion(access, assertion);
    if ("ok" in owner) return owner;
    // The id of a new case is this object's own name, which has the minted shape. A slug, or another case's id, is refused.
    if (caseId !== name) return { ok: false, refusal: "case-id-not-minted", at: null, logStarted: false };
    const checked = await checkedPlan(plan);
    if (!checked.ok) return { ...checked, logStarted: false };
    // Asked before anything is stored, so a second create of a case leaves the first one's objects alone.
    if (await logStarted()) return { ok: false, refusal: "log-exists", at: null, logStarted: true };
    for (const bytes of checked.objects) {
      const put = await putEvidence(stores, bytes);
      if (!put.ok) return { ok: false, refusal: put.refusal, at: put.at ?? null, logStarted: false };
    }
    const created = await createCase(stores, { caseId: named, actor: owner, slots: checked.slots, configuration: checked.configuration, now: world.now });
    if (created.ok) return { ok: true, case: { caseId: created.case.caseId, head: created.case.head, seq: created.case.seq, state: created.case.state } };
    return { ok: false, refusal: created.refusal, at: created.at, logStarted: await logStarted() };
  }

  return async (request) => {
    const call = await callOf(request);
    if (call === null) return jsonResponse(400, MALFORMED_CALL);
    const assertion = call.assertion as string;
    const caseId = call.caseId as string;
    switch (call.call) {
      case "open":
        return jsonResponse(200, await service.open(assertion, caseId));
      case "evidence":
        return jsonResponse(200, await service.evidence(assertion, caseId, call.digest as string, call.offset as number));
      case "claim":
        return jsonResponse(200, await service.claim(assertion, caseId, call.viewedHead as string, call.event as LogEvent));
      case "create":
        return jsonResponse(200, await create(assertion, caseId, call.plan));
      default:
        return jsonResponse(400, MALFORMED_CALL);
    }
  };
}

type IndexAnswer = Readonly<{ ok: true }> | AccessAnswer | Readonly<{ ok: false; refusal: "malformed-case-id" | "index-full" | "case-id-taken" | "not-reserved"; at: null }>;

/** The one object that lists this namespace's cases: ids reserved by a create, and which of them a create finished. */
export function caseIndexObject(world: HostObjectWorld): HostObject {
  const config = workspaceConfigFrom(world.env);
  const { name, storage } = world;
  if (config === null || name !== CASE_INDEX_NAME || !isHostStorage(storage)) return unavailableObject;

  const hosted = storage;
  const { sql } = hosted;
  sql.exec("CREATE TABLE IF NOT EXISTS hosted_cases (case_id TEXT PRIMARY KEY, reserved_at_ms INTEGER NOT NULL, created INTEGER NOT NULL CHECK (created IN (0, 1)))").toArray();
  const access: AccessWorld = { policy: config.policy, keySetFor: world.keySetFor, now: world.now };
  const refused = (refusal: Extract<IndexAnswer, { at: null }>["refusal"]): IndexAnswer => ({ ok: false, refusal, at: null });
  /** One statement's count of rows written, read after its rows. The count includes rows of an index, so a write is any count above zero. */
  const wrote = (query: string, ...bindings: (string | number)[]): number => {
    const cursor = sql.exec(query, ...bindings);
    cursor.toArray();
    return cursor.rowsWritten;
  };

  function reserve(caseId: string): IndexAnswer {
    const atMs = world.now();
    // The count and the insert are one synchronous step, so two reservations cannot both take the last place.
    return hosted.transactionSync<IndexAnswer>(() => {
      const [{ held }] = sql.exec("SELECT count(*) AS held FROM hosted_cases").toArray();
      if (typeof held !== "number" || held >= MAX_HOSTED_CASES) return refused("index-full");
      return wrote("INSERT INTO hosted_cases (case_id, reserved_at_ms, created) VALUES (?, ?, 0) ON CONFLICT (case_id) DO NOTHING", caseId, atMs) > 0 ? { ok: true } : refused("case-id-taken");
    });
  }

  function list(): ListAnswer {
    const rows = sql.exec("SELECT case_id, reserved_at_ms, created FROM hosted_cases ORDER BY reserved_at_ms DESC, case_id LIMIT ?", MAX_HOSTED_CASES).toArray();
    return { ok: true, limit: MAX_HOSTED_CASES, cases: rows.map((row) => ({ caseId: String(row.case_id), reservedAtMs: Number(row.reserved_at_ms), created: row.created === 1 })) };
  }

  return async (request) => {
    const call = await callOf(request);
    if (call === null) return jsonResponse(400, MALFORMED_CALL);
    // Every call is the owner's. A service token, a forged or an expired assertion reads and writes nothing here.
    const owner = await ownerFromAssertion(access, call.assertion);
    if ("ok" in owner) return jsonResponse(200, owner);
    if (call.call === "list") return jsonResponse(200, list());
    const { caseId } = call;
    if (!isHostedCaseId(caseId)) return jsonResponse(200, refused("malformed-case-id"));
    switch (call.call) {
      case "reserve":
        return jsonResponse(200, reserve(caseId));
      case "confirm":
        return jsonResponse(200, wrote("UPDATE hosted_cases SET created = 1 WHERE case_id = ?", caseId) > 0 ? { ok: true } : refused("not-reserved"));
      case "release":
        // Only a reservation no create finished is given back. A created case stays listed.
        return jsonResponse(200, wrote("DELETE FROM hosted_cases WHERE case_id = ? AND created = 0", caseId) > 0 ? { ok: true } : refused("not-reserved"));
      default:
        return jsonResponse(400, MALFORMED_CALL);
    }
  };
}

type HostStub = { fetch(input: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Response> };
type HostNamespace = { idFromName(name: string): unknown; get(id: unknown): HostStub };

function isHostNamespace(value: unknown): value is HostNamespace {
  const namespace = value as Partial<HostNamespace> | null;
  return typeof namespace === "object" && namespace !== null && typeof namespace.idFromName === "function" && typeof namespace.get === "function";
}

/** One call to the object of this name, or null when it did not answer as an object here answers. What it wrote, if anything, is then unknown. */
async function callObject(namespace: HostNamespace, name: string, body: Readonly<Record<string, unknown>>): Promise<unknown | null> {
  try {
    const response = await namespace.get(namespace.idFromName(name)).fetch(HOST_CALL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status !== 200) return null;
    const answer: unknown = await response.json();
    return typeof answer === "object" && answer !== null && typeof (answer as { ok?: unknown }).ok === "boolean" ? answer : null;
  } catch {
    return null;
  }
}

export type HostedCases = Readonly<{ service: CaseService; directory: CaseDirectory }>;

/**
 * The case service and the directory as the front Worker holds them, each call sent to the object
 * that answers it. Null unless the workspace's configuration and all three bindings are there, so
 * an entry with any of them missing serves no case, as it did before a case could be hosted.
 */
export function hostedCasesFrom(env: HostEnv, mint: () => string = mintCaseId): HostedCases | null {
  if (workspaceConfigFrom(env) === null) return null;
  const cases = env.INVESTIGATION_CASES;
  const index = env.INVESTIGATION_CASE_INDEX;
  if (!isHostNamespace(cases) || !isHostNamespace(index) || !isHostBucket(env.INVESTIGATION_OBJECTS)) return null;

  // Only an id of the minted shape names an object. Anything else a path could carry reads as a log never created, and starts no object.
  const toCase = async <A>(caseId: string, body: Readonly<Record<string, unknown>>): Promise<A | AccessAnswer | CaseRefusal> => (isHostedCaseId(caseId) ? (((await callObject(cases, caseId, body)) as A | null) ?? UNAVAILABLE) : NO_LOG);
  const toIndex = async (body: Readonly<Record<string, unknown>>): Promise<unknown | null> => callObject(index, CASE_INDEX_NAME, body);

  return {
    service: {
      open: (assertion, caseId) => toCase<OpenAnswer>(caseId, { call: "open", assertion, caseId }),
      evidence: (assertion, caseId, digest, offset) => toCase<EvidenceAnswer>(caseId, { call: "evidence", assertion, caseId, digest, offset }),
      claim: (assertion, caseId, viewedHead, event) => toCase<ClaimAnswer>(caseId, { call: "claim", assertion, caseId, viewedHead, event })
    },
    directory: {
      async create(assertion, plan) {
        const caseId = mint();
        const reserved = (await toIndex({ call: "reserve", assertion, caseId })) as IndexAnswer | null;
        if (reserved === null) return UNAVAILABLE;
        if (!reserved.ok) return reserved;
        const created = (await callObject(cases, caseId, { call: "create", assertion, caseId, plan })) as CaseCreateAnswer | null;
        // No answer: the case may hold a log or not. Its reservation stays, and the list shows it as not finished.
        if (created === null) return UNAVAILABLE;
        if (!created.ok) {
          // Given back when the case says no log was started, or refused the assertion, which it does before it writes anything.
          if (!("logStarted" in created) || created.logStarted === false) await toIndex({ call: "release", assertion, caseId });
          return "at" in created ? { ok: false, refusal: created.refusal, at: created.at } : created;
        }
        // If this fails the case is whole and its reservation stays unmarked, which the list shows.
        await toIndex({ call: "confirm", assertion, caseId });
        return { ok: true, caseId };
      },
      async list(assertion) {
        return ((await toIndex({ call: "list", assertion })) as ListAnswer | null) ?? UNAVAILABLE;
      }
    }
  };
}
