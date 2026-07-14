/** Preserve both the Node container's readiness and the edge gate's refusal. */
export function scansAvailableAfterEdgeOverlay(
  containerScansAvailable: unknown,
  edgeRefusals: readonly string[]
): boolean {
  return containerScansAvailable !== false && edgeRefusals.length === 0;
}
