import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from "node:crypto";
import {
  canonicalPrettyJson,
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  parseStrictJsonBuffer,
  sha256Hex
} from "./calibration-study-lib.mjs";

export const CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND =
  "site-behavior-detector-calibration-label-source-envelope";
export { CALIBRATION_LABEL_SEALING_ALGORITHM };

const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LOGIN = /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/;

export function calibrationLabelPublicKeyIdentity(publicKeyPem) {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("calibration label sealing public key is invalid");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("calibration label sealing public key must be RSA");
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < 2048) {
    throw new Error(
      "calibration label sealing RSA key must be at least 2048 bits"
    );
  }
  const publicKeyDer = key.export({ type: "spki", format: "der" });
  return {
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: sha256Hex(publicKeyDer),
    publicKeyPem: key.export({ type: "spki", format: "pem" }).toString()
  };
}

export function sealCalibrationLabelSourceEnvelope(input) {
  const identity = validateIdentity(input);
  const publicKey = calibrationLabelPublicKeyIdentity(input.publicKeyPem);
  if (publicKey.keyId !== identity.keyId) {
    throw new Error(
      "calibration label source envelope keyId does not match the public key"
    );
  }
  const parsed = parseStrictJsonBuffer(
    Buffer.isBuffer(input.plaintext)
      ? input.plaintext
      : Buffer.from(input.plaintext),
    "calibration label source plaintext",
    MAX_PLAINTEXT_BYTES
  );
  if (parsed.text !== canonicalPrettyJson(parsed.value)) {
    throw new Error(
      "calibration label source plaintext must be canonical serialized JSON"
    );
  }
  const dataKey = input.dataKey ?? randomBytes(AES_KEY_BYTES);
  const iv = input.iv ?? randomBytes(IV_BYTES);
  if (!Buffer.isBuffer(dataKey) || dataKey.byteLength !== AES_KEY_BYTES) {
    throw new Error("calibration label source data key must be 32 bytes");
  }
  if (!Buffer.isBuffer(iv) || iv.byteLength !== IV_BYTES) {
    throw new Error("calibration label source IV must be exactly 12 bytes");
  }
  const cipher = createCipheriv(AES_ALGORITHM, dataKey, iv);
  cipher.setAAD(Buffer.from(canonicalPrettyJson(identity)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(parsed.text)),
    cipher.final()
  ]);
  const envelope = {
    ...identity,
    encryptedKey: canonicalBase64(
      publicEncrypt(
        {
          key: publicKey.publicKeyPem,
          oaepHash: "sha256",
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING
        },
        dataKey
      )
    ),
    iv: canonicalBase64(iv),
    ciphertext: canonicalBase64(ciphertext),
    authTag: canonicalBase64(cipher.getAuthTag())
  };
  return {
    envelope,
    text: canonicalPrettyJson(envelope),
    commitmentSha256: sha256Hex(canonicalPrettyJson(envelope))
  };
}

export function validateCalibrationLabelSourceEnvelope(
  value,
  expectedIdentity
) {
  requireRecord(value, "calibration label source envelope");
  const keys = [
    "schemaVersion",
    "artifactKind",
    "studyId",
    "detector",
    "role",
    "candidateCommit",
    "reviewerLogin",
    "algorithm",
    "keyId",
    "encryptedKey",
    "iv",
    "ciphertext",
    "authTag"
  ];
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    throw new Error(
      `calibration label source envelope must contain exactly ${keys.join(", ")}`
    );
  }
  const identity = validateIdentity(value);
  const expected = validateIdentity(expectedIdentity);
  if (canonicalPrettyJson(identity) !== canonicalPrettyJson(expected)) {
    throw new Error(
      "calibration label source envelope identity does not match the authenticated dispatch"
    );
  }
  decodeCanonicalBase64(
    value.encryptedKey,
    null,
    "calibration label encrypted data key"
  );
  decodeCanonicalBase64(
    value.iv,
    IV_BYTES,
    "calibration label source IV"
  );
  const ciphertext = decodeCanonicalBase64(
    value.ciphertext,
    null,
    "calibration label source ciphertext"
  );
  decodeCanonicalBase64(
    value.authTag,
    TAG_BYTES,
    "calibration label source authentication tag"
  );
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("calibration label source ciphertext is outside bounds");
  }
  return value;
}

/**
 * The ciphertext commitment digest, in its ONE home. Roster uniqueness,
 * reveal uniqueness, and the authenticated-commitment projection all state
 * "this exact ciphertext" through this function; a restated formula is how
 * two sites drift apart while both stay green.
 */
export function calibrationCommitmentCiphertextSha256(envelope) {
  return sha256Hex(
    [envelope.encryptedKey, envelope.iv, envelope.ciphertext, envelope.authTag].join("\u0000")
  );
}

/**
 * The 9-field envelope identity in the exact key order the validator pins
 * (the AAD is canonicalPrettyJson of this object, so insertion order is
 * load-bearing). New code builds identities only through this; the frozen
 * v3 restatements inside calibration-study-lib.mjs (validateIdentity
 * callers) deliberately stay untouched and are not additional homes for
 * NEW writers.
 */
export function buildCalibrationLabelEnvelopeIdentity({
  studyId,
  detector,
  role,
  candidateCommit,
  reviewerLogin,
  keyId
}) {
  return {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId,
    detector,
    role,
    candidateCommit,
    reviewerLogin,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId
  };
}

export function openCalibrationLabelSourceEnvelope(
  value,
  privateKeyPem,
  expectedIdentity
) {
  const envelope = validateCalibrationLabelSourceEnvelope(
    value,
    expectedIdentity
  );
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("calibration label reveal private key is invalid");
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("calibration label reveal private key must be RSA");
  }
  const derivedPublic = calibrationLabelPublicKeyIdentity(
    createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString()
  );
  if (derivedPublic.keyId !== envelope.keyId) {
    throw new Error(
      "calibration label reveal private key does not match the candidate-pinned public key"
    );
  }
  let dataKey;
  try {
    dataKey = privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING
      },
      decodeCanonicalBase64(
        envelope.encryptedKey,
        null,
        "calibration label encrypted data key"
      )
    );
  } catch {
    throw new Error(
      "calibration label encrypted data key could not be revealed"
    );
  }
  if (dataKey.byteLength !== AES_KEY_BYTES) {
    throw new Error("calibration label revealed data key is invalid");
  }
  const decipher = createDecipheriv(
    AES_ALGORITHM,
    dataKey,
    decodeCanonicalBase64(
      envelope.iv,
      IV_BYTES,
      "calibration label source IV"
    )
  );
  decipher.setAAD(
    Buffer.from(canonicalPrettyJson(validateIdentity(envelope)))
  );
  decipher.setAuthTag(
    decodeCanonicalBase64(
      envelope.authTag,
      TAG_BYTES,
      "calibration label source authentication tag"
    )
  );
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(
        decodeCanonicalBase64(
          envelope.ciphertext,
          null,
          "calibration label source ciphertext"
        )
      ),
      decipher.final()
    ]);
  } catch {
    throw new Error(
      "calibration label source envelope authentication failed"
    );
  }
  const parsed = parseStrictJsonBuffer(
    plaintext,
    "calibration label source plaintext",
    MAX_PLAINTEXT_BYTES
  );
  if (parsed.text !== canonicalPrettyJson(parsed.value)) {
    throw new Error(
      "calibration label source plaintext must be canonical serialized JSON"
    );
  }
  return parsed;
}

function validateIdentity(value) {
  requireRecord(value, "calibration label source identity");
  if (
    value.schemaVersion !== 1 ||
    value.artifactKind !== CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND ||
    typeof value.studyId !== "string" ||
    !TOKEN.test(value.studyId) ||
    typeof value.detector !== "string" ||
    !TOKEN.test(value.detector) ||
    (value.role !== "labeler" && value.role !== "tiebreaker") ||
    typeof value.candidateCommit !== "string" ||
    !FULL_SHA.test(value.candidateCommit) ||
    typeof value.reviewerLogin !== "string" ||
    !LOGIN.test(value.reviewerLogin) ||
    value.algorithm !== CALIBRATION_LABEL_SEALING_ALGORITHM ||
    typeof value.keyId !== "string" ||
    !SHA256.test(value.keyId)
  ) {
    throw new Error("calibration label source envelope identity is invalid");
  }
  return {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: value.studyId,
    detector: value.detector,
    role: value.role,
    candidateCommit: value.candidateCommit,
    reviewerLogin: value.reviewerLogin,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: value.keyId
  };
}

function decodeCanonicalBase64(value, expectedBytes, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 48 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedBytes !== null && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error(
      expectedBytes === null
        ? `${label} must be canonical base64`
        : `${label} must decode to exactly ${expectedBytes} bytes`
    );
  }
  return decoded;
}

function canonicalBase64(value) {
  return Buffer.from(value).toString("base64");
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}
