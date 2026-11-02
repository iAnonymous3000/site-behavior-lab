// The one place an id for a case or an attempt comes from: 128 random bits from
// WebCrypto, in lowercase hex. Both are the same 32 digits, which case-log.ts accepts as a
// case id and actor.ts as an attempt id. investigation/test/ids.test.ts refuses any other
// source of randomness in the Worker's side, so nothing here is duplicated elsewhere.
//
// Uniqueness per store is what the log's note on case ids asks of whatever mints them.
// Given a working random source, two ids of this size do not meet. createLog still refuses
// a head that exists, so a collision or a replay cannot start a second log over the first.

const ID_BYTES = 16;

function mintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function mintCaseId(): string {
  return mintId();
}

export function mintAttemptId(): string {
  return mintId();
}
