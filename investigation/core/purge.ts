// What a case's raw tier still holds, as a read of a manifest. No route purges anything
// yet: this is the rule a route will have to satisfy, and nothing here removes an object.
//
// The reducer takes the closed flag and the manifest and nothing else, on purpose. That
// is what lets a later exploration walk it apart from the case machine, and widening its
// signature would take that justification away. investigation/test/purge.test.ts pins it.
// What a manifest must list is read from the log, so that rule is in the fold, in
// case-store.ts, and not here. That rule is also what lets a manifest be empty: a case in which
// no attempt began has exactly nothing to list. So no manifest yet is null, and differs from an
// empty one. Either way a manifest speaks only to what the log names: bytes uploaded ahead of a
// row that was never written are named by nothing, and no manifest covers them.
//
// A path is an object's address, a digest. It is never a URL or a key from a capture, since a
// path can carry an email. The log's decoder refuses anything else before it gets here.

export type PathState = "present" | "absent" | "remains";
export type ManifestPath = Readonly<{ path: string; state: PathState }>;
export type PurgeManifest = readonly ManifestPath[];

export type PurgeEvent =
  | Readonly<{ type: "purge-manifest-recorded"; paths: readonly string[] }>
  | Readonly<{ type: "purge-path-absent"; path: string }>
  | Readonly<{ type: "purge-path-remains"; path: string }>;

export type PurgeRefusal = "case-open" | "manifest-already-recorded" | "manifest-malformed" | "no-such-path" | "path-status-unchanged";

export type PurgeResult = Readonly<{ ok: true; manifest: PurgeManifest }> | Readonly<{ ok: false; refusal: PurgeRefusal }>;

export type RetentionTier = "RAW_HELD" | "SUMMARY_ONLY";

function withPath(manifest: PurgeManifest | null, path: string, state: PathState): PurgeResult {
  if (manifest === null) return { ok: false, refusal: "no-such-path" };
  const entry = manifest.find((candidate) => candidate.path === path);
  if (entry === undefined) return { ok: false, refusal: "no-such-path" };
  if (entry.state === state) return { ok: false, refusal: "path-status-unchanged" };
  return { ok: true, manifest: manifest.map((candidate) => (candidate.path === path ? { path, state } : candidate)) };
}

/**
 * One purge event. A repeat of a path's status is refused, so no event leaves a state where it
 * was. A path read as absent can still read as remaining later, and absent after that, since
 * what a listing found last is what is true: so purge states can return, unlike the capture
 * events', and nothing in this reducer may make an object reappear on paper or vanish on it.
 */
export function purgeStep(closed: boolean, manifest: PurgeManifest | null, event: PurgeEvent): PurgeResult {
  if (!closed) return { ok: false, refusal: "case-open" };
  switch (event.type) {
    case "purge-manifest-recorded":
      if (manifest !== null) return { ok: false, refusal: "manifest-already-recorded" };
      if (new Set(event.paths).size !== event.paths.length) return { ok: false, refusal: "manifest-malformed" };
      return { ok: true, manifest: event.paths.map((path) => ({ path, state: "present" })) };
    case "purge-path-absent":
      return withPath(manifest, event.path, "absent");
    case "purge-path-remains":
      return withPath(manifest, event.path, "remains");
  }
}

/**
 * SUMMARY_ONLY only when a manifest exists and every path on it is confirmed absent. No manifest
 * says nothing was listed, not that everything is gone, so it is not SUMMARY_ONLY. An empty one
 * says the log names nothing to remove and that no attempt began, which the fold holds it to. In
 * every case this reads what the log names, and says nothing of an object nothing names.
 */
export function retentionTier(manifest: PurgeManifest | null): RetentionTier {
  if (manifest === null) return "RAW_HELD";
  return manifest.every((entry) => entry.state === "absent") ? "SUMMARY_ONLY" : "RAW_HELD";
}
