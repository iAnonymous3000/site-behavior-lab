import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessKeySet, verifyAccessToken } from "../core/access-token";
import { ownerActorFrom, type OwnerActor } from "../core/actor";
import type { LogStores } from "../core/case-log";
import { fsLogStores, prepareFsLogDirectory } from "../local/fs-log-store";
import { memoryStores } from "./memory-log-store";
import { certsFor, generateSigningKey, ISSUER, NOW_MS, NOW_SECONDS, OWNER, OWNER_EMAIL, ownerClaims, POLICY, signToken } from "./token-fixture";

/**
 * What the log's tests compare it with. Nothing here imports the module under test's
 * canonical form or digest: entries are written out by hand in the documented key
 * order and hashed with node:crypto, so an oracle cannot be the code's own output.
 */

export const GENESIS = "0".repeat(64);
export const ANOTHER_DIGEST = "f".repeat(64);
export const CASE_A = "case-a";
export const CASE_B = "case-b";
/** Attempt ids are generated, so these only have the shape: 32 lowercase hex digits. */
export const ATTEMPT_ONE = "a1".repeat(16);
export const ATTEMPT_TWO = "b2".repeat(16);
export const ATTEMPT_THREE = "c3".repeat(16);
export const IAT = NOW_SECONDS - 60;
export const EXP = NOW_SECONDS + 3600;

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The owner's actor as an entry spells it, sorted by hand. */
export const OWNER_ACTOR_TEXT = `{"email":"${OWNER_EMAIL}","exp":${EXP},"iat":${IAT},"iss":"${ISSUER}","kind":"owner","sub":"${OWNER}"}`;

export function runnerActorText(attemptId: string): string {
  return `{"attemptId":"${attemptId}","kind":"system:runner"}`;
}

export type HandEntry = Readonly<{
  actorText: string;
  atMs: number;
  caseId?: string;
  eventsText: string;
  evidence?: readonly string[];
  prev: string;
  seq: number;
}>;

/** An entry's canonical text, written from the rules and not produced by them. */
export function handEntryText({ actorText, atMs, caseId = CASE_A, eventsText, evidence = [], prev, seq }: HandEntry): string {
  const evidenceText = evidence.map((digest) => `"${digest}"`).join(",");
  return `{"actor":${actorText},"atMs":${atMs},"case":"${caseId}","events":${eventsText},"evidence":[${evidenceText}],"prev":"${prev}","seq":${seq},"v":1}`;
}

export function eventsTextOf(type: string): string {
  return `[{"data":{},"type":"${type}"}]`;
}

/** The owner's actor, by the only route there is: a token signed and then verified. */
export async function verifiedOwnerActor(claims: Record<string, unknown> = {}): Promise<OwnerActor> {
  const signing = await generateSigningKey("key-1");
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
  const decision = await verifyAccessToken(await signToken(signing, ownerClaims(claims)), POLICY, keySet, () => NOW_MS);
  if (!decision.ok) throw new Error(`The fixture token was refused: ${decision.refusal}`);
  const actor = ownerActorFrom(decision.identity);
  if (actor === null) throw new Error("The fixture identity gave no actor");
  return actor;
}

/** Reach past the store's rules, the way someone holding the storage could. */
export type Tamper = {
  setEntry(address: string, bytes: Uint8Array): void;
  removeEntry(address: string): void;
  setEvidence(address: string, bytes: Uint8Array): void;
  removeEvidence(address: string): void;
  setHead(value: string): void;
  removeHead(): void;
  entryAddresses(): string[];
};

export type Backend = Readonly<{ name: string; fresh(): { stores: LogStores; tamper: Tamper; dispose(): void } }>;

export const MEMORY_BACKEND: Backend = {
  name: "memory",
  fresh() {
    const stores = memoryStores();
    return {
      stores,
      dispose() {},
      tamper: {
        setEntry: (address, bytes) => void stores.entries.objects.set(address, new Uint8Array(bytes)),
        removeEntry: (address) => void stores.entries.objects.delete(address),
        setEvidence: (address, bytes) => void stores.evidence.objects.set(address, new Uint8Array(bytes)),
        removeEvidence: (address) => void stores.evidence.objects.delete(address),
        setHead: (value) => {
          stores.head.value = value;
        },
        removeHead: () => {
          stores.head.value = null;
        },
        entryAddresses: () => [...stores.entries.objects.keys()]
      }
    };
  }
};

export function freshDirectory(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `sbl-case-log-${label}-`));
}

/** Run with a new directory, gone afterward whichever way the run ends. */
export async function withDirectory<T>(label: string, run: (root: string) => T | Promise<T>): Promise<T> {
  const root = freshDirectory(label);
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const FILESYSTEM_BACKEND: Backend = {
  name: "filesystem",
  fresh() {
    const root = freshDirectory("tamper");
    try {
      prepareFsLogDirectory(root);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    const headDirectory = path.join(root, "head");
    return {
      stores: fsLogStores(root),
      dispose: () => rmSync(root, { recursive: true, force: true }),
      tamper: {
        setEntry: (address, bytes) => writeFileSync(path.join(root, "entries", address), bytes),
        removeEntry: (address) => rmSync(path.join(root, "entries", address)),
        setEvidence: (address, bytes) => writeFileSync(path.join(root, "evidence", address), bytes),
        removeEvidence: (address) => rmSync(path.join(root, "evidence", address)),
        setHead: (value) => {
          const highest = readdirSync(headDirectory).sort().at(-1) ?? "000000000001";
          writeFileSync(path.join(headDirectory, highest), value);
        },
        removeHead: () => {
          rmSync(headDirectory, { recursive: true });
          mkdirSync(headDirectory, { mode: 0o700 });
        },
        entryAddresses: () => readdirSync(path.join(root, "entries"))
      }
    };
  }
};
