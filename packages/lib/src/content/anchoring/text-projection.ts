/**
 * Deterministic flattening of a page's stored content to the plain text that
 * anchor offsets are measured against.
 *
 * HARD CONSTRAINT: the projection must be byte-identical on server and client.
 * That is why the HTML tokenizer below is hand-rolled rather than delegating to
 * `DOMParser` in the browser and something else in Node — the two disagree on
 * whitespace, entity handling and implied elements, and every anchor in the
 * product would silently drift. This module is the single shared implementation.
 *
 * Zero I/O — no db, no fetch, no clock, no env, no DOM — enforced by the purity
 * test in __tests__/purity.test.ts.
 *
 * @module @pagespace/lib/content/anchoring/text-projection
 */

import { type PageContentFormat, detectPageContentFormat } from '../page-content-format';

/**
 * Tags that end the current run of text. `br` is here for the same reason the
 * real block elements are: it introduces a line boundary in the rendered prose.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul',
]);

/** Tags whose contents are code, not prose, and are dropped wholesale. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * The named entities that actually appear in stored PageSpace HTML.
 *
 * A Map, not an object literal: `NAMED_ENTITIES[body]` would also reach the
 * object prototype, and `&__proto__;` is short enough to pass the length guard
 * below. That lookup returns `Object.prototype`, which is not `undefined`, so
 * it was accepted as a decoded value — and since it stringifies to
 * `[object Object]`, which contains a space, it was then classified as
 * whitespace and swallowed. Every offset after it would have been wrong. The
 * `Record<string, string>` type hid all of this from the compiler.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/**
 * Tiptap node types that are line boundaries even though they carry no
 * `content` array of their own.
 */
const EMPTY_BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  'hardBreak', 'horizontalRule', 'image', 'file', 'mermaid',
]);

/**
 * Accumulates projected text, collapsing runs of whitespace to a single space
 * and runs of block boundaries to a single newline. Leading and trailing
 * whitespace never reach the output, so the projection is trimmed by
 * construction.
 */
function createEmitter() {
  const parts: string[] = [];
  let pendingSpace = false;
  let pendingNewline = false;
  let emitted = false;

  return {
    space(): void {
      if (emitted) {
        pendingSpace = true;
      }
    },
    newline(): void {
      if (emitted) {
        pendingNewline = true;
      }
    },
    /** Never called with an empty string; callers batch whole runs of text. */
    text(value: string): void {
      if (pendingNewline) {
        parts.push('\n');
      } else if (pendingSpace) {
        parts.push(' ');
      }
      pendingSpace = false;
      pendingNewline = false;
      emitted = true;
      parts.push(value);
    },
    result(): string {
      return parts.join('');
    },
  };
}

type Emitter = ReturnType<typeof createEmitter>;

/**
 * The one definition of collapsible whitespace, shared by both projection
 * strategies. They have to agree character for character: a page converted
 * between storage formats would otherwise re-project into a different
 * coordinate system and shift every anchor on it.
 *
 * U+00A0 is in the set so a literal non-breaking space and the `&nbsp;` that
 * renders identically to it collapse the same way — `convert-content-mode`
 * round-trips content through Turndown and marked and can swap one encoding for
 * the other, on precisely the path that has no diff to forward-port through.
 *
 * Deliberately NARROWER than the regex `\s`, which also matches EM SPACE, the
 * line separators and the rest of Unicode's space category. Those are content,
 * not layout: CSS does not collapse them either, and folding them away would
 * make a quote unfindable in the text it was taken from.
 */
const COLLAPSIBLE_WHITESPACE = /^[ \t\n\r\f\u00a0]$/;
const COLLAPSIBLE_WHITESPACE_RUN = /([ \t\n\r\f\u00a0]+)/;

function isWhitespace(char: string): boolean {
  return COLLAPSIBLE_WHITESPACE.test(char);
}

function isTagNameChar(char: string): boolean {
  return /[A-Za-z0-9:_-]/.test(char);
}

/** Decode a single entity starting at `&`. Returns the text and how far to advance. */
function decodeEntity(html: string, index: number): { value: string; length: number } | null {
  const semicolon = html.indexOf(';', index + 1);
  if (semicolon === -1 || semicolon - index > 10) {
    return null;
  }
  const body = html.slice(index + 1, semicolon);
  const length = semicolon - index + 1;

  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const digits = isHex ? body.slice(2) : body.slice(1);
    if (!digits || !(isHex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
      return null;
    }
    const code = parseInt(digits, isHex ? 16 : 10);
    // NUL and lone surrogates are rejected rather than decoded: Postgres stores
    // neither in text or jsonb, and an anchor's `exact` is headed for a jsonb
    // column. Leaving the entity as literal text keeps the projection storable.
    const isSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || isSurrogate) {
      return null;
    }
    return { value: String.fromCodePoint(code), length };
  }

  const named = NAMED_ENTITIES.get(body.toLowerCase());
  return named === undefined ? null : { value: named, length };
}

/**
 * Consume a tag starting at `<`. Returns the lower-cased tag name, whether it
 * was a closing tag, and the index just past the tag. Attribute values are
 * quote-aware so a `>` inside an attribute does not end the tag early.
 */
function readTag(html: string, index: number): { name: string; closing: boolean; next: number } {
  let cursor = index + 1;
  const closing = html[cursor] === '/';
  if (closing) {
    cursor += 1;
  }

  let name = '';
  while (cursor < html.length && isTagNameChar(html[cursor])) {
    name += html[cursor];
    cursor += 1;
  }

  // A quote only opens where an attribute VALUE begins — directly after `=`,
  // whitespace allowed. Treating any quote character as a delimiter would let
  // an apostrophe inside an unquoted value (`<div data-x=it's fine>`) open a
  // state that never closes, swallowing the rest of the document. Browsers keep
  // reading such a tag, and so must we.
  let quote = '';
  let expectingValue = false;
  while (cursor < html.length) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '>') {
      cursor += 1;
      break;
    } else if (char === '=') {
      expectingValue = true;
    } else if (expectingValue && (char === '"' || char === "'")) {
      quote = char;
      expectingValue = false;
    } else if (!isWhitespace(char)) {
      expectingValue = false;
    }
    cursor += 1;
  }

  return { name: name.toLowerCase(), closing, next: cursor };
}

/**
 * Skip to just past the closing tag of a raw-text element (`script`, `style`).
 * Scans case-insensitively over a window rather than lower-casing the whole
 * document, which would allocate a full copy of the page per element.
 */
function skipRawText(html: string, index: number, name: string): number {
  for (let i = index; i < html.length; i += 1) {
    if (html[i] !== '<' || html[i + 1] !== '/') {
      continue;
    }
    // The name has to end where it ends: `</scripture>` starts with `script`,
    // and accepting it would stop the skip early and project the rest of the
    // script body as visible text.
    const after = html[i + 2 + name.length];
    if (
      html.slice(i + 2, i + 2 + name.length).toLowerCase() === name &&
      (after === undefined || !isTagNameChar(after))
    ) {
      return readTag(html, i).next;
    }
  }
  return html.length;
}

function projectHtml(html: string): string {
  const out = createEmitter();
  let i = 0;

  while (i < html.length) {
    const char = html[i];

    if (char === '<') {
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end === -1 ? html.length : end + 3;
        continue;
      }
      if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? html.length : end + 1;
        continue;
      }
      const tag = readTag(html, i);
      if (!tag.name) {
        // A bare `<` that is not a tag — treat it as text.
        out.text('<');
        i += 1;
        continue;
      }
      if (RAW_TEXT_TAGS.has(tag.name)) {
        i = tag.closing ? tag.next : skipRawText(html, tag.next, tag.name);
        continue;
      }
      if (BLOCK_TAGS.has(tag.name)) {
        out.newline();
      }
      i = tag.next;
      continue;
    }

    if (char === '&') {
      const entity = decodeEntity(html, i);
      if (entity) {
        if (isWhitespace(entity.value)) {
          out.space();
        } else {
          out.text(entity.value);
        }
        i += entity.length;
        continue;
      }
      out.text('&');
      i += 1;
      continue;
    }

    if (isWhitespace(char)) {
      out.space();
      i += 1;
      continue;
    }

    // Consume the whole run of non-special characters in one push.
    let end = i;
    while (end < html.length && !isWhitespace(html[end]) && html[end] !== '<' && html[end] !== '&') {
      end += 1;
    }
    out.text(html.slice(i, end));
    i = end;
  }

  return out.result();
}

function walkTiptapNode(node: unknown, out: Emitter): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walkTiptapNode(child, out);
    }
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }

  const record = node as { type?: unknown; text?: unknown; content?: unknown };
  const type = typeof record.type === 'string' ? record.type : '';

  if (typeof record.text === 'string') {
    const value = record.text;
    // Leave the spacing decisions to the emitter, which collapses runs. Split
    // on the shared set rather than \s so this agrees with the HTML strategy.
    for (const segment of value.split(COLLAPSIBLE_WHITESPACE_RUN)) {
      if (!segment) {
        continue;
      }
      if (isWhitespace(segment[0])) {
        out.space();
      } else {
        out.text(segment);
      }
    }
    return;
  }

  if (EMPTY_BLOCK_NODE_TYPES.has(type)) {
    out.newline();
    return;
  }

  const hasChildren = Array.isArray(record.content);
  const isBlock = hasChildren && type !== 'doc';

  if (isBlock) {
    out.newline();
  }
  if (hasChildren) {
    walkTiptapNode(record.content, out);
  }
  if (isBlock) {
    out.newline();
  }
}

/**
 * Only ever called for content the format sniffer already parsed successfully,
 * so `JSON.parse` here cannot throw.
 */
function projectTiptap(content: string): string {
  const out = createEmitter();
  walkTiptapNode(JSON.parse(content), out);
  return out.result();
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Resolve the projection strategy. `contentMode` (`pages.contentMode`, i.e.
 * `'html' | 'markdown'`) only ever *narrows* the sniffed format: a markdown page
 * whose body happens to open with `<` and close with `>` is prose, not markup,
 * and must not have its "tags" stripped.
 */
export function resolveProjectionFormat(content: string, contentMode: string): PageContentFormat {
  const detected = detectPageContentFormat(content);
  if (contentMode === 'markdown' && detected === 'html') {
    return 'text';
  }
  return detected;
}

/**
 * Flatten stored page content to the plain text that anchor offsets index into.
 *
 * - `html`   — tags stripped, block elements become single newlines, runs of
 *              whitespace collapse to a single space, entities decoded.
 * - `tiptap` — the document's text nodes in order, blocks separated by newlines.
 * - `json`   — returned as the stored blob with newlines normalised. Non-tiptap
 *              JSON page types (sheets) anchor by natural key, not by text
 *              offset, so there is no prose to project.
 * - `text`   — newlines normalised, nothing else touched.
 *
 * Always returns the same output for the same input, on any runtime.
 *
 * CAVEAT: the strategy is sniffed per call, and detectPageContentFormat only
 * calls content HTML when the trimmed body both starts with '<' and ends with
 * '>'. A page whose markup gains an unclosed trailing element therefore
 * projects as raw text where the revision before it projected as stripped
 * prose — two incompatible coordinate systems for the same page. A caller
 * comparing two revisions should confirm resolveProjectionFormat agrees on both
 * before trusting offsets across them. The durable fix is a format stored per
 * page rather than re-derived, which needs the schema a later phase adds; the
 * sniffer itself is shared with diff-utils and is not this module's to change.
 */
export function projectContent(content: string, contentMode: string): string {
  if (!content) {
    return '';
  }

  const format = resolveProjectionFormat(content, contentMode);
  if (format === 'html') {
    return projectHtml(content);
  }
  if (format === 'tiptap') {
    return projectTiptap(content);
  }
  return normalizeNewlines(content);
}
