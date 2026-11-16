import { AccessKeySet } from "../core/access-token";
import { sha256Hex } from "../core/canonical-json";
import { caseIndexObject, caseObject, hostedCasesFrom, type CaseHostObject, type HostEnv, type HostObject } from "../core/case-host";
import type { Deadlines } from "../core/case-supervision";
import { runnerCredentialsOver } from "../core/case-runner";
import type { SlotName } from "../core/case-machine";
import { bucketObjectStore, sqlHeadStore, type HostBucket, type HostStorage } from "../core/case-host-stores";
import { viewerRoutes } from "../core/viewer-routes";
import { handleWorkspaceRequest } from "../core/workspace-gate";
import { RUNNER_CALL_HEADER, runnerHandler } from "../core/runner-handler";

/**
 * The production entry's wiring, bundled by the case host's fault and cost suites, with three
 * things the production entry has no way to do. Its case objects write through a bucket that
 * fails an entry's write while the test's marker object exists, which is how a kill between the
 * log's start and the plan is planted, and holds an entry's write back while a second marker
 * exists, which is how two commands are made to meet at the head. A case object also takes two
 * calls of the test's own:
 * one that runs the stores through their contract inside the object and reports what each call
 * answered, and one that sets a head, so a case built in Node can be measured as the host
 * opens it. None of this is reachable from cloudflare/investigation-worker.ts.
 *
 * For the alarm suite it also fills the seam that stops a runner, with one that only records each
 * stop it was asked for, and fails while a third marker exists. Its deadlines are the ones the
 * suite binds, so an alarm comes due in under a second. Three more calls of the test's own show
 * the object's deadline marks, its recorded stops and its alarm time, run the alarm's handler as
 * a second delivery would, and empty the marks as a lost write would.
 *
 * For the runner suite, three more: one brings every mark not yet flagged due now, so the next run
 * of the alarm's handler stops a running attempt's runner as its deadline would; one writes a
 * slot's destroy record, which only a later stage's container destroy writes in production; and
 * one hands back every row of every table in the object's storage, so a suite can look for a token
 * in all of it.
 *
 * For the container suite, when the suite binds TEST_CONTAINER, the object is given a stand-in
 * container that records every call made of it, in order, with what it was given; it starts nothing.
 * Faults the suite sets make its start throw, its registration reject or its destroy fail, and a
 * test call reports the exit of the run it is watching. The handler's binding for each start is the
 * real loopback binding of this entry's handler, with that start's props, and a test call sends a
 * request through the binding the latest start registered, as the runner, or a page, in that
 * container would. Without TEST_CONTAINER the object has no container, as in production today.
 */

const FAULT_KEY = "test-fault/entry-put";
const SLOW_KEY = "test-fault/slow-entry-put";
const STOP_FAILS_KEY = "test-fault/stop-fails";
const SLOW_EVIDENCE_KEY = "test-fault/slow-evidence-put";

type ObjectState = Readonly<{ id: Readonly<{ name?: string }>; storage: HostStorage & { getAlarm(): Promise<number | null> }; exports?: unknown }>;
type TestEnv = HostEnv & { TEST_DEADLINES?: string; TEST_CONTAINER?: string };
type Fetching = { fetch(input: string, init?: RequestInit): Promise<Response> };
type HandlerExport = ((options: { props: unknown }) => Fetching) & Fetching;

/** A container that starts nothing and records every call made of it, in this object's storage. */
class StandInContainer {
  running = false;
  /** The binding the latest start registered, kept in memory as the platform keeps it. */
  binding: Fetching | null = null;
  /** One per run watched, in the order the runs were started. */
  private readonly exits: (() => void)[] = [];

  constructor(private readonly sql: HostStorage["sql"]) {
    sql.exec("CREATE TABLE IF NOT EXISTS test_container_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, call TEXT NOT NULL, detail TEXT NOT NULL)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS test_container_faults (name TEXT PRIMARY KEY)").toArray();
  }

  log(call: string, detail: unknown): void {
    this.sql.exec("INSERT INTO test_container_calls (call, detail) VALUES (?, ?)", call, JSON.stringify(detail ?? null)).toArray();
  }

  private faulty(name: string): boolean {
    return this.sql.exec("SELECT name FROM test_container_faults WHERE name = ?", name).toArray().length > 0;
  }

  async interceptOutboundHttp(address: string, binding: unknown): Promise<void> {
    this.log("intercept", { address });
    if (this.faulty("intercept-rejects")) throw new Error("The test's planted registration failure");
    this.binding = binding as Fetching;
  }

  start(options: Readonly<{ env: Readonly<Record<string, string>>; enableInternet: boolean }>): void {
    this.log("start", options);
    if (this.faulty("start-throws")) throw new Error("The test's planted start failure");
    this.running = true;
  }

  monitor(): Promise<void> {
    this.log("monitor", null);
    const index = this.exits.length;
    return new Promise((resolve) => {
      this.exits[index] = () => {
        // Only the run the container holds now stops running when it exits.
        if (index === this.exits.length - 1) this.running = false;
        resolve();
      };
    });
  }

  async destroy(): Promise<void> {
    this.log("destroy", { running: this.running });
    if (this.faulty("destroy-fails")) throw new Error("The test's planted destroy failure");
    this.running = false;
  }

  /** A watched run ends, as a runner's exit would end it: the latest, or the first. */
  exited(which: "latest" | "first"): void {
    this.exits[which === "first" ? 0 : this.exits.length - 1]?.();
  }
}

const keySets = new Map<string, AccessKeySet>();

function keySetFor(issuer: string): AccessKeySet {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = new AccessKeySet(issuer, (url, init) => fetch(url, init), Date.now);
    keySets.set(issuer, keySet);
  }
  return keySet;
}

/** The bucket, counting its reads, and failing an entry's write while the marker is there. */
function plantable(bucket: HostBucket, counts: { gets: number }): HostBucket {
  return {
    head: (key) => bucket.head(key),
    get: (key, options) => {
      counts.gets += 1;
      return bucket.get(key, options);
    },
    put: async (key, value, options) => {
      if (key.includes("/entries/") && (await bucket.head(FAULT_KEY)) !== null) throw new Error("The test's planted store failure");
      // Held back while the second marker exists, so two commands that read one head are both past that read before either swaps it.
      if (key.includes("/entries/") && (await bucket.head(SLOW_KEY)) !== null) await new Promise((resolve) => setTimeout(resolve, 150));
      // A create held here has passed its own look at whether the case was abandoned, and has not yet started its log.
      if (key.includes("/evidence/") && (await bucket.head(SLOW_EVIDENCE_KEY)) !== null) await new Promise((resolve) => setTimeout(resolve, 400));
      return bucket.put(key, value, options);
    }
  };
}

const text = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(value));

/** Each store call the contract names, in order, with what it answered. */
async function probeStores(storage: HostStorage, bucket: HostBucket): Promise<Record<string, unknown>> {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((letter) => letter.repeat(64));
  const head = sqlHeadStore(storage);
  const absent = await head.read(64);
  const first = await head.compareAndSwap(null, a);
  const second = await head.compareAndSwap(null, b);
  const stale = await head.compareAndSwap(c, d);
  const afterRefused = await head.read(64);
  const swap = await head.compareAndSwap(a, b);
  const swapAgain = await head.compareAndSwap(a, c);
  const now = await head.read(64);
  const bounded = await head.read(63);
  storage.sql.exec("UPDATE log_head SET value = ?", "e".repeat(65)).toArray();
  const long = await head.read(64);

  const counts = { gets: 0 };
  const objects = bucketObjectStore(plantable(bucket, counts), "probe/");
  const digest = await sha256Hex(text("first"));
  const created = await objects.createOnly(digest, text("first"));
  const again = await objects.createOnly(digest, text("second"));
  const held = await objects.read(digest, 100);
  const exact = await objects.read(digest, 5);
  const getsBefore = counts.gets;
  const tooLarge = await objects.read(digest, 4);
  const getsForTooLarge = counts.gets - getsBefore;
  const missing = await objects.read(c, 10);
  const notADigest = await objects.read("not-a-digest", 10);
  const emptyDigest = await sha256Hex(new Uint8Array(0));
  const emptyCreated = await objects.createOnly(emptyDigest, new Uint8Array(0));
  const empty = await objects.read(emptyDigest, 0);
  let offDigest = "stored";
  try {
    await objects.createOnly("not-a-digest", text("x"));
  } catch {
    offDigest = "refused";
  }
  const shown = (value: unknown): unknown => (value instanceof Uint8Array ? new TextDecoder().decode(value) : value);
  return { absent, first, second, stale, afterRefused, swap, swapAgain, now, bounded, long, created, again, held: shown(held), exact: shown(exact), tooLarge, getsForTooLarge, missing, notADigest, emptyCreated, empty: shown(empty), offDigest };
}

/**
 * A body built here and counted as it is pulled, so a test can see how much of it the object read.
 * Nothing is pulled before a reader asks: its queue holds nothing ahead.
 * Its first part is offered at once; the rest only when `release` is called, so a test can hold it
 * open. `declared` is the length its request names, which need not be what it holds.
 */
function countedBody(parts: Readonly<{ first: number; rest: number; byte: number }>) {
  const counted = { pulled: 0 };
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let offered = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offered === 0 && parts.first > 0) {
        offered = 1;
        counted.pulled += parts.first;
        controller.enqueue(new Uint8Array(parts.first).fill(parts.byte));
        return;
      }
      await released;
      if (parts.rest > 0) {
        counted.pulled += parts.rest;
        controller.enqueue(new Uint8Array(parts.rest).fill(parts.byte));
      }
      controller.close();
    }
  }, { highWaterMark: 0 });
  return { stream, counted, release };
}

type StraightObject = Readonly<{ headers: Record<string, string>; declared: number; first: number; rest: number; byte: number; hold?: boolean }>;

/** An object's request built here, as the handler sends one: its call header, its declared length, and a counted body. */
function straightObject(object: StraightObject) {
  const body = countedBody(object);
  if (object.hold !== true) body.release();
  const request = new Request("http://case-object.internal/", { method: "POST", headers: { ...object.headers, "content-length": String(object.declared) }, body: body.stream });
  return { request, body };
}

export class InvestigationCase {
  private readonly answer: CaseHostObject;
  private readonly storage: ObjectState["storage"];
  private readonly bucket: HostBucket;
  private readonly container: StandInContainer | null;
  private readonly handler: HandlerExport | null;

  constructor(state: ObjectState, env: TestEnv) {
    this.storage = state.storage;
    this.bucket = env.INVESTIGATION_OBJECTS as HostBucket;
    const { sql } = this.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS test_stops (slot TEXT NOT NULL, at_ms INTEGER NOT NULL, stopped INTEGER NOT NULL)").toArray();
    this.container = env.TEST_CONTAINER === "1" ? new StandInContainer(sql) : null;
    this.handler = ((state.exports as Record<string, unknown> | undefined)?.InvestigationRunnerHandler as HandlerExport | undefined) ?? null;
    const container = this.container;
    const handler = this.handler;
    this.answer = caseObject({
      container: container ?? undefined,
      handlerFor:
        container === null || handler === null
          ? undefined
          : (props) => {
              container.log("handler-for", props);
              return handler({ props });
            },
      name: state.id.name,
      storage: state.storage,
      env: { ...env, INVESTIGATION_OBJECTS: plantable(this.bucket, { gets: 0 }) },
      keySetFor,
      now: Date.now,
      deadlines: env.TEST_DEADLINES === undefined ? undefined : (JSON.parse(env.TEST_DEADLINES) as Deadlines),
      // Every stop asked for is recorded, the ones that failed too.
      stopRunner: async (slot) => {
        const fails = (await this.bucket.head(STOP_FAILS_KEY)) !== null;
        sql.exec("INSERT INTO test_stops (slot, at_ms, stopped) VALUES (?, ?, ?)", slot, Date.now(), fails ? 0 : 1).toArray();
        if (fails) throw new Error("The test's planted stop failure");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    // A runner's call goes to the object as it came, unread here: an object's bytes are no JSON, and its body is read once, bounded, by the object.
    if (request.headers.has(RUNNER_CALL_HEADER)) return this.answer(request);
    const call = (await request.clone().json()) as { call?: string; head?: string };
    const { sql } = this.storage;
    if (call.call === "test-probe-stores") return Response.json(await probeStores(this.storage, this.bucket));
    if (call.call === "test-seed-head") return Response.json({ ok: await sqlHeadStore(this.storage).compareAndSwap(null, call.head as string) });
    if (call.call === "test-marks") {
      return Response.json({
        marks: sql.exec("SELECT kind, slot, due_at_ms, flagged_at_ms FROM due_marks ORDER BY kind, slot").toArray(),
        stops: sql.exec("SELECT slot, stopped FROM test_stops ORDER BY at_ms, rowid").toArray(),
        alarm: await this.storage.getAlarm()
      });
    }
    if (call.call === "test-run-alarm") {
      try {
        await this.answer.alarm();
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ ok: false, error: String(error) });
      }
    }
    if (call.call === "test-due-now") {
      // Now, not zero: the alarm the object sets from these marks must be a time the platform takes.
      sql.exec("UPDATE due_marks SET due_at_ms = ? WHERE flagged_at_ms IS NULL", Date.now()).toArray();
      return Response.json({ ok: true });
    }
    if (call.call === "test-destroy-record") {
      runnerCredentialsOver(this.storage, Date.now).recordDestroyed((call as { slot?: SlotName }).slot as SlotName);
      return Response.json({ ok: true });
    }
    if (call.call === "test-storage") {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").toArray();
      return Response.json(Object.fromEntries(tables.map(({ name }) => [String(name), sql.exec(`SELECT * FROM "${String(name)}"`).toArray()])));
    }
    if (call.call === "test-container-calls") {
      return Response.json(sql.exec("SELECT call, detail FROM test_container_calls ORDER BY seq").toArray().map((row) => ({ call: row.call, detail: JSON.parse(String(row.detail)) })));
    }
    if (call.call === "test-container-fault") {
      const { name, on } = call as { name?: string; on?: boolean };
      if (on === true) sql.exec("INSERT INTO test_container_faults (name) VALUES (?) ON CONFLICT (name) DO NOTHING", String(name)).toArray();
      else sql.exec("DELETE FROM test_container_faults WHERE name = ?", String(name)).toArray();
      return Response.json({ ok: true });
    }
    if (call.call === "test-container-exit") {
      this.container?.exited((call as { which?: "latest" | "first" }).which === "first" ? "first" : "latest");
      // The exit's own work runs after this answer; the suite reads the outcome with its next call.
      return Response.json({ ok: true });
    }
    if (call.call === "test-container-running") return Response.json({ running: this.container?.running ?? null });
    if (call.call === "test-through-handler" || call.call === "test-handler-unregistered") {
      // A request as something in the container sends it: through the binding the latest start registered, or through the handler's export with props the suite names, or none.
      const { headers = {}, body = "", fill, stream, props } = call as { headers?: Record<string, string>; body?: string; fill?: { length: number; byte: number }; stream?: boolean; props?: unknown };
      const target = call.call === "test-through-handler" ? this.container?.binding : props === undefined ? this.handler : this.handler?.({ props });
      if (target === null || target === undefined) return Response.json({ status: 0, answer: null });
      const bytes = fill === undefined ? new TextEncoder().encode(body) : new Uint8Array(fill.length).fill(fill.byte);
      // A stream declares no length; a byte array does.
      const sent = stream === true ? new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(bytes), controller.close()) }) : bytes;
      const response = await target.fetch("http://case-handler.internal/", { method: "POST", headers, body: sent });
      return Response.json({ status: response.status, answer: await response.json() });
    }
    if (call.call === "test-straight-to-object") {
      // An object sent to the object itself, not through the handler: what the object alone refuses, and how much it read first.
      const { request, body } = straightObject((call as unknown as { object: StraightObject }).object);
      const response = await this.answer(request);
      return Response.json({ status: response.status, answer: await response.json(), pulled: body.counted.pulled });
    }
    if (call.call === "test-objects-in-flight") {
      // A first object whose body is held open after its first part, then each of the others sent while it is, then the first let finish.
      const { first, during } = call as unknown as { first: StraightObject; during: StraightObject[] };
      const held = straightObject({ ...first, hold: true });
      const pending = this.answer(held.request);
      for (let turns = 0; held.body.counted.pulled === 0 && turns < 1000; turns += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      const startedReading = held.body.counted.pulled;
      const answers: unknown[] = [];
      for (const object of during) {
        const sent = straightObject(object);
        const response = await this.answer(sent.request);
        answers.push({ status: response.status, answer: await response.json(), pulled: sent.body.counted.pulled });
      }
      held.body.release();
      const response = await pending;
      return Response.json({ startedReading, during: answers, first: { status: response.status, answer: await response.json(), pulled: held.body.counted.pulled } });
    }
    if (call.call === "test-clear-marks") {
      sql.exec("DELETE FROM due_marks").toArray();
      return Response.json({ ok: true });
    }
    return this.answer(request);
  }

  alarm(): Promise<void> {
    return this.answer.alarm();
  }
}

export class InvestigationCaseIndex {
  private readonly answer: HostObject;

  constructor(state: ObjectState, env: HostEnv) {
    this.answer = caseIndexObject({ name: state.id.name, storage: state.storage, env, keySetFor, now: Date.now });
  }

  fetch(request: Request): Promise<Response> {
    return this.answer(request);
  }
}

/** The production entry's handler, as this entry's own export, so a start's binding reaches it. */
export const InvestigationRunnerHandler = {
  fetch(request: Request, env: HostEnv, ctx: { props?: unknown }): Promise<Response> {
    return runnerHandler(request, env, ctx.props);
  }
};

export default {
  fetch(request: Request, env: HostEnv): Promise<Response> {
    const hosted = hostedCasesFrom(env);
    return handleWorkspaceRequest(request, env, { keySetFor, now: Date.now, routes: viewerRoutes({ env, service: hosted?.service ?? null, directory: hosted?.directory ?? null, commands: hosted?.commands ?? null }) });
  }
};
