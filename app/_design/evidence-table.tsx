import type { DomainEvidenceTable } from "@/lib/domain-evidence-table";
import { DOMAIN_TABLE_SHARED_COPY as COPY } from "@/lib/domain-evidence-table";
import { LimitLine } from "./limit-line";

const STRIP_WIDTH = 400;

/**
 * The busiest recorded domains of one visit, each with a time strip: one tick
 * per retained request row, placed by when the request started.
 *
 * Server-rendered and bounded (lib/domain-evidence-table.ts); the overflow
 * line says how many domains it leaves to the evidence explorer. On a narrow
 * screen each row becomes a block and every cell keeps its column name.
 */
export function EvidenceTable({ table }: { table: DomainEvidenceTable }) {
  if (table.rows.length === 0) return null;
  return (
    <section aria-labelledby="domain-table-title">
      <div className="a-tbl-h">
        <h2 id="domain-table-title">{COPY.heading}</h2>
        <span>{table.countLabel}</span>
      </div>
      {/* Keyed by position: a key holding the text would store it twice. */}
      {table.notes.map((note, index) => <LimitLine className="a-tbl-l" key={index}>{note}</LimitLine>)}
      <div className="a-tbl-scroll">
        <table className="a-ev">
          <caption className="a-vh">{table.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{COPY.columnDomain}</th>
              <th scope="col" className="a-num">{COPY.columnRequests}</th>
              <th scope="col">{table.whenColumn}</th>
              <th scope="col">{COPY.columnCatalogMatch}</th>
              <th scope="col">{COPY.columnRole}</th>
              <th scope="col">{COPY.columnResourceTypes}</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr className={row.site ? "is-site" : undefined} key={index}>
                <td className="a-h">{row.host}</td>
                <td className="a-num">{row.requests.toLocaleString("en-US")}</td>
                <td className="a-t">
                  <svg
                    className="a-strip"
                    viewBox={`0 0 ${STRIP_WIDTH} 10`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={row.stripLabel}
                  >
                    <path d={row.ticks.map((tick) => `M${Math.round(tick * STRIP_WIDTH * 10) / 10} 0V10`).join("")} />
                  </svg>
                </td>
                <td className="a-c">
                  {row.catalogMatch ?? <span className="a-q">{COPY.noCatalogMatch}</span>}
                </td>
                <td className="a-e a-x" data-l={COPY.columnRole}>{row.role}</td>
                <td className="a-x" data-l={COPY.columnResourceTypes}>{row.resourceTypes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.overflow && <p className="a-tbl-f">{table.overflow}</p>}
    </section>
  );
}
