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
}

interface PublishAsset {
  id: string;
  kind: FileReferenceKind;
  sourceKey: string;
  assetKey: string;
  contentType: string;
}

const createFileRefRegex = (): RegExp =>
  /(?:https?:\/\/[^/'">\s]*)?\/api\/files\/([a-zA-Z0-9_-]+)\/(view|thumbnail)(?=$|[?#"')\s>])/g;

const referenceKey = ({ id, kind }: FileReference): string => `${id}:${kind}`;

/**
 * Extract all unique PageSpace file IDs referenced in canvas HTML.
 *
 * Scans `src`, `href`, CSS `url()` values — any occurrence of the pattern
 * `/api/files/{id}/view` or `/api/files/{id}/thumbnail`.
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
    const ref = { id: match[1], kind: match[2] as FileReferenceKind };
    refsByKey.set(referenceKey(ref), ref);
  }
  return Array.from(refsByKey.values());
}

/**
 * DB shape expected by rewriteCanvasAssets — only the columns we read.
 */
interface FilePageRow {
  id: string;
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

  if (!row.contentHash) return null;
  return {
    id: row.id,
    kind,
    sourceKey: `files/${row.contentHash}/original`,
    assetKey: buildAssetKey(row.contentHash),
    contentType: row.mimeType ?? 'application/octet-stream',
  };
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
 * Rewrite all `/api/files/{id}/view` (and `/thumbnail`) references in the
 * canvas HTML to public CDN asset URLs, copying any referenced files to the
 * publish bucket along the way.
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
    columns: { id: true, contentHash: true, mimeType: true, extractionMetadata: true },
  })) as FilePageRow[];

  const rowsById = new Map((await filterViewableRows(userId, rows)).map((row) => [row.id, row]));
  const resolved = new Map<string, PublishAsset>();
  const uniqueAssets = new Map<string, PublishAsset>();

  for (const ref of references) {
    const row = rowsById.get(ref.id);
    if (!row) continue;
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

  const rewritten = html.replace(createFileRefRegex(), (match, id: string, kind: FileReferenceKind) => {
    const asset = resolved.get(referenceKey({ id, kind }));
    return asset && copiedAssetKeys.has(asset.assetKey) ? buildAssetUrlFromKey(asset.assetKey) : match;
  });

  return { html: rewritten };
}
