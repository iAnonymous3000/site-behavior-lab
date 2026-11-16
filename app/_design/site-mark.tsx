/**
 * The site's mark: the request figure in small, its own four signs in the
 * figure's order. Three same-site marks; two cross-site marks and the open
 * box that ends a lane whose count is a lower bound; the hatched band of the
 * Not measured row. The Tracer cells are the figure's cross-site sign, the one
 * use of Tracer outside a figure's data (tokens.css).
 *
 * Cells of 4 with gaps of 1 on a 14 square. Colours and size come from the
 * stylesheet (base.css), so the mark follows the theme, forced colors and
 * print. It is decoration beside the wordmark, which names the site: hidden
 * from assistive technology, with no text of its own. The tab icon
 * (app/icon.svg) and the share card (lib/og-report-card.tsx) draw the same
 * figure.
 */
export function SiteMark() {
  return (
    <svg className="a-mark" width="1em" height="1em" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="a-mark-hatch" patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(45)">
          <rect width="0.5" height="1.6" />
        </pattern>
      </defs>
      <path className="a-mark-same" d="M0 0h4v4H0zM5 0h4v4H5zM10 0h4v4h-4z" />
      <path className="a-mark-cross" d="M0 5h4v4H0zM5 5h4v4H5z" />
      <path className="a-mark-open" d="M10.5 5.5h3v3h-3z" />
      <path d="M0 10h14v4H0z" fill="url(#a-mark-hatch)" />
    </svg>
  );
}
