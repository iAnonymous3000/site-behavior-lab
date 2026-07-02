"use client";

import { Upload } from "lucide-react";
import type { ReactNode } from "react";

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
          const handled = onError
            ? onSelect(file).catch((error) =>
                onError(error instanceof Error ? error.message : "Report JSON could not be opened.")
              )
            : onSelect(file);
          void handled.finally(() => {
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
