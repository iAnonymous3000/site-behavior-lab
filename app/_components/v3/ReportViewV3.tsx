"use client";

import { useMemo, useState } from "react";
import { LIVE_SCAN_API_BASE, STATIC_BASE_PATH, STATIC_EXPORT } from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";
import {
  resolveV3ApiUrl,
  resolveV3DynamicPageUrl,
  resolveV3StaticPageUrl
} from "@/lib/v3/client-urls";
import {
  buildDeveloperRuleBreakdownV3,
  buildInitiatorCausalityTreeV3,
  buildPhaseTimelineV3,
  rootInitiatorDomainV3
} from "@/lib/v3/dev-mode";
import type { ProbeName, ScanArmV3, ScanPhaseName, ScanReportV3 } from "@/lib/v3/schema";

type EvidenceTab = "requests" | "beacons" | "cookies" | "privacy-signals" | "policy";

export function ReportViewV3({ report }: { report: ScanReportV3 }) {
  const allArms = useMemo(
    () => [report.leadArm, ...report.comparisonArms],
    [report]
  );
  const [selectedArmId, setSelectedArmId] = useState(report.leadArm.armId);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [activeTab, setActiveTab] = useState<EvidenceTab>("requests");

  // Request table filters
  const [reqQuery, setReqQuery] = useState("");
  const [reqOnly3p, setReqOnly3p] = useState(true);
  const [reqOnlyShields, setReqOnlyShields] = useState(false);
  const [reqPhase, setReqPhase] = useState<ScanPhaseName | "all">("all");
  const [reqInitiatorFilter, setReqInitiatorFilter] = useState<string>("");
  const [reqPage, setReqPage] = useState(1);

  const activeArm: ScanArmV3 =
    allArms.find((a) => a.armId === selectedArmId) ?? report.leadArm;
  const s = activeArm.summary;

  const phaseTimeline = useMemo(() => buildPhaseTimelineV3(activeArm), [activeArm]);
  const causalityRoots = useMemo(() => buildInitiatorCausalityTreeV3(activeArm), [activeArm]);
  const devRules = useMemo(() => buildDeveloperRuleBreakdownV3(activeArm), [activeArm]);

  const probeStats = useMemo(() => {
    const entries = Object.entries(activeArm.probes) as [ProbeName, { status: string; reason?: string }][];
    const complete = entries.filter(([, p]) => p.status === "complete").length;
    const partial = entries.filter(([, p]) => p.status === "partial").length;
    return { total: entries.length, complete, partial, entries };
  }, [activeArm]);

  const filteredRequests = useMemo(() => {
    const q = reqQuery.trim().toLowerCase();
    return activeArm.network.filter((req) => {
      if (reqOnly3p && !req.thirdParty) return false;
      if (reqOnlyShields && !req.shields.matched) return false;
      if (reqPhase !== "all" && req.phase !== reqPhase) return false;
      if (reqInitiatorFilter && rootInitiatorDomainV3(req) !== reqInitiatorFilter) {
        return false;
      }
      if (!q) return true;
      return (
        req.domain.toLowerCase().includes(q) ||
        req.url.toLowerCase().includes(q) ||
        (req.entity?.entity.toLowerCase().includes(q) ?? false) ||
        (req.entity?.parentOrg.toLowerCase().includes(q) ?? false) ||
        (req.shields.rule?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [activeArm, reqQuery, reqOnly3p, reqOnlyShields, reqPhase, reqInitiatorFilter]);

  const PAGE_SIZE = 25;
  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const currentPage = Math.min(reqPage, totalPages);
  const pageRequests = filteredRequests.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const maxPhaseReq = Math.max(1, ...phaseTimeline.map((p) => p.totalRequests));

  return (
    <>
      {/* Layer 1: Hero & Behavior-First Actions */}
      <section className={styles.panel}>
        <div className={styles.heroHeader}>
          <div>
            <h1 className={styles.title}>{report.canonicalDomain}</h1>
            <p className={styles.subtitle}>
              <span className={styles.mono}>{report.finalUrl}</span> · Scanned{" "}
              {formatUtcTimestamp(report.scannedAt)} · HTTP {activeArm.httpStatus ?? "n/a"} (
              {activeArm.loadOutcome})
            </p>
          </div>
          <div className={styles.actionsRow}>
            <button
              type="button"
              className={`${styles.btn} ${devMode ? styles.btnActive : ""}`}
              onClick={() => setDevMode((v) => !v)}
              aria-pressed={devMode}
            >
              {devMode ? "Developer Mode: ON" : "Developer Mode"}
            </button>
            <a
              href={resolveV3DynamicPageUrl(`/v3/sites/${encodeURIComponent(report.canonicalDomain)}`, {
                staticExport: STATIC_EXPORT,
                scanApiBase: LIVE_SCAN_API_BASE,
                basePath: STATIC_BASE_PATH
              })}
              className={styles.btn}
            >
              Site History &amp; Diff
            </a>
            <a
              href={resolveV3ApiUrl(`/api/v3/reports/${report.reportId}`, LIVE_SCAN_API_BASE)}
              className={styles.btn}
              target="_blank"
              rel="noreferrer"
            >
              JSON
            </a>
            <a
              href={resolveV3ApiUrl(`/api/v3/reports/${report.reportId}/pdf?format=html`, LIVE_SCAN_API_BASE)}
              className={styles.btn}
              target="_blank"
              rel="noreferrer"
            >
              Print HTML
            </a>
            <a
              href={resolveV3ApiUrl(`/api/v3/reports/${report.reportId}/pdf`, LIVE_SCAN_API_BASE)}
              className={`${styles.btn} ${styles.btnPrimary}`}
              target="_blank"
              rel="noreferrer"
            >
              PDF
            </a>
          </div>
        </div>

        {/* Layer 2: Compact Structured Measurement Chips + Visit Scope Drawer */}
        <div className={styles.chipsRow}>
          <span className={`${styles.chip} ${styles.chipInfo}`}>
            Region: {report.provenance.egressRegion} · {activeArm.conditions.device}
          </span>
          <span className={styles.chip}>
            Phases: {activeArm.phases.filter((p) => p.status === "completed").length}/{activeArm.phases.length} completed
          </span>
          <span className={`${styles.chip} ${probeStats.partial > 0 ? styles.chipWarn : styles.chipOk}`}>
            Probes: {probeStats.complete}/{probeStats.total} complete
          </span>
          <span className={`${styles.chip} ${styles.chipOk}`}>Redaction verified (v3)</span>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setScopeOpen((v) => !v)}
            aria-expanded={scopeOpen}
          >
            {scopeOpen ? "Hide Visit Scope" : "Visit Scope & Provenance"}
          </button>
        </div>

        {scopeOpen && (
          <div className={styles.scopeDrawer}>
            <div>
              <strong>Runtime &amp; Provenance</strong>
              <div className={styles.mono}>
                Report ID: {report.reportId}
                <br />
                Scanner: {report.provenance.scannerVersion} ({report.provenance.buildCommit})
                <br />
                Chromium: {report.provenance.engineVersions.chromium} · Playwright:{" "}
                {report.provenance.engineVersions.playwright}
                <br />
                adblock-rust: {report.provenance.engineVersions.adblockRust}
                <br />
                Locale / TZ: {report.provenance.locale} / {report.provenance.timezone}
              </div>
            </div>
            <div>
              <strong>Probe Coverage</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                {probeStats.entries.map(([name, info]) => (
                  <li key={name}>
                    <code>{name}</code>: <strong>{info.status}</strong>
                    {info.reason ? ` — ${info.reason}` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Measurement Boundaries</strong>
              <p style={{ margin: "6px 0 0", color: "var(--text-muted)" }}>
                Observations reflect one controlled unauthenticated visit per arm. Cookie values, storage values, query
                strings, and keystroke probe sentinels are stripped at the persistence boundary and never stored.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Layer 1: KPI Strip */}
      <section className={styles.kpiGrid} aria-label="Key behavioral metrics">
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>{s.thirdPartyDomains}</div>
          <div className={styles.kpiLabel}>Third-Party Domains</div>
          <div className={styles.kpiSub}>
            {s.distinctEntities} entities · {s.distinctParentOrgs} parent orgs
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>
            {s.trackingRequests} / {s.totalRequests}
          </div>
          <div className={styles.kpiLabel}>Tracking / Total Req</div>
          <div className={styles.kpiSub}>
            Shields: {s.shieldsBlockedStandard} std / {s.shieldsBlockedAggressive} agg
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>{s.cookiesTotal}</div>
          <div className={styles.kpiLabel}>Cookies ({s.longLivedCookies} &gt;30d)</div>
          <div className={styles.kpiSub}>
            {s.thirdPartyCookies} 3P · {s.partitionedCookies} CHIPS · {s.storageKeysTotal} storage keys
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>{s.beaconPlatforms}</div>
          <div className={styles.kpiLabel}>Beacon Platforms</div>
          <div className={styles.kpiSub}>{s.serverSideTaggingEndpoints} first-party sGTM / CAPI</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>{s.darkPatternScore}/100</div>
          <div className={styles.kpiLabel}>CMP Dark-Pattern Score</div>
          <div className={styles.kpiSub}>
            {activeArm.consent.banner.detected
              ? activeArm.consent.banner.cmp ?? "Generic banner"
              : "No banner observed"}
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>
            {s.keystrokeLeaksCount} / {s.cnameCloaksCount} / {s.fingerprintKindsCount}
          </div>
          <div className={styles.kpiLabel}>Keystroke / CNAME / FP</div>
          <div className={styles.kpiSub}>
            {s.websocketsTotal} WS · {s.serviceWorkersTotal} SW
          </div>
        </div>
      </section>

      {/* Intervention Strip (Concurrent Arms) */}
      {allArms.length > 1 && (
        <section className={styles.panel}>
          <h2 className={styles.sectionTitle}>Intervention Strip (Concurrent Arm Comparison)</h2>
          <div className={styles.interventionGrid}>
            <button
              type="button"
              className={`${styles.interventionCard} ${activeArm.armId === report.leadArm.armId ? styles.interventionCardActive : ""}`}
              onClick={() => {
                setSelectedArmId(report.leadArm.armId);
                setReqPage(1);
              }}
            >
              <strong>{report.leadArm.label}</strong>
              <div className={styles.deltaRow}>
                <span>{report.leadArm.summary.totalRequests} req</span>
                <span>{report.leadArm.summary.thirdPartyDomains} 3P domains</span>
                <span>{report.leadArm.summary.cookiesTotal} cookies</span>
              </div>
            </button>
            {report.comparisonArms.map((arm) => {
              const delta = report.comparisons.find((c) => c.variantArmId === arm.armId);
              return (
                <button
                  key={arm.armId}
                  type="button"
                  className={`${styles.interventionCard} ${activeArm.armId === arm.armId ? styles.interventionCardActive : ""}`}
                  onClick={() => {
                    setSelectedArmId(arm.armId);
                    setReqPage(1);
                  }}
                >
                  <strong>{arm.label}</strong>
                  {delta && (
                    <div className={styles.deltaRow}>
                      <span>Req {signed(delta.requestsDelta)}</span>
                      <span>3P {signed(delta.thirdPartyDomainsDelta)}</span>
                      <span>Cookies {signed(delta.cookiesDelta)}</span>
                      {delta.shieldsBlockedCount > 0 && <span>Blocked {delta.shieldsBlockedCount}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Behavior-First Highlights */}
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Key Observed Behaviors</h2>
        <ul className={styles.highlightsList}>
          {report.highlights.length === 0 ? (
            <li className={styles.highlightItem}>No elevated behavioral signals observed during this visit.</li>
          ) : (
            report.highlights.map((h) => (
              <li
                key={h.id}
                className={`${styles.highlightItem} ${
                  h.severity === "critical"
                    ? styles.hlCritical
                    : h.severity === "high"
                      ? styles.hlHigh
                      : h.severity === "medium"
                        ? styles.hlMedium
                        : ""
                }`}
              >
                <div className={styles.highlightTitle}>{h.title}</div>
                <div className={styles.highlightDetail}>{h.detail}</div>
              </li>
            ))
          )}
        </ul>
      </section>

      {/* On-Screen Phase Waterfall Timeline */}
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Visit Phase Waterfall ({activeArm.label})</h2>
        <div className={styles.waterfallList}>
          {phaseTimeline.map((row) => {
            const trackCount = Math.min(row.totalRequests, row.trackingRequests);
            const nonTrack3p = Math.max(0, Math.min(row.thirdPartyRequests, row.totalRequests - trackCount));
            const firstParty = Math.max(0, row.totalRequests - trackCount - nonTrack3p);
            const p1 = (firstParty / maxPhaseReq) * 100;
            const p3 = (nonTrack3p / maxPhaseReq) * 100;
            const pt = (trackCount / maxPhaseReq) * 100;
            return (
              <div key={row.phase} className={styles.waterfallRow}>
                <div>
                  <strong>{row.label}</strong>{" "}
                  <span style={{ color: "var(--text-subtle)" }}>({row.durationMs}ms)</span>
                </div>
                <div className={styles.waterfallBarTrack} title={`${row.totalRequests} requests (${row.trackingRequests} tracking)`}>
                  <div className={styles.waterfallSeg1p} style={{ width: `${p1}%` }} />
                  <div className={styles.waterfallSeg3p} style={{ width: `${p3}%` }} />
                  <div className={styles.waterfallSegTrack} style={{ width: `${pt}%` }} />
                </div>
                <div className={styles.mono}>
                  {row.totalRequests} req · {row.trackingRequests} trk
                  {row.beacons > 0 ? ` · ${row.beacons} bcn` : ""}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Interactive On-Screen Causality / Initiator Graph */}
      <section className={styles.panel}>
        <div className={styles.heroHeader}>
          <div>
            <h2 className={styles.sectionTitle}>
              Interactive Causality &amp; Initiator Graph ({causalityRoots.length} originating triggers)
            </h2>
            <p className={styles.subtitle}>
              Click any originating script or tag manager to filter the request evidence log below.
            </p>
          </div>
          {reqInitiatorFilter && (
            <button type="button" className={styles.btn} onClick={() => setReqInitiatorFilter("")}>
              Clear initiator filter ({reqInitiatorFilter})
            </button>
          )}
        </div>

        {causalityRoots.length === 0 ? (
          <div className={styles.emptyState}>No third-party requests recorded in this arm.</div>
        ) : (
          <div className={styles.causalityGrid} style={{ marginTop: 12 }}>
            {causalityRoots.slice(0, devMode ? 25 : 8).map((root) => (
              <div key={root.rootId} className={styles.causalityCard}>
                <div className={styles.causalityHead}>
                  <div>
                    <button
                      type="button"
                      className={`${styles.btn} ${reqInitiatorFilter === root.scriptDomain ? styles.btnActive : ""}`}
                      onClick={() => {
                        setReqInitiatorFilter((cur) => (cur === root.scriptDomain ? "" : root.scriptDomain));
                        setActiveTab("requests");
                        setReqPage(1);
                      }}
                    >
                      <span className={styles.mono}>
                        {root.label}
                        {devMode && root.line !== null ? `:${root.line}` : ""}
                      </span>
                    </button>{" "}
                    <span className={styles.chip}>
                      {root.isFirstPartyScript ? "1st-party trigger" : "3rd-party chain"}
                    </span>
                  </div>
                  <div className={styles.mono} style={{ fontSize: 12 }}>
                    {root.totalRequests} req · {root.trackingRequests} tracking · {root.distinctEntities} entities
                  </div>
                </div>
                <div className={styles.causalityEntities}>
                  {root.entities.map((ent) => (
                    <a
                      key={ent.entity}
                      href={resolveV3StaticPageUrl(`/v3/catalog/?entity=${encodeURIComponent(ent.entity)}`, STATIC_BASE_PATH)}
                      className={`${styles.chip} ${ent.shieldsBlocked > 0 ? styles.chipLoud : styles.chipInfo}`}
                      style={{ textDecoration: "none" }}
                    >
                      {ent.entity} ({ent.parentOrg}) · {ent.requests}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Developer Mode Panel: Exact Brave Shields Filter Rules & Rewrites */}
      {devMode && (
        <section className={styles.panel}>
          <h2 className={styles.sectionTitle}>
            Developer Mode: Exact Matched Brave Shields Rules &amp; $removeparam Diffs ({devRules.length})
          </h2>
          {devRules.length === 0 ? (
            <div className={styles.emptyState}>No filter rules matched in this arm.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Filter Rule</th>
                    <th>Filter List</th>
                    <th>Action</th>
                    <th className={styles.num}>Hits</th>
                    <th>Target Hosts</th>
                    <th>Originating Script(s)</th>
                  </tr>
                </thead>
                <tbody>
                  {devRules.map((r) => (
                    <tr key={`${r.list}-${r.rule}-${r.exception ?? ""}`}>
                      <td className={styles.mono}>
                        {r.rule}
                        {r.exception ? <div style={{ color: "var(--sig-ok)" }}>Exception: {r.exception}</div> : null}
                      </td>
                      <td>{r.list}</td>
                      <td className={styles.mono}>
                        {r.shouldBlockStandard
                          ? "Block (Std)"
                          : r.shouldBlockAggressive
                            ? "Block (Agg)"
                            : r.hasUrlRewrite
                              ? "$removeparam"
                              : "Matched"}
                        {r.redirect ? ` · redirect:${r.redirect}` : ""}
                      </td>
                      <td className={styles.num}>{r.matchedRequests}</td>
                      <td className={styles.mono}>{r.sampleDomains.join(", ")}</td>
                      <td className={styles.mono}>{r.initiatorScripts.join(", ") || "parser"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Layer 3: Filterable, Paginated Deep Evidence Tabs */}
      <section className={styles.panel}>
        <div className={styles.tabs} role="tablist" aria-label="Evidence sections">
          {(
            [
              ["requests", `Requests (${activeArm.network.length})`],
              ["beacons", `Beacons & sGTM (${activeArm.beacons.length})`],
              ["cookies", `Cookies (${activeArm.cookies.length}) & Storage (${activeArm.storage.length})`],
              [
                "privacy-signals",
                `Consent, CNAME (${activeArm.cnameCloaks.length}), FP (${activeArm.fingerprinting.length}) & Keystrokes (${activeArm.keystrokes.leaks.length})`
              ],
              ["policy", "Privacy Policy"]
            ] as [EvidenceTab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              id={`v3-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`v3-panel-${id}`}
              className={`${styles.tabBtn} ${activeTab === id ? styles.tabBtnActive : ""}`}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`v3-panel-${activeTab}`} aria-labelledby={`v3-tab-${activeTab}`}>

        {activeTab === "requests" && (
          <>
            <div className={styles.formGrid} style={{ marginBottom: 12 }}>
              <label className={styles.fieldLabel}>
                Search host, path, entity, or Shields rule
                <input
                  className={styles.input}
                  value={reqQuery}
                  onChange={(e) => {
                    setReqQuery(e.target.value);
                    setReqPage(1);
                  }}
                  placeholder="e.g. doubleclick, Meta, ||google-analytics..."
                />
              </label>
              <label className={styles.fieldLabel}>
                Phase
                <select
                  className={styles.select}
                  value={reqPhase}
                  onChange={(e) => {
                    setReqPhase(e.target.value as ScanPhaseName | "all");
                    setReqPage(1);
                  }}
                >
                  <option value="all">All phases</option>
                  <option value="passive-load">Passive Load</option>
                  <option value="consent-choice">Consent Choice</option>
                  <option value="scroll-interaction">Scroll</option>
                  <option value="active-input">Active Input</option>
                  <option value="policy-check">Policy Check</option>
                </select>
              </label>
              <div className={styles.checkboxRow} style={{ marginTop: 0 }}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={reqOnly3p}
                    onChange={(e) => {
                      setReqOnly3p(e.target.checked);
                      setReqPage(1);
                    }}
                  />
                  Third-party only
                </label>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={reqOnlyShields}
                    onChange={(e) => {
                      setReqOnlyShields(e.target.checked);
                      setReqPage(1);
                    }}
                  />
                  Shields-matched only
                </label>
              </div>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Method / Status</th>
                    <th>Domain &amp; URL</th>
                    <th>Entity &amp; Parent</th>
                    <th>Phase</th>
                    <th>Shields Attribution</th>
                    {devMode && <th>Initiator &amp; Headers</th>}
                  </tr>
                </thead>
                <tbody>
                  {pageRequests.map((req) => (
                    <tr key={req.id}>
                      <td className={styles.mono}>
                        {req.method} {req.status ?? "—"}
                        <div style={{ color: "var(--text-subtle)" }}>{req.resourceType}</div>
                      </td>
                      <td className={styles.mono}>
                        <strong>{req.domain}</strong>
                        <div style={{ color: "var(--text-muted)" }}>{req.url}</div>
                      </td>
                      <td>
                        {req.entity ? (
                          <>
                            <strong>{req.entity.entity}</strong>
                            <div style={{ color: "var(--text-muted)" }}>
                              {req.entity.parentOrg} · {req.entity.category}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--text-subtle)" }}>
                            {req.thirdParty ? "Unattributed 3P" : "First-party"}
                          </span>
                        )}
                      </td>
                      <td className={styles.mono}>{req.phase}</td>
                      <td className={styles.mono}>
                        {req.shields.matched ? (
                          <>
                            <span className={`${styles.chip} ${styles.chipLoud}`}>
                              {req.shields.blocked ? "Blocked" : req.shields.shouldBlockStandard ? "Std block" : "Agg block"}
                            </span>
                            {req.shields.rule && <div style={{ marginTop: 4 }}>{req.shields.rule}</div>}
                            {req.shields.list && <div style={{ color: "var(--text-subtle)" }}>{req.shields.list}</div>}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      {devMode && (
                        <td className={styles.mono}>
                          <div>{req.initiator?.scriptUrl ?? req.initiator?.type ?? "other"}</div>
                          {req.requestHeaders && Object.keys(req.requestHeaders).length > 0 && (
                            <div style={{ color: "var(--text-subtle)", marginTop: 4 }}>
                              Req: {Object.entries(req.requestHeaders).map(([k, v]) => `${k}=${v}`).join("; ")}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.pagination}>
              <span>
                Showing {filteredRequests.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}–
                {Math.min(currentPage * PAGE_SIZE, filteredRequests.length)} of {filteredRequests.length} matching
                requests
              </span>
              <div className={styles.actionsRow}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={currentPage <= 1}
                  onClick={() => setReqPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                <span>
                  Page {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={currentPage >= totalPages}
                  onClick={() => setReqPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}

        {activeTab === "beacons" && (
          <div className={styles.tableWrap}>
            {activeArm.beacons.length === 0 ? (
              <div className={styles.emptyState}>No structured analytics or ad beacons decoded.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Endpoint Host</th>
                    <th>Server-Side</th>
                    <th>Events &amp; Scroll</th>
                    <th>Consent Mode</th>
                    <th>Identifier Fields</th>
                    <th className={styles.num}>Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {activeArm.beacons.map((b, i) => (
                    <tr key={`${b.platform}-${b.endpointHost}-${i}`}>
                      <td>
                        <strong>{b.platform}</strong>
                        <div style={{ color: "var(--text-subtle)" }}>{b.product}</div>
                      </td>
                      <td className={styles.mono}>{b.endpointHost}</td>
                      <td>
                        {b.serverSideTagging ? (
                          <span className={`${styles.chip} ${styles.chipWarn}`}>1st-party sGTM / CAPI</span>
                        ) : (
                          "Standard"
                        )}
                      </td>
                      <td className={styles.mono}>
                        {b.events.join(", ") || "—"}
                        {b.scrollDepths.length > 0 ? ` (scroll: ${b.scrollDepths.join("%, ")}%)` : ""}
                      </td>
                      <td className={styles.mono}>
                        {b.consentModeSignals.length > 0
                          ? b.consentModeSignals
                              .map((c) => `${c.gcs ?? "gcd"} (ad:${c.adStorage}, an:${c.analyticsStorage})`)
                              .join("; ")
                          : "—"}
                      </td>
                      <td className={styles.mono}>
                        {b.identifierCategories.length > 0 ? (
                          <span className={`${styles.chip} ${styles.chipLoud}`}>
                            {b.identifierCategories.join(", ")}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={styles.num}>{b.requests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === "cookies" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className={styles.tableWrap}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Cookies ({activeArm.cookies.length})</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Domain</th>
                    <th>Party / CHIPS</th>
                    <th>Set Via</th>
                    <th className={styles.num}>TTL (days)</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {activeArm.cookies.map((c, idx) => (
                    <tr key={`${c.domain}-${c.name}-${idx}`}>
                      <td className={styles.mono}>{c.name}</td>
                      <td className={styles.mono}>{c.domain}</td>
                      <td>
                        {c.thirdParty ? "3P" : "1P"}
                        {c.partitionKey ? ` · CHIPS (${c.partitionKey})` : ""}
                      </td>
                      <td className={styles.mono}>{c.setVia}</td>
                      <td className={styles.num}>{c.session ? "Session" : c.ttlDays ?? "—"}</td>
                      <td className={styles.mono}>
                        {[c.secure ? "Secure" : "", c.httpOnly ? "HttpOnly" : "", c.sameSite]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.tableWrap}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>
                Multi-Origin Storage ({activeArm.storage.length}) · WebSockets ({activeArm.websockets.length}) · Service
                Workers ({activeArm.serviceWorkers.length})
              </h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Origin</th>
                    <th>Key / Store (values redacted)</th>
                    <th className={styles.num}>Value Bytes / Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {activeArm.storage.map((st, idx) => (
                    <tr key={`${st.origin}-${st.area}-${st.keyOrStore}-${idx}`}>
                      <td className={styles.mono}>{st.area}</td>
                      <td className={styles.mono}>{st.origin}</td>
                      <td className={styles.mono}>{st.keyOrStore}</td>
                      <td className={styles.num}>
                        {st.entryCount !== undefined ? `${st.entryCount} entries` : `${st.valueBytes} B`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "privacy-signals" && (
          <div style={{ display: "grid", gap: 16 }}>
            <div className={styles.causalityCard}>
              <strong>
                Consent Banner Audit — Score {activeArm.consent.banner.darkPatternScore}/100 (
                {activeArm.consent.banner.cmp ?? "No CMP detected"})
              </strong>
              <div className={styles.chipsRow}>
                <span className={styles.chip}>
                  Layer 1 Accept: {activeArm.consent.banner.hasFirstLayerAccept ? "Yes" : "No"}
                </span>
                <span className={styles.chip}>
                  Layer 1 Reject: {activeArm.consent.banner.hasFirstLayerReject ? "Yes" : "No"}
                </span>
                <span className={styles.chip}>
                  Clicks Accept/Reject: {activeArm.consent.banner.clicksToAccept ?? "—"} /{" "}
                  {activeArm.consent.banner.clicksToReject ?? "—"}
                </span>
                <span className={styles.chip}>
                  Verification: {activeArm.consent.verification.consistency} (TCF:
                  {activeArm.consent.verification.tcf.state}, GPP:{activeArm.consent.verification.gpp.state})
                </span>
              </div>
              {activeArm.consent.banner.darkPatternFlags.length > 0 && (
                <div className={styles.chipsRow}>
                  {activeArm.consent.banner.darkPatternFlags.map((flag) => (
                    <span key={flag} className={`${styles.chip} ${styles.chipWarn}`}>
                      {flag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {activeArm.cnameCloaks.length > 0 && (
              <div className={styles.tableWrap}>
                <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>CNAME-Cloaked Trackers</h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>First-Party Subdomain</th>
                      <th>CNAME Chain</th>
                      <th>Uncloaked Entity</th>
                      <th className={styles.num}>Requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeArm.cnameCloaks.map((c) => (
                      <tr key={c.host}>
                        <td className={styles.mono}>{c.host}</td>
                        <td className={styles.mono}>{c.cnameChain.join(" → ")}</td>
                        <td>
                          {c.entity.entity} ({c.entity.parentOrg})
                        </td>
                        <td className={styles.num}>{c.requestCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeArm.fingerprinting.length > 0 && (
              <div className={styles.tableWrap}>
                <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Fingerprinting &amp; DOM Replay Signals</h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Signal Kind</th>
                      <th>Realms</th>
                      <th className={styles.num}>Calls</th>
                      <th>APIs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeArm.fingerprinting.map((f) => (
                      <tr key={f.kind}>
                        <td className={styles.mono}>{f.kind}</td>
                        <td className={styles.mono}>{f.realms.join(", ")}</td>
                        <td className={styles.num}>{f.count}</td>
                        <td className={styles.mono}>{f.apis.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className={styles.causalityCard}>
              <strong>
                Active Keystroke Probe ({activeArm.keystrokes.fieldsTyped} fields typed —{" "}
                {activeArm.keystrokes.iframeFieldsTyped} iframe, {activeArm.keystrokes.shadowDomFieldsTyped} Shadow DOM)
              </strong>
              {activeArm.keystrokes.leaks.length === 0 ? (
                <p className={styles.subtitle}>No pre-submission keystroke exfiltration observed.</p>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {activeArm.keystrokes.leaks.map((l, idx) => (
                    <li key={idx} className={styles.mono}>
                      {l.domain} ({l.transport}, {l.encoding}
                      {l.cnameTarget ? `, CNAME→${l.cnameTarget}` : ""})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {activeTab === "policy" && (
          <div>
            {!activeArm.policy ? (
              <div className={styles.emptyState}>No privacy policy page was discovered during this visit.</div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <strong>Policy URL:</strong> <span className={styles.mono}>{activeArm.policy.url}</span> (lang:{" "}
                  {activeArm.policy.language ?? "unknown"}, {activeArm.policy.textLength} chars
                  {activeArm.policy.fromIframe ? ", discovered in iframe" : ""})
                </div>
                {activeArm.policy.claims.length > 0 && (
                  <div>
                    <strong>Extracted Claims</strong>
                    <ul>
                      {activeArm.policy.claims.map((cl, i) => (
                        <li key={i}>
                          <code>{cl.kind}</code>: &ldquo;{cl.quote}&rdquo;
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className={styles.chipsRow}>
                  {activeArm.policy.mentionedEntities.map((m) => (
                    <span key={m} className={`${styles.chip} ${styles.chipOk}`}>
                      Mentioned: {m}
                    </span>
                  ))}
                  {activeArm.policy.unmentionedEntities.map((u) => (
                    <span key={u} className={`${styles.chip} ${styles.chipWarn}`}>
                      Not mentioned: {u}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </section>
    </>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function formatUtcTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
