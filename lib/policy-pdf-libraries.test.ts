import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DETECTOR_VERSIONS } from "./measurement-kernel";

// The privacy-policy detector fetches a direct PDF policy with undici, through
// the scan proxy (lib/scanner.ts), and reads it with pdf.js (lib/policy-pdf.ts),
// both inside the measurement, so either library's version is an input of what
// the detector reports. Each detector version is listed with the versions it
// reads with, the ones the lock resolved while it was current. A row is never
// edited after its version lands: moving either library is a new detector
// version, declared as a detector epoch, and a new row.
const reviewedPolicyPdfLibraries: Readonly<Record<string, { "pdfjs-dist": string; undici: string }>> = {
  // node-detectors-v12 (6e37fe8a) moved pdf.js from 6.2.108 and undici from
  // 7.29.1 together and declared the move as this version.
  "policy-text-cross-check@8": { "pdfjs-dist": "6.3.289", undici: "8.11.2" },
  // node-detectors-v13 (d64612b9) and v14 (ac89fc6b) changed which policy page
  // the reader accepts, not either library.
  "policy-text-cross-check@9": { "pdfjs-dist": "6.3.289", undici: "8.11.2" },
  "policy-text-cross-check@10": { "pdfjs-dist": "6.3.289", undici: "8.11.2" },
  // node-detectors-v18 changed how a privacy hub's prose is measured, not
  // either library.
  "policy-text-cross-check@11": { "pdfjs-dist": "6.3.289", undici: "8.11.2" },
  // node-detectors-v19 withholds an HTML read cut short, as a PDF whose text
  // runs past the cap already was, and moved neither library.
  "policy-text-cross-check@12": { "pdfjs-dist": "6.3.289", undici: "8.11.2" }
};

test("pdf.js and undici move only with the privacy-policy detector's version", () => {
  const detector = DETECTOR_VERSIONS["privacy-policy"];
  const reviewed = reviewedPolicyPdfLibraries[detector];
  assert.ok(reviewed, `${detector} needs a row naming the pdfjs-dist and undici versions it reads with`);

  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  for (const name of ["pdfjs-dist", "undici"] as const) {
    assert.equal(
      packageLock.packages?.[""]?.dependencies?.[name],
      packageJson.dependencies?.[name],
      `package-lock.json was not resolved from package.json's ${name} declaration`
    );
    // package.json declares pdfjs-dist as a range, so a regenerated lock can
    // move it without touching the manifest. The lock decides what npm ci
    // installs for the scanner.
    const resolved = packageLock.packages?.[`node_modules/${name}`]?.version;
    assert.equal(
      resolved,
      reviewed[name],
      `package-lock.json resolves ${name} ${resolved}, but ${detector} reads with ${reviewed[name]}. ` +
        `${name} is an input of the privacy-policy detector, so it moves only in a detector epoch: a new ` +
        "policy-text-cross-check version and DETECTOR_REGISTRY_VERSION in lib/measurement-kernel.ts, their " +
        "producer-contract rows and CHANGELOG entry, and a new row here, as node-detectors-v12 moved both " +
        "libraries for policy-text-cross-check@8."
    );
  }
});
