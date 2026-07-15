import { siteProfileKey } from "./site-profile";

/** The corpus and public history pages share one PSL-aware site identity. */
export function corpusSiteDomainKey(value: string): string {
  return siteProfileKey(value) ?? "";
}
