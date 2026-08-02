import { createHash } from "node:crypto";

export const CONTROLLED_RUNNER_IDENTITY_REF_PATTERN =
  /^sha256:[0-9a-f]{64}$/;

const MAX_RAW_IDENTITY_BYTES = 512;
const IDENTITY_DOMAINS = Object.freeze({
  "runner-label": "runner-label\u0000",
  "host-image": "runner-host-image\u0000",
  "nat-identity": "runner-nat-identity\u0000"
});

function canonicalPrivateIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAX_RAW_IDENTITY_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function identityRef(kind, value) {
  if (!Object.hasOwn(IDENTITY_DOMAINS, kind)) {
    throw new Error("controlled runner identity kind is not supported");
  }
  if (!canonicalPrivateIdentity(value)) {
    throw new Error(
      "controlled runner identity must be a bounded private identifier"
    );
  }
  return `sha256:${createHash("sha256")
    .update(`${IDENTITY_DOMAINS[kind]}${value}`)
    .digest("hex")}`;
}

export function runnerLabelRef(value) {
  return identityRef("runner-label", value);
}

export function runnerHostImageIdentityRef(value) {
  return identityRef("host-image", value);
}

export function runnerNatIdentityRef(value) {
  return identityRef("nat-identity", value);
}
