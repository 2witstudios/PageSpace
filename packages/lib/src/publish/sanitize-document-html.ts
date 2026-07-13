/**
 * Sanitize TipTap-authored DOCUMENT HTML for publishing.
 *
 * Published documents must never execute author scripts — unlike CANVAS pages,
 * whose whole point is author JS (see `canvas/render-document.ts`, which
 * PRESERVES scripts because canvas isolation is by origin). The hard
 * enforcement for documents is CSP (`script-src 'none'`); this module is the
 * hygiene layer that keeps the markup itself clean:
 *
 *   - `<script>`/`<style>` blocks are removed with their content, and
 *     `<iframe>`/`<object>`/`<form>` elements likewise (their inner content is
 *     fallback/control junk, not document prose). `<embed>`/`<base>`/`<meta>`/
 *     `<link>` are void — the tags are removed.
 *   - `on*` event-handler attributes are removed; the element is kept.
 *   - `href`/`src` values with `javascript:` or `data:text/html` schemes are
 *     removed (attribute only), after undoing case/whitespace/entity tricks.
 *
 * Pure function: no DOM, no I/O, deterministic — it runs identically in Node
 * and the browser. Benign TipTap output passes through byte-identical, and the
 * function is idempotent.
 *
 * Parsing mirrors the HTML tokenizer the same way `render-document.ts` does:
 * a tag name only counts when followed by a genuine delimiter (whitespace, `/`
 * or `>`), so `<script-template>` is never mistaken for `<script>`; and
 * attribute scanning is quote-aware, so a `>` inside a quoted value (e.g.
 * `alt="a>b"`) cannot end the tag early and smuggle a handler past the scan.
 *
 * The whole pass loops to a fixpoint because removals can concatenate
 * surrounding text into a NEW dangerous construct (`<` + stripped block +
 * `script src=…>` reassembles into a live script tag). Every pass only ever
 * deletes characters, so the loop strictly shrinks and always terminates.
 */

/** Elements removed together with their content (first matching close tag wins,
 * as in the HTML tokenizer; unclosed at EOF consumes the rest). */
const STRIP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'form']);

/** Void (or effectively void) elements whose tags are removed outright. */
const STRIP_TAG_ONLY = new Set(['embed', 'base', 'meta', 'link']);

/** Attributes whose values are URLs and must not carry executable schemes. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href']);

const isForbiddenElement = (name: string): boolean =>
  STRIP_WITH_CONTENT.has(name) || STRIP_TAG_ONLY.has(name);

/**
 * Minimal entity decoding for the scheme CHECK only (never for output):
 * numeric references plus every named entity that yields a character the two
 * denied scheme prefixes are built from — `:` (`&colon;`), `/` (`&sol;`) and
 * the whitespace browsers strip (`&Tab;`, `&NewLine;`). ASCII letters have no
 * named entities, so this set is complete for `javascript:`/`data:text/html`.
 * Decoding more would risk changing benign values; matching is deliberately
 * case-insensitive (broader than HTML) — a false decode only means we inspect
 * a stricter string.
 */
const NAMED_ENTITIES_FOR_CHECK: ReadonlyArray<[RegExp, string]> = [
  [/&colon;/gi, ':'],
  [/&sol;/gi, '/'],
  [/&tab;/gi, '\t'],
  [/&newline;/gi, '\n'],
];

const decodeEntitiesForCheck = (value: string): string =>
  NAMED_ENTITIES_FOR_CHECK.reduce(
    (decoded, [entity, char]) => decoded.replace(entity, char),
    value
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
        const code = parseInt(hex, 16);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/&#(\d+);?/g, (_, dec: string) => {
        const code = parseInt(dec, 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
  );

/**
 * True when a URL attribute value resolves to an executable scheme. Browsers
 * strip ASCII control characters and whitespace inside/around the scheme
 * before matching it, so the check does the same (only for the comparison —
 * kept attributes are emitted verbatim).
 */
const hasDangerousScheme = (rawValue: string): boolean => {
  const normalized = decodeEntitiesForCheck(rawValue)
    .replace(/[\u0000-\u0020]+/g, '')
    .toLowerCase();
  return normalized.startsWith('javascript:') || normalized.startsWith('data:text/html');
};

interface ScannedAttribute {
  /** Lowercased attribute name. */
  name: string;
  /** Attribute value with surrounding quotes removed ('' when valueless). */
  value: string;
  /** Slice bounds in the source covering leading whitespace + name + value. */
  start: number;
  end: number;
}

interface ScannedTag {
  /** Index just past the closing `>` (or EOF for an unterminated tag). */
  end: number;
  attributes: ScannedAttribute[];
}

/**
 * Scan an open tag's attribute area starting just past the tag name.
 * Quote-aware per the HTML attribute-value states: `>` inside a quoted value
 * does not end the tag.
 */
const scanTag = (html: string, from: number): ScannedTag => {
  const attributes: ScannedAttribute[] = [];
  let i = from;
  while (i < html.length) {
    const attrStart = i;
    while (i < html.length && (/\s/.test(html[i]) || html[i] === '/')) i++;
    if (i >= html.length) break;
    if (html[i] === '>') return { end: i + 1, attributes };

    // Attribute name: anything up to whitespace, `=`, `/` or `>`.
    const nameStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
    const name = html.slice(nameStart, i).toLowerCase();

    // Optional `= value`.
    let value = '';
    let valueEnd = i;
    let j = i;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] === '=') {
      j++;
      while (j < html.length && /\s/.test(html[j])) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const closeQuote = html.indexOf(quote, j + 1);
        const valueTo = closeQuote === -1 ? html.length : closeQuote;
        value = html.slice(j + 1, valueTo);
        valueEnd = closeQuote === -1 ? html.length : closeQuote + 1;
      } else {
        const valueStart = j;
        while (j < html.length && !/[\s>]/.test(html[j])) j++;
        value = html.slice(valueStart, j);
        valueEnd = j;
      }
      i = valueEnd;
    }
    attributes.push({ name, value, start: attrStart, end: valueEnd });
  }
  return { end: html.length, attributes };
};

const isDroppedAttribute = (attr: ScannedAttribute): boolean =>
  attr.name.startsWith('on') || (URL_ATTRIBUTES.has(attr.name) && hasDangerousScheme(attr.value));

/** Re-emit an open tag with its offending attributes spliced out. */
const cleanTagMarkup = (html: string, tagStart: number, scanned: ScannedTag): string => {
  let out = '';
  let cursor = tagStart;
  for (const attr of scanned.attributes) {
    if (!isDroppedAttribute(attr)) continue;
    out += html.slice(cursor, attr.start);
    cursor = attr.end;
  }
  return out + html.slice(cursor, scanned.end);
};

/**
 * Find the index just past the first `</name …>` close tag at or after `from`.
 * Same close-tag shape as `render-document.ts`: junk after the name is
 * tolerated up to `>`, but the name itself needs a genuine delimiter so
 * `</script-template>` never closes a `<script>`. Returns EOF when unclosed.
 */
const skipPastCloseTag = (html: string, name: string, from: number): number => {
  const close = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, 'gi');
  close.lastIndex = from;
  const match = close.exec(html);
  return match ? match.index + match[0].length : html.length;
};

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;

/** One full sanitize pass. Only ever deletes characters, never inserts. */
const sanitizePass = (html: string): string => {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    const isCloseTag = html[lt + 1] === '/';
    const nameMatch = TAG_NAME.exec(html.slice(lt + (isCloseTag ? 2 : 1)));
    if (!nameMatch) {
      // Not a tag (stray `<`, comment, doctype…) — emit the `<` and move on.
      out += '<';
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const afterName = lt + (isCloseTag ? 2 : 1) + nameMatch[0].length;
    // A real tag name must be followed by a delimiter — `<script-template>`
    // already failed the Set lookups (full name matched), this guards `<p<`.
    const scanned = scanTag(html, afterName);

    if (isCloseTag) {
      // Orphan close tags of forbidden elements are dropped; others verbatim.
      out += isForbiddenElement(name) ? '' : html.slice(lt, scanned.end);
      i = scanned.end;
      continue;
    }

    if (STRIP_WITH_CONTENT.has(name)) {
      i = skipPastCloseTag(html, name, scanned.end);
      continue;
    }
    if (STRIP_TAG_ONLY.has(name)) {
      i = scanned.end;
      continue;
    }

    out += scanned.attributes.some(isDroppedAttribute)
      ? cleanTagMarkup(html, lt, scanned)
      : html.slice(lt, scanned.end);
    i = scanned.end;
  }
  return out;
};

/**
 * Sanitize published DOCUMENT HTML. Idempotent; benign TipTap output passes
 * through byte-identical.
 */
export const sanitizeDocumentHtml = (html: string): string => {
  // Loop to a fixpoint: removing a block can concatenate its neighbours into
  // a new dangerous construct. Passes only delete, so length strictly
  // decreases until stable — guaranteed termination.
  let previous = html;
  for (;;) {
    const next = sanitizePass(previous);
    if (next === previous) return next;
    previous = next;
  }
};
