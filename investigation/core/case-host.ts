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
// A case object also takes the owner's commands: the plan of a case whose create stopped after
// its log began, the freeze of a plan, and the events case-service.ts lists as commands. A plan's
// ids are minted here, and a frozen plan's digest is worked out here from the text stored, so
// neither event is taken ready made. Each command is written against the head the owner viewed,
// as a claim is. No command carries a key of its own, so a command sent again after an answer
// that never arrived is refused as a conflict when the first one landed: the case handed back
// with that refusal is how the owner learns it did.
//
// The object watches its case's deadlines with an alarm, which writes nothing to the log:
// case-supervision.ts says what it does and why. Every answer that carries a case's state has
// brought the marks back to that state first.
//
// A reservation can be stranded with no log behind it: a create whose assertion expired between
// the list's reserve and the case's create is refused by the case, and the release that follows
// carries the same expired assertion, so the list refuses that too. The owner can give such a
// place back. The case's object is asked first, and answers only when it holds no log: it then
// marks itself abandoned, in its own storage, and from then on refuses to start a log, so a
// create that was still on its way cannot land on an id the list no longer holds. Only then is
// the list asked to release, and the list releases only a reservation never marked created. A
// case with a log, even one with no entry, is never released this way: it is planned instead.
// Objects a stopped create stored under an abandoned id stay in the bucket, named by nothing.
//
// A case object also takes a runner's calls, which carry no assertion: the one that hands an
// attempt's token over, once, and the one that writes a runner's event with it. Neither has a route
// in the front Worker, which never sends either. What a token speaks for, and when it stops, is in
// case-runner.ts, and which events it carries is in case-service.ts. A runner's answer carries the
// case's head and nothing else of the case: the runner needs the head to write, and nothing the
// owner wrote. The runner's actor is derived inside the object and never leaves it.
//
// Stopping a runner is recorded here, as that attempt's stop record, before its container is
// destroyed. So a stop revokes the attempt's token even when the destroy fails, and a second stop
// finds the record there and is done. The destroy record is the other record case-runner.ts keeps,
// set by case-container.ts only when a destroy has resolved.
//
// A case object with a container starts its runner's after the owner's attempt-started has been
// written, and never for a start the case refused: case-container.ts says how. It stops one when
// the attempt's deadline alarm comes due, when the token is asked for twice, when the container
// reports its exit, when the runner's own cleanup event is written, and when the owner's command
// ends the attempt or the case. The owner's environment-destroyed is refused until the slot has a
// destroy record (ruling D-5): a slot whose container was never started has none. A runner may
// also store an object, its bytes the call's body, bounded per attempt by case-runner.ts.
//
// There is no call here that purges or deletes, and none that writes a control or a changed
// configuration.

import { sha256Hex } from "./canonical-json";
import { configurationKey, isConfigurationIdentity, MAX_TEXT_CHARS, type ConfigurationIdentity } from "./case-events";
import { MAX_EVIDENCE_BYTES, MAX_HEAD_CHARS, putEvidence, type LogEvent } from "./case-log";
import { caseCommandsOver, caseRunnerOver, caseServiceOver, ownerFromAssertion, type AccessAnswer, type AccessWorld, type CaseRefusal, type CaseService, type CaseView, type ClaimAnswer, type CommandAnswer, type EvidenceAnswer, type OpenAnswer, type RunnerAnswer } from "./case-service";
import { DEFAULT_DEADLINES, isAlarmStorage, supervisionOver, type Deadlines, type DueMark } from "./case-supervision";
import { runnerCredentialsOver, runnerObjectsOver, tokenRefusalFor, type HandOut, type RunnerFlag } from "./case-runner";
import { isContainerSeam, runnerRunsOver, type HandlerProps } from "./case-container";
import { readBounded, RUNNER_CALL_CAPS, RUNNER_CALL_HEADER, RUNNER_CASE_HEADER, RUNNER_DIGEST_HEADER, RUNNER_TOKEN_HEADER } from "./runner-handler";
import { createCase, mintedSlots, openCase } from "./case-store";
import { hostedStores, isHostBucket, isHostStorage } from "./case-host-stores";
import { mintAttemptId, mintCaseId } from "./ids";
import { isRunningPhase, plannedState, SLOT_NAMES, type SlotName } from "./case-machine";
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
export type ReleaseAnswer = Readonly<{ ok: true }> | AccessAnswer | Readonly<{ ok: false; refusal: string; at: string | null }>;

/** The seam for what no single case answers: making a new one, listing those there are, and giving back a reserved id whose case has no log. */
export type CaseDirectory = Readonly<{
  create(assertion: string, plan: NewCasePlan): Promise<CreateAnswer>;
  list(assertion: string): Promise<ListAnswer>;
  release(assertion: string, caseId: string): Promise<ReleaseAnswer>;
}>;

export type HostObjectWorld = Readonly<{
  /** The name this object was reached by. */
  name: string | undefined;
  /** The object's own storage. */
  storage: unknown;
  env: HostEnv;
  keySetFor: AccessWorld["keySetFor"];
  now: () => number;
  /** How long each deadline runs. The defaults of case-supervision.ts unless a test sets its own. */
  deadlines?: Deadlines;
  /** A test's own seam, asked after a runner's stop is recorded and its container destroyed. The production entry gives none. */
  stopRunner?: (slot: SlotName) => Promise<void>;
  /** The object's container, read by its shape. Absent when the platform gives the object none: then nothing is started, and a stop records the stop only. */
  container?: unknown;
  /** The handler's binding for one start, with that start's props. */
  handlerFor?: (props: HandlerProps) => unknown;
}>;

export type HostObject = (request: Request) => Promise<Response>;

/** A case's object: its calls, and what its alarm runs. */
export type CaseHostObject = HostObject & Readonly<{ alarm: () => Promise<void> }>;

/**
 * An open as a hosted case answers it: the case, the deadline marks an alarm has flagged that its
 * state still wants, and the attempts still running whose runner was cut off for a second request
 * of its token, each with the reason, so the owner knows a reconcile is due. Once the attempt has
 * an outcome its flag is no longer shown; the object's storage keeps it.
 */
export type HostedOpenAnswer = OpenAnswer | Readonly<{ ok: true; case: CaseView; due: readonly DueMark[]; runnerFlags: readonly RunnerFlag[] }>;

/** A command's answers on a hosted case: the case service's, and environment-destroyed refused for a slot with no destroy record. */
export type HostedCommandAnswer = CommandAnswer | Readonly<{ ok: false; refusal: "environment-not-destroyed"; at: string; case: CaseView }>;

/** What planning or freezing answers: a command's answers, or the field of the plan that is wrong. */
export type PlanAnswer = HostedCommandAnswer | Readonly<{ ok: false; refusal: string; at: string | null }>;

/** The seam for the owner's commands on a hosted case. */
export type HostedCommands = Readonly<{
  command(assertion: string, caseId: string, viewedHead: string, event: LogEvent): Promise<HostedCommandAnswer>;
  /** Plan a case whose log holds no plan. The ids are minted where the plan is written. */
  plan(assertion: string, caseId: string, viewedHead: string, plan: NewCasePlan): Promise<PlanAnswer>;
  /** Freeze the plan as this text, stored as an object the plan then names. */
  freeze(assertion: string, caseId: string, viewedHead: string, text: string): Promise<PlanAnswer>;
}>;

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

/** The owner's commands that end an attempt or the case. After one is written, the live run of each attempt no longer running is stopped. */
const ENDING_COMMANDS: readonly string[] = ["attempt-deadline", "reconcile", "case-cancelled", "case-deadline"];

/** The events the generic command call writes. A plan and a freeze are built here, by their own calls, and never taken ready made. */
const BUILT_HERE: readonly string[] = ["case-planned", "plan-frozen"];

/** What a runner's write answers on the wire: the case's head, never the rest of the case. */
export type RunnerWireAnswer =
  | Readonly<{ ok: true; head: string; seq: number }>
  | Readonly<{ ok: false; refusal: string; at: string | null; head: string | null }>;

function runnerWire(answer: RunnerAnswer): RunnerWireAnswer {
  const view = (answer as { case?: CaseView }).case;
  const head = view === undefined ? null : view.head;
  if (answer.ok) return { ok: true, head: answer.case.head, seq: answer.case.seq };
  return { ok: false, refusal: answer.refusal, at: "at" in answer ? answer.at : null, head };
}

/** The fields each of a runner's calls takes, and no others: a call that names an actor, an attempt or anything else besides is refused whole. */
const RUNNER_CALL_FIELDS: Readonly<Record<string, readonly string[]>> = { "runner-token": ["attemptId", "call", "caseId"], runner: ["call", "caseId", "event", "token", "viewedHead"] };

function hasRunnerFields(call: Call): boolean {
  const keys = Object.keys(call).sort();
  const wanted = RUNNER_CALL_FIELDS[call.call];
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

/**
 * What handing a token over answers. Only the first answer for an attempt carries one, with the
 * case's head and sequence as the object opened it, so the runner's first write names a head it
 * was given rather than one it learned from a conflict. Nothing else of the case goes with it.
 */
export type HandOutAnswer = Readonly<{ ok: true; token: string; head: string; seq: number }> | Extract<HandOut, { ok: false }> | Readonly<{ ok: false; refusal: "no-such-attempt" }>;

const NO_SUCH_ATTEMPT = Object.freeze({ ok: false, refusal: "no-such-attempt" } as const);

/** One case's object: the three calls of the case service, the one that makes this case, the owner's commands, a runner's calls, and its alarm. */
export function caseObject(world: HostObjectWorld): CaseHostObject {
  const config = workspaceConfigFrom(world.env);
  const { name, storage } = world;
  const bucket = world.env.INVESTIGATION_OBJECTS;
  // An object that serves nothing watches nothing: its alarm, if one is ever delivered, does nothing.
  if (config === null || !isHostedCaseId(name) || !isHostStorage(storage) || !isAlarmStorage(storage) || !isHostBucket(bucket)) return Object.assign(((request: Request) => unavailableObject(request)) as HostObject, { alarm: async () => {} });

  const named: string = name;
  const own = storage;
  own.sql.exec("CREATE TABLE IF NOT EXISTS abandoned (slot INTEGER PRIMARY KEY CHECK (slot = 0), at_ms INTEGER NOT NULL)").toArray();
  const isAbandoned = (): boolean => own.sql.exec("SELECT slot FROM abandoned").toArray().length > 0;
  const hosted = hostedStores(own, bucket, named);
  // An abandoned case never starts a log. The mark is read and the head written with no await between, so neither can slip past the other.
  const stores = Object.freeze({ ...hosted, head: { read: hosted.head.read, compareAndSwap: async (expected: string | null, next: string): Promise<boolean> => (expected === null && isAbandoned() ? false : hosted.head.compareAndSwap(expected, next)) } });

  /** Mark this case abandoned, if it holds no log. Asked again of an abandoned case, it answers the same. */
  async function abandon(assertion: unknown, caseId: unknown): Promise<ReleaseAnswer> {
    const owner = await ownerFromAssertion(access, assertion);
    if ("ok" in owner) return owner;
    if (caseId !== name) return NO_LOG;
    const atMs = world.now();
    return own.transactionSync<ReleaseAnswer>(() => {
      // Whether a log exists is read from the head's own row, in the same step as the mark is written.
      if (own.sql.exec("SELECT slot FROM log_head").toArray().length > 0) return { ok: false, refusal: "log-exists", at: null };
      own.sql.exec("INSERT INTO abandoned (slot, at_ms) VALUES (0, ?) ON CONFLICT (slot) DO NOTHING", atMs).toArray();
      return { ok: true };
    });
  }
  const access: AccessWorld = { policy: config.policy, keySetFor: world.keySetFor, now: world.now };
  // Only this object's own case has stores here. Any other id reads as a log never created.
  const serviceWorld = { ...access, storesFor: (caseId: string) => (caseId === name ? stores : null) };
  const service = caseServiceOver(serviceWorld);
  const commands = caseCommandsOver(serviceWorld);
  const credentials = runnerCredentialsOver(own, world.now);
  const objects = runnerObjectsOver(own, world.now);
  const runner = caseRunnerOver({ ...serviceWorld, holderOf: credentials.holderOf });
  const stopRunner = async (slot: SlotName): Promise<void> => {
    // Recorded first, so the token is revoked whatever the destroy after it does.
    credentials.recordStop(slot);
    await runs.destroy(slot);
    await (world.stopRunner ?? (async () => {}))(slot);
  };
  const runs = runnerRunsOver({
    storage: own,
    now: world.now,
    container: isContainerSeam(world.container) ? world.container : null,
    handlerFor: world.handlerFor ?? null,
    recordDestroyed: (slot) => credentials.recordDestroyed(slot),
    recordStop: (slot) => credentials.recordStop(slot),
    onExit: stopRunner
  });
  /** A stop asked for after a write has committed. A failed destroy leaves the stop recorded; the write stands. */
  const stopQuietly = async (slot: SlotName): Promise<void> => {
    try {
      await stopRunner(slot);
    } catch {
      // The next start destroys a live earlier run before it launches.
    }
  };
  const supervision = supervisionOver({ storage, now: world.now, deadlines: world.deadlines ?? DEFAULT_DEADLINES, stopRunner });

  /** The token of an attempt of this case that is running, handed over once. */
  async function handOut(caseId: unknown, attemptId: unknown): Promise<HandOutAnswer> {
    if (caseId !== name) return NO_SUCH_ATTEMPT;
    const opened = await openCase(stores, named);
    if (!opened.ok) return NO_SUCH_ATTEMPT;
    const attempt = opened.case.state?.machine.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined || !isRunningPhase(attempt.phase)) return NO_SUCH_ATTEMPT;
    const answer = await credentials.handOut(attempt.slot, attempt.attemptId);
    // Handing a token over writes nothing to the log, so the head opened above is still the head.
    if (answer.ok) return { ok: true, token: answer.token, head: opened.case.head, seq: opened.case.seq };
    if (answer.refusal === "token-already-handed") {
      // The flag and the revocation are already recorded. The stop is asked for once here; if it
      // fails, the attempt's deadline asks for it again through the alarm.
      try {
        await stopRunner(attempt.slot);
      } catch {
        // The refusal stands either way.
      }
    }
    return answer;
  }

  /** Bring the deadline marks to the state an answer carries, when it carries one. */
  async function synced<A>(answer: A): Promise<A> {
    const view = (answer as { case?: CaseView }).case;
    if (view !== undefined) await supervision.sync(view.state?.machine ?? null);
    return answer;
  }

  async function open(assertion: string, caseId: string): Promise<HostedOpenAnswer> {
    const answer = await synced(await service.open(assertion, caseId));
    if (!answer.ok) return answer;
    const machine = answer.case.state?.machine ?? null;
    // A flag is shown while its attempt still reads as running, which is while a reconcile is due for it.
    const runnerFlags = [...credentials.flags(), ...runs.flags()].filter(({ slot }) => machine?.attempts.some((attempt) => attempt.slot === slot && isRunningPhase(attempt.phase)) === true);
    return { ...answer, due: supervision.flagged(machine), runnerFlags };
  }

  /**
   * One of the owner's commands, with an attempt's marks written ahead of the command that starts it,
   * its container started only once that command is written, environment-destroyed refused for a slot
   * with no destroy record, and the live run of each attempt an ending command ends stopped after it.
   */
  async function command(assertion: string, caseId: string, viewedHead: string, event: LogEvent): Promise<HostedCommandAnswer> {
    const type = (event as { type?: unknown } | null)?.type;
    const slot = (event as { data?: { slot?: unknown } } | null)?.data?.slot;
    const named = caseId === name && (SLOT_NAMES as readonly unknown[]).includes(slot);
    if (type === "attempt-started" && named) {
      const owner = await ownerFromAssertion(access, assertion);
      if ("ok" in owner) return owner;
      await supervision.prepareStart(slot as SlotName);
    }
    if (type === "environment-destroyed" && named) {
      const owner = await ownerFromAssertion(access, assertion);
      if ("ok" in owner) return owner;
      if (!credentials.isDestroyed(slot as SlotName)) {
        const opened = await synced(await service.open(assertion, caseId));
        return opened.ok ? { ok: false, refusal: "environment-not-destroyed", at: slot as SlotName, case: opened.case } : opened;
      }
    }
    const answer = await synced(await commands.command(assertion, caseId, viewedHead, event));
    if (!answer.ok) return answer;
    const machine = answer.case.state?.machine ?? null;
    if (type === "attempt-started" && named && machine !== null) {
      // Only a start the case has written launches anything, and only for the attempt it wrote.
      const attempt = machine.attempts.find((candidate) => candidate.slot === slot && candidate.phase === "starting");
      if (attempt !== undefined) await runs.launch({ caseId: name as string, slot: attempt.slot, attemptId: attempt.attemptId });
    }
    if (typeof type === "string" && ENDING_COMMANDS.includes(type) && machine !== null) {
      for (const live of runs.liveSlots()) {
        if (!machine.attempts.some((attempt) => attempt.slot === live && isRunningPhase(attempt.phase))) await stopQuietly(live);
      }
    }
    return answer;
  }

  async function plan(assertion: string, caseId: string, viewedHead: string, given: unknown): Promise<PlanAnswer> {
    const owner = await ownerFromAssertion(access, assertion);
    if ("ok" in owner) return owner;
    if (caseId !== name) return NO_LOG;
    const checked = await checkedPlan(given);
    if (!checked.ok) return checked;
    for (const bytes of checked.objects) {
      const put = await putEvidence(stores, bytes);
      if (!put.ok) return { ok: false, refusal: put.refusal, at: put.at ?? null };
    }
    const event = { type: "case-planned", data: { slots: mintedSlots(checked.slots), controlRunId: mintAttemptId(), configuration: checked.configuration } } as unknown as LogEvent;
    return synced(await commands.command(assertion, caseId, viewedHead, event));
  }

  async function freeze(assertion: string, caseId: string, viewedHead: string, text: unknown): Promise<PlanAnswer> {
    const owner = await ownerFromAssertion(access, assertion);
    if ("ok" in owner) return owner;
    if (caseId !== name) return NO_LOG;
    const bytes = textBytes(text);
    if (bytes === null) return { ok: false, refusal: "malformed-plan", at: "plan" };
    const put = await putEvidence(stores, bytes);
    if (!put.ok) return { ok: false, refusal: put.refusal, at: put.at ?? null };
    return synced(await commands.command(assertion, caseId, viewedHead, { type: "plan-frozen", data: { planDigest: put.digest } }));
  }
  const logStarted = async (): Promise<boolean> => (await stores.head.read(MAX_HEAD_CHARS)) !== null;

  async function create(assertion: unknown, caseId: unknown, plan: unknown): Promise<CaseCreateAnswer> {
    const owner = await ownerFromAssertion(access, assertion);
    if ("ok" in owner) return owner;
    // The id of a new case is this object's own name, which has the minted shape. A slug, or another case's id, is refused.
    if (caseId !== name) return { ok: false, refusal: "case-id-not-minted", at: null, logStarted: false };
    if (isAbandoned()) return { ok: false, refusal: "case-abandoned", at: null, logStarted: false };
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

  /**
   * Store one object a runner sends, its bytes the body. Its declared length is read before anything
   * else and the body no further than that; the token is held to the rule of a row (D-7); the key is
   * the digest worked out here from the bytes, a digest the call gives only compared with it (F-2);
   * and the attempt's objects are counted against their bound before the bytes are stored (F-3).
   * One object is read and stored at a time: a second sent while one is in flight is refused unread,
   * after its token is checked and before anything is held for its bytes, so the object's memory for
   * objects is one buffer of a declared length and its stored copy, never two.
   */
  async function storeObject(request: Request): Promise<Response> {
    const refuse = async (status: number, refusal: string): Promise<Response> => {
      try {
        await request.body?.cancel();
      } catch {
        // Nothing more is read either way.
      }
      return jsonResponse(status, { ok: false, refusal });
    };
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);
    if (!request.headers.has("content-length") || !Number.isSafeInteger(declared) || declared < 0) return refuse(411, "length-required");
    if (declared > MAX_EVIDENCE_BYTES) return refuse(413, "body-too-large");
    const given = request.headers.get(RUNNER_DIGEST_HEADER);
    if (given !== null && !/^[0-9a-f]{64}$/.test(given)) return refuse(400, "malformed-call");
    if (request.headers.get(RUNNER_CASE_HEADER) !== name) return refuse(200, "token-refused");
    const holder = await credentials.holderOf(request.headers.get(RUNNER_TOKEN_HEADER));
    if (holder === null) return refuse(200, "token-refused");
    const opened = await openCase(stores, named);
    if (!opened.ok || opened.case.state === null) return refuse(200, "token-refused");
    const attempt = opened.case.state.machine.attempts.find(({ slot }) => slot === holder.slot);
    if (attempt === undefined || attempt.attemptId !== holder.attemptId) return refuse(200, "token-refused");
    // An object is evidence a row will name, so the token stores one only while it could write a row.
    const ended = tokenRefusalFor(holder, opened.case.state.machine, attempt, "evidence-recorded");
    if (ended !== null) return refuse(200, ended);
    // Checked and taken with no wait between, so two requests cannot both pass; freed however this one ends.
    if (objectInFlight) return refuse(200, "object-in-flight");
    objectInFlight = true;
    try {
      const bytes = await readBounded(request, RUNNER_CALL_CAPS["runner-object"], true);
      if (bytes === "too-large") return jsonResponse(413, { ok: false, refusal: "body-too-large" });
      if (bytes === "length-required") return jsonResponse(411, { ok: false, refusal: "length-required" });
      if (bytes === "length-mismatch") return jsonResponse(400, { ok: false, refusal: "body-length-mismatch" });
      const digest = await sha256Hex(bytes);
      if (given !== null && given !== digest) return jsonResponse(200, { ok: false, refusal: "digest-mismatch" });
      const admission = objects.admit(holder.slot, digest, bytes.byteLength);
      if (admission === "object-bound") return jsonResponse(200, { ok: false, refusal: "object-bound" });
      const put = await putEvidence(stores, bytes);
      if (!put.ok) return jsonResponse(200, { ok: false, refusal: put.refusal });
      objects.count(holder.slot, put.digest, bytes.byteLength);
      return jsonResponse(200, { ok: true, digest: put.digest });
    } finally {
      objectInFlight = false;
    }
  }

  /** Whether an object is being read or stored now. Held in memory only: a restart ends any read in flight with it. */
  let objectInFlight = false;

  /** A runner's call as the handler sends it: its name in a header, its body read no further than that call's cap. */
  async function runnerCallOf(request: Request, callName: string): Promise<Call | "too-large" | null> {
    const cap = Object.hasOwn(RUNNER_CALL_CAPS, callName) ? RUNNER_CALL_CAPS[callName] : null;
    if (cap === null) return null;
    const bytes = await readBounded(request, cap, false);
    if (bytes === "too-large") return "too-large";
    if (typeof bytes === "string") return null;
    try {
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return typeof body === "object" && body !== null && !Array.isArray(body) && (body as Call).call === callName ? (body as Call) : null;
    } catch {
      return null;
    }
  }

  const answer: HostObject = async (request) => {
    const runnerCall = request.headers.get(RUNNER_CALL_HEADER);
    if (runnerCall === "runner-object") return storeObject(request);
    // A runner's call arrives with its name in a header, which no owner's call carries, so its body is bounded before it is read.
    const call = runnerCall === null ? await callOf(request) : await runnerCallOf(request, runnerCall);
    if (call === "too-large") return jsonResponse(413, { ok: false, refusal: "body-too-large" });
    if (call === null) return jsonResponse(400, MALFORMED_CALL);
    // A runner's call without its header would be read unbounded, so it is refused.
    if (runnerCall === null && (call.call === "runner-token" || call.call === "runner")) return jsonResponse(400, MALFORMED_CALL);
    const assertion = call.assertion as string;
    const caseId = call.caseId as string;
    const viewedHead = call.viewedHead as string;
    switch (call.call) {
      case "open":
        return jsonResponse(200, await open(assertion, caseId));
      case "evidence":
        return jsonResponse(200, await service.evidence(assertion, caseId, call.digest as string, call.offset as number));
      case "claim":
        return jsonResponse(200, await synced(await service.claim(assertion, caseId, viewedHead, call.event as LogEvent)));
      case "create":
        return jsonResponse(200, await synced(await create(assertion, caseId, call.plan)));
      case "command":
        // A plan or a freeze sent ready made is refused as no command, before the assertion is even read.
        if (BUILT_HERE.includes((call.event as { type?: unknown } | null)?.type as string)) return jsonResponse(200, { ok: false, refusal: "not-a-command" });
        return jsonResponse(200, await command(assertion, caseId, viewedHead, call.event as LogEvent));
      case "plan":
        return jsonResponse(200, await plan(assertion, caseId, viewedHead, call.plan));
      case "freeze":
        return jsonResponse(200, await freeze(assertion, caseId, viewedHead, call.text));
      case "abandon":
        return jsonResponse(200, await abandon(assertion, caseId));
      case "runner-token":
        if (!hasRunnerFields(call)) return jsonResponse(400, MALFORMED_CALL);
        return jsonResponse(200, await handOut(caseId, call.attemptId));
      case "runner": {
        if (!hasRunnerFields(call)) return jsonResponse(400, MALFORMED_CALL);
        const written = await synced(await runner.write(call.token as string, caseId, viewedHead, call.event as LogEvent));
        // The runner's own cleanup event says its browser is closed: its container's work is over.
        const event = call.event as { type?: unknown; data?: { slot?: unknown } };
        if (written.ok && (event.type === "cleanup-confirmed" || event.type === "cleanup-unconfirmed") && (SLOT_NAMES as readonly unknown[]).includes(event.data?.slot)) await stopQuietly(event.data?.slot as SlotName);
        return jsonResponse(200, runnerWire(written));
      }
      default:
        return jsonResponse(400, MALFORMED_CALL);
    }
  };
  return Object.assign(answer, {
    alarm: async () => {
      await supervision.alarm();
    }
  });
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

export type HostedCases = Readonly<{ service: CaseService; directory: CaseDirectory; commands: HostedCommands }>;

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
    commands: {
      command: (assertion, caseId, viewedHead, event) => toCase<HostedCommandAnswer>(caseId, { call: "command", assertion, caseId, viewedHead, event }),
      async plan(assertion, caseId, viewedHead, plan) {
        const answer = await toCase<PlanAnswer>(caseId, { call: "plan", assertion, caseId, viewedHead, plan });
        // The create that reserved this id never marked it created. If this fails the list still shows it as not finished.
        if (answer.ok) await toIndex({ call: "confirm", assertion, caseId });
        return answer;
      },
      freeze: (assertion, caseId, viewedHead, text) => toCase<PlanAnswer>(caseId, { call: "freeze", assertion, caseId, viewedHead, text })
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
      async release(assertion, caseId) {
        if (!isHostedCaseId(caseId)) return NO_LOG;
        // The case answers first, and only a case with no log answers yes. The list is asked only after that.
        const abandoned = (await callObject(cases, caseId, { call: "abandon", assertion, caseId })) as ReleaseAnswer | null;
        if (abandoned === null) return UNAVAILABLE;
        if (!abandoned.ok) return abandoned;
        return ((await toIndex({ call: "release", assertion, caseId })) as ReleaseAnswer | null) ?? UNAVAILABLE;
      },
      async list(assertion) {
        return ((await toIndex({ call: "list", assertion })) as ListAnswer | null) ?? UNAVAILABLE;
      }
    }
  };
}
