import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { type db as DbType } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { inArray } from '@pagespace/db/operators';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { buildAssetKey, buildAssetUrlFromKey, copyObjectToPublishBucket } from './published-storage';

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
  ogImageUrl?: string;
  ogDescription?: string;
  faviconHref?: string;
}

/**
 * Extract OG/favicon meta from already-rewritten canvas HTML and strip those
 * tags from the body so they can be hoisted into <head> by renderCanvasDocument.
 *
 * Reads standard HTML semantics the author placed directly in the canvas:
 *   <meta property="og:image"       content="…">  → ogImageUrl
 *   <meta property="og:description" content="…">  → ogDescription
 *   <link rel="icon" href="…">                    → faviconHref
 *
 * After rewriteCanvasAssets has run, any file URLs in those attributes are
 * already public CDN URLs, so no further rewriting is needed here.
 *
 * Pure function: no I/O, no env reads.
 */
export function extractAndStripOgMeta(html: string): { meta: OgMeta; html: string } {
  const meta: OgMeta = {};

  const result = html
    .replace(/<meta\b[^>]+property="og:image"[^>]+content="([^"]*)"[^>]*\/?>/gi, (_, content: string) => {
      meta.ogImageUrl ??= content || undefined;
      return '';
    })
    .replace(/<meta\b[^>]+content="([^"]*)"[^>]+property="og:image"[^>]*\/?>/gi, (_, content: string) => {
      meta.ogImageUrl ??= content || undefined;
      return '';
    })
    .replace(/<meta\b[^>]+property="og:description"[^>]+content="([^"]*)"[^>]*\/?>/gi, (_, content: string) => {
      meta.ogDescription ??= content || undefined;
      return '';
    })
    .replace(/<meta\b[^>]+content="([^"]*)"[^>]+property="og:description"[^>]*\/?>/gi, (_, content: string) => {
      meta.ogDescription ??= content || undefined;
      return '';
    })
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
