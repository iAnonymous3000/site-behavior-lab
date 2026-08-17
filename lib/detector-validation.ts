import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import { DETECTOR_REGISTRY_VERSION, DETECTOR_VERSIONS } from "./measurement-kernel";
import { sha256Hex } from "./sha256";

export type ValidationFixtureKind = "positive" | "negative" | "adversarial";
export type ValidationFixtureEnvironment = "unit" | "real-chromium";

export type DetectorValidationFixture = {
  detector: DetectorId;
  kind: ValidationFixtureKind;
  environment: ValidationFixtureEnvironment;
  file: string;
  testName: string;
  verifies: string;
};

export type DetectorValidationRow = {
  detector: DetectorId;
  label: string;
  version: string;
  positiveCases: number;
  negativeCases: number;
  adversarialCases: number;
  realChromiumCases: number;
  limitations: string;
  fixtures: DetectorValidationFixture[];
};

const DETECTOR_PUBLIC_COPY: Readonly<Record<DetectorId, { label: string; limitations: string }>> = {
  "fingerprint-heuristics": {
    label: "Fingerprint and behavior heuristics",
    limitations:
      "These cases exercise selected APIs, attribution paths, and hostile-page behavior. A matching pattern can have a legitimate use, and uninstrumented browser surfaces remain outside coverage."
  },
  "keystroke-exfiltration": {
    label: "Synthetic input sentinel",
    limitations:
      "Coverage is bounded to visible fields the scan probes, captured HTTP requests, and the documented plain, encoded, and hashed sentinel forms. It does not cover arbitrary encryption or uncaptured transports."
  },
  "cname-uncloaking": {
    label: "CNAME uncloaking",
    limitations:
      "Classification depends on the DNS chain observed during the visit and the curated service catalog. A CNAME match is a routing observation, not proof of a request's purpose."
  },
  "pixel-events": {
    label: "Advertising pixel events",
    limitations:
      "Decoding covers reviewed request formats for Meta, TikTok, and X. Unknown products, changed payload formats, and custom event meaning are not inferred."
  },
  "consent-banner": {
    label: "Consent banner and controls",
    limitations:
      "Cases cover known CMP selectors and conservative first-layer labels. Finding or clicking a control does not establish legal validity or prove that every request honored the choice."
  },
  "privacy-policy": {
    label: "Privacy-policy cross-check",
    limitations:
      "The detector checks narrow, testable phrases in an eligible policy page. It does not interpret a complete policy, determine compliance, or infer the meaning of ambiguous legal language."
  }
};

/**
 * Source-pinned acceptance cases selected from the existing test suite. This
 * is an inventory of reviewed fixtures, not a representative labeled corpus.
 * Exact test names are checked in detector-validation.test.ts so a rename or
 * deletion cannot silently leave the public matrix stale.
 */
export const DETECTOR_VALIDATION_FIXTURES: readonly DetectorValidationFixture[] = [
  {
    detector: "fingerprint-heuristics",
    kind: "positive",
    environment: "unit",
    file: "lib/fingerprint-observer.test.ts",
    testName: "fingerprintObserverInitScript flags the canvas heuristic after text write and readback",
    verifies: "A qualifying canvas write-and-read pattern produces a review finding."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "negative",
    environment: "unit",
    file: "lib/fingerprint-observer.test.ts",
    testName: "fingerprintObserverInitScript does not flag benign first-party form listeners",
    verifies: "First-party form listeners are not mislabeled as third-party input monitoring."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName: "first-party addEventListener wrappers do not hide a deferred third-party registrant",
    verifies: "A first-party framework wrapper neither censors the frame nor hides the deferred third-party registrant."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "positive",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks detects the plain value in a third-party request URL",
    verifies: "A synthetic value sent to a third party is identified without retaining the value."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "negative",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks ignores requests that do not contain the sentinel",
    verifies: "Unrelated first- and third-party requests do not produce a sentinel match."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "adversarial",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks bounds the per-field search so a padded body cannot exhaust it",
    verifies: "Oversized padding cannot force unbounded scanning or smuggle evidence past the declared cap."
  },
  {
    detector: "cname-uncloaking",
    kind: "positive",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "classifyCnameCloak flags a first-party subdomain CNAME'd to a tracking vendor",
    verifies: "A first-party alias resolving to a curated service is reported with its DNS chain."
  },
  {
    detector: "cname-uncloaking",
    kind: "negative",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "classifyCnameCloak ignores a CNAME to a non-tracker CDN",
    verifies: "A non-catalog CDN alias does not become a tracker label."
  },
  {
    detector: "cname-uncloaking",
    kind: "adversarial",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "resolveCnameCloaks skips a host whose DNS resolution throws",
    verifies: "A failed DNS lookup stays an explicit absence of evidence rather than a fabricated match."
  },
  {
    detector: "pixel-events",
    kind: "positive",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "Meta: a plain /tr GET yields the event name and no advanced matching",
    verifies: "A reviewed Meta Pixel request shape yields its standard event label."
  },
  {
    detector: "pixel-events",
    kind: "negative",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "a non-pixel request decodes to null",
    verifies: "Unrelated and share-link requests do not become advertising pixel events."
  },
  {
    detector: "pixel-events",
    kind: "adversarial",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "decodePixelRequest ignores an over-large POST body but still reads the URL",
    verifies: "Oversized bodies are skipped while bounded URL evidence remains available."
  },
  {
    detector: "consent-banner",
    kind: "positive",
    environment: "unit",
    file: "lib/consent-banner.test.ts",
    testName: "detectConsentPlatform names a CMP from its loader host (suffix + exact)",
    verifies: "Reviewed CMP loader domains produce a platform label."
  },
  {
    detector: "consent-banner",
    kind: "negative",
    environment: "unit",
    file: "lib/consent-interaction.test.ts",
    testName: "whole-label matching rejects partial and page-authored phrases",
    verifies: "Ambiguous or page-authored text is not treated as a consent decision."
  },
  {
    detector: "consent-banner",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/consent-interaction.test.ts",
    testName: "browser probes retain trusted DOM brands and methods after hostile intrinsic poisoning",
    verifies: "Consent probes preserve bounded behavior under hostile page prototype changes in Chromium."
  },
  {
    detector: "privacy-policy",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a direct PDF privacy policy completes through the bounded scan proxy",
    verifies: "A direct PDF policy is fetched through the SSRF proxy and produces a complete cross-check."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "unit",
    file: "lib/privacy-policy.test.ts",
    testName: "extractPolicyClaims does not turn qualified real-policy wording into blanket combined claims",
    verifies: "Population, knowledge, monetary, temporal, and contradictory qualifiers are not promoted to blanket claims."
  },
  {
    detector: "privacy-policy",
    kind: "adversarial",
    environment: "unit",
    file: "lib/privacy-policy.test.ts",
    testName: "pickPrivacyPolicyLink accepts a known policy-hosting service but not arbitrary off-site policies",
    verifies: "An unrelated company's policy cannot be attributed to the scanned site."
  }
] as const;

export const detectorValidationMetadata = {
  version: "detector-fixture-matrix-v1",
  registryVersion: DETECTOR_REGISTRY_VERSION,
  cases: DETECTOR_VALIDATION_FIXTURES.length,
  digest: sha256Hex(JSON.stringify(DETECTOR_VALIDATION_FIXTURES))
};

export function detectorValidationRows(): DetectorValidationRow[] {
  return DETECTOR_IDS.map((detector) => {
    const fixtures = DETECTOR_VALIDATION_FIXTURES.filter((fixture) => fixture.detector === detector).map((fixture) => ({ ...fixture }));
    const copy = DETECTOR_PUBLIC_COPY[detector];
    return {
      detector,
      label: copy.label,
      version: DETECTOR_VERSIONS[detector],
      positiveCases: fixtures.filter((fixture) => fixture.kind === "positive").length,
      negativeCases: fixtures.filter((fixture) => fixture.kind === "negative").length,
      adversarialCases: fixtures.filter((fixture) => fixture.kind === "adversarial").length,
      realChromiumCases: fixtures.filter((fixture) => fixture.environment === "real-chromium").length,
      limitations: copy.limitations,
      fixtures
    };
  });
}

export function validateDetectorValidationManifest(fixtures: readonly DetectorValidationFixture[]): string[] {
  const issues: string[] = [];
  const identities = new Set<string>();

  for (const [index, fixture] of fixtures.entries()) {
    const label = `${fixture.detector} fixture ${index + 1}`;
    if (!DETECTOR_IDS.includes(fixture.detector)) issues.push(`${label}: unknown detector`);
    if (!fixture.file.startsWith("lib/") || !fixture.file.endsWith(".test.ts") || fixture.file.includes("..")) {
      issues.push(`${label}: source must be a repository lib/*.test.ts path`);
    }
    if (!fixture.testName.trim()) issues.push(`${label}: exact test name is required`);
    if (!fixture.verifies.trim()) issues.push(`${label}: verification scope is required`);
    const identity = `${fixture.file}\u0000${fixture.testName}`;
    if (identities.has(identity)) issues.push(`${label}: duplicate source test`);
    identities.add(identity);
  }

  for (const detector of DETECTOR_IDS) {
    const detectorFixtures = fixtures.filter((fixture) => fixture.detector === detector);
    for (const kind of ["positive", "negative", "adversarial"] as const) {
      if (!detectorFixtures.some((fixture) => fixture.kind === kind)) {
        issues.push(`${detector}: missing ${kind} fixture`);
      }
    }
  }

  return issues;
}
