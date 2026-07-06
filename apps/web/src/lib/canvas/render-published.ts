import 'server-only';

import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';
import { getPublicAssetHost } from './published-storage';

/**
 * Server-side renderer for PUBLISHED canvas pages.
 *
 * Thin wrapper over the shared isomorphic `renderCanvasDocument` so the published
 * artifact and the in-app canvas iframe render identically. Author HTML/JS is
 * PRESERVED (isolation is by origin, not by sanitizer); only the author CSS is
 * sanitized. The authoritative edge policy (frame-ancestors, etc.) is applied as
 * real response headers at the edge — see the deploy repo Caddy config.
 */
export interface RenderPublishedPageInput {
  html: string;
  title?: string;
  /**
   * Base URL of the public CDN bucket used for published assets
   * (e.g. `https://pagespace-published.t3.tigrisfiles.io`). When provided,
   * that host is allowed through the CSS `url()` sanitizer so that
   * background-image references to copied assets survive in the published
   * artifact. Omit for in-app rendering — the sanitizer keeps blocking all
   * external HTTPS `url()` values.
   */
  assetBaseUrl?: string;
  /** Base URL for favicon assets — see RenderCanvasDocumentInput.faviconBaseUrl. */
  faviconBaseUrl?: string;
  /** Explicit favicon href from the canvas — see RenderCanvasDocumentInput.faviconHref. */
  faviconHref?: string;
  /** Canonical public URL for OG/canonical meta tags — see RenderCanvasDocumentInput.pageUrl. */
  pageUrl?: string;
  /** Absolute URL of the OG social preview image — see RenderCanvasDocumentInput.ogImageUrl. */
  ogImageUrl?: string;
  /** Short description for og:description — see RenderCanvasDocumentInput.ogDescription. */
  ogDescription?: string;
  /** Document language for `<html lang>` — see RenderCanvasDocumentInput.lang (defaults to "en"). */
  lang?: string;
  /** SEO meta description; derived from content when omitted — see RenderCanvasDocumentInput.description. */
  description?: string;
  /** Robots directive; defaults to "index, follow" — see RenderCanvasDocumentInput.robots. */
  robots?: string;
  /** Scopes form-action/connect-src to this origin — see RenderCanvasDocumentInput.formActionOrigin. */
  formActionOrigin?: string;
}

/**
 * Render a complete, standalone HTML document for a published canvas page.
 */
export function renderPublishedPage(input: RenderPublishedPageInput): string {
  const { assetBaseUrl, faviconBaseUrl, faviconHref, pageUrl, ogImageUrl, ogDescription, lang, description, robots, ...rest } = input;
  const allowedAssetHosts = assetBaseUrl ? [getPublicAssetHost(assetBaseUrl)] : [];
  return renderCanvasDocument({ ...rest, allowedAssetHosts, faviconBaseUrl, faviconHref, pageUrl, ogImageUrl, ogDescription, lang, description, robots });
}
