/**
 * Page-mutation shell.
 *
 * The imperative shell around computePageMutation: reads the current page,
 * applies the revision-guarded write (WHERE id = ? AND revision = ?), syncs
 * mentions when content changed, and records a page version — all against the
 * injected deps.db (which is the transaction when one is threaded). A concurrent
 * edit makes the guarded write return no row, which throws
 * 'Page was modified while applying rollback'.
 */
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { SyncMentionsResult } from '@/services/api/page-mention-service';
import { computePageMutation } from './page-mutation-plan';
import type { RollbackDeps, PageMutationMeta, PageUpdateWithRevisionOptions } from './deps';

export async function applyPageUpdateWithRevision(
  deps: RollbackDeps,
  pageId: string,
  updateData: Record<string, unknown>,
  options?: PageUpdateWithRevisionOptions
): Promise<PageMutationMeta> {
  const [currentPage] = await deps.db
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!currentPage) {
    throw new Error('Page not found');
  }

  const {
    currentRevision,
    nextRevision,
    nextContent,
    contentFormatAfter,
    contentRefAfter,
    stateHashBefore,
    stateHashAfter,
  } = computePageMutation(currentPage, updateData);

  const [updated] = await deps.db
    .update(pages)
    .set({
      ...updateData,
      revision: nextRevision,
      stateHash: stateHashAfter,
      updatedAt: deps.clock(),
    })
    .where(and(eq(pages.id, pageId), eq(pages.revision, currentRevision)))
    .returning({ id: pages.id });

  if (!updated) {
    throw new Error('Page was modified while applying rollback');
  }

  let mentionsResult: SyncMentionsResult | undefined;
  if (updateData.content !== undefined) {
    mentionsResult = await deps.syncMentions(pageId, nextContent, deps.db, { mentionedByUserId: options?.userId ?? undefined });
  }

  const changeGroupId = options?.changeGroupId ?? deps.genChangeGroupId();
  const changeGroupType = options?.changeGroupType ?? deps.inferChangeGroupType({ isAiGenerated: false });

  const version = await deps.createPageVersion({
    pageId,
    driveId: currentPage.driveId,
    createdBy: options?.userId ?? null,
    source: options?.source ?? 'restore',
    content: nextContent,
    contentFormat: contentFormatAfter,
    pageRevision: nextRevision,
    stateHash: stateHashAfter,
    changeGroupId,
    changeGroupType,
    metadata: options?.metadata,
  }, { tx: deps.db });

  return {
    pageId,
    nextRevision,
    stateHashBefore,
    stateHashAfter,
    contentRefAfter: version.contentRef ?? contentRefAfter ?? null,
    contentSizeAfter: version.contentSize ?? null,
    contentFormatAfter,
    mentionsResult,
  };
}
