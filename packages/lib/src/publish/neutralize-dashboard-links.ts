// At publish time, inter-page links whose target is itself published are
// rewritten to public URLs (see apps/web's asset pipeline). Links to
// UNPUBLISHED pages keep their in-app `/dashboard/{driveId}/{pageId}` href —
// a dead, login-walled destination for an anonymous visitor. This transform
// converts those leftover anchors into inert `<span>`s, preserving the inner
// HTML and the mention data attributes so mention-chip CSS still applies.
//
// Pure string transform: no DOM, no I/O. The expected input is TipTap
// document HTML (double-quoted attributes, `<`/`>` entity-encoded in text
// and attribute values), but the matcher is hardened for hand-authored
// markup by following the HTML tokenizer's grammar for the attribute
// region: a quote opens a value only after `=`, and a quoted value may
// contain `>` (title="2 > 1") but not `<`, so a match can never extend
// across a tag boundary. Anything that violates the grammar — a bare quote
// in name position, an unclosed quote, an unclosed anchor — simply never
// matches and is left byte-identical; when corrupt output and a missed
// anchor are the only options, this module always prefers the miss.
//
// Deliberately out of scope (per the 1-6 spec): absolute or
// protocol-relative dashboard URLs (`https://host/dashboard/…`) — matching
// those by path alone would false-positive external sites whose paths
// merely contain /dashboard/, and this module reads no config to know the
// app's own host.

// The value grammar is shared by the tag matcher and the attribute
// tokenizer so both always accept the same syntax.
const ATTR_VALUE_SRC = `"[^"<]*"|'[^'<]*'|[^\\s"'<>=\`]+`;
const ATTR_NAME_SRC = `[^\\s"'<>=/]+`;

// A well-formed opening tag whose attribute region is a run of
// name(=value)? tokens, its inner HTML, and the closing tag. The inner
// content is lazy and additionally refuses to cross another `<a` opening:
// anchors cannot nest in valid HTML, so an unclosed anchor can never steal
// a later anchor's closing tag, and a failed scan stops at the next anchor
// instead of the end of the input (keeping worst-case time linear).
const ANCHOR_RE = new RegExp(
  `<a\\b((?:\\s+${ATTR_NAME_SRC}(?:\\s*=\\s*(?:${ATTR_VALUE_SRC}))?)*\\s*/?)>` +
    `((?:(?!<a\\b)[\\s\\S])*?)</a\\s*>`,
  'gi',
);

// Tokenizes an attribute region ANCHOR_RE has already validated. Because a
// quoted value is consumed as a single token, `href=` or `data-page-id=`
// text INSIDE another attribute's value is never mistaken for an attribute.
const ATTR_TOKEN_RE = new RegExp(
  `(${ATTR_NAME_SRC})\\s*(?:=\\s*(${ATTR_VALUE_SRC}))?`,
  'g',
);

interface AttrToken {
  name: string;
  value: string;
}

const unquote = (raw: string): string =>
  raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;

const parseAttrs = (attrs: string): AttrToken[] => {
  const tokens: AttrToken[] = [];
  for (const match of attrs.matchAll(ATTR_TOKEN_RE)) {
    tokens.push({ name: match[1].toLowerCase(), value: unquote(match[2] ?? '') });
  }
  return tokens;
};

// The mention attributes carried over onto the neutralized span.
const MENTION_ATTR_NAMES = new Set(['data-mention-type', 'data-page-id']);

/**
 * Replace anchors that still point into the app (`href` starting with the
 * relative `/dashboard/` path) with inert `<span>`s, preserving inner HTML
 * and any `data-mention-type`/`data-page-id` attributes. All other anchors —
 * published `https://` URLs, same-page fragments, non-dashboard paths — and
 * any malformed/unclosed anchor markup are left byte-identical. Idempotent.
 */
export function neutralizeDashboardLinks(html: string): string {
  if (!html.includes('/dashboard/')) return html;
  return html.replace(ANCHOR_RE, (anchor, attrs: string, inner: string) => {
    const tokens = parseAttrs(attrs);
    // Browsers strip whitespace padding from URL attributes, so trim before
    // classifying; like the HTML tokenizer, the first href wins.
    const href = tokens.find((token) => token.name === 'href')?.value.trim();
    if (href === undefined || !href.startsWith('/dashboard/')) return anchor;
    const kept = tokens
      .filter((token) => MENTION_ATTR_NAMES.has(token.name))
      .map((token) => `${token.name}="${token.value.replace(/"/g, '&quot;')}"`);
    return `<span${kept.length > 0 ? ` ${kept.join(' ')}` : ''}>${inner}</span>`;
  });
}
