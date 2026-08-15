import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparisonDeltaHeading,
  displayEvidenceName,
  displayHost,
  displayPublicUrl,
  hostMatchesQuery,
  reportKindLabel
} from "./text-format";

test("host search accepts the wildcard form displayed to readers", () => {
  assert.equal(displayHost("{label}.metrics.example"), "*.metrics.example");
  assert.equal(hostMatchesQuery("{label}.metrics.example", "*.metrics.example"), true);
  assert.equal(hostMatchesQuery("{label}.metrics.example", "{label}.metrics"), true);
  assert.equal(hostMatchesQuery("{label}.metrics.example", "unrelated"), false);
});

test("privacy-reduced URLs use reader notation instead of wire tokens", () => {
  assert.equal(
    displayPublicUrl("https://static.{label}.fbcdn.net/{seg}/{seg}/{n}/{seg}"),
    "https://static.*.fbcdn.net/…"
  );
  assert.equal(
    displayPublicUrl("https://{label}.fbsbx.com/{seg}/{seg}?%5Bredacted%5D=&version="),
    "https://*.fbsbx.com/…?…&version"
  );
  assert.equal(
    displayPublicUrl("https://example.com/legal/privacy?utm_source=&utm_source="),
    "https://example.com/legal/privacy?utm_source"
  );
  assert.equal(displayPublicUrl("{invalid-url}"), "URL unavailable");
  assert.equal(displayPublicUrl("not a public URL"), "URL unavailable");
  assert.equal(displayHost("{invalid-host}"), "host unavailable");
});

test("privacy markers render as explained, distinct evidence rows while reviewed names stay exact", () => {
  assert.equal(displayEvidenceName("_octo", "cookie", 1), "_octo");
  assert.equal(displayEvidenceName("_ga", "cookie", 2), "_ga");
  assert.equal(displayEvidenceName("soft-nav:marker", "storage", 1), "soft-nav:marker");
  assert.equal(displayEvidenceName("theme", "storage", 2), "theme");

  const markers = [
    "[redacted]",
    "[redacted:uuid-like]",
    "[redacted:numeric]",
    "[redacted:hex-like]",
    "[redacted:long-token]"
  ];
  for (const [index, marker] of markers.entries()) {
    const cookieLabel = displayEvidenceName(marker, "cookie", index + 1);
    const storageLabel = displayEvidenceName(marker, "storage", index + 1);
    assert.equal(cookieLabel, `Cookie ${index + 1} · name hidden for privacy`);
    assert.equal(storageLabel, `Storage key ${index + 1} · name hidden for privacy`);
    assert.equal(cookieLabel.includes("[redacted"), false);
    assert.equal(storageLabel.includes("[redacted"), false);
  }

  assert.equal(displayEvidenceName("[redacted]", "cookie", 1), "Cookie 1 · name hidden for privacy");
  assert.equal(displayEvidenceName("[redacted]", "cookie", 2), "Cookie 2 · name hidden for privacy");
  assert.equal(displayEvidenceName("alice_private_session", "cookie", 3), "Cookie 3 · name hidden for privacy");
  assert.equal(displayEvidenceName("alice@example.com", "storage", 4), "Storage key 4 · name hidden for privacy");
  assert.equal(displayEvidenceName("[redacted:invented]", "cookie", 5), "Cookie 5 · name hidden for privacy");
});

test("report kind labels distinguish consent comparisons from incomplete attempts", () => {
  const consent = (consentClicks: "accept-and-reject" | "accept-only" | "reject-only" | "none") =>
    reportKindLabel({ reportType: "comparison", comparisonType: "consent", consentClicks });

  assert.equal(consent("accept-and-reject"), "consent comparison");
  assert.equal(consent("accept-only"), "consent comparison attempt (Reject not activated)");
  assert.equal(consent("reject-only"), "consent comparison attempt (Accept not activated)");
  assert.equal(consent("none"), "consent comparison attempt (no control activated)");
  assert.equal(reportKindLabel({ reportType: "single" }), "single scan");
  assert.equal(reportKindLabel({ reportType: "comparison", comparisonType: "shields" }), "Brave-list blocking comparison");
});

test("comparison heading does not promise a delta when no metric family is comparable", () => {
  const labels = { baseline: "GPC off", variant: "GPC on" };
  assert.equal(comparisonDeltaHeading(labels, true), "GPC off → GPC on delta");
  assert.equal(
    comparisonDeltaHeading(labels, false),
    "GPC off and GPC on: two visits, no comparable metric delta"
  );
});
