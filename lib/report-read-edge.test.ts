import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  PUBLIC_REPORT_READ_ALLOW_HEADER,
  REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_RATE_LIMIT_PER_MINUTE,
  parsePublicReportReadPath,
  refusePublicReportRouteMethod
} from "./report-read-edge";

const REPORT_ID = `20260721-${"a".repeat(32)}`;

/**
 * A marker lookup that answers -1 makes every slice and ordering assertion
 * below vacuous (`-1 < anything` is true, `slice(-1, ...)` widens to the whole
 * file). Fail on the missing marker instead, naming it.
 */
function requireIndex(source: string, marker: string): number {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `container-worker.ts no longer contains ${JSON.stringify(marker)}; update this marker`);
  return index;
}

test("the edge recognizes every storage/rendering report representation with the canonical id", () => {
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}`), {
    reportId: REPORT_ID,
    resource: "page"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/`), {
    reportId: REPORT_ID,
    resource: "page"
  });
  assert.deepEqual(parsePublicReportReadPath("HEAD", `/reports/${REPORT_ID}/opengraph-image`), {
    reportId: REPORT_ID,
    resource: "opengraph-image"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/twitter-image/`), {
    reportId: REPORT_ID,
    resource: "twitter-image"
  });
  // The printable rendering is the heaviest representation: the complete
  // evidence, server-rendered eagerly. It landed after the parser did and was
  // forwarded uncharged until this case existed.
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/print`), {
    reportId: REPORT_ID,
    resource: "print"
  });
  assert.deepEqual(parsePublicReportReadPath("HEAD", `/reports/${REPORT_ID}/print/`), {
    reportId: REPORT_ID,
    resource: "print"
  });
  assert.deepEqual(
    parsePublicReportReadPath(
      "GET",
      `/%72eports/${REPORT_ID.slice(0, -1)}%61/%6fpengraph-image`
    ),
    { reportId: REPORT_ID, resource: "opengraph-image" },
    "percent-encoded route segments must not bypass a quota Next applies after decoding"
  );

  for (const [method, pathname] of [
    ["GET", `/api/reports/${REPORT_ID}`],
    ["GET", "/reports/not-a-report"],
    ["GET", `/reports/${REPORT_ID}/other`],
    ["GET", `/reports/${REPORT_ID}%2Fopengraph-image`],
    ["GET", `/reports/${REPORT_ID}/%zz`]
  ]) {
    assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname}`);
  }
});

test("a non-read method on a report route is refused at the edge, not forwarded uncharged", () => {
  // The earlier version of this file pinned POST /reports/<id> -> null as the
  // expected outcome, which restated the code's assumption that a null parse
  // meant "nothing to charge, forward it". Next renders the page for a POST
  // too, so null there was a bypass, not a policy. The contract is now: the
  // parser still has nothing to charge, AND the request never reaches the
  // container.
  const reportRoutes = [
    `/reports/${REPORT_ID}`,
    `/reports/${REPORT_ID}/`,
    `/reports/${REPORT_ID}/print`,
    `/reports/${REPORT_ID}/opengraph-image`,
    `/%72eports/${REPORT_ID}`,
    "/reports/not-a-report",
    "/reports/index.json",
    "/reports"
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const pathname of reportRoutes) {
      assert.equal(refusePublicReportRouteMethod(method, pathname), true, `${method} ${pathname} must be refused`);
      assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname} has nothing to charge`);
    }
  }
  for (const method of ["GET", "HEAD"]) {
    for (const pathname of reportRoutes) {
      assert.equal(refusePublicReportRouteMethod(method, pathname), false, `${method} ${pathname} is a read`);
    }
  }
  // Only report routes. The scan API takes POST by design and Node's own
  // routes answer their own 405s.
  for (const pathname of ["/api/scan", `/api/reports/${REPORT_ID}`, "/reportsx", "/", "/directory"]) {
    assert.equal(refusePublicReportRouteMethod("POST", pathname), false, `POST ${pathname} is not this rule's`);
  }
  assert.equal(PUBLIC_REPORT_READ_ALLOW_HEADER, "GET, HEAD");
});

/**
 * Every URL the app can render under app/reports/[id], as the suffix after
 * the id (empty for the page itself), derived from Next's file conventions on
 * the real directory tree rather than from a list this file would have to be
 * told about.
 */
function renderableReportRepresentations(dir: string, prefix: string[] = []): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dotfiles and _private folders are outside routing.
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      // Route groups and parallel slots add no URL segment.
      const segments =
        entry.name.startsWith("(") || entry.name.startsWith("@") ? prefix : [...prefix, entry.name];
      for (const suffix of renderableReportRepresentations(path.join(dir, entry.name), segments)) {
        found.add(suffix);
      }
      continue;
    }
    const base = entry.name.replace(/\.[^.]+$/, "");
    if (base === "page" || base === "route" || base === "default") {
      found.add(prefix.join("/"));
    } else if (["opengraph-image", "twitter-image", "icon", "apple-icon"].includes(base)) {
      found.add([...prefix, base].join("/"));
    }
  }
  return found;
}

test("every representation app/reports/[id] can render is a charged edge read", () => {
  // The printable route landed after the parser did and was forwarded
  // uncharged until this test existed, because nothing tied the parser's
  // allow-list to the directory Next routes from. This walks that directory,
  // so the next route file cannot land without either a charge or a
  // deliberate change to this policy.
  const representations = renderableReportRepresentations(path.join(process.cwd(), "app", "reports", "[id]"));
  assert.ok(representations.has(""), "the walk should have found the report page itself");
  assert.ok(representations.has("print"), "the walk should have found the printable route");
  for (const suffix of representations) {
    const pathname = suffix === "" ? `/reports/${REPORT_ID}` : `/reports/${REPORT_ID}/${suffix}`;
    const parsed = parsePublicReportReadPath("GET", pathname);
    assert.ok(
      parsed,
      `${pathname} is a representation the app renders but the edge does not charge; ` +
        "extend parsePublicReportReadPath in lib/report-read-edge.ts in the same change as the route"
    );
    assert.equal(parsed.resource, suffix === "" ? "page" : suffix);
    assert.equal(parsed.reportId, REPORT_ID);
  }
});

test("report-read ceilings are finite and retain the established per-client policy", () => {
  assert.equal(REPORT_READ_RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE, 1_200);
  assert.ok(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE > REPORT_READ_RATE_LIMIT_PER_MINUTE);
});

test("container ingress refuses non-read methods, then charges recognized report reads, before any container forward", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const ingress = source.slice(
    requireIndex(source, "if (refusePublicReportRouteMethod(request.method, url.pathname))"),
    requireIndex(source, "const durableAdmission = durableScanJobsEnabled")
  );
  assert.match(ingress, /return reportRouteMethodNotAllowedResponse\(\)/);
  assert.match(ingress, /await enforcePublicReportReadRateLimit\(request, env\)/);
  assert.ok(
    requireIndex(ingress, "reportRouteMethodNotAllowedResponse()") <
      requireIndex(ingress, "const reportRead = parsePublicReportReadPath"),
    "a refused method must answer before the quota is consulted, so it consumes nothing"
  );
  assert.ok(
    requireIndex(ingress, "enforcePublicReportReadRateLimit") < requireIndex(ingress, "forwardToContainer(request, env)"),
    "quota must settle before report storage or rendering can start"
  );

  const methodRefusal = source.slice(
    requireIndex(source, "function reportRouteMethodNotAllowedResponse("),
    requireIndex(source, "function gateErrorResponse(")
  );
  assert.match(methodRefusal, /status: 405/);
  assert.match(methodRefusal, /allow: PUBLIC_REPORT_READ_ALLOW_HEADER/, "the Allow header must come from the one method list");
  assert.match(methodRefusal, /"cache-control": "no-store"/);

  const response = source.slice(
    requireIndex(source, "function reportReadGateResponse("),
    requireIndex(source, "function reportRouteMethodNotAllowedResponse(")
  );
  assert.match(response, /"cache-control": "no-store"/);
  assert.match(response, /"retry-after"/);
});
