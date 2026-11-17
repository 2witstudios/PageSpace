import { decodeHTML } from 'entities';
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
// An optional trailing slash: Next.js redirects `/view/` to `/view`, so it serves too.
const STORED_FILE_REFERENCE =
  /\/api\/files\/([a-zA-Z0-9_-]+)\/(?:view|thumbnail|download)\/?(?=$|[?#"')\s>\\])|\/dashboard\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\/view\/?(?=$|[?#"')\s>\\])/g;

/**
 * `content` with every `%XX` escape decoded, one byte at a time. The router
 * decodes path segments before matching, so `/api/files/%70age-a/%76iew` is
 * served as `/api/files/page-a/view`; screening the decoded form too means an
 * encoded reference can't slip past. Multi-byte sequences are irrelevant here:
 * every character a reference can contain is ASCII.
 */
function decodePercentEscapes(content: string): string {
  return content.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Every distinct file or page id that `content` references, in first-seen order.
 *
 * Scanned in every form a reference can take on its way to a request: the raw
 * text, the text with HTML character references resolved (the browser does
 * that to an attribute before it fetches — `&#101;`, `&sol;`, any named or
 * numeric reference, via the WHATWG decoder in `entities`), and the
 * percent-decoding of each (the router decodes path segments).
 */
export function extractStoredFileReferenceIds(content: string): string[] {
  const html = decodeHTML(content);
  const forms = new Set([content, decodePercentEscapes(content), html, decodePercentEscapes(html)]);
  const ids = new Set<string>();
  for (const text of forms) {
    for (const match of text.matchAll(STORED_FILE_REFERENCE)) {
      ids.add(match[1] ?? match[2]);
    }
  }
  return [...ids];
}

/** Page types whose `content` can embed stored files by reference. */
export function pageContentCanReferenceFiles(type: string): boolean {
  return type === PageType.DOCUMENT || type === PageType.CANVAS;
}
