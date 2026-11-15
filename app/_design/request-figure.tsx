import type { CSSProperties } from "react";
import {
  figureMarks,
  type RequestFigure as RequestFigureData,
  type RequestFigureRow
} from "@/lib/request-figure";

/**
 * Where a visit's requests went: one mark per retained request row.
 *
 * Solid marks are rows on record. A visit whose request evidence was cut
 * short ends each row of marks in an open-ended box: the count is a lower
 * bound. What the visit could not see is listed under hatching, from the
 * same leads the visit summary prints below the bottom line.
 *
 * Server-rendered and static: no script, and color carries only same site
 * against cross-site, stated again in words in every row and in the legend.
 * The legend says "cross-site", not "another site": a different domain is
 * not by itself a different operator.
 */
export function RequestFigure({
  figure,
  notMeasured
}: {
  figure: RequestFigureData;
  /** What the visit could not see, one short phrase each. */
  notMeasured: readonly string[];
}) {
  const labelled = figure.visits.length > 1;
  return (
    <figure className="a-plate" aria-labelledby="request-figure-title">
      <div className="a-plate-h">
        <h2 className="a-plate-t" id="request-figure-title">{figure.title}</h2>
        <p className="a-plate-s">{figure.caption}</p>
      </div>
      {figure.visits.map((visit) => (
        // One group per visit. On a two-visit figure print may break between
        // the groups and never inside one (components.css).
        <div className={labelled ? "a-visit is-one-of-two" : "a-visit"} key={visit.label ?? "visit"}>
          {labelled && <h3 className="a-visit-label">{visit.label}</h3>}
          {visit.rows.length === 0 && <p className="a-plate-n">{figure.unsupported}</p>}
          {visit.rows.map((row) => (
            <div className="a-dest" key={row.kind}>
              <div className="a-dest-l">
                <b>{row.name}</b>
                <span className="a-n">{row.countPhrase}</span>
                <small>{row.note}</small>
              </div>
              <Marks row={row} lowerBound={visit.lowerBound} />
            </div>
          ))}
        </div>
      ))}
      {notMeasured.length > 0 && (
        <div className="a-unm">
          <div className="a-dest-l">
            <b>{figure.notMeasuredTitle}</b>
            <small>{figure.notMeasuredNote}</small>
          </div>
          <ul>
            {notMeasured.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {/* The key's marks are single fixed elements, not text: it prints as it shows. */}
      <ul className="a-key" aria-label="Key">
        <li><span className="a-marks is-site" aria-hidden="true"><i /></span>{figure.legend.site}</li>
        <li><span className="a-marks" aria-hidden="true"><i /></span>{figure.legend.crossSite}</li>
        {figure.legend.lowerBound && (
          <li><span className="a-marks" aria-hidden="true"><span className="a-tail"><b className="a-open" /></span></span>{figure.legend.lowerBound}</li>
        )}
        <li><i className="a-hatch" aria-hidden="true" />{figure.legend.notMeasured}</li>
      </ul>
    </figure>
  );
}

/**
 * The count is stated in words beside the marks, so the marks are decoration
 * to a screen reader.
 *
 * A row's marks are one run of text, one character per retained request row,
 * and never one element per mark: a report page is stored several times over
 * in the static export, and an element per request made the figure the
 * heaviest thing on it. The stylesheet draws each character as a square.
 *
 * On a lower bound the open-ended box is bound to the last mark in one group
 * that cannot wrap, so a full row sends the last mark down with the box.
 * Alone at the start of a row the box reads as a stray mark.
 *
 * Paper does not get the run: its characters would sit in a PDF's text layer
 * and copy out as zeros. Print hides the run and shows two blocks of constant
 * markup instead, sized by two numbers: one block of `--r` full rows of 60
 * squares and one of `--m` squares for the last row, each cut into squares by
 * the tile the run uses. The open-ended box follows the last square, in
 * columns kept free for it.
 */
function Marks({ row, lowerBound }: { row: RequestFigureRow; lowerBound: boolean }) {
  const marks = figureMarks(row.count, lowerBound);
  const { fullRows, remainder } = marks.print;
  return (
    <p className={`a-marks${row.kind === "site" ? " is-site" : ""}`} aria-hidden="true">
      {marks.run !== "" && <span className="a-run">{marks.run}</span>}
      {fullRows > 0 && <i className="a-pf" style={{ "--r": fullRows } as CSSProperties} />}
      {remainder > 0 && <i className="a-pm" style={{ "--m": remainder } as CSSProperties} />}
      {marks.held !== null && (
        <span className="a-tail">
          {marks.held !== "" && <span className="a-run">{marks.held}</span>}
          <b className="a-open" />
        </span>
      )}
    </p>
  );
}
