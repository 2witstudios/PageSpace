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

/**
 * CSS escapes (`\70 `, `\/`) resolved, and string line continuations (a
 * backslash before a newline, which the tokenizer drops along with the newline)
 * removed, as the CSS tokenizer does before `url()` fetches. One pass, left to
 * right, so an escaped backslash (`\\`) is never read as a continuation.
 */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:(\r\n|[\n\r\f])|([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g, (_, continuation: string | undefined, hex: string | undefined, char: string | undefined) => {
    if (continuation !== undefined) return '';
    if (hex === undefined) return char ?? '';
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�';
  });
}

/** What a JavaScript single-character escape stands for; any other escaped character is itself. */
const JS_SINGLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

/**
 * JavaScript string-literal escapes resolved as the engine resolves them, the
 * whole escape grammar: `/`; `\u{2f}` with any number of leading zeros
 * (bounded by value, not digit count); `\x2f`; legacy octal (`\57`, `\057`,
 * `\0`), which classic sloppy-mode scripts accept; single-character escapes
 * (`\/`, `\t`, `\q`); and line continuations dropped. One pass, left to right,
 * so `\\` is one backslash. A malformed `\u`/`\x` is left as written.
 */
function decodeJsEscapes(text: string): string {
  return text.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\u2028\u2029])|([^ux]))/g,
    (
      whole,
      braced: string | undefined,
      u4: string | undefined,
      x2: string | undefined,
      octal: string | undefined,
      continuation: string | undefined,
      single: string | undefined,
    ) => {
      if (continuation !== undefined) return '';
      if (single !== undefined) return JS_SINGLE_ESCAPES[single] ?? single;
      if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8));
      const codePoint = parseInt(braced ?? u4 ?? x2 ?? '', 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
    },
  );
}

/**
 * Every URL a CSS fragment can fetch, after escapes are resolved: each unquoted
 * `url(...)`, and every quoted string (`url("...")`, `@import "..."`,
 * `image-set("..." 1x)` and anything else that takes a string URL). Each
 * pattern is linear: no two quantifiers compete for the same characters.
 */
function cssUrls(css: string): string[] {
  const decoded = decodeCssEscapes(css);
  const urls: string[] = [];
  for (const match of decoded.matchAll(/url\(\s*([^)\s"']*)/gi)) urls.push(match[1]);
  for (const match of decoded.matchAll(/"([^"]*)"|'([^']*)'/g)) urls.push(match[1] ?? match[2] ?? '');
  return urls;
}

/**
 * The URL candidates in one attribute value: the whole value, each `srcset`
 * candidate, each CSS URL, and whatever follows a `url=` (a meta refresh target).
 */
function attributeUrlCandidates(value: string): string[] {
  const srcsetParts = value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '');
  const refreshTargets = value.split(/url\s*=\s*/i).slice(1).map((target) => target.replace(/^["']|["']$/g, ''));
  return [value, ...srcsetParts, ...refreshTargets, ...cssUrls(value)];
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

type ParsedContent = ReturnType<typeof load>;

/** Ids referenced from the parsed document: every attribute on every element, and every `<style>` block. */
function parsedReferenceIds($: ParsedContent): string[] {
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

interface ScriptRegions {
  /** `content` with each `<script>` body blanked, at the parser's own offsets. */
  outsideScripts: string;
  /** Text a browser runs as JavaScript: `<script>` bodies, `on*` handlers, `javascript:` URLs. */
  scripts: string[];
}

/**
 * Where `content` holds JavaScript. Script bodies are found at the offsets
 * parse5 itself reports, so what is blanked is exactly what the browser runs.
 * Handler and `javascript:` attributes stay in `outsideScripts` too: read both
 * ways, only over-reporting is possible.
 */
function scriptRegions($: ParsedContent, content: string): ScriptRegions {
  const scripts: string[] = [];
  const spans: Array<[number, number]> = [];
  $('script').each((_, element) => {
    const location = 'sourceCodeLocation' in element ? element.sourceCodeLocation : null;
    const bodyStart = location?.startTag?.endOffset;
    if (bodyStart === undefined) {
      scripts.push($(element).text());
      return;
    }
    const bodyEnd = location?.endTag?.startOffset ?? content.length;
    scripts.push(content.slice(bodyStart, bodyEnd));
    spans.push([bodyStart, bodyEnd]);
  });
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    for (const [name, value] of Object.entries(element.attribs)) {
      if (/^on/i.test(name) || /^[\s\p{Cc}]*javascript:/iu.test(value)) scripts.push(value);
    }
  });
  let outsideScripts = '';
  let cursor = 0;
  for (const [bodyStart, bodyEnd] of spans.sort((a, b) => a[0] - b[0])) {
    if (bodyStart < cursor) continue;
    outsideScripts += `${content.slice(cursor, bodyStart)} `;
    cursor = bodyEnd;
  }
  outsideScripts += content.slice(cursor);
  return { outsideScripts, scripts };
}

/** Free text split into URL-like tokens: anything between whitespace, quotes, brackets and separators. */
const TEXT_TOKEN_SEPARATOR = /[\s"'`()<>[\]{},;=]+/;

/**
 * Ids referenced from the raw text, outside attributes (markdown, script and
 * style bodies), in every form a reference can take on its way to a request:
 * raw, HTML character references resolved, JavaScript string escapes resolved,
 * and the percent-decoding of each. Each form is matched by pattern, and each
 * URL-like token in it is normalised through `new URL` as attribute values are,
 * so dot segments, `%2e` and backslashes resolve as the browser resolves them.
 */
function textReferenceIds(content: string): string[] {
  const html = decodeHTML(content);
  const unescaped = [content, html, decodeJsEscapes(content), decodeJsEscapes(html)];
  const forms = new Set(unescaped.flatMap((text) => [text, decodePercentEscapes(text)]));
  const ids: string[] = [];
  for (const text of forms) {
    for (const match of text.matchAll(STORED_FILE_REFERENCE)) ids.push(match[1] ?? match[2]);
    const literals = [...text.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
    for (const candidate of [...text.split(TEXT_TOKEN_SEPARATOR), ...literals]) {
      if (!/files|dashboard/i.test(candidate)) continue;
      const id = servedIdOf(candidate.trim());
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Path dot segments and repeated slashes collapsed, as the URL parser and the
 * router would collapse them (`api/./files`, `api/x/../files`, `api//files`).
 * Over-collapsing is harmless here: it can only surface more mentions.
 */
function collapsePathSegments(text: string): string {
  let current = text;
  for (let round = 0; round < 64; round++) {
    const next = current
      .replace(/\/{2,}/g, '/')
      .replace(/\/\.(?=\/)/g, '')
      .replace(/\/(?!\.\.\/)[^/]+\/\.\.(?=\/)/g, '');
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * `content` reduced to the skeleton the backstop counts in: every encoding
 * peeled (HTML references, percent escapes, and CSS escapes, or JavaScript escapes in script regions, repeatedly), backslashes
 * turned into slashes, every whitespace, control and format character
 * (zero-width included) removed, and dot segments and repeated slashes collapsed.
 */
function backstopSkeletons({ outsideScripts, scripts }: ScriptRegions): string[] {
  // CSS and JavaScript read a backslash differently (`\70 ` is `p` in CSS, `8` in
  // a script): script bodies are read with JavaScript rules, everything else
  // with CSS rules.
  const decodings: Array<[string, (text: string) => string]> = [
    [outsideScripts, decodeCssEscapes],
    ...scripts.map((script): [string, (text: string) => string] => [script, decodeJsEscapes]),
  ];
  const chains = decodings.map(([source, decodeEscapes]) => {
    let text = source;
    for (let round = 0; round < 4; round++) {
      const next = decodePercentEscapes(decodeHTML(decodeEscapes(text)));
      if (next === text) break;
      text = next;
    }
    return text.replace(/\\/g, '/').replace(/[\s\p{Cc}\p{Cf}]/gu, '');
  });
  // Collapsing can join separate regions of the document (`x/../` across
  // markup) and erase a mention, so the uncollapsed forms are counted too.
  return [...chains, ...chains.map(collapsePathSegments)];
}

export interface StoredFileReferenceScan {
  /** Every distinct file or page id the content references, in first-seen order. */
  ids: string[];
  /**
   * False when the content mentions `api/files/` or `dashboard/{d}/{id}/view` in a way none of `ids`
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
 * `api/files/` and each `dashboard/{d}/{id}/view` must name an id the scan extracted.
 *
 * Not covered: a URL that canvas script assembles at runtime (string joins).
 * No static scan can see one.
 */
export function scanStoredFileReferences(content: string): StoredFileReferenceScan {
  const $ = load(content, { sourceCodeLocationInfo: true });
  const ids = [...new Set([...parsedReferenceIds($), ...textReferenceIds(content)])];
  const accounted = new Set(ids.map((id) => id.toLowerCase()));
  const mentioned = backstopSkeletons(scriptRegions($, content)).flatMap((skeleton) => [
    ...[...skeleton.matchAll(/api\/files\/([a-zA-Z0-9_-]*)/gi)].map((match) => match[1]),
    ...[...skeleton.matchAll(/dashboard\/[a-zA-Z0-9_-]*\/([a-zA-Z0-9_-]*)\/view/gi)].map((match) => match[1]),
  ]);
  const complete = mentioned.every((id) => accounted.has(id.toLowerCase()));
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
