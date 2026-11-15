import { AccessKeySet } from "../core/access-token";
import { sha256Hex } from "../core/canonical-json";
import { caseIndexObject, caseObject, hostedCasesFrom, type CaseHostObject, type HostEnv, type HostObject } from "../core/case-host";
import type { Deadlines } from "../core/case-supervision";
import { runnerCredentialsOver } from "../core/case-runner";
import type { SlotName } from "../core/case-machine";
import { bucketObjectStore, sqlHeadStore, type HostBucket, type HostStorage } from "../core/case-host-stores";
import { viewerRoutes } from "../core/viewer-routes";
import { handleWorkspaceRequest } from "../core/workspace-gate";

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
 */

const FAULT_KEY = "test-fault/entry-put";
const SLOW_KEY = "test-fault/slow-entry-put";
const STOP_FAILS_KEY = "test-fault/stop-fails";
const SLOW_EVIDENCE_KEY = "test-fault/slow-evidence-put";

type ObjectState = Readonly<{ id: Readonly<{ name?: string }>; storage: HostStorage & { getAlarm(): Promise<number | null> } }>;
type TestEnv = HostEnv & { TEST_DEADLINES?: string };

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

export class InvestigationCase {
  private readonly answer: CaseHostObject;
  private readonly storage: ObjectState["storage"];
  private readonly bucket: HostBucket;

  constructor(state: ObjectState, env: TestEnv) {
    this.storage = state.storage;
    this.bucket = env.INVESTIGATION_OBJECTS as HostBucket;
    const { sql } = this.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS test_stops (slot TEXT NOT NULL, at_ms INTEGER NOT NULL, stopped INTEGER NOT NULL)").toArray();
    this.answer = caseObject({
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

export default {
  fetch(request: Request, env: HostEnv): Promise<Response> {
    const hosted = hostedCasesFrom(env);
    return handleWorkspaceRequest(request, env, { keySetFor, now: Date.now, routes: viewerRoutes({ env, service: hosted?.service ?? null, directory: hosted?.directory ?? null, commands: hosted?.commands ?? null }) });
  }
};
