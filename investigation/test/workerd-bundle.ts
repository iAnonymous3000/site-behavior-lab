import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ISSUER, certsResponse, type SigningKey } from "./token-fixture";

/**
 * How the viewer's workerd suites build and serve what they run: the same tool and
 * compatibility date as the workspace's Worker, as `wrangler deploy --dry-run`, which writes a
 * bundle and deploys nothing. The Worker's one way out, the fetch of the Access team's keys, is
 * answered here, and any other address it asks for is refused and remembered, so a suite can
 * hold that the Worker reached nothing else. Miniflare's own fetch of its request properties
 * (cf.json), which it makes outside NODE_ENV=test when node_modules holds no copy under 30 days
 * old, does not pass through here.
 */

const ROOT = process.cwd();
const CONFIG_PATH = "wrangler.investigation.jsonc";

export const COMPATIBILITY_DATE = (ts.parseConfigFileTextToJson(CONFIG_PATH, readFileSync(path.join(ROOT, CONFIG_PATH), "utf8")).config as { compatibility_date: string }).compatibility_date;

/** Bundle an entry, or the config's own main when none is named, into this directory. Returns the bundle's path. */
export function bundleForWorkerd(entry: string | null, outputDirectory: string, bundleName: string): string {
  const args = [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", ...(entry === null ? [] : [entry]), "--config", CONFIG_PATH, "--dry-run", "--outdir", outputDirectory];
  // The test's own bound cannot fire while this blocks the event loop. With its banner hidden,
  // wrangler skips the update check its banner runs. It still runs one when a configuration has
  // unexpected fields or it prints a possible-bug error, and that check asks the npm registry only
  // when its one-hour cache in the temp folder is stale.
  execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" }, stdio: "pipe", timeout: 120_000 });
  return path.join(outputDirectory, bundleName);
}

export type Outbound = Readonly<{ handler: (request: Request) => Response; refused: string[]; keyFetches: () => number }>;

/** Miniflare's outbound hook: the team's keys, and nothing else. */
export function accessKeysOnly(signing: SigningKey): Outbound {
  const refused: string[] = [];
  let keyFetches = 0;
  return {
    handler: (request) => {
      if (request.url === `${ISSUER}/cdn-cgi/access/certs`) {
        keyFetches += 1;
        return certsResponse(signing);
      }
      refused.push(request.url);
      return new Response("refused by the test", { status: 502 });
    },
    refused,
    keyFetches: () => keyFetches
  };
}
