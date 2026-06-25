import { deriveDescription } from './render-document';

/**
 * Author-supplied per-page SEO overrides for a published canvas page. Each field
 * is optional and may be null/empty (treated as "no override"). These map to the
 * persisted `published_pages.publish_*` columns and the publish dialog's inputs.
 */
export interface PublishedMetaOverride {
  /** Overrides the document `<title>` / `og:title`. Blank → fall back to page title. */
  title?: string | null;
  /** Overrides the meta + social description. Blank → fall back to canvas/derived. */
  description?: string | null;
  /** Overrides the social preview image URL. Blank → fall back to canvas/drive default. */
  ogImageUrl?: string | null;
}

/**
 * Inputs to {@link resolvePublishedMeta}. The override is the highest-priority
 * source; the canvas-extracted meta and the drive default are progressively
 * lower fallbacks; `body` is the last resort for the description.
 */
export interface ResolvePublishedMetaInput {
  /** Author overrides (per-page). Highest priority. */
  override?: PublishedMetaOverride | null;
  /** Persisted noindex flag for this page. Maps directly to the robots directive. */
  noindex?: boolean;
  /** The live page title, used when no title override is set. */
  pageTitle?: string | null;
  /** OG meta the author embedded in the canvas (`<meta property="og:*">`). */
  canvasMeta?: { ogImageUrl?: string | null; ogDescription?: string | null } | null;
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
 * sources, applying a fixed precedence:
 *
 *   title       = override.title          → pageTitle
 *   ogImageUrl  = override.ogImageUrl      → canvasMeta.ogImageUrl → driveDefaultOgImageUrl
 *   description = override.description      → canvasMeta.ogDescription → deriveDescription(body)
 *   robots      = noindex ? 'noindex' : 'index, follow'
 *
 * Pure: no I/O, no env reads. The publish service is a thin shell over this.
 */
export function resolvePublishedMeta(input: ResolvePublishedMetaInput): ResolvedPublishedMeta {
  const { override, noindex, pageTitle, canvasMeta, driveDefaultOgImageUrl, body } = input;

  const title = clean(override?.title) ?? clean(pageTitle);

  const ogImageUrl =
    clean(override?.ogImageUrl) ??
    clean(canvasMeta?.ogImageUrl) ??
    clean(driveDefaultOgImageUrl);

  const description =
    clean(override?.description) ??
    clean(canvasMeta?.ogDescription) ??
    deriveDescription(body);

  return {
    title,
    description,
    ogImageUrl,
    robots: noindex ? 'noindex' : 'index, follow',
  };
}
