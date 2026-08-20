/**
 * Decides whether a text-extraction result may be written to a page's body.
 *
 * The processor is a separate process on a raw pg driver: its writes bump no
 * revision, record no `page_versions` row, log no activity and broadcast
 * nothing. That is acceptable for a FILE page, whose body IS the machine
 * extraction the processor owns — and only for a FILE page. A DOCUMENT body is
 * authored by people (and, later, by a Y.Doc), so an extraction write there is
 * pure data loss.
 *
 * The hazard is not hypothetical at enqueue time: a FILE page can be converted
 * to a DOCUMENT (`/api/files/[id]/convert-to-document`) after extraction has
 * been queued but before the job runs. So the type must be evaluated at WRITE
 * time, under a row lock, not when the job was created.
 */

/** The one page type whose body the processor may write. */
export const EXTRACTABLE_PAGE_TYPE = 'FILE';

export interface ExtractionTarget {
  /** The page's current type, read under a row lock; `null` when the page is gone. */
  pageType: string | null;
}

export type ExtractionWriteDecision =
  /** Still a FILE — write the extracted body along with the processing bookkeeping. */
  | { action: 'write' }
  /** Converted since enqueue — keep the bookkeeping, never touch the body. */
  | { action: 'skip-content'; pageType: string }
  /** Page no longer exists — write nothing at all. */
  | { action: 'skip-all' };

export function decideExtractionWrite(target: ExtractionTarget): ExtractionWriteDecision {
  if (target.pageType === null) {
    return { action: 'skip-all' };
  }
  if (target.pageType !== EXTRACTABLE_PAGE_TYPE) {
    return { action: 'skip-content', pageType: target.pageType };
  }
  return { action: 'write' };
}
