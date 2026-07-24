/**
 * Deterministic newest-report selection shared by corpus statistics, exports,
 * and directory rollups. Timestamps normally decide. If two immutable reports
 * record the same instant, the lexicographically larger report id wins so the
 * result is stable regardless of filesystem or input iteration order.
 */
export type CorpusRepresentativeRef = {
  id: string;
  scannedAt: string;
};

export function preferCorpusRepresentative(
  candidate: CorpusRepresentativeRef,
  current: CorpusRepresentativeRef
): boolean {
  const candidateAt = Date.parse(candidate.scannedAt);
  const currentAt = Date.parse(current.scannedAt);
  if (Number.isFinite(candidateAt) && Number.isFinite(currentAt) && candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  if (Number.isFinite(candidateAt) !== Number.isFinite(currentAt)) return Number.isFinite(candidateAt);
  return candidate.id.localeCompare(current.id) > 0;
}
