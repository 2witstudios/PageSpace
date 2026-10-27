import { renderCanvasDocument } from '../canvas/render-document';
import { buildDocumentCsp } from '../canvas/csp';
import { sanitizeDocumentHtml } from './sanitize-document-html';
import { wrapDocumentBody, DOCUMENT_TYPOGRAPHY_CSS } from './document-shell';

export interface RenderDocumentPageInput {
  html: string;
  title: string;
  pageUrl?: string;
  ogImageUrl?: string;
  ogDescription?: string;
  description?: string;
  robots?: string;
  faviconHref?: string;
  faviconBaseUrl?: string;
  lang?: string;
  allowedAssetHosts?: string[];
}

/**
 * Render a complete, standalone HTML document for a published DOCUMENT page
 * (as opposed to a Canvas page — see `../canvas/render-document.ts`). Reuses
 * the canvas renderer's whole head assembly (SEO/OG/Twitter/JSON-LD, favicon,
 * CSP `<meta>`) via `cspOverride`/`injectThemeBridge: false` rather than
 * duplicating it: documents never run author scripts, so they get
 * `buildDocumentCsp()` (`script-src 'none'`) and no theme-bridge script
 * (standalone documents use `prefers-color-scheme` only).
 *
 * `DOCUMENT_TYPOGRAPHY_CSS` is prepended as a `<style>` block ahead of the
 * sanitized body so it flows through `renderCanvasDocument`'s existing CSS
 * sanitization/hoisting path exactly like an author `<style>` tag, landing in
 * the generated `<head>`.
 */
export function renderDocumentPage(input: RenderDocumentPageInput): string {
  const { html, title, pageUrl, ogImageUrl, ogDescription, description, robots, faviconHref, faviconBaseUrl, lang, allowedAssetHosts } = input;

  const sanitizedBody = sanitizeDocumentHtml(html);
  const wrappedBody = wrapDocumentBody({ bodyHtml: sanitizedBody, title });

  return renderCanvasDocument({
    html: `<style>${DOCUMENT_TYPOGRAPHY_CSS}</style>${wrappedBody}`,
    title,
    pageUrl,
    ogImageUrl,
    ogDescription,
    description,
    robots,
    faviconHref,
    faviconBaseUrl,
    lang,
    allowedAssetHosts,
    cspOverride: buildDocumentCsp(),
    injectThemeBridge: false,
  });
}
