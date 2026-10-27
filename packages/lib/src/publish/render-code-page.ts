import { renderCanvasDocument } from '../canvas/render-document';
import { buildDocumentCsp } from '../canvas/csp';
import { escapeHtml } from '../utils/html';
import { wrapDocumentBody, DOCUMENT_TYPOGRAPHY_CSS } from './document-shell';

export interface RenderCodePageInput {
  code: string;
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
 * Render a CODE page as a complete, standalone HTML document. No syntax
 * highlighting (Shiki is client-side in this repo) — the raw code string is
 * HTML-escaped and emitted verbatim inside `<pre><code>`, so it can never
 * carry live markup.
 *
 * Mirrors `render-document-page.ts`: reuses the canvas renderer's whole head
 * assembly (SEO/OG/Twitter/JSON-LD, favicon, CSP `<meta>`) via
 * `cspOverride`/`injectThemeBridge: false` rather than duplicating it — CODE
 * pages never run author scripts, so they get `buildDocumentCsp()`
 * (`script-src 'none'`) and no theme-bridge script.
 */
export function renderCodePage(input: RenderCodePageInput): string {
  const { code, title, pageUrl, ogImageUrl, ogDescription, description, robots, faviconHref, faviconBaseUrl, lang, allowedAssetHosts } = input;

  const wrappedBody = wrapDocumentBody({
    bodyHtml: `<pre><code>${escapeHtml(code ?? '')}</code></pre>`,
    title,
  });

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
