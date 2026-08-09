import {
  createIndexedPrivateResponseSink,
  destroyIndexedPrivateResponseDirectory
} from "./staging-teardown-target-private-io.mjs";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Enforce the raw-byte custody boundary around an injected capture operation.
 * writeOutput is unreachable until authoritative private-directory destruction
 * succeeds, and is never called for a failed capture.
 */
export async function runStagingTeardownTargetCaptureCommand({
  privateDirectory,
  capture,
  writeOutput
}) {
  requireValue(typeof capture === "function", "target capture operation is required");
  requireValue(typeof writeOutput === "function", "target capture output writer is required");
  const sink = createIndexedPrivateResponseSink(privateDirectory);
  let captured;
  let captureError;
  try {
    captured = await capture(sink.persistRaw);
  } catch (error) {
    captureError = error;
  }
  let cleanupError;
  try {
    destroyIndexedPrivateResponseDirectory(sink.directory);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    throw new Error("private provider response destruction failed");
  }
  if (captureError !== undefined) throw captureError;
  return writeOutput(captured);
}
