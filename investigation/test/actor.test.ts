import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as productionToken from "../core/access-token";
import { AccessKeySet, isVerifiedIdentity, verifyAccessToken, type VerifiedIdentity } from "../core/access-token";
import * as productionActor from "../core/actor";
import { isDerivedActor, ownerActorFrom, runnerActorFrom } from "../core/actor";
import { ATTEMPT_ONE } from "./log-fixture";
import {
  certsFor,
  generateSigningKey,
  HEALTH_CLIENT,
  ISSUER,
  NOW_MS,
  NOW_SECONDS,
  OWNER,
  OWNER_EMAIL,
  ownerClaims,
  POLICY,
  serviceClaims,
  signToken,
  type SigningKey
} from "./token-fixture";

/**
 * Actors are derived, never declared. Tokens here are generated, signed and really
 * verified, because a hand-built identity is one of the things this must refuse.
 * The log's half of this, that a look-alike actor cannot write and that nothing in a
 * command can change who an entry names, is in case-log.test.ts.
 */

type ActorModule = typeof productionActor;

const actorVariant = (...edits: SourceEdit[]) => loadVariant<ActorModule>(require.resolve("../core/actor"), edits);

let signing: SigningKey;
let owner: VerifiedIdentity;
let service: VerifiedIdentity;

async function verify(token: string): Promise<VerifiedIdentity> {
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
  const decision = await verifyAccessToken(token, POLICY, keySet, () => NOW_MS);
  if (!decision.ok) throw new Error(`The fixture token was refused: ${decision.refusal}`);
  return decision.identity;
}

before(async () => {
  signing = await generateSigningKey("key-1");
  owner = await verify(await signToken(signing, ownerClaims()));
  service = await verify(await signToken(signing, serviceClaims()));
});

test("positive control: the owner's actor holds what the token verified, and nothing else", () => {
  assert.deepEqual(ownerActorFrom(owner), {
    kind: "owner",
    iss: ISSUER,
    sub: OWNER,
    email: OWNER_EMAIL,
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600
  });
});

const checkRecognized = (module: ActorModule) => {
  const actor = module.ownerActorFrom(owner);
  const runner = module.runnerActorFrom(ATTEMPT_ONE);
  holds("a derived actor is recognized", module.isDerivedActor(actor) && module.isDerivedActor(runner), () => ({ actor, runner }));
  holds("a derived actor cannot be changed afterward", Object.isFrozen(actor) && Object.isFrozen(runner), () => ({ actor, runner }));
};

test("a derived actor is recognized and cannot be changed afterward", () => {
  checkRecognized(productionActor);
  assert.throws(() => {
    (ownerActorFrom(owner) as { email: string }).email = "someone-else@example.org";
  }, TypeError);
});

test("removing the actor's registration or freeze is caught", async () => {
  await assertCaughtBy("the registration", "a derived actor is recognized", () =>
    checkRecognized(actorVariant({ find: "derivedActors.add(actor);", replace: "" }))
  );
  await assertCaughtBy("the freeze", "a derived actor cannot be changed afterward", () =>
    checkRecognized(actorVariant({ find: "Object.freeze(actor);", replace: "" }))
  );
});

const checkServiceHasNoActor = (module: ActorModule) => {
  holds("a health-service identity cannot become an actor", module.ownerActorFrom(service) === null, () => service);
};

test("a health-service identity is really verified, and cannot become an actor", async () => {
  assert.deepEqual(service, { kind: "health-service", issuer: ISSUER, clientId: HEALTH_CLIENT, issuedAt: NOW_SECONDS - 60, expiresAt: NOW_SECONDS + 3600 });
  assert.equal(isVerifiedIdentity(service), true);
  checkServiceHasNoActor(productionActor);
  await assertCaughtBy("the kind check", "a health-service identity cannot become an actor", () =>
    checkServiceHasNoActor(actorVariant({ find: 'if (identity.kind !== "owner")\n        return null;', replace: "" }))
  );
});

/** Everything that looks like the owner's identity and did not come out of verification. */
function lookalikes(): readonly (readonly [string, VerifiedIdentity])[] {
  return [
    ["spelled out", { kind: "owner", issuer: ISSUER, subject: OWNER, email: OWNER_EMAIL, issuedAt: NOW_SECONDS - 60, expiresAt: NOW_SECONDS + 3600 }],
    ["spread from a real one", { ...owner }],
    ["parsed from a real one", JSON.parse(JSON.stringify(owner)) as VerifiedIdentity],
    ["inheriting from a real one", Object.create(owner) as VerifiedIdentity],
    ["frozen like a real one", Object.freeze({ ...owner })]
  ];
}

const checkLookalikes = (module: ActorModule) => {
  for (const [how, identity] of lookalikes()) {
    holds("only an identity that was really verified becomes an actor", module.ownerActorFrom(identity) === null, () => how);
  }
};

test("no identity becomes an actor but one that was really verified", async () => {
  checkLookalikes(productionActor);
  await assertCaughtBy("the verification check", "only an identity that was really verified becomes an actor", () =>
    checkLookalikes(actorVariant({ find: "if (!(0, access_token_1.isVerifiedIdentity)(identity))\n        return null;", replace: "" }))
  );
});

const GOOD_ATTEMPT_IDS = [ATTEMPT_ONE, "0".repeat(32), "f".repeat(32), "0123456789abcdef0123456789abcdef"] as const;
const BAD_ATTEMPT_IDS = [
  "owner",
  "Mallory",
  "attempt-1",
  "",
  " ",
  "a b",
  "a\n",
  `${ATTEMPT_ONE}\n`,
  `\n${ATTEMPT_ONE}`,
  ` ${ATTEMPT_ONE}`,
  ATTEMPT_ONE.toUpperCase(),
  "g".repeat(32),
  "-".repeat(32),
  "a".repeat(31),
  "a".repeat(33),
  "../a",
  "\u00e9".repeat(32),
  7,
  0,
  null,
  undefined,
  true,
  {},
  [ATTEMPT_ONE],
  { attemptId: ATTEMPT_ONE }
] as const;

const checkAttemptIds = (module: ActorModule) => {
  for (const id of BAD_ATTEMPT_IDS) {
    holds("anything not of the generated shape gives no actor, so typed text is refused", module.runnerActorFrom(id) === null, () => id);
  }
  for (const id of GOOD_ATTEMPT_IDS) {
    const actor = module.runnerActorFrom(id);
    holds("an id of the generated shape gives exactly that actor", actor?.kind === "system:runner" && actor.attemptId === id, () => id);
  }
};

test("stated limit: the shape refuses typed text and says nothing of who minted an id, since the hex of a short name fits", () => {
  const hexOfAName = Buffer.from("alice@example.co").toString("hex");
  assert.equal(hexOfAName.length, 32);
  assert.deepEqual(runnerActorFrom(hexOfAName), { kind: "system:runner", attemptId: hexOfAName });
});

test("a runner actor holds an attempt id of the generated shape and nothing else, and typed text is not one", () => {
  checkAttemptIds(productionActor);
  assert.deepEqual(runnerActorFrom(ATTEMPT_ONE), { kind: "system:runner", attemptId: ATTEMPT_ONE });
  assert.equal(runnerActorFrom("owner"), null);
});

const REAL_PATTERN = "const ATTEMPT_ID = /^[0-9a-f]{32}$/;";

for (const [name, find, replace] of [
  ["the old pattern, which could hold a name", REAL_PATTERN, "const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;"],
  ["the pattern's start", REAL_PATTERN, "const ATTEMPT_ID = /[0-9a-f]{32}$/;"],
  ["the pattern's end", REAL_PATTERN, "const ATTEMPT_ID = /^[0-9a-f]{32}/;"],
  ["a shorter length allowed", REAL_PATTERN, "const ATTEMPT_ID = /^[0-9a-f]{31,32}$/;"],
  ["a longer length allowed", REAL_PATTERN, "const ATTEMPT_ID = /^[0-9a-f]{32,33}$/;"],
  ["uppercase allowed", REAL_PATTERN, "const ATTEMPT_ID = /^[0-9a-fA-F]{32}$/;"],
  ["any letter allowed", REAL_PATTERN, "const ATTEMPT_ID = /^[0-9a-z]{32}$/;"],
  ["the type check", 'typeof value === "string" && ATTEMPT_ID.test(value)', "ATTEMPT_ID.test(value)"]
] as const) {
  test(`loosening the attempt id with ${name} is caught`, async () => {
    await assertCaughtBy(name, "anything not of the generated shape gives no actor, so typed text is refused", () => checkAttemptIds(actorVariant({ find, replace })));
  });
}

test("a pattern stricter than the stated shape is caught too", async () => {
  await assertCaughtBy("no digits", "an id of the generated shape gives exactly that actor", () => checkAttemptIds(actorVariant({ find: REAL_PATTERN, replace: "const ATTEMPT_ID = /^[a-f]{32}$/;" })));
});

test("nothing that merely looks like an actor is recognized as one", () => {
  const real = ownerActorFrom(owner);
  for (const lookalike of [
    { ...real },
    JSON.parse(JSON.stringify(real)),
    Object.create(real),
    { kind: "system:runner", attemptId: ATTEMPT_ONE },
    { ...runnerActorFrom(ATTEMPT_ONE) },
    null,
    undefined,
    "owner",
    7
  ]) {
    assert.equal(isDerivedActor(lookalike), false);
  }
});

test("removing identity verification's registration leaves no way to derive the owner", async () => {
  type TokenModule = typeof productionToken;
  const check = async (module: TokenModule) => {
    const keySet = new module.AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
    const decision = await module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, () => NOW_MS);
    holds("a verified identity is registered as verified", decision.ok && module.isVerifiedIdentity(decision.identity), () => decision);
    holds("a verified identity is frozen", decision.ok && Object.isFrozen(decision.identity), () => decision);
  };
  await check(productionToken);
  const variant = (edit: SourceEdit) => loadVariant<TokenModule>(require.resolve("../core/access-token"), [edit]);
  await assertCaughtBy("the registration", "a verified identity is registered as verified", () =>
    check(variant({ find: "verifiedIdentities.add(frozen);", replace: "" }))
  );
  await assertCaughtBy("the freeze", "a verified identity is frozen", () =>
    check(variant({ find: "const frozen = Object.freeze(identity);", replace: "const frozen = identity;" }))
  );
});
