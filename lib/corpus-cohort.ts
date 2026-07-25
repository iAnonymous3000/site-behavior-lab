import { legacyV1MethodologyIdentity } from "./legacy-methodology";
import { displayRunView, type ReportView } from "./scan-report-views";

/**
 * Public, auditable identity for one statistical measurement cohort.
 *
 * Schema revision and methodology are deliberately part of the key. Producer
 * identity is included when it was recorded because PageGraph imports and
 * browser observations do not measure the same evidence surface. Build,
 * browser patch, acquisition route, and egress remain row-level provenance:
 * splitting on each of those would turn every deployment into an unusably
 * small cohort, while methodologyVersion is the producer's reviewed promise
 * about when the meaning of the measurements changes.
 *
 * The requested GPC state joins them because it is a measured condition, not
 * environment: comparison eligibility already refuses to compare two arms that
 * differ in it. It also changed what the corpus could observe at all. While
 * every lane sent GPC, the injector could not add the signal to a blob: worker
 * without changing that realm's origin, so it blocked those workers and
 * censored the request family on 80 committed reports across 30 domains. Their
 * truncated floors already median 93 third-party requests to the measured
 * population's 25, so pooling the two eras would pool two different inclusion
 * criteria and move published percentiles by an unmarked amount.
 */
export type CorpusCohortIdentity = {
  id: string;
  schemaVersion: 1 | 2;
  schemaRevision: 1 | 2 | null;
  methodologyVersion: string;
  methodologyOrigin: "recorded" | "legacy-derived";
  producer: string | null;
  /** Whether the cohort's lead runs requested Global Privacy Control. */
  gpc: boolean;
};

export function corpusCohortIdentityForView(view: ReportView): CorpusCohortIdentity {
  const run = displayRunView(view);
  const methodologyVersion =
    run.provenance?.methodologyVersion ?? legacyV1MethodologyIdentity(run.conditions.disclosure ?? undefined);
  const producer = run.provenance?.observer ?? null;
  const schemaVersion = view.origin === "v2" ? 2 : 1;
  const schemaRevision = view.revision;
  const schema = schemaVersion === 1 ? "v1" : `v2-r${schemaRevision}`;
  const producerKey = producer ?? "producer-unrecorded";
  const gpc = run.conditions.gpcEnabled;

  return {
    id: `${schema}:${encodeURIComponent(methodologyVersion)}:${encodeURIComponent(producerKey)}:gpc-${gpc ? "on" : "off"}`,
    schemaVersion,
    schemaRevision,
    methodologyVersion,
    methodologyOrigin: run.provenance ? "recorded" : "legacy-derived",
    producer,
    gpc
  };
}
