import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import { ACCESS_TOKEN_HEADER } from "../core/access-token";
import { RUNNER_CALL_HEADER } from "../core/runner-handler";
import { IDENTITY_ALDER, RAW_OBJECTS } from "./case-fixture";
import { VIEWER_ORIGIN } from "./memory-case-world";
import { generateSigningKey, ownerClaims, serviceClaims, signToken, type SigningKey } from "./token-fixture";
import { claimsAt, VIEWER_ENV } from "./viewer-fixture";
import { accessKeysOnly, bundleForWorkerd, COMPATIBILITY_DATE, type Outbound } from "./workerd-bundle";

/**
 * The hosted workspace on real workerd, for the suites that hold the case host: an entry's
 * bundle with both Durable Object classes on SQLite storage and a bucket, all local and in
 * memory. Nothing deploys, and the only address the Worker may ask for is the team's keys.
 *
 * An object is reached two ways. `send` goes through the front Worker and its gate, as a
 * browser would. `direct` calls an object's own stub from this process, which no client of a
 * deployment can do: it is how a suite shows what an object answers when the gate is not there.
 */

export const CASES_BINDING = "INVESTIGATION_CASES";
export const INDEX_BINDING = "INVESTIGATION_CASE_INDEX";
export const OBJECTS_BINDING = "INVESTIGATION_OBJECTS";
export const INDEX_NAME = "case-index";
const CALL_URL = "https://case-host.invalid/call";

/** The create form's fields for the fixture's alder configuration, over the fixture's own fixture and criterion. */
export const CREATE_FIELDS: readonly (readonly [string, string])[] = [
  ["slot", "B1"],
  ["slot", "I1"],
  ["commit", IDENTITY_ALDER.commit],
  ["runner-image", IDENTITY_ALDER.runnerImage],
  ["rea-release", IDENTITY_ALDER.reaRelease],
  ["rea-integrity", IDENTITY_ALDER.reaIntegrity],
  ["scanner-node", IDENTITY_ALDER.scannerNode],
  ["rea-node", IDENTITY_ALDER.reaNode],
  ["chromium", IDENTITY_ALDER.chromium],
  ["instruments", IDENTITY_ALDER.instruments.join(" ")],
  ["grammar-version", String(IDENTITY_ALDER.grammarVersion)],
  ["fixture", RAW_OBJECTS["raw-fixture"]],
  ["criterion", RAW_OBJECTS["raw-criterion"]]
];

/** The same plan as an object's create call takes it. */
export const CREATE_PLAN = {
  slots: ["B1", "I1"],
  configuration: {
    commit: IDENTITY_ALDER.commit,
    runnerImage: IDENTITY_ALDER.runnerImage,
    reaRelease: IDENTITY_ALDER.reaRelease,
    reaIntegrity: IDENTITY_ALDER.reaIntegrity,
    scannerNode: IDENTITY_ALDER.scannerNode,
    reaNode: IDENTITY_ALDER.reaNode,
    chromium: IDENTITY_ALDER.chromium,
    instruments: IDENTITY_ALDER.instruments,
    grammarVersion: IDENTITY_ALDER.grammarVersion
  },
  fixture: RAW_OBJECTS["raw-fixture"],
  criterion: RAW_OBJECTS["raw-criterion"]
} as const;

export type Answer = Readonly<{ status: number; body: string; location: string | null }>;

export type HostWorld = Readonly<{
  miniflare: Miniflare;
  signing: SigningKey;
  outbound: Outbound;
  ownerToken: string;
  /** Tokens an object must refuse, by what is wrong with each. */
  refusedTokens: Readonly<Record<string, string | null>>;
  send: (pathname: string, init?: Readonly<{ method?: string; token?: string | null; origin?: string | null; fields?: readonly (readonly [string, string])[] }>) => Promise<Answer>;
  /** One call to an object's own stub, past the front Worker and its gate. A runner's call carries its name in a header, as the handler sends it. */
  direct: (binding: string, name: string, call: Readonly<Record<string, unknown>>) => Promise<Readonly<{ status: number; answer: Record<string, unknown> }>>;
  /** One request to an object's own stub with these headers and this body, exactly, for what direct always shapes. */
  directRaw: (binding: string, name: string, init: Readonly<{ headers: Record<string, string>; body: string | Uint8Array }>) => Promise<Readonly<{ status: number; answer: Record<string, unknown> }>>;
  /** Every key the bucket holds under a prefix. */
  keys: (prefix: string) => Promise<string[]>;
  /** The ids the list page shows, created first and then those whose create did not finish. */
  listed: () => Promise<Readonly<{ created: string[]; unfinished: string[] }>>;
  /** Create the fixture's case through the front Worker, and give back its id. */
  create: (fields?: readonly (readonly [string, string])[]) => Promise<string>;
  dispose: () => Promise<void>;
}>;

export type HostWorldOptions = Readonly<{
  /** More bindings beside the workspace's own, such as the test entry's deadlines. */
  bindings?: Readonly<Record<string, string>>;
  /** A folder the objects' storage and the bucket are kept in, so a second world over it finds what the first left. */
  persist?: string;
}>;

/** Bundle this entry, or the production entry when none is named, and serve it with the host's three bindings. */
export async function hostWorld(entry: string | null, bundleName: string, options: HostWorldOptions = {}): Promise<HostWorld> {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-case-host-"));
  const signing = await generateSigningKey("key-1");
  const forger = await generateSigningKey("key-1");
  const nowMs = Date.now();
  const seconds = Math.floor(nowMs / 1000);
  const outbound = accessKeysOnly(signing);
  const scriptPath = bundleForWorkerd(entry, directory, bundleName);
  const miniflare = new Miniflare({
    modules: true,
    scriptPath,
    modulesRoot: directory,
    compatibilityDate: COMPATIBILITY_DATE,
    log: new Log(LogLevel.ERROR),
    bindings: { ...(VIEWER_ENV as Record<string, string>), ...options.bindings },
    ...(options.persist === undefined ? {} : { durableObjectsPersist: path.join(options.persist, "objects"), r2Persist: path.join(options.persist, "bucket") }),
    durableObjects: { [CASES_BINDING]: { className: "InvestigationCase", useSQLite: true }, [INDEX_BINDING]: { className: "InvestigationCaseIndex", useSQLite: true } },
    r2Buckets: [OBJECTS_BINDING],
    outboundService: outbound.handler
  });
  const ownerToken = await signToken(signing, claimsAt(nowMs));

  const send: HostWorld["send"] = async (pathname, init = {}) => {
    const method = init.method ?? (init.fields === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {};
    const token = init.token === undefined ? ownerToken : init.token;
    if (token !== null) headers[ACCESS_TOKEN_HEADER] = token;
    const origin = init.origin === undefined ? (method === "GET" ? null : VIEWER_ORIGIN) : init.origin;
    if (origin !== null) headers.origin = origin;
    if (method !== "GET") headers["content-type"] = "application/x-www-form-urlencoded";
    const response = await miniflare.dispatchFetch(`${VIEWER_ORIGIN}${pathname}`, { method, headers, redirect: "manual", body: method === "GET" ? undefined : new URLSearchParams((init.fields ?? []) as [string, string][]).toString() });
    return { status: response.status, body: await response.text(), location: response.headers.get("location") };
  };

  const listed: HostWorld["listed"] = async () => {
    const page = await send("/cases");
    if (page.status !== 200) throw new Error(`The list answered ${page.status}`);
    const [whole, late = ""] = page.body.split("Creates that did not finish");
    const ids = (text: string) => [...text.matchAll(/href="\/cases\/([0-9a-f]{32})"/g)].map((match) => match[1]);
    return { created: ids(whole), unfinished: ids(late.split("Create a case")[0]) };
  };

  return {
    miniflare,
    signing,
    outbound,
    ownerToken,
    refusedTokens: {
      "no token": null,
      "a malformed token": "not.a.token",
      "a service token": await signToken(signing, serviceClaims({ iat: seconds - 60, exp: seconds + 3600 })),
      "a forged token": await signToken(forger, claimsAt(nowMs)),
      "an expired token": await signToken(signing, ownerClaims({ iat: seconds - 7200, nbf: seconds - 7200, exp: seconds - 3600 })),
      "a token for another audience": await signToken(signing, claimsAt(nowMs, { aud: ["e".repeat(64)] })),
      "another person's token": await signToken(signing, claimsAt(nowMs, { sub: "11111111-61da-459d-899c-0a01c76a2f94" }))
    },
    send,
    direct: async (binding, name, call) => {
      const namespace = await miniflare.getDurableObjectNamespace(binding);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (call.call === "runner-token" || call.call === "runner") headers[RUNNER_CALL_HEADER] = call.call;
      const response = await namespace.get(namespace.idFromName(name)).fetch(CALL_URL, { method: "POST", headers, body: JSON.stringify(call) });
      return { status: response.status, answer: (await response.json()) as Record<string, unknown> };
    },
    directRaw: async (binding, name, init) => {
      const namespace = await miniflare.getDurableObjectNamespace(binding);
      const response = await namespace.get(namespace.idFromName(name)).fetch(CALL_URL, { method: "POST", headers: init.headers, body: init.body });
      return { status: response.status, answer: (await response.json()) as Record<string, unknown> };
    },
    keys: async (prefix) => {
      const bucket = await miniflare.getR2Bucket(OBJECTS_BINDING);
      return (await bucket.list({ prefix })).objects.map(({ key }) => key).sort();
    },
    listed,
    create: async (fields = CREATE_FIELDS) => {
      const answer = await send("/cases", { fields });
      const id = /^\/cases\/([0-9a-f]{32})$/.exec(answer.location ?? "")?.[1];
      if (answer.status !== 303 || id === undefined) throw new Error(`The create answered ${answer.status}: ${answer.body.slice(-900, -600)}`);
      return id;
    },
    dispose: async () => {
      await miniflare.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
