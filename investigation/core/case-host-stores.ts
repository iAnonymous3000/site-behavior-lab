// The log's stores as a Durable Object holds them: the head in the object's own SQLite
// storage, and entries and evidence as objects in a private bucket, each under its case's
// prefix. So the head does not live beside the objects it protects, as case-log.ts asks.
//
// Nothing here names a platform type. The object's storage and the bucket are taken as the
// few calls this file makes, so the same code runs on workerd and under a test's stand-in,
// and the core still names no package.
//
// The head's compare-and-swap is one SQL statement that writes only where the stored value
// still reads as expected, run inside the object's synchronous transaction, and it answers
// by how many rows that statement wrote. No await stands between the comparison and the
// write, so two commands that read one head cannot both replace it.
//
// An entry is written first and the head second, which case-log.ts orders. A kill between
// the two leaves an object no head names.
//
// NOT SHOWN HERE: that the hosted bucket refuses a conditional write the way the local
// simulator does. createOnly asks the bucket to store only where nothing is stored, and
// reads a null answer as "exists". The simulator answers so. Whether the hosted service
// does is a staging probe, and until it is run this is a claim about the simulator alone.
// What limits the harm if it does not: the log writes an object only at the digest of its
// own bytes, so a write that went through over an object already there would store the
// same bytes again.

import { isDigest, type HeadStore, type LogStores, type ObjectStore, type UnreadableObject } from "./case-log";

/** What one statement gives back. Its rows are read before its count of rows written is. */
export type HostSqlCursor = { toArray(): Record<string, unknown>[]; readonly rowsWritten: number };

/** The synchronous SQL of a Durable Object's own storage. */
export type HostSql = { exec(query: string, ...bindings: (string | number | null)[]): HostSqlCursor };

/** The part of a Durable Object's storage this host uses. */
export type HostStorage = { readonly sql: HostSql; transactionSync<T>(closure: () => T): T };

/** The part of a bucket binding this host uses. */
export type HostBucket = {
  head(key: string): Promise<{ readonly size: number } | null>;
  get(key: string, options: { range: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string } }): Promise<unknown>;
};

export function isHostStorage(value: unknown): value is HostStorage {
  const storage = value as Partial<HostStorage> | null;
  return typeof storage === "object" && storage !== null && typeof storage.transactionSync === "function" && typeof storage.sql === "object" && storage.sql !== null && typeof storage.sql.exec === "function";
}

export function isHostBucket(value: unknown): value is HostBucket {
  const bucket = value as Partial<HostBucket> | null;
  return typeof bucket === "object" && bucket !== null && typeof bucket.head === "function" && typeof bucket.get === "function" && typeof bucket.put === "function";
}

/** The head of the one log this object holds, in a table of one row. */
export function sqlHeadStore(storage: HostStorage): HeadStore {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS log_head (slot INTEGER PRIMARY KEY CHECK (slot = 0), value TEXT NOT NULL)").toArray();
  return {
    async read(maxChars) {
      // A value past the bound is never selected, so it is not held here whatever its length.
      const rows = storage.sql.exec("SELECT CASE WHEN length(value) <= ? THEN value END AS value FROM log_head WHERE slot = 0", maxChars).toArray();
      if (rows.length === 0) return null;
      const { value } = rows[0];
      return typeof value === "string" ? value : "";
    },
    async compareAndSwap(expected, next) {
      return storage.transactionSync(() => {
        const written =
          expected === null
            ? storage.sql.exec("INSERT INTO log_head (slot, value) VALUES (0, ?) ON CONFLICT (slot) DO NOTHING", next)
            : storage.sql.exec("UPDATE log_head SET value = ? WHERE slot = 0 AND value = ?", next, expected);
        written.toArray();
        return written.rowsWritten > 0;
      });
    }
  };
}

/** Objects in the bucket under one prefix, each at the digest the log addresses it by. */
export function bucketObjectStore(bucket: HostBucket, prefix: string): ObjectStore {
  return {
    async createOnly(address, bytes) {
      if (!isDigest(address)) throw new Error("An object is stored only at a digest");
      const stored = await bucket.put(prefix + address, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
      return stored === null ? "exists" : "created";
    },
    async read(address, maxBytes): Promise<Uint8Array<ArrayBuffer> | UnreadableObject | null> {
      if (!isDigest(address)) return null;
      const key = prefix + address;
      // The size comes from the object's record, so an object past the bound is refused with none of its bytes read.
      const found = await bucket.head(key);
      if (found === null) return null;
      if (found.size > maxBytes) return "too-large";
      if (found.size === 0) return new Uint8Array(0);
      // An object replaced by a longer one since its size was read is still cut one byte past the bound, which reads as too large.
      const object = await bucket.get(key, { range: { offset: 0, length: maxBytes + 1 } });
      if (object === null) return null;
      const bytes = new Uint8Array(await object.arrayBuffer());
      return bytes.length > maxBytes ? "too-large" : bytes;
    }
  };
}

/** Where one case's objects live in the bucket. A case id is one label with no slash, so no case's prefix holds another's. */
export function casePrefix(caseId: string, kind: "entries" | "evidence"): string {
  return `cases/${caseId}/${kind}/`;
}

/** One case's stores: its entries and evidence under its own prefixes, and its head in this object's storage. */
export function hostedStores(storage: HostStorage, bucket: HostBucket, caseId: string): LogStores {
  return Object.freeze({ entries: bucketObjectStore(bucket, casePrefix(caseId, "entries")), evidence: bucketObjectStore(bucket, casePrefix(caseId, "evidence")), head: sqlHeadStore(storage) });
}
