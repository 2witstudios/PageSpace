/**
 * Turning what an admin typed into the email that actually goes out.
 *
 * Three jobs, in order: resolve WHICH content this broadcast sends (free-composed or a
 * saved template), render that markdown to HTML we are willing to put in a mass email,
 * and wrap it in the branded shell with a mandatory unsubscribe footer.
 *
 * The sanitizer is not decoration. Admin markdown is trusted-ish input from a privileged
 * user, but it is still input, and the output lands in hundreds of mail clients with
 * wildly different HTML parsers and no CSP to fall back on. The allowlist is therefore
 * closed, not open: everything except the tags a marketing email legitimately needs is
 * dropped, so a paste from a rich-text editor (or an XSS payload) cannot smuggle script,
 * styles, frames, forms, or event handlers into someone's inbox.
 */

import type { ReactElement } from 'react';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { EmailBroadcastContentMode } from '@pagespace/db/schema/email-broadcasts';
import { BroadcastEmail } from '../../email-templates/BroadcastEmail';
import { renderEmailToHtml } from '../../email-templates/render-email';

/**
 * What a marketing email needs, and nothing else.
 *
 * Deliberately absent: `img` (needs its own hosting + tracking-pixel conversation),
 * `table` (mail-client layout tables are the chrome's job, not the author's), `pre`
 * beyond inline `code`, `style`/`script`/`iframe`/`form`/`object` (never), and `class`
 * or `style` attributes (the shell owns the look; an author-set style is how a broadcast
 * ends up unreadable in dark mode).
 */
const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'a',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'blockquote',
  'code',
  'br',
  'hr',
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // `href`/`title` only. No `target`, no `rel`, no `style` — and no `on*`, which
  // sanitize-html drops for any tag by virtue of the allowlist being closed.
  allowedAttributes: { a: ['href', 'title'] },
  // A `javascript:` or `data:` href in an email is either an attack or a broken link;
  // both are things we refuse to mail.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    // `allowedSchemes` only filters URLs that HAVE a scheme, so a relative href sails
    // through it. An email has no base to resolve one against — it is broken for every
    // recipient — so drop the href and keep the text rather than mail a dead link.
    a: (tagName, attribs) => {
      const href = attribs.href?.trim();
      if (!href) return { tagName, attribs };

      try {
        new URL(href);
        return { tagName, attribs };
      } catch {
        const { href: _dropped, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
    },
  },
  // Drop these tags AND their contents. Without this, the text inside a stripped
  // <script> would survive as visible prose in the email.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/** Render admin markdown to HTML that is safe to put in a mass email. */
export function renderMarkdownToSafeHtml(markdown: string): string {
  // `async: false` pins the sync overload — marked returns `string | Promise<string>`
  // depending on configured extensions, and a Promise stringified into an email body
  // would ship "[object Promise]" to the whole audience.
  const rendered = marked.parse(markdown, { async: false });
  return sanitizeHtml(rendered, SANITIZE_OPTIONS);
}

/** The stored content of a saved template, as `content.ts` needs it. */
export interface BroadcastTemplateContent {
  subject: string;
  bodyMarkdown: string;
  isActive: boolean;
}

export interface ResolvableBroadcast {
  contentMode: EmailBroadcastContentMode;
  subject: string;
  bodyMarkdown: string | null;
  templateId: string | null;
}

export interface ResolvedContent {
  subject: string;
  bodyMarkdown: string;
}

/**
 * Decide what this broadcast actually says.
 *
 * The template loader is injected so this stays testable without a database, and so the
 * worker and the admin preview route resolve content through identical code — a preview
 * that renders different content than the send is worse than no preview.
 *
 * Throws rather than falling back: every failure here means the admin's intent is
 * ambiguous, and the safe reading of an ambiguous mass email is "don't send it".
 */
export async function resolveBroadcastContent(
  broadcast: ResolvableBroadcast,
  loadTemplate: (id: string) => Promise<BroadcastTemplateContent | null>,
): Promise<ResolvedContent> {
  if (broadcast.contentMode === 'compose') {
    const body = broadcast.bodyMarkdown?.trim();
    if (!body) throw new Error('Broadcast is in compose mode but has no body.');
    const subject = broadcast.subject.trim();
    if (!subject) throw new Error('Broadcast has no subject.');
    return { subject, bodyMarkdown: body };
  }

  if (!broadcast.templateId) {
    throw new Error('Broadcast is in template mode but names no template.');
  }

  const template = await loadTemplate(broadcast.templateId);
  if (!template) {
    throw new Error(`Broadcast template ${broadcast.templateId} not found.`);
  }
  if (!template.isActive) {
    // Retiring a template is how an operator says "stop sending this". Honour it here
    // rather than only in the UI that picks one.
    throw new Error(`Broadcast template ${broadcast.templateId} is not active.`);
  }

  const body = template.bodyMarkdown.trim();
  if (!body) throw new Error(`Broadcast template ${broadcast.templateId} has an empty body.`);

  // The broadcast's own subject wins when set, so an admin can reuse a template's body
  // under a new subject line without editing (and versioning) the template itself.
  const subject = broadcast.subject.trim() || template.subject.trim();
  if (!subject) throw new Error('Broadcast has no subject and its template supplies none.');

  return { subject, bodyMarkdown: body };
}

export interface RenderBroadcastEmailInput {
  subject: string;
  bodyMarkdown: string;
  /** Per-recipient unsubscribe link (a placeholder in a dry-run preview). */
  unsubscribeUrl: string;
  postalAddress?: string;
}

/**
 * Build the email element: markdown → sanitized HTML → branded shell.
 *
 * The live send hands this element to `sendEmail` and the preview renders it to a string,
 * so both paths go through one construction. A preview built any other way would be
 * evidence about a different email than the one that ships.
 */
export function buildBroadcastEmail(input: RenderBroadcastEmailInput): ReactElement {
  return BroadcastEmail({
    preview: input.subject,
    bodyHtml: renderMarkdownToSafeHtml(input.bodyMarkdown),
    unsubscribeUrl: input.unsubscribeUrl,
    postalAddress: input.postalAddress,
  });
}

/** Render the final email HTML — the dry-run preview, and what the admin approves. */
export function renderBroadcastEmail(input: RenderBroadcastEmailInput): Promise<string> {
  return renderEmailToHtml(buildBroadcastEmail(input));
}

/**
 * The absolute links the email puts in front of recipients, for the reachability
 * preflight — a CTA that 404s reaches everyone at once and cannot be un-sent.
 *
 * Only `http(s)` is returned: `mailto:` has nothing to fetch. Deduplicated, because a
 * link repeated in the body and the button is one page to check, not two.
 */
export function extractCtaUrls(html: string): string[] {
  const urls = new Set<string>();
  const hrefPattern = /href\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(hrefPattern)) {
    const raw = match[1].trim();
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(raw);
    } catch {
      // Not absolute — nothing to reach out and check.
    }
  }

  return [...urls];
}