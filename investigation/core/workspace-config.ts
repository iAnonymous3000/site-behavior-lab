// The workspace's configuration, read from the Worker's environment in one place.
//
// Either every value is present and well formed, and the result is complete and
// frozen, or there is no configuration at all and the gate answers 503. There is
// no partial reading, so a missing or malformed value can never admit anyone.
//
// Nothing here names a real hostname or identity: those are deployment values, and
// neither the DNS record nor the Access application exists yet.

import { accessPolicyFrom, type AccessPolicy } from "./access-token";

export type WorkspaceEnv = {
  INVESTIGATION_ACCESS_ISSUER?: string;
  INVESTIGATION_ACCESS_AUDIENCE?: string;
  INVESTIGATION_OWNER_SUBJECT?: string;
  INVESTIGATION_OWNER_EMAIL?: string;
  /** Optional, with the audience below: both or neither, and they may equal the owner's audience. */
  INVESTIGATION_HEALTH_CLIENT_ID?: string;
  INVESTIGATION_HEALTH_ACCESS_AUDIENCE?: string;
  /** The one hostname the workspace answers on. */
  INVESTIGATION_WORKSPACE_HOSTNAME?: string;
  SITE_BEHAVIOR_LAB_BUILD_COMMIT?: string;
};

export type WorkspaceConfig = Readonly<{
  policy: AccessPolicy;
  /** Compared with a request's URL host, so only the spelling a URL parser produces can ever match. */
  hostname: string;
}>;

const MAX_HOSTNAME_CHARS = 253;
/** Two or more lowercase labels, the last not all digits: no port, scheme, path, wildcard, trailing dot or address. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * Platform aliases. Each answers outside the Access application meant to stand in
 * front of the workspace, so naming one here would defeat the host check it feeds.
 */
const ALIAS_SUFFIXES = [".workers.dev", ".pages.dev"] as const;

function isWorkspaceHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_HOSTNAME_CHARS || !HOSTNAME.test(value)) return false;
  return !ALIAS_SUFFIXES.some((suffix) => `.${value}`.endsWith(suffix));
}

/** The complete frozen configuration, or null when any required value is missing or malformed. */
export function workspaceConfigFrom(env: WorkspaceEnv): WorkspaceConfig | null {
  const policy = accessPolicyFrom({
    issuer: env.INVESTIGATION_ACCESS_ISSUER,
    audience: env.INVESTIGATION_ACCESS_AUDIENCE,
    ownerSubject: env.INVESTIGATION_OWNER_SUBJECT,
    ownerEmail: env.INVESTIGATION_OWNER_EMAIL,
    healthClientId: env.INVESTIGATION_HEALTH_CLIENT_ID,
    healthAudience: env.INVESTIGATION_HEALTH_ACCESS_AUDIENCE
  });
  if (policy === null) return null;
  const hostname = env.INVESTIGATION_WORKSPACE_HOSTNAME;
  if (!isWorkspaceHostname(hostname)) return null;
  return Object.freeze({ policy, hostname });
}
