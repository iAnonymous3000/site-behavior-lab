#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../lib/strict-json.ts";
import {
  hostedEvidenceSourceClosureProblems
} from "./hosted-evidence-provenance-lib.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(args) {
  requireValue(
    args.length === 8,
    "source-closure verification requires exactly --root, --context, --profile, and --candidate-commit"
  );
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    requireValue(
      [
        "--root",
        "--context",
        "--profile",
        "--candidate-commit"
      ].includes(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !values.has(key),
      `invalid or duplicate source-closure option ${String(key)}`
    );
    values.set(key, value);
  }
  const rootDir = path.resolve(values.get("--root"));
  const contextPath = path.resolve(values.get("--context"));
  requireValue(
    contextPath.startsWith(`${rootDir}${path.sep}`),
    "hosted source-closure context must stay inside the repository"
  );
  const profile = values.get("--profile");
  requireValue(
    profile === "durable-soak",
    "hosted source-closure verification currently accepts only durable-soak"
  );
  const candidateCommit = values.get("--candidate-commit");
  requireValue(
    FULL_SHA.test(candidateCommit),
    "hosted source-closure candidate must be a full lowercase Git commit"
  );
  return {
    rootDir,
    contextPath,
    profile,
    candidateCommit
  };
}

export function verifyHostedSourceClosure(options) {
  const info = lstatSync(options.contextPath);
  requireValue(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.size > 0 &&
      info.size <= MAX_CONTEXT_BYTES,
    "hosted source-closure context must be a bounded regular file"
  );
  const contextBytes = readFileSync(options.contextPath);
  requireValue(
    contextBytes.byteLength === info.size,
    "hosted source-closure context changed while it was read"
  );
  const context = parseStrictJson(
    contextBytes.toString("utf8"),
    MAX_CONTEXT_BYTES
  );
  requireValue(
    context &&
      typeof context === "object" &&
      !Array.isArray(context) &&
      context.profile === options.profile &&
      Array.isArray(context.sources),
    "hosted source-closure context profile or sources are invalid"
  );
  const problems = hostedEvidenceSourceClosureProblems({
    profile: options.profile,
    candidateCommit: options.candidateCommit,
    sources: context.sources,
    readBlob: (commit, relativePath) => {
      if (
        !FULL_SHA.test(commit) ||
        typeof relativePath !== "string"
      ) {
        return null;
      }
      try {
        return execFileSync(
          "git",
          ["show", `${commit}:${relativePath}`],
          {
            cwd: options.rootDir,
            encoding: "buffer",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 16 * 1024 * 1024
          }
        );
      } catch {
        return null;
      }
    }
  });
  requireValue(
    problems.length === 0,
    problems.join("; ")
  );
  return {
    ok: true,
    profile: options.profile,
    candidateCommit: options.candidateCommit,
    sourceCount: context.sources.length
  };
}

export function main(args = process.argv.slice(2)) {
  const result = verifyHostedSourceClosure(
    parseOptions(args)
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `FAIL ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
