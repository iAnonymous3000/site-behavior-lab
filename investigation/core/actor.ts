// Who a case log entry says acted.
//
// An actor is derived, never declared. The owner's comes from an identity that
// verifyAccessToken produced in this isolate, and holds what that token verified. A
// health-service identity cannot become an actor. No function here or in the log takes a
// name, so nothing a person types can reach an entry's attribution.
//
// The runner's actor holds an attempt id of a generated shape: 32 lowercase hex digits.
// The shape refuses typed text, and that is all it does: the hex of a short name fits it.
// NOTHING YET PROVES WHO MINTED AN ID OR WHO CALLS runnerActorFrom. Any code in this isolate
// can claim system:runner with an id of that shape, and an entry saying so means only that.
// The per-attempt credential that binds the claim to a real attempt arrives with the
// runner, at a later batch.
//
// Both kinds are plain frozen data, the same bytes an entry holds. What makes one an
// actor is membership of the set below, which only these two functions add to, so
// a copy, a parsed entry's actor, or an object spelled to look like one is refused
// by the log. Runtime membership cannot cross an isolate: see the note at the top of
// case-log.ts on what a Durable Object must do.

import { isVerifiedIdentity, type VerifiedIdentity } from "./access-token";

export type OwnerActor = Readonly<{ kind: "owner"; iss: string; sub: string; email: string; iat: number; exp: number }>;
export type RunnerActor = Readonly<{ kind: "system:runner"; attemptId: string }>;
export type Actor = OwnerActor | RunnerActor;

const ATTEMPT_ID = /^[0-9a-f]{32}$/;

const derivedActors = new WeakSet<Actor>();

function derive<T extends Actor>(actor: T): T {
  Object.freeze(actor);
  derivedActors.add(actor);
  return actor;
}

/** The owner's actor, or null for anything else: a service token's identity, or an object that did not come out of verification. */
export function ownerActorFrom(identity: VerifiedIdentity): OwnerActor | null {
  if (identity.kind !== "owner") return null;
  if (!isVerifiedIdentity(identity)) return null;
  return derive({
    kind: "owner",
    iss: identity.issuer,
    sub: identity.subject,
    email: identity.email,
    iat: identity.issuedAt,
    exp: identity.expiresAt
  });
}

export function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && ATTEMPT_ID.test(value);
}

/** The runner's actor for one attempt, or null when the id is not well formed. */
export function runnerActorFrom(attemptId: unknown): RunnerActor | null {
  if (!isAttemptId(attemptId)) return null;
  return derive({ kind: "system:runner", attemptId });
}

/** Whether this exact object came from one of the two functions above. */
export function isDerivedActor(actor: unknown): actor is Actor {
  return derivedActors.has(actor as Actor);
}
