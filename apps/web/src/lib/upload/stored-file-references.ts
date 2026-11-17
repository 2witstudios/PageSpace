import { load } from 'cheerio';
import { decodeHTML } from 'entities';
import { PageType } from '@pagespace/lib/utils/enums';

/**
 * Internal references to stored files inside page content, the shapes the app
 * serves bytes for:
 *   - `/api/files/{id}/view`, `/thumbnail`, `/download` (any host, so an
 *     absolute or protocol-relative URL to the app counts too)
 *   - `/dashboard/{driveId}/{pageId}/view`, the canvas embed convention
 *
 * The same shapes `lib/canvas/asset-pipeline.ts` rewrites on publish, plus
 * `download`. Kept separate because that module is `server-only` and pulls in the
 * publish storage; this one is pure.
 *
 * Bulk copy screens what this finds, so it errs towards finding too much: a
 * missed reference is a blocklist bypass, a spurious one only an extra lookup.
 */

/** A served reference as a whole, normalised pathname. Optional trailing slash: Next.js redirects `/view/` to `/view`. */
const SERVED_PATHNAME =
  /^\/api\/files\/([a-zA-Z0-9_-]+)\/(?:view|thumbnail|download)\/?$|^\/dashboard\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\/view\/?$/i;

/** The same shapes found inside free text (markdown, script, anything not an attribute). */
const STORED_FILE_REFERENCE =
  /\/api\/files\/([a-zA-Z0-9_-]+)\/(?:view|thumbnail|download)\/?(?=$|[?#"')\s>\\])|\/dashboard\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\/view\/?(?=$|[?#"')\s>\\])/gi;

/**
 * The base relative references resolve against. Its host is irrelevant: a
 * reference counts on any host, because the id, not the origin, names the bytes.
 */
const RESOLUTION_BASE = 'https://app.invalid/';

/** The router decodes path segments before matching, so `/%76iew` is served as `/view`. */
function decodePercentEscapes(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** CSS escapes (`\70 `, `\/`) resolved, as the CSS tokenizer does before `url()` fetches. */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g, (_, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? '';
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�';
  });
}

/** Every URL a CSS fragment fetches: `url(...)` and `@import "..."`, after escapes are resolved. */
function cssUrls(css: string): string[] {
  const decoded = decodeCssEscapes(css);
  const urls: string[] = [];
  for (const match of decoded.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
    urls.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  for (const match of decoded.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    urls.push(match[1] ?? match[2] ?? '');
  }
  return urls;
}

/** The URL candidates in one attribute value: the whole value, each `srcset` candidate, each CSS `url()`. */
function attributeUrlCandidates(value: string): string[] {
  const srcsetParts = value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '');
  return [value, ...srcsetParts, ...cssUrls(value)];
}

/**
 * The id a URL serves, normalised as the browser and the router see it: WHATWG
 * `new URL` (strips tab/newline, trims, turns `\` into `/`, resolves dot
 * segments and protocol-relative URLs), then the router's percent-decoding.
 */
function servedIdOf(candidate: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(candidate, RESOLUTION_BASE).pathname;
  } catch {
    return null;
  }
  const match = decodePercentEscapes(pathname).match(SERVED_PATHNAME);
  return match ? (match[1] ?? match[2]) : null;
}

/** Ids referenced from the parsed document: every attribute on every element, and every `<style>` block. */
function parsedReferenceIds(content: string): string[] {
  const $ = load(content);
  const ids: string[] = [];
  const consider = (candidate: string) => {
    const id = servedIdOf(candidate);
    if (id) ids.push(id);
  };
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    for (const value of Object.values(element.attribs)) {
      for (const candidate of attributeUrlCandidates(value)) consider(candidate);
    }
  });
  $('style').each((_, element) => {
    for (const candidate of cssUrls($(element).text())) consider(candidate);
  });
  return ids;
}

/**
 * Ids referenced from the raw text, in every form a reference can take on its
 * way to a request: raw, HTML character references resolved, and the
 * percent-decoding of each. Catches references outside attributes (markdown).
 */
function textReferenceIds(content: string): string[] {
  const html = decodeHTML(content);
  const forms = new Set([content, decodePercentEscapes(content), html, decodePercentEscapes(html)]);
  const ids: string[] = [];
  for (const text of forms) {
    for (const match of text.matchAll(STORED_FILE_REFERENCE)) ids.push(match[1] ?? match[2]);
  }
  return ids;
}

/**
 * `content` reduced to the skeleton the backstop counts in: every encoding
 * peeled (HTML references, percent and CSS escapes, repeatedly), backslashes
 * turned into slashes, and every whitespace, control and format character
 * (zero-width included) removed.
 */
function backstopSkeleton(content: string): string {
  let text = content;
  for (let round = 0; round < 4; round++) {
    const next = decodePercentEscapes(decodeHTML(decodeCssEscapes(text)));
    if (next === text) break;
    text = next;
  }
  return text.replace(/\\/g, '/').replace(/[\s\p{Cc}\p{Cf}]/gu, '');
}

export interface StoredFileReferenceScan {
  /** Every distinct file or page id the content references, in first-seen order. */
  ids: string[];
  /**
   * False when the content mentions `api/files/` in a way none of `ids`
   * accounts for: an encoding this scan doesn't model. Callers must treat the
   * content as unverifiable and fail closed.
   */
  complete: boolean;
}

/**
 * The stored files `content` references, found by parsing it as a browser does
 * (every attribute and inline style, normalised through `new URL`) and by
 * matching the free text, plus a fail-closed backstop: in the content with every
 * encoding peeled and all whitespace and control characters removed, each
 * `api/files/` must be followed by an id the scan extracted.
 */
export function scanStoredFileReferences(content: string): StoredFileReferenceScan {
  const ids = [...new Set([...parsedReferenceIds(content), ...textReferenceIds(content)])];
  const accounted = new Set(ids.map((id) => id.toLowerCase()));
  const complete = [...backstopSkeleton(content).matchAll(/api\/files\/([a-zA-Z0-9_-]*)/gi)]
    .every((match) => accounted.has(match[1].toLowerCase()));
  return { ids, complete };
}

/** The ids alone; see {@link scanStoredFileReferences}, whose `complete` callers screening content must check. */
export function extractStoredFileReferenceIds(content: string): string[] {
  return scanStoredFileReferences(content).ids;
}

/** Page types whose `content` can embed stored files by reference. */
export function pageContentCanReferenceFiles(type: string): boolean {
  return type === PageType.DOCUMENT || type === PageType.CANVAS;
}
