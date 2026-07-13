// At publish time, inter-page links whose target is itself published are
// rewritten to public URLs (see apps/web's asset pipeline). Links to
// UNPUBLISHED pages keep their in-app `/dashboard/{driveId}/{pageId}` href —
// a dead, login-walled destination for an anonymous visitor. This transform
// converts those leftover anchors into inert `<span>`s, preserving the inner
// HTML and the mention data attributes so mention-chip CSS still applies.
//
// Pure string transform: no DOM, no I/O. The matcher is deliberately
// conservative — an anchor tag whose attribute region contains `<` or `>`
// (i.e. is malformed or unclosed) never matches and is left unchanged.

// A well-formed opening tag (no `<`/`>` inside the attribute region), its
// inner HTML (lazy, up to the nearest close tag — anchors cannot nest in
// valid HTML), and the closing tag.
const ANCHOR_RE = /<a\b([^<>]*)>([\s\S]*?)<\/a\s*>/gi;

const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/i;

// The mention attributes carried over onto the neutralized span.
const MENTION_ATTR_RE =
  /(?:^|\s)(data-mention-type|data-page-id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;

const extractHref = (attrs: string): string | undefined => {
  const match = attrs.match(HREF_RE);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
};

const mentionAttrs = (attrs: string): string => {
  const kept: string[] = [];
  for (const match of attrs.matchAll(MENTION_ATTR_RE)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
  }
  return kept.length > 0 ? ` ${kept.join(' ')}` : '';
};

/**
 * Replace anchors that still point into the app (`href` starting with the
 * relative `/dashboard/` path) with inert `<span>`s, preserving inner HTML
 * and any `data-mention-type`/`data-page-id` attributes. All other anchors —
 * published `https://` URLs, same-page fragments, non-dashboard paths — and
 * any malformed/unclosed anchor markup are left byte-identical. Idempotent.
 */
export function neutralizeDashboardLinks(html: string): string {
  return html.replace(ANCHOR_RE, (anchor, attrs: string, inner: string) => {
    const href = extractHref(attrs);
    if (href === undefined || !href.startsWith('/dashboard/')) return anchor;
    return `<span${mentionAttrs(attrs)}>${inner}</span>`;
  });
}
