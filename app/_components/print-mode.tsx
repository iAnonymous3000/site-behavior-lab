"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this render is for paper rather than a screen.
 *
 * Screen deliberately renders evidence lazily: disclosures stay collapsed until
 * a reader opens them, tables cap their rows, and diff lists show the first few
 * with an expand control. Every one of those is a bet that the reader can ask
 * for more. Paper cannot ask, so a print that inherits them is not a compact
 * view of the evidence, it is silent truncation of it.
 *
 * A context rather than a prop because the flag has to reach four tables, a
 * state-change ledger and eight diff lists behind three wrapper components. A
 * prop threaded that far is a prop somebody eventually forgets on a new list,
 * and the failure mode is invisible: the page still renders, just missing
 * evidence, only on paper, only for reports large enough to hit the cap.
 *
 * Default false, so any component rendered outside a print tree keeps its
 * existing screen behaviour with no change.
 */
const PrintCompleteContext = createContext(false);

export function PrintCompleteProvider({
  children,
  value
}: {
  children: ReactNode;
  value: boolean;
}) {
  return <PrintCompleteContext.Provider value={value}>{children}</PrintCompleteContext.Provider>;
}

export function usePrintComplete(): boolean {
  return useContext(PrintCompleteContext);
}

const PrintVisitContext = createContext("");
export function PrintVisitProvider({ children, arm }: { children: ReactNode; arm: string }) {
  return <PrintVisitContext.Provider value={arm}>{children}</PrintVisitContext.Provider>;
}
/** Keep both printed visits addressable without duplicate DOM IDs. */
export function useEvidenceIds() {
  const arm = useContext(PrintVisitContext);
  return (id: string) => arm ? `${arm}-${id}` : id;
}
export function usePrintVisit() { return useContext(PrintVisitContext); }
