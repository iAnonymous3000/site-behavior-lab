"use client";

import { Upload } from "lucide-react";
import type { ReactNode } from "react";

// Reports (even comparisons with two inline screenshots) stay well under a few
// megabytes, and PageGraph exports under a few tens; anything past this bound
// is not a plausible artifact and would only stall the tab in JSON/XML parsing.
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

// Shared file-picker button. Resets the input after each pick so re-selecting
// the same file fires onChange again; an optional onError surfaces a rejected
// selection (callers that handle their own errors omit it).
export function FileUploadButton({
  accept,
  onSelect,
  onError,
  children
}: {
  accept: string;
  onSelect: (file: File | null) => Promise<void>;
  onError?: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="secondary-button file-button">
      <Upload size={17} aria-hidden="true" />
      {children}
      <input
        type="file"
        accept={accept}
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0] ?? null;
          const handled =
            file && file.size > MAX_UPLOAD_BYTES
              ? Promise.reject(
                  new Error(
                    `That file is ${Math.round(file.size / 1024 / 1024)} MB; uploads are limited to ${
                      MAX_UPLOAD_BYTES / 1024 / 1024
                    } MB.`
                  )
                )
              : onSelect(file);
          // Always catch: the size rejection is minted here (it never reaches
          // onSelect), so without this a caller that handles its own onSelect
          // errors would still leak an unhandled rejection.
          const surfaced = handled.catch((error) => {
            const message = error instanceof Error ? error.message : "Report JSON could not be opened.";
            if (onError) onError(message);
            else console.error(message);
          });
          void surfaced.finally(() => {
            input.value = "";
          });
        }}
      />
    </label>
  );
}

export function ReportUploadButton({
  onUploadReport,
  children
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <FileUploadButton accept="application/json,.json" onSelect={onUploadReport}>
      {children}
    </FileUploadButton>
  );
}

export function PageGraphUploadButton({
  onUploadReport,
  children
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <FileUploadButton accept=".graphml,.xml,application/xml,text/xml" onSelect={onUploadReport}>
      {children}
    </FileUploadButton>
  );
}
