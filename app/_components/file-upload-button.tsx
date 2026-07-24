"use client";

import { Upload } from "lucide-react";
import type { ReactNode } from "react";
import {
  pageGraphUploadSelection,
  type PageGraphUploadSelection
} from "@/lib/pagegraph-upload-selection";
import { assertClientFileReadable } from "@/lib/client-file-policy";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "@/lib/report-resource-limits";

export { pageGraphUploadSelection } from "@/lib/pagegraph-upload-selection";
export type { PageGraphUploadSelection } from "@/lib/pagegraph-upload-selection";

// Keep local report uploads at the same decompressed byte ceiling as fetched
// reports. The actual report readers repeat this check before File.text().
export const MAX_UPLOAD_BYTES = BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES;

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
          const handled = Promise.resolve()
            .then(() => {
              if (file) {
                assertClientFileReadable(file, {
                  label: "That report file",
                  maxBytes: MAX_UPLOAD_BYTES
                });
              }
            })
            .then(() => onSelect(file));
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
  onError,
  children
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  onError?: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <FileUploadButton accept="application/json,.json" onSelect={onUploadReport} onError={onError}>
      {children}
    </FileUploadButton>
  );
}

/**
 * Revision-2 PageGraph picker. Both the GraphML and its exact digest-bound
 * `.meta.json` sidecar are mandatory; selecting an arbitrary GraphML alone
 * can no longer mint guessed capture conditions.
 */
export function PageGraphR2UploadButton({
  onUploadPair,
  onError,
  children
}: {
  onUploadPair: (selection: PageGraphUploadSelection) => Promise<void>;
  onError?: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="secondary-button file-button">
      <Upload size={17} aria-hidden="true" />
      {children}
      <input
        type="file"
        multiple
        accept=".graphml,.xml,.meta.json,application/xml,text/xml,application/json"
        onChange={(event) => {
          const input = event.currentTarget;
          const surfaced = Promise.resolve()
            .then(() => pageGraphUploadSelection(Array.from(input.files ?? [])))
            .then(onUploadPair)
            .catch((error) => {
              const message = error instanceof Error ? error.message : "PageGraph capture files could not be opened.";
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
