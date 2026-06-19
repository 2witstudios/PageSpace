import 'server-only';

import { type db as DbType } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { inArray } from '@pagespace/db/operators';
import { buildAssetUrl, copyAssetToPublishBucket } from './published-storage';

/**
 * Regex that matches /api/files/{id}/view and /api/files/{id}/thumbnail in:
 *  - HTML attributes (src, href, srcset)
 *  - CSS url() values (single- or double-quoted, or unquoted)
 *
 * The id capture group is group 1.
 *
 * Anchored to the start of a possible absolute origin (https://…) or a bare
 * relative path so we never accidentally match external non-PageSpace URLs
 * that happen to contain `/api/files/`.
 */
const FILE_REF_REGEX = /(?:https?:\/\/[^/'">\s]*)?\/api\/files\/([a-zA-Z0-9_-]+)\/(?:view|thumbnail)/g;

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
  let match: RegExpExecArray | null;
  FILE_REF_REGEX.lastIndex = 0;
  while ((match = FILE_REF_REGEX.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * DB shape expected by rewriteCanvasAssets — only the columns we read.
 */
interface FilePageRow {
  id: string;
  contentHash: string | null;
  mimeType: string | null;
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
  db: Pick<typeof DbType, 'query'>;
}): Promise<{ html: string }> {
  const { html, db } = params;

  const fileIds = extractFileIds(html);
  if (fileIds.length === 0) return { html };

  // Batch-query: only FILE-type pages, only the columns we need
  const rows = (await db.query.pages.findMany({
    where: inArray(pages.id, fileIds),
    columns: { id: true, contentHash: true, mimeType: true },
  })) as FilePageRow[];

  // Build id → { contentHash, mimeType } map (skip pages with no hash)
  const resolved = new Map<string, { contentHash: string; mimeType: string }>();
  for (const row of rows) {
    if (row.contentHash) {
      resolved.set(row.id, {
        contentHash: row.contentHash,
        mimeType: row.mimeType ?? 'application/octet-stream',
      });
    }
  }

  if (resolved.size === 0) return { html };

  // Copy all resolved assets to publish bucket (content-addressed → idempotent)
  await Promise.all(
    Array.from(resolved.values()).map((asset) =>
      copyAssetToPublishBucket(asset).catch((err) => {
        console.warn(`[asset-pipeline] Failed to copy asset ${asset.contentHash}:`, err);
      }),
    ),
  );

  // One-pass URL rewrite
  FILE_REF_REGEX.lastIndex = 0;
  const rewritten = html.replace(FILE_REF_REGEX, (match, id: string) => {
    const asset = resolved.get(id);
    return asset ? buildAssetUrl(asset.contentHash) : match;
  });

  return { html: rewritten };
}
