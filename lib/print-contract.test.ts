import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * A printed report is the one surface where our sentences reach a reader who
 * cannot click through to a correction. These assertions pin what the paper
 * says and, just as importantly, that only one file says it.
 */

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

const FOOTER_COMPONENT = "app/_components/print-evidence-footer.tsx";

test("the printed footer states that the print is a rendering and carries the wire digest", () => {
  const footer = source(FOOTER_COMPONENT);

  assert.ok(
    footer.includes(
      "Printed copy of {reportUrl}. This print is a rendering, not the evidence; the JSON wire is"
    ),
    "the print must disclaim being the evidence"
  );
  assert.ok(
    footer.includes("canonical. Exact evidence bytes: SHA-256 <code>{wireSha256}</code>."),
    "the print must carry the digest of the bytes it renders"
  );
});

test("only committed reports are told they have an external chain", () => {
  const footer = source(FOOTER_COMPONENT);

  assert.ok(
    footer.includes("<code>npm run verify:report -- {id}</code> to check the bytes this site serves"),
    "committed reports name the verification command and what it checks"
  );
  // The command defaults to fetching from the live site, so a reader holding
  // saved bytes needs the other form named. Without it the printed
  // instruction reads as an offline check that it is not.
  assert.ok(
    footer.includes("<code>--from &lt;dir&gt;</code> to check a copy you saved yourself"),
    "the printed instruction must name the form that checks the reader's own copy"
  );
  assert.ok(
    footer.includes("sitebehavior.org/transparency-log.json."),
    "committed reports name the transparency log"
  );

  // A time-limited share has no external anchor, so it must claim none: no
  // verification command and no log reference, only the instruction to keep
  // the bytes. Splitting on the ternary keeps this honest as the copy evolves.
  const shareBranch = footer.slice(footer.indexOf(") : ("));
  assert.ok(shareBranch.length > 0, "the footer must branch on committed vs share");
  assert.ok(
    shareBranch.includes("This report is a time-limited share and expires on its retention schedule."),
    "a share must say it expires"
  );
  assert.ok(
    shareBranch.includes("save the JSON evidence and its digest now"),
    "a share must tell the reader to keep the bytes"
  );
  assert.doesNotMatch(
    shareBranch,
    /verify:report|transparency-log/,
    "a share must not point at a verifier it cannot honour"
  );
});

test("the verification command printed on paper names a real package script", () => {
  const footer = source(FOOTER_COMPONENT);
  const printed = /<code>npm run ([\w:-]+) -- \{id\}<\/code>/.exec(footer);
  assert.ok(printed, "the footer must print an npm script instruction");

  const manifest = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  assert.ok(
    manifest.scripts?.[printed[1]],
    `package.json must define the ${printed[1]} script the printed footer instructs readers to run`
  );
});

test("report routes render the shared footer instead of restating it", () => {
  const page = source("app/reports/[id]/page.tsx");

  assert.match(page, /<PrintEvidenceFooter\b/, "the report route renders the shared component");
  assert.doesNotMatch(
    page,
    /<footer className="print-evidence-footer">/,
    "the footer markup must live in exactly one component"
  );
});
