import { inspectedAddressFromRowUrl } from "./connection-inspection-address";
import { INSPECT_CONNECTION_LINK } from "./connection-inspection-copy";
import { scanInspectHref } from "./scan-prefill";
import type { NetworkRequestRecord } from "./types";

/**
 * What a request log row's "Inspect this connection" link needs: the page to
 * visit again (reportNewVisitTarget), the fresh result's own share report id
 * when it has one, and the deployment's base path. Absent everywhere a row
 * offers no link: a report that is not fresh, a page that cannot be visited
 * again, a visit that did not establish the page, a scanner whose results
 * cannot carry an inspection, and paper.
 */
export type RequestInspectionContext = {
  page: string;
  from: string | null;
  basePath: string;
};

export type RequestInspectionLink = {
  href: string;
  /** The published address the link inspects: the row's URL, query dropped. */
  address: string;
  label: string;
  /** The accessible name: the label and the address, as the row shows it. */
  name: string;
};

/**
 * A row's link, for a third-party row whose published address the scan form
 * accepts; null for a first-party row and for a row redaction could not
 * publish. The one minter the explorer renders, so a test can hold every
 * committed row's link to the form and the gate.
 */
export function requestInspectionLink(
  request: Pick<NetworkRequestRecord, "thirdParty" | "url">,
  context: RequestInspectionContext
): RequestInspectionLink | null {
  if (!request.thirdParty) return null;
  const address = inspectedAddressFromRowUrl(request.url);
  const prefill = address ? scanInspectHref(context.page, address, context.from) : null;
  if (!address || !prefill) return null;
  return {
    href: `${context.basePath}${prefill}`,
    address,
    label: INSPECT_CONNECTION_LINK.label,
    name: INSPECT_CONNECTION_LINK.name(address)
  };
}
