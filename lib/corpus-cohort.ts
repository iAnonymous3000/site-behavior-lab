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
 */
export type CorpusCohortIdentity = {
  id: string;
  schemaVersion: 1 | 2;
  schemaRevision: 1 | 2 | null;
  methodologyVersion: string;
  methodologyOrigin: "recorded" | "legacy-derived";
  producer: string | null;
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

  return {
    id: `${schema}:${encodeURIComponent(methodologyVersion)}:${encodeURIComponent(producerKey)}`,
    schemaVersion,
    schemaRevision,
    methodologyVersion,
    methodologyOrigin: run.provenance ? "recorded" : "legacy-derived",
    producer
  };
}
