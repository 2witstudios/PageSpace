import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { type db as DbType } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { and, eq, inArray } from '@pagespace/db/operators';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { buildAssetKey, buildAssetUrlFromKey, copyObjectToPublishBucket } from './published-storage';
import { extractInterPageLinks, rewriteInterPageLinks } from './file-view-links';

type FileReferenceKind = 'view' | 'thumbnail';

interface FileReference {
  id: string;
  kind: FileReferenceKind;
  driveId?: string;
}

interface PublishAsset {
  id: string;
  kind: FileReferenceKind;
  sourceKey: string;
  assetKey: string;
  contentType: string;
}

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/i;

const createFileRefRegex = (): RegExp =>
  /(?:https?:\/\/[^/'">\s]*)?(?:\/api\/files\/([a-zA-Z0-9_-]+)\/(view|thumbnail)|\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/(view))(?=$|[?#"')\s>])/g;

const referenceKey = ({ id, kind, driveId }: FileReference): string =>
  driveId ? `dashboard:${driveId}:${id}:${kind}` : `api:${id}:${kind}`;

export interface OgMeta {
  ogTitle?: string;
  ogImageUrl?: string;
  ogDescription?: string;
  faviconHref?: string;
  /** Plain `<title>` the author wrote — a lower-priority fallback behind `ogTitle`. */
  title?: string;
  /** Plain `<meta name="description">` the author wrote — a lower-priority fallback behind `ogDescription`. */
  description?: string;
}

/**
 * Extract SEO/OG/favicon meta from already-rewritten canvas HTML and strip
 * those tags from the body so they can be hoisted into <head> by
 * renderCanvasDocument. This is how code wins: whatever the author wrote
 * directly in their canvas — whether a small fragment with an inline
 * `<meta property="og:*">`, or a complete standalone document with its own
 * `<title>`/`<meta name="description">` — is read here and later takes
 * precedence over UI-only fallbacks (see `resolvePublishedMeta`).
 *
 * Reads standard HTML semantics the author placed directly in the canvas:
 *   <meta property="og:title"       content="…">  → ogTitle
 *   <meta property="og:image"       content="…">  → ogImageUrl
 *   <meta property="og:description" content="…">  → ogDescription
 *   <link rel="icon" href="…">                    → faviconHref
 *   <title>…</title>                              → title (fallback behind ogTitle)
 *   <meta name="description" content="…">         → description (fallback behind ogDescription)
 *
 * After rewriteCanvasAssets has run, any file URLs in those attributes are
 * already public CDN URLs, so no further rewriting is needed here.
 *
 * Pure function: no I/O, no env reads.
 */
/**
 * Strip every `<meta property="{property}" content="…">` tag (either attribute
 * order) from `html`, invoking `assign` with each match's `content`. Shared by
 * the og:image/og:title/og:description extractions below, which differ only in
 * the property name and where the captured content is stored.
 */
function stripMetaProperty(html: string, property: string, assign: (content: string) => void): string {
  const propertyFirst = new RegExp(`<meta\\b[^>]+property="${property}"[^>]+content="([^"]*)"[^>]*/?>`, 'gi');
  const contentFirst = new RegExp(`<meta\\b[^>]+content="([^"]*)"[^>]+property="${property}"[^>]*/?>`, 'gi');
  return html
    .replace(propertyFirst, (_, content: string) => {
      assign(content);
      return '';
    })
    .replace(contentFirst, (_, content: string) => {
      assign(content);
      return '';
    });
}

/** Same as `stripMetaProperty`, but for `<meta name="{name}" content="…">`. */
function stripMetaName(html: string, name: string, assign: (content: string) => void): string {
  const nameFirst = new RegExp(`<meta\\b[^>]+name="${name}"[^>]+content="([^"]*)"[^>]*/?>`, 'gi');
  const contentFirst = new RegExp(`<meta\\b[^>]+content="([^"]*)"[^>]+name="${name}"[^>]*/?>`, 'gi');
  return html
    .replace(nameFirst, (_, content: string) => {
      assign(content);
      return '';
    })
    .replace(contentFirst, (_, content: string) => {
      assign(content);
      return '';
    });
}

/**
 * Strip a document-level `<title>…</title>` tag, invoking `assign` with its
 * text. A `<title>` nested inside an inline `<svg>…</svg>` is valid
 * accessibility markup (the SVG's accessible name), not page metadata, so it
 * must be left untouched — both the tag itself and any title text inside it.
 *
 * Mirrors the alternation pattern in `extractAndSanitizeStyles`
 * (packages/lib/src/canvas/render-document.ts): a single regex alternates
 * between whole `<svg>...</svg>` blocks (consumed first, returned verbatim)
 * and the `<title>` pattern, acting only on the capture group that matched.
 */
function stripTitle(html: string, assign: (content: string) => void): string {
  const svgOrTitle =
    /<svg(?=[\s/>])[^>]*>[\s\S]*?<\/svg(?=[\s/>])[^>]*>|<title(?=[\s/>])[^>]*>([\s\S]*?)<\/title(?=[\s/>])[^>]*>/gi;
  return html.replace(svgOrTitle, (match, content: string | undefined) => {
    if (content !== undefined) {
      assign(content);
      return '';
    }
    return match; // <svg> block — leave verbatim, including any nested <title>
  });
}

export function extractAndStripOgMeta(html: string): { meta: OgMeta; html: string } {
  const meta: OgMeta = {};

  let result = stripMetaProperty(html, 'og:image', (content) => {
    meta.ogImageUrl ??= content || undefined;
  });
  result = stripMetaProperty(result, 'og:title', (content) => {
    meta.ogTitle ??= content || undefined;
  });
  result = stripMetaProperty(result, 'og:description', (content) => {
    meta.ogDescription ??= content || undefined;
  });
  result = stripMetaName(result, 'description', (content) => {
    meta.description ??= content || undefined;
  });
  result = stripTitle(result, (content) => {
    meta.title ??= content || undefined;
  });
  result = result
    .replace(/<link\b[^>]+rel="icon"[^>]+href="([^"]*)"[^>]*\/?>/gi, (_, href: string) => {
      meta.faviconHref ??= href || undefined;
      return '';
    })
    .replace(/<link\b[^>]+href="([^"]*)"[^>]+rel="icon"[^>]*\/?>/gi, (_, href: string) => {
      meta.faviconHref ??= href || undefined;
      return '';
    });

  return { meta, html: result };
}

/**
 * Extract all unique PageSpace file IDs referenced in canvas HTML.
 *
 * Scans `src`, `href`, CSS `url()` values — any occurrence of the pattern
 * `/api/files/{id}/view`, `/api/files/{id}/thumbnail`, or
 * `/dashboard/{driveId}/{pageId}/view`.
 *
 * Pure function: no I/O, no env reads.
 */
export function extractFileIds(html: string): string[] {
  const ids = new Set<string>();
  for (const { id } of extractFileReferences(html)) {
    ids.add(id);
  }
  return Array.from(ids);
}

function extractFileReferences(html: string): FileReference[] {
  const refsByKey = new Map<string, FileReference>();
  for (const match of html.matchAll(createFileRefRegex())) {
    const ref = match[1]
      ? { id: match[1], kind: match[2] as FileReferenceKind }
      : { driveId: match[3], id: match[4], kind: match[5] as FileReferenceKind };
    refsByKey.set(referenceKey(ref), ref);
  }
  return Array.from(refsByKey.values());
}

/**
 * DB shape expected by rewriteCanvasAssets — only the columns we read.
 */
interface FilePageRow {
  id: string;
  driveId: string | null;
  contentHash: string | null;
  mimeType: string | null;
  extractionMetadata: unknown;
}

function getThumbnailSourceKey(row: FilePageRow): string | null {
  const metadata = row.extractionMetadata;
  if (!metadata || typeof metadata !== 'object' || !('thumbnailKey' in metadata)) {
    return null;
  }

  const thumbnailKey = (metadata as { thumbnailKey?: unknown }).thumbnailKey;
  if (typeof thumbnailKey !== 'string') return null;

  return /^cache\/[a-f0-9]+\/thumbnail\.webp$/i.test(thumbnailKey) ? thumbnailKey : null;
}

function resolvePublishAsset(row: FilePageRow, kind: FileReferenceKind): PublishAsset | null {
  if (kind === 'thumbnail') {
    const sourceKey = getThumbnailSourceKey(row);
    if (!sourceKey) return null;
    return {
      id: row.id,
      kind,
      sourceKey,
      assetKey: `assets/${sourceKey}`,
      contentType: 'image/webp',
    };
  }

  if (!row.contentHash || !CONTENT_HASH_RE.test(row.contentHash)) return null;
  try {
    const contentHash = row.contentHash.toLowerCase();
    return {
      id: row.id,
      kind,
      sourceKey: `files/${contentHash}/original`,
      assetKey: buildAssetKey(contentHash),
      contentType: row.mimeType ?? 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an uploaded FILE page to a durable public CDN URL, copying it to the
 * publish bucket if needed (idempotent — see `copyObjectToPublishBucket`).
 *
 * Used wherever a user picks one of their own uploaded files as an image
 * reference (OG image, favicon) instead of pasting a URL: `/api/files/{id}/view`
 * and `/dashboard/.../view` both require auth, so a pasted link to one of those
 * silently fails for anonymous site visitors. Resolving through this function
 * — the same resolution `rewriteCanvasAssets` already applies to canvas-embedded
 * images — turns the reference into a URL that actually loads publicly.
 *
 * Returns null when the page doesn't exist, is trashed, isn't viewable by
 * `userId`, isn't in `driveId`, or has no resolvable asset (e.g. no
 * contentHash yet).
 */
export async function resolveUploadedImageAssetUrl(params: {
  fileId: string;
  driveId: string;
  userId: string;
  db: Pick<typeof DbType, 'query'>;
}): Promise<string | null> {
  const { fileId, driveId, userId, db } = params;

  const row = (await db.query.pages.findFirst({
    where: and(eq(pages.id, fileId), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true, contentHash: true, mimeType: true, extractionMetadata: true },
  })) as FilePageRow | undefined;
  if (!row) return null;
  // Scope to the drive being configured — same precondition rewriteCanvasAssets
  // enforces for dashboard-style file references (line ~255 below). Without
  // this, a user with mere view access to a file in an unrelated drive (e.g. a
  // page shared with them individually) could make it publicly served as
  // another drive's OG image/favicon — view access isn't consent to publish.
  if (row.driveId !== driveId) return null;

  const canView = await canUserViewPage(userId, fileId).catch(() => false);
  if (!canView) return null;

  const asset = resolvePublishAsset(row, 'view');
  if (!asset) return null;

  await copyObjectToPublishBucket(asset);
  return buildAssetUrlFromKey(asset.assetKey);
}

async function filterViewableRows(userId: string, rows: FilePageRow[]): Promise<FilePageRow[]> {
  const checks = await Promise.all(
    rows.map(async (row) => ({
      row,
      canView: await canUserViewPage(userId, row.id).catch((err) => {
        loggers.api.warn('asset-pipeline: failed to authorize referenced asset', {
          fileId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }),
    })),
  );

  return checks.filter(({ canView }) => canView).map(({ row }) => row);
}

/**
 * Rewrite all `/api/files/{id}/view`, `/api/files/{id}/thumbnail`, and
 * `/dashboard/{driveId}/{pageId}/view` references in canvas HTML to public CDN
 * asset URLs, copying any referenced files to the publish bucket along the way.
 *
 * - Unresolvable IDs (file not found in DB, or page has no contentHash) are
 *   left as-is — publish still succeeds; the image just won't load publicly.
 * - DB is queried once for all IDs (batch, not N+1).
 * - Copy is idempotent (HeadObject dedup in copyAssetToPublishBucket).
 */
export async function rewriteCanvasAssets(params: {
  html: string;
  userId: string;
  db: Pick<typeof DbType, 'query'>;
}): Promise<{ html: string }> {
  const { html, userId, db } = params;

  const references = extractFileReferences(html);
  const fileIds = Array.from(new Set(references.map(({ id }) => id)));
  if (fileIds.length === 0) return { html };

  // Batch-query referenced page rows; permission checks below decide which assets can publish.
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const rows = (await db.query.pages.findMany({
    where: inArray(pages.id, fileIds),
    columns: { id: true, driveId: true, contentHash: true, mimeType: true, extractionMetadata: true },
  })) as FilePageRow[];

  const rowsById = new Map((await filterViewableRows(userId, rows)).map((row) => [row.id, row]));
  const resolved = new Map<string, PublishAsset>();
  const uniqueAssets = new Map<string, PublishAsset>();

  for (const ref of references) {
    const row = rowsById.get(ref.id);
    if (!row) continue;
    if (ref.driveId && row.driveId !== ref.driveId) continue;
    const asset = resolvePublishAsset(row, ref.kind);
    if (!asset) continue;
    resolved.set(referenceKey(ref), asset);
    uniqueAssets.set(asset.assetKey, asset);
  }

  if (resolved.size === 0) return { html };

  // Copy each distinct source object to the publish bucket; only successful copies are rewritten.
  const copiedAssetKeys = new Set<string>();
  await Promise.all(
    Array.from(uniqueAssets.values()).map(async (asset) => {
      try {
        await copyObjectToPublishBucket(asset);
        copiedAssetKeys.add(asset.assetKey);
      } catch (err) {
        loggers.api.warn('asset-pipeline: failed to copy asset', {
          fileId: asset.id,
          kind: asset.kind,
          sourceKey: asset.sourceKey,
          assetKey: asset.assetKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  const rewritten = html.replace(createFileRefRegex(), (
    match,
    apiId: string | undefined,
    apiKind: FileReferenceKind | undefined,
    dashboardDriveId: string | undefined,
    dashboardPageId: string | undefined,
    dashboardKind: FileReferenceKind | undefined,
  ) => {
    const ref = apiId
      ? { id: apiId, kind: apiKind as FileReferenceKind }
      : { driveId: dashboardDriveId, id: dashboardPageId as string, kind: dashboardKind as FileReferenceKind };
    const asset = resolved.get(referenceKey(ref));
    return asset && copiedAssetKeys.has(asset.assetKey) ? buildAssetUrlFromKey(asset.assetKey) : match;
  });

  return { html: rewritten };
}

/**
 * Rewrite canvas inter-page links (`/dashboard/{driveId}/{pageId}` and the
 * `/view` variant) to the target page's PUBLIC published URL, so navigation
 * between published pages works on `<subdomain>.pagespace.site`.
 *
 * This is the thin I/O shell around the pure `rewriteInterPageLinks` transform:
 * it builds the `pageId → published path` map by querying `published_pages`,
 * scoped to THIS drive (`driveId` in the WHERE clause) and restricted to the
 * page ids actually referenced in the HTML. Because only same-drive published
 * pages enter the map:
 *  - a link to a published sibling rewrites to its `pagespace.site/<path>` URL;
 *  - a link to the drive home page rewrites to the site root `/`;
 *  - a link to an unpublished or out-of-drive page is left unchanged (the pure
 *    transform's documented fallback) so it never fails the publish build.
 *
 * Runs AFTER `rewriteCanvasAssets`: file-view links to actual file pages are
 * already CDN URLs by then, so the only `/dashboard/.../view` links left for
 * this pass are page→page links.
 *
 * The page CURRENTLY being published (`currentPageId` / `currentPath`) is seeded
 * into the map directly rather than read from the DB: its `published_pages` row
 * does not exist yet on first publish, and still holds the OLD path when
 * republishing at a new path (the upsert happens later in `publishCanvasPage`).
 * Seeding from the freshly-computed path means a canvas link back to the page
 * being published — common in nav/logo links, and the norm for a home page —
 * resolves to the correct public URL instead of a dead `/dashboard/...` link or
 * a stale path.
 */
export async function rewriteInterPageLinksForDrive(params: {
  html: string;
  driveId: string;
  subdomain: string;
  homePageId: string | null;
  currentPageId: string;
  currentPath: string;
  db: Pick<typeof DbType, 'query'>;
}): Promise<{ html: string }> {
  const { html, driveId, subdomain, homePageId, currentPageId, currentPath, db } = params;

  const links = extractInterPageLinks(html);
  const pageIds = Array.from(new Set(links.map(({ pageId }) => pageId)));
  if (pageIds.length === 0) return { html };

  // Drive-scoped: only pages published under THIS drive's site may be linked.
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const rows = (await db.query.publishedPages.findMany({
    where: and(eq(publishedPages.driveId, driveId), inArray(publishedPages.pageId, pageIds)),
    columns: { pageId: true, path: true },
  })) as Array<{ pageId: string; path: string }>;

  const pathByPageId = new Map(rows.map((row) => [row.pageId, row.path]));

  // The drive home page is also served at the site root; link to it as '/'.
  if (homePageId && pathByPageId.has(homePageId)) {
    pathByPageId.set(homePageId, '');
  }

  // Seed the page being published from its freshly-computed path, overriding any
  // missing (first publish) or stale (republish at a new path) DB row. The home
  // page is served at the root, so it resolves to '/'.
  pathByPageId.set(currentPageId, currentPageId === homePageId ? '' : currentPath);

  return { html: rewriteInterPageLinks(html, pathByPageId, subdomain) };
}
