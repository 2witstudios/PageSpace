import { deriveDescription } from './render-document';

/**
 * Author-supplied per-page SEO overrides for a published canvas page, set via
 * the publish dialog. Each field is optional and may be null/empty (treated as
 * "no override"). These map to the persisted `published_pages.publish_*`
 * columns. They only take effect when the canvas code itself doesn't already
 * set the equivalent meta — code wins (see {@link resolvePublishedMeta}).
 */
export interface PublishedMetaOverride {
  /** Used when the canvas code sets no `<title>`/`og:title`. Blank → fall back to page title. */
  title?: string | null;
  /** Used when the canvas code sets no description meta. Blank → fall back to derived text. */
  description?: string | null;
  /** Used when the canvas code sets no `og:image`. Blank → fall back to the drive default. */
  ogImageUrl?: string | null;
}

/**
 * Inputs to {@link resolvePublishedMeta}. `canvasMeta` (what the author wrote
 * in code) is the highest-priority source; `override` (the publish dialog) and
 * the drive default are progressively lower fallbacks; `body` is the last
 * resort for the description.
 */
export interface ResolvePublishedMetaInput {
  /** Author overrides (per-page). Highest priority. */
  override?: PublishedMetaOverride | null;
  /** Persisted noindex flag for this page. Maps directly to the robots directive. */
  noindex?: boolean;
  /** The live page title, used when no title override is set. */
  pageTitle?: string | null;
  /**
   * Meta the author embedded directly in the canvas code — either `og:*`
   * properties or plain `<title>`/`<meta name="description">`. This is
   * authoritative: code wins over the publish dialog's UI override fields
   * (see the precedence note on {@link resolvePublishedMeta}).
   */
  canvasMeta?: {
    ogTitle?: string | null;
    ogImageUrl?: string | null;
    ogDescription?: string | null;
    title?: string | null;
    description?: string | null;
  } | null;
  /** Drive-level default share image, used when neither override nor canvas set one. */
  driveDefaultOgImageUrl?: string | null;
  /** Rendered page body, used to derive a description when nothing else supplies one. */
  body: string;
}

/**
 * Fully-resolved published-page metadata. `description` is unified — the same
 * value backs both `<meta name="description">` and `og:description`. `title` and
 * `ogImageUrl` are `undefined` when no source supplies them (the renderer then
 * falls back to `"Untitled"` / omits the image).
 */
export interface ResolvedPublishedMeta {
  title?: string;
  description: string;
  ogImageUrl?: string;
  robots: 'noindex' | 'index, follow';
}

/** Trim a possibly-null string and return undefined when it is blank. */
function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the effective SEO metadata for a published canvas page from the layered
 * sources, applying a fixed precedence. Meta the author wrote directly in the
 * canvas code is authoritative — the publish dialog's UI override fields are a
 * fallback for when the author hasn't set something in code, not a forced
 * override:
 *
 *   title       = canvasMeta.ogTitle       → canvasMeta.title       → override.title       → pageTitle
 *   ogImageUrl  = canvasMeta.ogImageUrl    → override.ogImageUrl    → driveDefaultOgImageUrl
 *   description = canvasMeta.ogDescription → canvasMeta.description → override.description → deriveDescription(body)
 *   robots      = noindex ? 'noindex' : 'index, follow'
 *
 * Pure: no I/O, no env reads. The publish service is a thin shell over this.
 */
export function resolvePublishedMeta(input: ResolvePublishedMetaInput): ResolvedPublishedMeta {
  const { override, noindex, pageTitle, canvasMeta, driveDefaultOgImageUrl, body } = input;

  const title =
    clean(canvasMeta?.ogTitle) ?? clean(canvasMeta?.title) ?? clean(override?.title) ?? clean(pageTitle);

  const ogImageUrl =
    clean(canvasMeta?.ogImageUrl) ??
    clean(override?.ogImageUrl) ??
    clean(driveDefaultOgImageUrl);

  const description =
    clean(canvasMeta?.ogDescription) ??
    clean(canvasMeta?.description) ??
    clean(override?.description) ??
    deriveDescription(body);

  return {
    title,
    description,
    ogImageUrl,
    robots: noindex ? 'noindex' : 'index, follow',
  };
}
