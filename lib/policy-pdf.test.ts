import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPolicyTextFromPdf,
  MAX_POLICY_PDF_BYTES
} from "./policy-pdf";

test("extractPolicyTextFromPdf reads a bounded text policy", async () => {
  const policyText =
    "Privacy Policy. We collect information and use cookies for analytics. ".repeat(12);
  const extracted = await extractPolicyTextFromPdf(pdfWithText(policyText), 10_000);

  assert.ok(extracted?.startsWith("Privacy Policy."));
  assert.ok((extracted?.length ?? 0) >= 500);
});

test("extractPolicyTextFromPdf fails closed on malformed and truncated inputs", async () => {
  const policy = pdfWithText("Privacy Policy. ".repeat(40));

  assert.equal(await extractPolicyTextFromPdf(policy, 20), null);
  assert.equal(await extractPolicyTextFromPdf(new TextEncoder().encode("not a pdf"), 10_000), null);
  assert.equal(
    await extractPolicyTextFromPdf(new Uint8Array(MAX_POLICY_PDF_BYTES + 1), 10_000),
    null
  );
});

function pdfWithText(text: string): Uint8Array {
  const textCommands = (text.match(/.{1,60}(?:\s|$)/g) ?? [text])
    .map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"))
    .map((line) => `(${line}) Tj\n0 -14 Td`)
    .join("\n");
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${textCommands}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n", "latin1")];
  const offsets = [0];
  let byteLength = parts[0].byteLength;
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    parts.push(bytes);
    byteLength += bytes.byteLength;
  });
  const xrefOffset = byteLength;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}
