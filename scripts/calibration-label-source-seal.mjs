#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  calibrationLabelPublicKeyIdentity,
  sealCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const publicKeyPem = readFileSync(options.publicKey, "utf8");
const publicKey = calibrationLabelPublicKeyIdentity(publicKeyPem);
const sealed = sealCalibrationLabelSourceEnvelope({
  schemaVersion: 1,
  artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  studyId: options.studyId,
  detector: options.detector,
  role: options.role,
  candidateCommit: options.candidateCommit,
  reviewerLogin: options.actor,
  algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
  keyId: publicKey.keyId,
  publicKeyPem,
  plaintext: readFileSync(options.input)
});
mkdirSync(path.dirname(options.output), { recursive: true, mode: 0o700 });
writeFileSync(options.output, sealed.text, { flag: "wx", mode: 0o600 });
console.log(
  `Sealed ${options.role} calibration source for ${options.studyId}; plaintext was not copied.`
);

function parseOptions(args) {
  const allowed = new Set([
    "--study-id",
    "--detector",
    "--role",
    "--actor",
    "--candidate-commit",
    "--public-key",
    "--input",
    "--output"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !allowed.has(name) ||
      !value ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        `Invalid calibration label source argument ${name ?? "(missing)"}`
      );
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  const actor = values.get("--actor").toLowerCase();
  if (
    !path.isAbsolute(values.get("--input")) ||
    !path.isAbsolute(values.get("--output")) ||
    !path.isAbsolute(values.get("--public-key")) ||
    !/^[0-9a-f]{40}$/.test(values.get("--candidate-commit")) ||
    !/^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(actor) ||
    !["labeler", "tiebreaker"].includes(values.get("--role"))
  ) {
    throw new Error("calibration label source seal arguments are malformed");
  }
  return {
    studyId: values.get("--study-id"),
    detector: values.get("--detector"),
    role: values.get("--role"),
    actor,
    candidateCommit: values.get("--candidate-commit"),
    publicKey: values.get("--public-key"),
    input: values.get("--input"),
    output: values.get("--output")
  };
}
