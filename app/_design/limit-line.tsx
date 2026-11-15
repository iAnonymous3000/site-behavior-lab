import { useId, type ReactNode } from "react";

/**
 * A limit: the sentence that says what a claim does not establish.
 *
 * Always on the page beside its claim. When a limit has more behind it, the
 * limit sentence itself is the disclosure control, so opening or closing can
 * add to what a reader sees and never take the limit away. With nothing behind
 * it, it is a plain line.
 *
 * The control is a native details that holds only its summary. The text
 * behind the line is rendered once, in the element directly after the
 * details, which the summary names with aria-controls. On screen that element
 * shows while the details is open. On paper it always shows, by a plain rule
 * of its own that does not depend on how a browser prints a closed details
 * (app/_design/components.css). A second copy for paper was tried and cost
 * 24 MB across the committed reports; printing from inside the details would
 * leave the text to each browser's handling of a closed one.
 *
 * Pass `details` only where the evidence layer supplies a limit sentence and
 * its elaboration as two separate strings. Never split one string here.
 */
export function LimitLine({
  children,
  details,
  className,
  id
}: {
  children: ReactNode;
  /** Paragraphs behind the limit line. Omit to render the line alone. */
  details?: readonly string[];
  className?: string;
  id?: string;
}) {
  const behindId = useId();
  const classes = `a-lim${className ? ` ${className}` : ""}`;
  if (!details || details.length === 0) {
    return <p className={classes} id={id}>{children}</p>;
  }
  // Keyed by position: a key holding the paragraph would put its whole text
  // into the page data a second time.
  return (
    <>
      <details className={classes} id={id}>
        <summary aria-controls={behindId}>
          {children}
          {/* The space before the control sits inside a span that does not
              wrap, so the line cannot break between the sentence's last word
              and the control: "Details" never stands alone on a line. The
              same characters as before; the sentence is not touched. The
              two spans carry no class: the stylesheet finds them by place. */}
          <span>
            {" "}
            <span>Details</span>
          </span>
        </summary>
      </details>
      <div className="a-lim-behind" id={behindId}>
        {details.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
    </>
  );
}
