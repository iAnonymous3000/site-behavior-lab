export const MAX_PAGEGRAPH_UPLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PAGEGRAPH_METADATA_BYTES = 256 * 1024;

export type PageGraphUploadSelection = {
  graphml: File;
  metadata: File;
};

/** Resolve one same-stem GraphML + metadata pair from an untrusted picker. */
export function pageGraphUploadSelection(files: readonly File[]): PageGraphUploadSelection {
  if (files.length !== 2) {
    throw new Error("Choose exactly two files: one PageGraph .graphml capture and its matching .meta.json sidecar.");
  }
  const graphml = files.find((file) => /\.(?:graphml|xml)$/i.test(file.name));
  const metadata = files.find((file) => /\.meta\.json$/i.test(file.name));
  if (!graphml || !metadata || graphml === metadata) {
    throw new Error("Choose one PageGraph .graphml capture and one matching .meta.json sidecar.");
  }
  if (graphml.size <= 0 || graphml.size > MAX_PAGEGRAPH_UPLOAD_BYTES) {
    throw new Error(`PageGraph captures must be between 1 byte and ${MAX_PAGEGRAPH_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_PAGEGRAPH_METADATA_BYTES) {
    throw new Error(`PageGraph metadata must be between 1 byte and ${MAX_PAGEGRAPH_METADATA_BYTES / 1024} KB.`);
  }
  const graphBase = graphml.name.replace(/\.(?:graphml|xml)$/i, "");
  const metadataBase = metadata.name.replace(/\.meta\.json$/i, "");
  if (graphBase !== metadataBase) {
    throw new Error("The PageGraph capture and metadata sidecar must share the same base filename.");
  }
  return { graphml, metadata };
}
