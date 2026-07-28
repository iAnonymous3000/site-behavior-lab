/**
 * Small, reviewed corporate-ownership map for report interpretation.
 *
 * `thirdParty` in the scan wire is deliberately a registrable-domain boundary:
 * youtube.com -> google.com and x.com -> twimg.com are cross-site requests even
 * though the named domains belong to the same organization. That boundary is
 * useful for browser policy and cookie semantics, but it is not by itself
 * evidence of disclosure to an outside company.
 *
 * This map is intentionally narrow. Each family has an official reference for
 * the corporate relationship; individual suffix membership remains a
 * maintainer-reviewed mapping, not an assertion that the source enumerates
 * every domain below.
 */

export type ReviewedOrganization = "Google" | "X";

export type ReviewedOwnershipRecord = {
  organization: ReviewedOrganization;
  domains: readonly string[];
  reviewedAt: string;
  reviewer: string;
  source: {
    kind: "official";
    title: string;
    url: string;
  };
  limitations: string;
};

export type ReviewedOwnershipRelationship =
  | {
      kind: "same-organization";
      organization: ReviewedOrganization;
    }
  | {
      kind: "different-reviewed-organizations";
      subjectOrganization: ReviewedOrganization;
      recipientOrganization: ReviewedOrganization;
    }
  | {
      kind: "unreviewed";
      subjectOrganization: ReviewedOrganization | null;
      recipientOrganization: ReviewedOrganization | null;
    };

export const REVIEWED_OWNERSHIP_VERSION = "reviewed-ownership-v1";

const DOMAIN_MAPPING_LIMITATION =
  "The official source establishes the named corporate relationship. Individual domain-family membership is a maintainer-reviewed mapping and the source is not asserted to enumerate every suffix.";

const OWNERSHIP_RECORDS: readonly ReviewedOwnershipRecord[] = [
  {
    organization: "Google",
    domains: [
      "doubleclick.net",
      "google-analytics.com",
      "google.com",
      "googleadservices.com",
      "googleapis.com",
      "googleusercontent.com",
      "googlevideo.com",
      "googlesyndication.com",
      "googletagmanager.com",
      "gstatic.com",
      "youtu.be",
      "youtube-nocookie.com",
      "youtube.com",
      "ytimg.com"
    ],
    reviewedAt: "2026-07-28",
    reviewer: "Site Behavior Lab maintainers",
    source: {
      kind: "official",
      title: "YouTube and Google account relationship",
      url: "https://support.google.com/youtube/answer/69961?hl=en"
    },
    limitations: DOMAIN_MAPPING_LIMITATION
  },
  {
    organization: "X",
    domains: ["ads-twitter.com", "t.co", "twitter.com", "twimg.com", "x.com"],
    reviewedAt: "2026-07-28",
    reviewer: "Site Behavior Lab maintainers",
    source: {
      kind: "official",
      title: "X Help: X videos and twimg.com",
      url: "https://help.x.com/en/using-x/x-videos"
    },
    limitations: DOMAIN_MAPPING_LIMITATION
  }
];

export function reviewedOwnershipRecords(): ReviewedOwnershipRecord[] {
  return OWNERSHIP_RECORDS.map((record) => ({
    ...record,
    domains: [...record.domains],
    source: { ...record.source }
  }));
}

export function reviewedOrganizationForDomain(domain: string): ReviewedOrganization | null {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  for (const record of OWNERSHIP_RECORDS) {
    if (record.domains.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
      return record.organization;
    }
  }
  return null;
}

export function reviewedOwnershipRelationship(
  subjectDomain: string,
  recipientDomain: string
): ReviewedOwnershipRelationship {
  const subjectOrganization = reviewedOrganizationForDomain(subjectDomain);
  const recipientOrganization = reviewedOrganizationForDomain(recipientDomain);

  if (subjectOrganization && subjectOrganization === recipientOrganization) {
    return { kind: "same-organization", organization: subjectOrganization };
  }
  if (subjectOrganization && recipientOrganization) {
    return {
      kind: "different-reviewed-organizations",
      subjectOrganization,
      recipientOrganization
    };
  }
  return { kind: "unreviewed", subjectOrganization, recipientOrganization };
}

export function isReviewedSameOrganizationDomain(subjectDomain: string, recipientDomain: string): boolean {
  return reviewedOwnershipRelationship(subjectDomain, recipientDomain).kind === "same-organization";
}

function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/^\./, "").replace(/\.$/, "") || null;
    } catch {
      return null;
    }
  }

  const normalized = trimmed
    .replace(/^\./, "")
    .replace(/\.$/, "")
    .replace(/:\d+$/, "");
  return normalized || null;
}
