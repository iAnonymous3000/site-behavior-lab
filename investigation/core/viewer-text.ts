// How the viewer turns any string into markup: as text, every time.
//
// What a capture held, a URL, a host or a script, and what the owner wrote, reach a page only
// through escapeText. Markup characters become entities, so nothing in them can open or close
// an element, end a pre or a textarea, or break out of an attribute. A character a browser draws
// as nothing, or that reorders the text around it, becomes a visible token instead, such as
// `U+202E`. That class is every Default_Ignorable_Code_Point, among them the variation selectors,
// the tag characters, the Hangul fillers and the reserved code points the standard says to draw as
// nothing; every control but tab and line feed; every format character, astral ones included; the
// line and paragraph separators; every Bidi_Control; a lone surrogate; every space separator but
// the plain space; every private-use character, which a font may draw as nothing; every code point
// the engine's Unicode data leaves unassigned, the noncharacters among them, since fonts draw some
// of those as nothing too; and the braille blank and the object replacement character, which draw
// no ink either. Entity-encoding one of those would still render it, so it would still hide or
// reorder text. investigation/test/viewer.test.ts holds the class to range lists written from the
// Unicode data, checked against the engine's own properties, over every code point. Unassigned is
// the engine's own by design: it moves with the engine's Unicode version, and an engine that does
// not know a newer character shows it as a token, which fails safe.
//
// A space or a tab shows as itself in two places only: alone inside a line, and in indentation of
// spaces alone or tabs alone, at most MAX_INDENT of them, at the start of the string or of a line,
// with something after it on that line. Every other run of spaces and tabs shows as a count, such
// as `2 spaces 1 tab`: two or more inside a line, any run that ends a line or the string, a line of
// nothing else, indentation that mixes the two, and indentation longer than MAX_INDENT. What shows
// as itself is indentation of one kind up to MAX_INDENT and single blanks between other characters,
// so a line can still carry its indentation's length and kind, and one bit for each single blank,
// space or tab; all of it is drawn as visible spacing, a tab wider than a space, and none of it as
// nothing. A run is matched whole, with no lookahead, and judged by the characters on either side
// of it, never by reading along the line, so the work for each run does not grow with the line.
//
// Attribute values are only ever the viewer's own paths and ids. They go through escapeAttribute,
// which has no markup to offer: an unseen character there becomes U+FFFD.
//
// Pages are written with the html tag below, which reads where in the markup each value lands. In
// text, a value is escaped unless it is markup this module made. Inside a tag, the one value taken
// is the whole of a quoted attribute value, made by attribute(): never markup, never a name, never
// part of a value, never an unquoted one.

const UNSEEN = /(?![\t\n])\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}|\p{Cs}|\p{Default_Ignorable_Code_Point}|\p{Bidi_Control}|\p{Cn}|(?! )\p{Zs}|\p{Co}|[\u{2800}\u{FFFC}]/u;
/** A run of spaces and tabs, matched whole. Where it sits decides how it shows. */
const BLANKS = /[ \t]+/;
const TEXT_SPECIALS = new RegExp(`${BLANKS.source}|[&<>"']|${UNSEEN.source}`, "gu");

/** The most spaces, or the most tabs, that show as themselves as a line's indentation. */
export const MAX_INDENT = 64;
const ATTRIBUTE_SPECIALS = new RegExp(`[&<>"'\`=]|${UNSEEN.source}`, "gu");

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" };

/** The code point's name as a reader can see it, such as U+202E. A lone surrogate is one code unit. */
function codePointName(character: string): string {
  const point = character.codePointAt(0) as number;
  return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A run of spaces and tabs as a reader can count it, such as 2 spaces 1 tab. */
function blankCount(run: string): string {
  const spaces = run.split(" ").length - 1;
  const tabs = run.length - spaces;
  return [spaces === 0 ? "" : `${spaces} ${spaces === 1 ? "space" : "spaces"}`, tabs === 0 ? "" : `${tabs} ${tabs === 1 ? "tab" : "tabs"}`].filter((part) => part !== "").join(" ");
}

/**
 * Whether a run of spaces and tabs at `at` in `whole` shows as itself: something follows it on its
 * line, and it is one blank, or indentation of one kind no longer than MAX_INDENT.
 */
function showsAsItself(run: string, at: number, whole: string): boolean {
  const end = at + run.length;
  if (end === whole.length || whole[end] === "\n") return false;
  if (run.length === 1) return true;
  const startsLine = at === 0 || whole[at - 1] === "\n";
  return startsLine && run.length <= MAX_INDENT && (!run.includes(" ") || !run.includes("\t"));
}

/** Any string as text in an element. Never markup, whatever it holds. */
export function escapeText(value: string): string {
  return value.replace(TEXT_SPECIALS, (found: string, at: number, whole: string) => {
    // Neither a space nor a tab is unseen, so a match that starts with one is a whole run of them.
    if (found[0] === " " || found[0] === "\t") return showsAsItself(found, at, whole) ? found : `<span class="ctl">${blankCount(found)}</span>`;
    return ENTITIES[found] ?? `<span class="ctl">${codePointName(found)}</span>`;
  });
}

/** A value for a quoted attribute. Markup characters become entities, and an unseen character becomes U+FFFD. */
export function escapeAttribute(value: string): string {
  return value.replace(ATTRIBUTE_SPECIALS, (character) => ENTITIES[character] ?? "\u{FFFD}");
}

/** Markup this module made or vouched for. Nothing else is inserted unescaped. */
export class Markup {
  constructor(readonly source: string) {}
}

/** An attribute's value, escaped for a quoted attribute by attribute(). The only value the html tag takes inside a tag. */
export class AttributeValue {
  constructor(readonly source: string) {}
}

/** Where a template has got to: in text, inside a tag, or inside an attribute value quoted with this character. */
type Context = "text" | "tag" | '"' | "'";

/** Where reading this literal from `start` leaves a template. The literals are the viewer's own markup, never anything a capture held. */
function contextAfter(literal: string, start: Context): Context {
  let context = start;
  for (let index = 0; index < literal.length; index += 1) {
    const character = literal[index];
    if (context === "text") {
      // A value right after a bare < could only be a tag's name, so it counts as inside the tag.
      if (character === "<" && (index + 1 === literal.length || /[a-zA-Z/!]/.test(literal.charAt(index + 1)))) context = "tag";
    } else if (context === "tag") {
      if (character === '"' || character === "'") context = character;
      else if (character === ">") context = "text";
    } else if (character === context) {
      context = "tag";
    }
  }
  return context;
}

const OPENS: Readonly<Record<'"' | "'", RegExp>> = { '"': /=\s*"$/, "'": /=\s*'$/ };

function render(value: unknown): string {
  if (value instanceof Markup) return value.source;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeText(String(value));
}

/**
 * A template whose every value lands where the markup around it says. In text, a value is escaped
 * unless it is Markup, and an attribute's value is refused. Inside a tag, a value is refused unless
 * it is the whole of a quoted attribute value, from attribute().
 */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): Markup {
  let source = strings[0];
  let context = contextAfter(strings[0], "text");
  values.forEach((value, index) => {
    const after = strings[index + 1];
    if (context === "text") {
      if (value instanceof AttributeValue) throw new Error("html: an attribute's value outside an attribute");
      source += render(value);
    } else if (context === "tag") {
      throw new Error("html: a value inside a tag, outside a quoted attribute value");
    } else {
      const whole = OPENS[context].test(strings[index]) && after.startsWith(context);
      if (!(value instanceof AttributeValue) || !whole) throw new Error("html: an attribute's value must be the whole of it, quoted, and come from attribute()");
      source += value.source;
    }
    source += after;
    context = contextAfter(after, context);
  });
  return new Markup(source);
}

/** A link to one of the viewer's own pages, built from path segments each encoded on its own. */
export function linkTo(segments: readonly string[], label: unknown, query = ""): Markup {
  return new Markup(`<a href="${escapeAttribute(pathOf(segments) + query)}">${render(label)}</a>`);
}

/** The viewer's own path for these segments. */
export function pathOf(segments: readonly string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** A form field the owner does not type, such as the head they viewed. */
export function hiddenField(name: string, value: string): Markup {
  return new Markup(`<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`);
}

/** An attribute value for markup built with the html tag, such as a field's name or value. */
export function attribute(value: string): AttributeValue {
  return new AttributeValue(escapeAttribute(value));
}
