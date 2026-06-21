// Front Worker for the Cloudflare Containers deployment of the full Node/Playwright
// scanner — the path that runs *live* Brave Shields (tried-vs-blocked). It runs the
// repo Dockerfile as a Cloudflare Container and forwards every request to it.
//
// Deployed separately (wrangler.container.jsonc) from cloudflare/worker.ts (the
// Browser Run GPC worker), so the existing live GPC worker is untouched.
// Full runbook: docs/deploy-cloudflare-containers.md
import { Container, getContainer } from "@cloudflare/containers";

type Env = {
  SCANNER: DurableObjectNamespace<ScannerContainer>;
  // Set as Worker secrets (`wrangler secret put -c wrangler.container.jsonc <NAME>`)
  // and forwarded into the container via envVars below.
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  SITE_BEHAVIOR_LAB_R2_ENDPOINT?: string;
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID?: string;
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY?: string;
};

export class ScannerContainer extends Container<Env> {
  // The Dockerfile serves Next.js on :3000.
  defaultPort = 3000;
  // Keep the instance (and its warm Chromium) alive between scans; it scales to
  // zero after this idle window. Raise for fewer cold starts, lower to save cost.
  sleepAfter = "15m";

  // Non-secret config plus secrets sourced from Worker secrets, passed to the
  // container process. Reports go to R2 because container disk is ephemeral.
  envVars = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND: "r2",
    SITE_BEHAVIOR_LAB_R2_BUCKET: "site-behavior-lab-reports",
    SITE_BEHAVIOR_LAB_R2_PREFIX: "reports/",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "cloudflare-containers",
    // Long Shields scans return 202 + jobId instead of holding the connection.
    SITE_BEHAVIOR_LAB_ASYNC_SCANS: "1",
    // Operator-gated by default: managed containers have no external egress
    // firewall, so the in-app connect-time proxy is the only SSRF backstop.
    SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: this.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
    SITE_BEHAVIOR_LAB_R2_ENDPOINT: this.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: this.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
    SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: this.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One warm singleton instance keeps the scanner's in-memory async job queue
    // coherent (a client polls /api/scans/:id on the same instance). Shard on a
    // key here once a single instance is not enough.
    return getContainer(env.SCANNER).fetch(request);
  }
} satisfies ExportedHandler<Env>;
