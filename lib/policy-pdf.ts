import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Hard resource bounds for a policy document fetched outside the page. */
export const MAX_POLICY_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_POLICY_PDF_PAGES = 64;

/**
 * Extract policy text from an already SSRF-checked, size-bounded PDF.
 *
 * `null` means the document cannot support a complete policy cross-check: it
 * is malformed/encrypted, exceeds a declared bound, or contains no usable
 * text. Returning a prefix would be a fail-open because later policy claims
 * could live in the omitted portion, so every bound is all-or-nothing.
 */
export async function extractPolicyTextFromPdf(
  bytes: Uint8Array,
  maxTextChars: number
): Promise<string | null> {
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAX_POLICY_PDF_BYTES ||
    maxTextChars <= 0 ||
    !hasPdfSignature(bytes)
  ) {
    return null;
  }

  // PDF.js transfers its input buffer to its worker. Give it a private copy so
  // the caller's bounded byte accounting cannot be detached as a side effect.
  const loadingTask = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    useWasm: false
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages <= 0 || document.numPages > MAX_POLICY_PDF_PAGES) return null;

    let text = "";
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
        const itemSeparator = pageText.length === 0 ? "" : " ";
        const pageSeparator = text.length === 0 ? "" : "\n";
        if (
          text.length +
            pageSeparator.length +
            pageText.length +
            itemSeparator.length +
            item.str.length >
          maxTextChars
        ) {
          return null;
        }
        pageText += `${itemSeparator}${item.str}`;
      }
      pageText = pageText.trim();
      if (pageText.length === 0) continue;
      const separator = text.length === 0 ? "" : "\n";
      text += `${separator}${pageText}`;
    }
    return text.trim() || null;
  } catch {
    return null;
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
