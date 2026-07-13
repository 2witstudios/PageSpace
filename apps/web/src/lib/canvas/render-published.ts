import 'server-only';

import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';
import { renderDocumentPage } from '@pagespace/lib/publish/render-document-page';
import { renderCodePage } from '@pagespace/lib/publish/render-code-page';
import { renderSheetPage } from '@pagespace/lib/publish/render-sheet-page';
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
  return renderCanvasDocument({ ...rest, allowedAssetHosts, faviconBaseUrl, faviconHref, pageUrl, ogImageUrl, ogDescription, lang, description, robots, injectThemeBridge: true });
}

/**
 * SEO/head fields shared by the non-canvas published-document renderers below.
 * Same semantics as the matching fields on `RenderPublishedPageInput` — see
 * `RenderCanvasDocumentInput` for the full doc comments.
 */
interface PublishedDocumentHeadInput {
  /** Defaults to "Untitled" when omitted/blank — matches `renderPublishedPage`. */
  title?: string;
  assetBaseUrl?: string;
  faviconBaseUrl?: string;
  faviconHref?: string;
  pageUrl?: string;
  ogImageUrl?: string;
  ogDescription?: string;
  lang?: string;
  description?: string;
  robots?: string;
}

export interface RenderPublishedDocumentInput extends PublishedDocumentHeadInput {
  html: string;
}

/**
 * Server-side renderer for published DOCUMENT pages. Thin wrapper over
 * `renderDocumentPage` (shared with the DOCUMENT static renderer) plumbing
 * `assetBaseUrl` through to `allowedAssetHosts` exactly like `renderPublishedPage`.
 */
export function renderPublishedDocument(input: RenderPublishedDocumentInput): string {
  const { assetBaseUrl, title, ...rest } = input;
  const allowedAssetHosts = assetBaseUrl ? [getPublicAssetHost(assetBaseUrl)] : [];
  return renderDocumentPage({ ...rest, title: title?.trim() || 'Untitled', allowedAssetHosts });
}

export interface RenderPublishedCodeInput extends PublishedDocumentHeadInput {
  code: string;
}

/**
 * Server-side renderer for published CODE pages. Thin wrapper over
 * `renderCodePage` — see `renderPublishedDocument` above.
 */
export function renderPublishedCode(input: RenderPublishedCodeInput): string {
  const { assetBaseUrl, title, ...rest } = input;
  const allowedAssetHosts = assetBaseUrl ? [getPublicAssetHost(assetBaseUrl)] : [];
  return renderCodePage({ ...rest, title: title?.trim() || 'Untitled', allowedAssetHosts });
}

export interface RenderPublishedSheetInput extends PublishedDocumentHeadInput {
  serializedContent: unknown;
  hasHeaders?: boolean;
}

/**
 * Server-side renderer for published SHEET pages. Thin wrapper over
 * `renderSheetPage` — see `renderPublishedDocument` above.
 */
export function renderPublishedSheet(input: RenderPublishedSheetInput): string {
  const { assetBaseUrl, title, ...rest } = input;
  const allowedAssetHosts = assetBaseUrl ? [getPublicAssetHost(assetBaseUrl)] : [];
  return renderSheetPage({ ...rest, title: title?.trim() || 'Untitled', allowedAssetHosts });
}
