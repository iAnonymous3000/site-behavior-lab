-- Site Behavior Lab v3 — Cloudflare D1 / SQLite Metadata & Corpus Index Schema
-- Replaces R2 ListObjectsV2 + 1,000-HEAD pruning and cold 450 MB filesystem corpus scans.

CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  canonical_domain TEXT NOT NULL,
  final_url TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public', -- 'public' | 'unlisted' | 'corpus'
  egress_region TEXT NOT NULL DEFAULT 'local',
  device TEXT NOT NULL DEFAULT 'desktop',
  load_outcome TEXT NOT NULL DEFAULT 'ok',
  http_status INTEGER,
  total_requests INTEGER NOT NULL DEFAULT 0,
  third_party_requests INTEGER NOT NULL DEFAULT 0,
  third_party_domains INTEGER NOT NULL DEFAULT 0,
  tracking_requests INTEGER NOT NULL DEFAULT 0,
  shields_blocked_standard INTEGER NOT NULL DEFAULT 0,
  shields_blocked_aggressive INTEGER NOT NULL DEFAULT 0,
  distinct_entities INTEGER NOT NULL DEFAULT 0,
  distinct_parent_orgs INTEGER NOT NULL DEFAULT 0,
  cookies_total INTEGER NOT NULL DEFAULT 0,
  third_party_cookies INTEGER NOT NULL DEFAULT 0,
  long_lived_cookies INTEGER NOT NULL DEFAULT 0,
  partitioned_cookies INTEGER NOT NULL DEFAULT 0,
  storage_keys_total INTEGER NOT NULL DEFAULT 0,
  websockets_total INTEGER NOT NULL DEFAULT 0,
  service_workers_total INTEGER NOT NULL DEFAULT 0,
  beacon_platforms INTEGER NOT NULL DEFAULT 0,
  server_side_tagging_endpoints INTEGER NOT NULL DEFAULT 0,
  cname_cloaks_count INTEGER NOT NULL DEFAULT 0,
  fingerprint_kinds_count INTEGER NOT NULL DEFAULT 0,
  keystroke_leaks_count INTEGER NOT NULL DEFAULT 0,
  keystroke_fields_typed INTEGER NOT NULL DEFAULT 0,
  dark_pattern_score INTEGER NOT NULL DEFAULT 0,
  top_highlight TEXT,
  r2_key TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_domain_time ON reports(canonical_domain, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_visibility_time ON reports(visibility, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_third_party ON reports(visibility, third_party_domains DESC);
CREATE INDEX IF NOT EXISTS idx_reports_dark_pattern ON reports(visibility, dark_pattern_score DESC);
CREATE INDEX IF NOT EXISTS idx_reports_expires_at ON reports(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS report_entities (
  report_id TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  entity TEXT NOT NULL,
  parent_org TEXT NOT NULL,
  category TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  domain_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, entity),
  FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_report_entities_entity ON report_entities(entity, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_entities_parent ON report_entities(parent_org, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_entities_category ON report_entities(category, scanned_at DESC);

CREATE TABLE IF NOT EXISTS report_beacons (
  report_id TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  platform TEXT NOT NULL,
  format TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  server_side_tagging INTEGER NOT NULL DEFAULT 0,
  has_identifiers INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, platform, endpoint_host),
  FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_report_beacons_platform ON report_beacons(platform);
CREATE INDEX IF NOT EXISTS idx_report_beacons_sgtm ON report_beacons(server_side_tagging);

CREATE TABLE IF NOT EXISTS watches (
  watch_id TEXT PRIMARY KEY,
  canonical_domain TEXT NOT NULL,
  target_url TEXT NOT NULL,
  egress_region TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_report_id TEXT,
  runs_completed INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active' -- 'active' | 'completed' | 'deleted'
);

CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(status, next_run_at);

CREATE TABLE IF NOT EXISTS watch_runs (
  watch_id TEXT NOT NULL,
  run_index INTEGER NOT NULL,
  report_id TEXT NOT NULL,
  previous_report_id TEXT,
  scanned_at TEXT NOT NULL,
  regression_count INTEGER NOT NULL DEFAULT 0,
  alerts_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (watch_id, run_index),
  FOREIGN KEY (watch_id) REFERENCES watches(watch_id) ON DELETE CASCADE
);
