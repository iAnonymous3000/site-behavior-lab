import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as productionToken from "../core/access-token";
import { AccessKeySet, ACCESS_TOKEN_HEADER } from "../core/access-token";
import * as productionConfig from "../core/workspace-config";
import { workspaceConfigFrom, type WorkspaceEnv } from "../core/workspace-config";
import * as productionGate from "../core/workspace-gate";
import type { WorkspaceRoutes } from "../core/workspace-gate";
import {
  AUDIENCE,
  certsFor,
  generateSigningKey,
  HEALTH_AUDIENCE,
  HEALTH_CLIENT,
  ISSUER,
  NOW_MS,
  OWNER,
  OWNER_EMAIL,
  ownerClaims,
  serviceClaims,
  signToken,
  type SigningKey
} from "./token-fixture";

/**
 * The workspace's configuration and the hostname rule. Every required value is held
 * to the same closed table of malformed values, and each guard has a broken variant
 * that a named property catches. All hostnames here are synthetic but one: no DNS
 * record or Access application exists, and these tests show nothing about them.
 */

type ConfigModule = typeof productionConfig;
type GateModule = typeof productionGate;
type TokenModule = typeof productionToken;

const HOSTNAME = "workspace.example";
const ENV: WorkspaceEnv = {
  INVESTIGATION_ACCESS_ISSUER: ISSUER,
  INVESTIGATION_ACCESS_AUDIENCE: AUDIENCE,
  INVESTIGATION_OWNER_SUBJECT: OWNER,
  INVESTIGATION_OWNER_EMAIL: OWNER_EMAIL,
  INVESTIGATION_HEALTH_CLIENT_ID: HEALTH_CLIENT,
  INVESTIGATION_HEALTH_ACCESS_AUDIENCE: HEALTH_AUDIENCE,
  INVESTIGATION_WORKSPACE_HOSTNAME: HOSTNAME
};

const configVariant = (...edits: SourceEdit[]) => loadVariant<ConfigModule>(require.resolve("../core/workspace-config"), edits);
const gateVariant = (...edits: SourceEdit[]) => loadVariant<GateModule>(require.resolve("../core/workspace-gate"), edits);
const tokenVariant = (...edits: SourceEdit[]) => loadVariant<TokenModule>(require.resolve("../core/access-token"), edits);

/** Unusable for any required value. Each entry would be a plausible way for a deployment to drift. */
const UNUSABLE_FOR_ANY_REQUIRED = [undefined, null, "", " ", 7, true, {}, ["a"]] as const;

const REQUIRED_NAMES = [
  "INVESTIGATION_ACCESS_ISSUER",
  "INVESTIGATION_ACCESS_AUDIENCE",
  "INVESTIGATION_OWNER_SUBJECT",
  "INVESTIGATION_OWNER_EMAIL",
  "INVESTIGATION_WORKSPACE_HOSTNAME"
] as const;

const MALFORMED_HOSTNAMES = [
  "localhost",
  "https://workspace.example",
  "workspace.example/",
  "workspace.example/health",
  "workspace.example:443",
  "workspace.example.",
  ".workspace.example",
  "workspace..example",
  "*.workspace.example",
  "WORKSPACE.example",
  "work_space.example",
  "-workspace.example",
  "workspace-.example",
  "127.0.0.1",
  "[::1]",
  "workspace.example\n",
  "wörkspace.example",
  `${"a".repeat(64)}.example`,
  `workspace.${"a".repeat(64)}`,
  "workspace.example-",
  "workspace.1example"
] as const;

const ALIASES = [
  "workers.dev",
  "pages.dev",
  "site-behavior-lab-investigation.example.workers.dev",
  "preview-id-site-behavior-lab-investigation.example.workers.dev",
  "site-behavior-lab-investigation.pages.dev",
  "abc123.site-behavior-lab-investigation.pages.dev"
] as const;

/** Each label is legal and the whole is exactly the DNS limit of 253 characters, the longest a hostname can be. */
const LONGEST_HOSTNAME = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
/** One character over, so only the length bound stands in the way. */
const TOO_LONG_HOSTNAME = `${LONGEST_HOSTNAME.slice(0, -1)}dd`;
/** At the edges of what a label can be, which a stricter pattern would refuse. */
const WELL_FORMED_HOSTNAMES = [LONGEST_HOSTNAME, `${"a".repeat(63)}.example`, `workspace.${"a".repeat(63)}`, "a.b", "a-b.example", "0.example"] as const;

async function checkConfigRefusesMalformed(module: ConfigModule): Promise<void> {
  for (const name of REQUIRED_NAMES) {
    for (const value of UNUSABLE_FOR_ANY_REQUIRED) {
      let answer: unknown;
      try {
        answer = module.workspaceConfigFrom({ ...ENV, [name]: value } as WorkspaceEnv);
      } catch (error) {
        // A throw is a 500 rather than the gate's 503, so it is not the promised answer either.
        answer = error;
      }
      holds("a required value that is missing or unusable gives no configuration", answer === null, () => ({ name, value }));
    }
  }
}

async function checkWellFormed(module: ConfigModule): Promise<void> {
  assert.equal(LONGEST_HOSTNAME.length, 253);
  assert.equal(TOO_LONG_HOSTNAME.length, 254);
  for (const hostname of WELL_FORMED_HOSTNAMES) {
    holds("a well-formed hostname is accepted, at the edges of the rule", module.workspaceConfigFrom({ ...ENV, INVESTIGATION_WORKSPACE_HOSTNAME: hostname })?.hostname === hostname, () => hostname);
  }
}

async function checkHostnames(module: ConfigModule, hostnames: readonly string[], property: string): Promise<void> {
  for (const hostname of hostnames) {
    const config = module.workspaceConfigFrom({ ...ENV, INVESTIGATION_WORKSPACE_HOSTNAME: hostname });
    holds(property, config === null, () => hostname);
  }
}

test("positive control: complete configuration gives exactly the values it was given", () => {
  assert.deepEqual(workspaceConfigFrom(ENV), {
    hostname: HOSTNAME,
    policy: { issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER, ownerEmail: OWNER_EMAIL, healthClientId: HEALTH_CLIENT, healthAudience: HEALTH_AUDIENCE }
  });
});

const checkHealthPair = (module: ConfigModule) => {
  for (const absent of [undefined, ""]) {
    const neither = module.workspaceConfigFrom({ ...ENV, INVESTIGATION_HEALTH_CLIENT_ID: absent, INVESTIGATION_HEALTH_ACCESS_AUDIENCE: absent });
    holds("the health path is optional as a pair", neither?.policy.healthClientId === null && neither.policy.healthAudience === null, () => absent);
    holds("a client id with no health audience gives no configuration", module.workspaceConfigFrom({ ...ENV, INVESTIGATION_HEALTH_ACCESS_AUDIENCE: absent }) === null, () => absent);
    holds("a health audience with no client id gives no configuration", module.workspaceConfigFrom({ ...ENV, INVESTIGATION_HEALTH_CLIENT_ID: absent }) === null, () => absent);
  }
  const equal = module.workspaceConfigFrom({ ...ENV, INVESTIGATION_HEALTH_ACCESS_AUDIENCE: AUDIENCE });
  holds("the owner's and the health audience may be equal", equal?.policy.healthAudience === AUDIENCE, () => equal);
};

test("the health path is optional as a pair: half of it gives no configuration, and equal audiences are allowed", () => {
  checkHealthPair(productionConfig);
  for (const [name, value] of [["INVESTIGATION_HEALTH_CLIENT_ID", "has a space"], ["INVESTIGATION_HEALTH_CLIENT_ID", 7], ["INVESTIGATION_HEALTH_ACCESS_AUDIENCE", "short"], ["INVESTIGATION_HEALTH_ACCESS_AUDIENCE", 7]] as const) {
    assert.equal(workspaceConfigFrom({ ...ENV, [name]: value } as WorkspaceEnv), null, `${name}=${value}`);
  }
});

test("reading the health audience from anywhere but its own variable is caught", async () => {
  await assertCaughtBy("the health audience unread", "the health path is optional as a pair", () =>
    checkHealthPair(configVariant({ find: "healthAudience: env.INVESTIGATION_HEALTH_ACCESS_AUDIENCE", replace: "healthAudience: env.INVESTIGATION_ACCESS_AUDIENCE" }))
  );
});

test("the proposed hostname, whose availability is still being checked, is well formed", () => {
  // Named here and nowhere else. It is a deployment value, not a constant.
  const proposed = "investigate.sitebehavior.org";
  assert.equal(workspaceConfigFrom({ ...ENV, INVESTIGATION_WORKSPACE_HOSTNAME: proposed })?.hostname, proposed);
});

test("no hostname is written into the gate, the Worker or its deployment config", () => {
  for (const file of ["investigation/core/workspace-config.ts", "investigation/core/workspace-gate.ts", "cloudflare/investigation-worker.ts", "wrangler.investigation.jsonc"]) {
    assert.doesNotMatch(readFileSync(path.join(process.cwd(), file), "utf8"), /sitebehavior\.org/, file);
  }
});

test("every required value, missing or unusable, gives no configuration", async () => {
  await checkConfigRefusesMalformed(productionConfig);
});

test("a malformed hostname gives no configuration", async () => {
  await checkHostnames(productionConfig, MALFORMED_HOSTNAMES, "a malformed hostname gives no configuration");
  await checkHostnames(productionConfig, [TOO_LONG_HOSTNAME], "a hostname past the DNS limit gives no configuration");
});

test("a well-formed hostname is accepted, at the edges of the rule", async () => {
  await checkWellFormed(productionConfig);
});

for (const [name, find, replace] of [
  ["a shorter length bound", "const MAX_HOSTNAME_CHARS = 253;", "const MAX_HOSTNAME_CHARS = 252;"],
  ["the length bound's edge", "value.length > MAX_HOSTNAME_CHARS", "value.length >= MAX_HOSTNAME_CHARS"],
  ["a shorter label", "/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+", "/^(?:[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?\\.)+"],
  ["a shorter last label", "+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;", "+[a-z](?:[a-z0-9-]{0,60}[a-z0-9])?$/;"]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, "a well-formed hostname is accepted, at the edges of the rule", () => checkWellFormed(configVariant({ find, replace })));
  });
}

for (const [name, property, find, replace, hostnames] of [
  ["a higher length bound", "a hostname past the DNS limit gives no configuration", "const MAX_HOSTNAME_CHARS = 253;", "const MAX_HOSTNAME_CHARS = 254;", [TOO_LONG_HOSTNAME]],
  ["a last label that may end in a hyphen", "a malformed hostname gives no configuration", "+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;", "+[a-z][a-z0-9-]{0,62}$/;", MALFORMED_HOSTNAMES],
  ["an unbounded last label", "a malformed hostname gives no configuration", "+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;", "+[a-z](?:[a-z0-9-]*[a-z0-9])?$/;", MALFORMED_HOSTNAMES],
  ["a last label that may start with a digit", "a malformed hostname gives no configuration", "+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;", "+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;", MALFORMED_HOSTNAMES],
  ["an unbounded label", "a malformed hostname gives no configuration", "/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+", "/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+", MALFORMED_HOSTNAMES]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkHostnames(configVariant({ find, replace }), hostnames, property));
  });
}

test("a platform alias cannot be configured as the workspace's hostname", async () => {
  await checkHostnames(productionConfig, ALIASES, "a platform alias gives no configuration");
});

const checkFrozen = (module: ConfigModule) => {
  const config = module.workspaceConfigFrom(ENV);
  holds("the configuration is frozen at every level", config !== null && Object.isFrozen(config) && Object.isFrozen(config.policy), () => config);
};

test("the configuration is frozen at both levels", () => {
  checkFrozen(productionConfig);
  const config = workspaceConfigFrom(ENV) as NonNullable<ReturnType<typeof workspaceConfigFrom>>;
  assert.throws(() => {
    (config as { hostname: string }).hostname = "attacker.example";
  }, TypeError);
  assert.throws(() => {
    (config.policy as { ownerEmail: string }).ownerEmail = "attacker@example.org";
  }, TypeError);
});

for (const [name, property, edits, check] of [
  [
    "the policy check",
    "a required value that is missing or unusable gives no configuration",
    [{ find: "if (policy === null)\n        return null;", replace: "" }],
    checkConfigRefusesMalformed
  ],
  [
    "the hostname check",
    "a required value that is missing or unusable gives no configuration",
    [{ find: "if (!isWorkspaceHostname(hostname))\n        return null;", replace: "" }],
    checkConfigRefusesMalformed
  ],
  [
    "the hostname's type check",
    "a required value that is missing or unusable gives no configuration",
    [{ find: 'typeof value !== "string" || ', replace: "" }],
    checkConfigRefusesMalformed
  ],
  [
    "the hostname pattern",
    "a malformed hostname gives no configuration",
    [{ find: "!HOSTNAME.test(value)", replace: "false" }],
    (module: ConfigModule) => checkHostnames(module, MALFORMED_HOSTNAMES, "a malformed hostname gives no configuration")
  ],
  [
    "the hostname's length bound",
    "a hostname past the DNS limit gives no configuration",
    [{ find: "value.length > MAX_HOSTNAME_CHARS || ", replace: "" }],
    (module: ConfigModule) => checkHostnames(module, [TOO_LONG_HOSTNAME], "a hostname past the DNS limit gives no configuration")
  ],
  [
    "the alias rule",
    "a platform alias gives no configuration",
    [{ find: "return !ALIAS_SUFFIXES.some((suffix) => `.${value}`.endsWith(suffix));", replace: "return true;" }],
    (module: ConfigModule) => checkHostnames(module, ALIASES, "a platform alias gives no configuration")
  ],
  [
    "the outer freeze",
    "the configuration is frozen at every level",
    [{ find: "return Object.freeze({ policy, hostname });", replace: "return { policy, hostname };" }],
    checkFrozen
  ]
] as const) {
  test(`removing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => check(configVariant(...edits)));
  });
}

test("removing the policy's freeze or its owner email requirement is caught", async () => {
  const checkPolicy = (module: TokenModule) => {
    const noHealth = { issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER, ownerEmail: OWNER_EMAIL };
    for (const values of [noHealth, { ...noHealth, healthClientId: HEALTH_CLIENT, healthAudience: HEALTH_AUDIENCE }]) {
      const policy = module.accessPolicyFrom(values);
      holds("a policy is frozen", policy !== null && Object.isFrozen(policy), () => policy);
    }
    holds("a policy needs the owner's email", module.accessPolicyFrom({ issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER }) === null, () => "no email");
  };
  checkPolicy(productionToken);
  await assertCaughtBy("the freeze with no health path", "a policy is frozen", () =>
    checkPolicy(tokenVariant({ find: "return Object.freeze({ issuer, audience, ownerSubject, ownerEmail, healthClientId: null, healthAudience: null });", replace: "return { issuer, audience, ownerSubject, ownerEmail, healthClientId: null, healthAudience: null };" }))
  );
  await assertCaughtBy("the freeze with a health path", "a policy is frozen", () =>
    checkPolicy(tokenVariant({ find: "return Object.freeze({ issuer, audience, ownerSubject, ownerEmail, healthClientId, healthAudience });", replace: "return { issuer, audience, ownerSubject, ownerEmail, healthClientId, healthAudience };" }))
  );
  await assertCaughtBy("the email requirement", "a policy needs the owner's email", () =>
    checkPolicy(tokenVariant({ find: 'if (typeof ownerEmail !== "string" || !OWNER_EMAIL.test(ownerEmail))\n        return null;', replace: "" }))
  );
});

let signing: SigningKey;
let ownerToken: string;
let serviceToken: string;

before(async () => {
  signing = await generateSigningKey("key-1");
  ownerToken = await signToken(signing, ownerClaims());
  serviceToken = await signToken(signing, serviceClaims());
});

type Answer = Readonly<{ status: number; body: string; headers: readonly (readonly [string, string])[]; keyFetches: number; routeReached: boolean }>;

async function answerFor(module: GateModule, url: string, token: string | null): Promise<Answer> {
  const certs = certsFor(signing);
  let routeReached = false;
  const routes: WorkspaceRoutes = () => {
    routeReached = true;
    return new Response("reached");
  };
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => NOW_MS);
  const response = await module.handleWorkspaceRequest(
    new Request(url, token === null ? {} : { headers: { [ACCESS_TOKEN_HEADER]: token } }),
    ENV,
    { keySetFor: () => keySet, now: () => NOW_MS, routes }
  );
  return { status: response.status, body: await response.text(), headers: [...response.headers.entries()].sort(), keyFetches: certs.calls(), routeReached };
}

/** Other hosts, each with a genuine token, by every spelling that could be mistaken for the configured one. */
const OTHER_ORIGINS = [
  "https://site-behavior-lab-investigation.example.workers.dev",
  "https://abc123-site-behavior-lab-investigation.example.workers.dev",
  "https://attacker.example",
  `https://${HOSTNAME}.attacker.example`,
  `https://attacker.${HOSTNAME}`,
  `https://attacker${HOSTNAME}`,
  `https://${HOSTNAME}.`,
  `https://${HOSTNAME}:8443`,
  `http://${HOSTNAME}`,
  `http://${HOSTNAME}:443`
] as const;

async function checkAliasesRefused(module: GateModule): Promise<void> {
  const noToken = await answerFor(module, `https://${HOSTNAME}/health`, null);
  for (const origin of OTHER_ORIGINS) {
    for (const [who, token] of [["the owner", ownerToken], ["the health service", serviceToken], ["no one", null]] as const) {
      const answer = await answerFor(module, `${origin}/health`, token);
      const input = () => ({ origin, who, answer });
      holds("another host reaches no route, whatever token it holds", !answer.routeReached && answer.status !== 200, input);
      holds("another host fetches no key, so nothing about the token can show", answer.keyFetches === 0, input);
      holds(
        "another host answers exactly as a request with no token does",
        answer.status === noToken.status && answer.body === noToken.body && JSON.stringify(answer.headers) === JSON.stringify(noToken.headers),
        input
      );
    }
  }
}

test("positive control: the configured host admits the owner, however a client cases it", async () => {
  for (const url of [`https://${HOSTNAME}/health`, "https://WORKSPACE.EXAMPLE/health", `https://${HOSTNAME}:443/health`]) {
    const answer = await answerFor(productionGate, url, ownerToken);
    assert.equal(answer.status, 200, url);
    assert.equal(answer.routeReached, true, url);
  }
});

test("any other host is refused with a genuine token, and learns nothing", async () => {
  await checkAliasesRefused(productionGate);
});

const HOST_CHECK = 'if (protocol !== "https:" || host !== config.hostname)\n        return refusalResponse(401);';

for (const [name, property, edits] of [
  ["the host check", "another host reaches no route, whatever token it holds", [{ find: HOST_CHECK, replace: "" }]],
  ["the rule that it is https", "another host reaches no route, whatever token it holds", [{ find: 'protocol !== "https:" || ', replace: "" }]],
  ["the port in the host comparison", "another host reaches no route, whatever token it holds", [{ find: "host !== config.hostname", replace: "new URL(request.url).hostname !== config.hostname" }]],
  ["the exact host comparison", "another host reaches no route, whatever token it holds", [{ find: "host !== config.hostname", replace: "!host.endsWith(config.hostname)" }]],
  [
    "the host check coming first",
    "another host fetches no key, so nothing about the token can show",
    [
      { find: HOST_CHECK, replace: "" },
      {
        find: 'return refusalResponse(decision.refusal === "keys-unavailable" ? 503 : 401);',
        replace: 'return refusalResponse(decision.refusal === "keys-unavailable" ? 503 : 401);\n    if (protocol !== "https:" || host !== config.hostname)\n        return refusalResponse(401);'
      }
    ]
  ],
  ["the uniform status", "another host answers exactly as a request with no token does", [{ find: HOST_CHECK, replace: 'if (protocol !== "https:" || host !== config.hostname)\n        return refusalResponse(403);' }]]
] as const) {
  test(`removing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkAliasesRefused(gateVariant(...edits)));
  });
}

test("configuration is read before the host, so nothing is compared with a missing value", async () => {
  const certs = certsFor(signing);
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => NOW_MS);
  const runtime = { keySetFor: () => keySet, now: () => NOW_MS };
  const noHostname = { ...ENV, INVESTIGATION_WORKSPACE_HOSTNAME: undefined };
  for (const url of [`https://${HOSTNAME}/health`, "https://attacker.example/health"]) {
    const response = await productionGate.handleWorkspaceRequest(new Request(url, { headers: { [ACCESS_TOKEN_HEADER]: ownerToken } }), noHostname, runtime);
    assert.equal(response.status, 503, url);
    assert.deepEqual(await response.json(), { error: "unavailable" });
  }
  assert.equal(certs.calls(), 0);
});
