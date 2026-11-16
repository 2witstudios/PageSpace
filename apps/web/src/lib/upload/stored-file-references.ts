import { PageType } from '@pagespace/lib/utils/enums';

/**
 * Internal references to stored files inside page content, the shapes the app
 * serves bytes for:
 *   - `/api/files/{id}/view`, `/thumbnail`, `/download` (any host prefix, so an
 *     absolute URL to the app counts too)
 *   - `/dashboard/{driveId}/{pageId}/view`, the canvas embed convention
 *
 * The same shapes `lib/canvas/asset-pipeline.ts` rewrites on publish, plus
 * `download`. Kept separate because that module is `server-only` and pulls in the
 * publish storage; this one is pure.
 */
const STORED_FILE_REFERENCE =
  /\/api\/files\/([a-zA-Z0-9_-]+)\/(?:view|thumbnail|download)(?=$|[?#"')\s>\\])|\/dashboard\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\/view(?=$|[?#"')\s>\\])/g;

/** Every distinct file or page id that `content` references, in first-seen order. */
export function extractStoredFileReferenceIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(STORED_FILE_REFERENCE)) {
    ids.add(match[1] ?? match[2]);
  }
  return [...ids];
}

/** Page types whose `content` can embed stored files by reference. */
export function pageContentCanReferenceFiles(type: string): boolean {
  return type === PageType.DOCUMENT || type === PageType.CANVAS;
}
