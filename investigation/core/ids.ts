// The one place an id for a case or an attempt comes from: 128 random bits from
// WebCrypto, in lowercase hex. Both are the same 32 digits, which case-log.ts accepts as a
// case id and actor.ts as an attempt id. investigation/test/ids.test.ts refuses any other
// source of randomness in the Worker's side, so nothing here is duplicated elsewhere.
//
// A runner's token comes from here too, for the same reason: two draws of sixteen bytes, so
// 256 random bits from the same source, as 64 lowercase hex digits. case-runner.ts keeps only
// its SHA-256 digest and hands the token over once.
//
// Uniqueness per store is what the log's note on case ids asks of whatever mints them.
// Given a working random source, two ids of this size do not meet. createLog still refuses
// a head that exists, so a collision or a replay cannot start a second log over the first.

const ID_BYTES = 16;

/** A token is this many draws of ID_BYTES, so 32 bytes in all. */
const TOKEN_DRAWS = 2;

/** This many draws of ID_BYTES from WebCrypto, one after another, in lowercase hex. */
function mintHex(draws: number): string {
  let hex = "";
  for (let draw = 0; draw < draws; draw += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function mintId(): string {
  return mintHex(1);
}

export function mintCaseId(): string {
  return mintId();
}

export function mintAttemptId(): string {
  return mintId();
}

/** A runner's token for one attempt: 32 bytes from WebCrypto, as 64 lowercase hex digits. */
export function mintRunnerToken(): string {
  return mintHex(TOKEN_DRAWS);
}
