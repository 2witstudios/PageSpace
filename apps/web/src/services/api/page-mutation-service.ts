import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { logActivityWithTx, type ActivityOperation, type ActivityResourceType, type DeferredWorkflowTrigger } from '@pagespace/lib/monitoring/activity-logger'
import { inferChangeGroupType, createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { computePageStateHash, createPageVersion, type PageVersionSource } from '@pagespace/lib/services/page-version-service'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { writePageContent } from '@pagespace/lib/services/page-content-store';
import { detectPageContentFormat, type PageContentFormat } from '@pagespace/lib/content/page-content-format';
import { hashWithPrefix } from '@pagespace/lib/utils/hash-utils';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import { replaceFromDocument, readSheetDocument } from '@pagespace/lib/sheets/store';
import { PageType } from '@pagespace/lib/utils/enums';
import { syncMentions, type SyncMentionsResult } from '@/services/api/page-mention-service';
import { createMentionNotification } from '@pagespace/lib/notifications/notifications';

export class PageRevisionMismatchError extends Error {
  currentRevision: number;
  expectedRevision?: number;

  constructor(message: string, currentRevision: number, expectedRevision?: number) {
    super(message);
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
  }
}

export interface PageMutationContext {
  userId: string;
  actorEmail?: string;
  actorDisplayName?: string | null;
  isAiGenerated?: boolean;
  aiProvider?: string;
  aiModel?: string;
  aiConversationId?: string;
  resourceType?: ActivityResourceType;
  changeGroupId?: string;
  changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
  metadata?: Record<string, unknown>;
}

export interface ApplyPageMutationInput {
  pageId: string;
  operation: ActivityOperation;
  updates: Record<string, unknown>;
  updatedFields?: string[];
  expectedRevision?: number;
  context: PageMutationContext;
  source?: PageVersionSource;
  tx?: typeof db;
}

export interface ApplyPageMutationResult {
  pageId: string;
  driveId: string;
  nextRevision: number;
  stateHashBefore: string;
  stateHashAfter: string;
  contentRefBefore: string | null;
  contentRefAfter: string | null;
  contentFormatBefore: PageContentFormat;
  contentFormatAfter: PageContentFormat;
  /** Deferred workflow trigger — callers that pass their own `tx` must invoke this after commit. Ignored if undefined. */
  deferredTrigger?: DeferredWorkflowTrigger;
}

const STRICT_REVISION = process.env.PAGE_REVISION_STRICT === 'true';

export async function applyPageMutation({
  pageId,
  operation,
  updates,
  updatedFields,
  expectedRevision,
  context,
  source,
  tx,
}: ApplyPageMutationInput): Promise<ApplyPageMutationResult> {
  const database = tx ?? db;
  const [currentPage] = await database
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!currentPage) {
    throw new Error('Page not found');
  }

  if (STRICT_REVISION && expectedRevision === undefined) {
    throw new PageRevisionMismatchError('Expected revision required', currentPage.revision, undefined);
  }

  if (expectedRevision !== undefined && currentPage.revision !== expectedRevision) {
    throw new PageRevisionMismatchError(
      'Page was modified since your last read',
      currentPage.revision,
      expectedRevision
    );
  }

  const nextRevision = currentPage.revision + 1;
  const changeGroupId = context.changeGroupId ?? createChangeGroupId();
  const changeGroupType = context.changeGroupType ?? inferChangeGroupType({ isAiGenerated: context.isAiGenerated });

  // A sheet's previous content is its rows, not its column.
  //
  // `pages.content` is empty for a materialised sheet, so hashing it produced a
  // `stateHashBefore` over the empty string while `stateHashAfter` covered the
  // real document — making the before/after pair in the activity chain
  // meaningless for exactly the pages that change most. One projection read on
  // the editor save path, which is already O(document).
  const isSheetPage = isSheetType(currentPage.type as PageType);
  const storedContent = currentPage.content ?? '';

  // Projected for EVERY sheet mutation, including rename, move and trash.
  //
  // An earlier version skipped the projection for non-content mutations as an
  // optimisation. That was wrong twice over: `nextContent` fell back to the
  // empty column, so renaming a 100k-row sheet wrote a ZERO-BYTE
  // `page_versions` entry that a restore would bring back blank, and the
  // state-hash pair stopped describing the same content.
  //
  // Renames are rare and the projection is bounded by the sheet; correctness
  // first. Read through `database` so a caller-supplied transaction sees its
  // own uncommitted writes rather than a stale snapshot.
  const previousContent = isSheetPage
    ? (await readSheetDocument(pageId, database as never)) ?? storedContent
    : storedContent;
  const nextContent = updates.content !== undefined ? String(updates.content) : previousContent;

  const contentFormatBefore = detectPageContentFormat(previousContent);
  const contentFormatAfter = detectPageContentFormat(nextContent);

  const contentRefBefore = hashWithPrefix(contentFormatBefore, previousContent);
  const contentRefAfter = hashWithPrefix(contentFormatAfter, nextContent);

  const stateHashBefore = computePageStateHash({
    title: currentPage.title,
    contentRef: contentRefBefore,
    parentId: currentPage.parentId,
    position: currentPage.position,
    isTrashed: currentPage.isTrashed,
    type: currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: currentPage.aiProvider,
    aiModel: currentPage.aiModel,
    systemPrompt: currentPage.systemPrompt,
    enabledTools: currentPage.enabledTools,
    isPaginated: currentPage.isPaginated,
    includeDrivePrompt: currentPage.includeDrivePrompt,
    agentDefinition: currentPage.agentDefinition,
    visibleToGlobalAssistant: currentPage.visibleToGlobalAssistant,
    includePageTree: currentPage.includePageTree,
    pageTreeScope: currentPage.pageTreeScope,
    toolExposureMode: currentPage.toolExposureMode,
    userScopedAccess: currentPage.userScopedAccess,
  });

  const nextPageState = {
    title: updates.title !== undefined ? String(updates.title) : currentPage.title,
    contentRef: contentRefAfter,
    parentId: updates.parentId !== undefined ? (updates.parentId as string | null) : currentPage.parentId,
    position: updates.position !== undefined ? Number(updates.position) : currentPage.position,
    isTrashed: updates.isTrashed !== undefined ? Boolean(updates.isTrashed) : currentPage.isTrashed,
    type: updates.type !== undefined ? String(updates.type) : currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: updates.aiProvider !== undefined
      ? (updates.aiProvider === null ? null : String(updates.aiProvider))
      : currentPage.aiProvider,
    aiModel: updates.aiModel !== undefined
      ? (updates.aiModel === null ? null : String(updates.aiModel))
      : currentPage.aiModel,
    systemPrompt: updates.systemPrompt !== undefined
      ? (updates.systemPrompt === null ? null : String(updates.systemPrompt))
      : currentPage.systemPrompt,
    enabledTools: updates.enabledTools !== undefined ? updates.enabledTools : currentPage.enabledTools,
    isPaginated: updates.isPaginated !== undefined ? Boolean(updates.isPaginated) : currentPage.isPaginated,
    includeDrivePrompt: updates.includeDrivePrompt !== undefined ? Boolean(updates.includeDrivePrompt) : currentPage.includeDrivePrompt,
    agentDefinition: updates.agentDefinition !== undefined
      ? (updates.agentDefinition === null ? null : String(updates.agentDefinition))
      : currentPage.agentDefinition,
    visibleToGlobalAssistant: updates.visibleToGlobalAssistant !== undefined ? Boolean(updates.visibleToGlobalAssistant) : currentPage.visibleToGlobalAssistant,
    includePageTree: updates.includePageTree !== undefined ? Boolean(updates.includePageTree) : currentPage.includePageTree,
    pageTreeScope: updates.pageTreeScope !== undefined
      ? (updates.pageTreeScope === null ? null : String(updates.pageTreeScope))
      : currentPage.pageTreeScope,
    toolExposureMode: updates.toolExposureMode !== undefined
      ? (updates.toolExposureMode === null ? null : String(updates.toolExposureMode))
      : currentPage.toolExposureMode,
    userScopedAccess: updates.userScopedAccess !== undefined
      ? Boolean(updates.userScopedAccess)
      : currentPage.userScopedAccess,
  };

  const stateHashAfter = computePageStateHash(nextPageState);

  // A sheet's content lives in rows, so a content write to one takes a
  // different path entirely.
  //
  // Everything that edits page content funnels through here — the editor, the
  // AI write tools, `/api/mcp/documents`, the page service — so routing sheets
  // once, here, is what stops rows and `pages.content` being two competing
  // sources of truth. It also removes the whole O(document) apparatus for
  // sheets: no blob snapshot, no page version, and no full-document payload in
  // the activity log. The sheet's own change log records the edit instead.
  const isSheetContentWrite = updates.content !== undefined && isSheetPage;

  // The inline snapshot is skipped for sheets; the blob REFERENCE is not.
  //
  // `contentSnapshot` is the multi-megabyte inline copy that caused the write
  // amplification. `contentRef` is a 64-character hash of a content-addressed
  // blob, and it is what `rollback/content-snapshot.ts` reads to rebuild a
  // restore payload. Dropping both is what made Undo a silent no-op on sheets.
  const shouldSnapshotBefore = updates.content !== undefined;
  let contentSnapshotRef: string | null = null;
  let contentSnapshotSize = 0;

  if (shouldSnapshotBefore) {
    const stored = await writePageContent(previousContent, contentFormatBefore);
    contentSnapshotRef = stored.ref;
    contentSnapshotSize = stored.size;
  }

  const safeUpdatedFields = updatedFields
    ?? Object.keys(updates).filter((key) => key !== 'expectedRevision');

  const previousValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};

  for (const field of safeUpdatedFields) {
    // A sheet's content is never carried INLINE in the activity log's value
    // payloads. Two copies of a multi-megabyte document per edit is the write
    // amplification that made a 1MB sheet fail its CHECK constraint and roll
    // the user's write back.
    //
    // The blob reference is still recorded (`contentRef`/`contentSize` below),
    // which is what activity rollback resolves the restore payload from — so
    // Undo on a sheet edit still has something to restore. Skipping both left
    // `restoreFields(['content'], previousValues)` with nothing to find, and
    // Undo returned 200 while doing nothing.
    if (isSheetContentWrite && field === 'content') continue;
    if (field in currentPage) {
      previousValues[field] = (currentPage as Record<string, unknown>)[field];
    }
    newValues[field] = updates[field];
  }

  // Track newly mentioned users to send notifications after transaction commits
  let mentionsResult: SyncMentionsResult | null = null;
  let deferredTrigger: DeferredWorkflowTrigger | undefined;

  const applyMutationInTx = async (transaction: typeof db) => {
    // BEFORE the column is blanked below.
    //
    // `replaceFromDocument` goes through `ensureTab`, which materialises a
    // never-migrated sheet from `pages.content`. Running it after the update
    // would have it read the empty string this mutation just wrote and
    // materialise a single blank tab — permanently losing every tab of a
    // multi-tab sheet on its first save.
    if (isSheetContentWrite) {
      await replaceFromDocument(
        { pageId },
        nextContent,
        { userId: context.userId, actorEmail: context.actorEmail ?? undefined, changeGroupId },
        transaction
      );
    }

    const updateWhere = expectedRevision !== undefined
      ? and(eq(pages.id, pageId), eq(pages.revision, expectedRevision))
      : eq(pages.id, pageId);

    const [updated] = await transaction
      .update(pages)
      .set({
        ...updates,
        // Rows are the truth for a sheet; the column would be a stale copy.
        ...(isSheetContentWrite ? { content: '' } : {}),
        revision: nextRevision,
        stateHash: stateHashAfter,
        updatedAt: new Date(),
      })
      .where(updateWhere)
      .returning({ id: pages.id });

    if (!updated) {
      throw new PageRevisionMismatchError(
        'Page was modified while applying changes',
        currentPage.revision,
        expectedRevision
      );
    }

    if (updates.content !== undefined) {
      mentionsResult = await syncMentions(pageId, nextContent, transaction, {
        mentionedByUserId: context.userId,
        driveId: currentPage.driveId,
      });
    }

    // Only when the content actually changed.
    //
    // A rename, move or trash has nothing to version — the content is
    // unchanged, so the entry would duplicate the previous one. For a sheet it
    // was worse than redundant: `nextContent` came from the empty column, so
    // the entry claimed the spreadsheet was blank.
    //
    // Create page version BEFORE acquiring the activity chain lock,
    // so disk I/O (compression + fs.writeFile) doesn't hold the global lock.
    //
    // Sheets get versions too, and the content is the PROJECTED document
    // (`nextContent`), not the blanked column. Skipping this removed sheet
    // version history outright, which is what drive backup, drive restore and
    // page rollback all read — a backup taken after the migration would store a
    // zero-byte version for every spreadsheet, and restoring it would bring the
    // sheet back empty.
    //
    // One content-addressed blob per DOCUMENT save. Addressed cell writes
    // (MCP, the SDK, form submissions) never reach here, so they stay O(1) and
    // are attributed through `sheet_changes` instead.
    if (updates.content !== undefined) await createPageVersion({
      pageId,
      driveId: currentPage.driveId,
      createdBy: context.userId,
      source: source ?? (context.isAiGenerated ? 'pre_ai' : 'auto'),
      content: nextContent,
      contentFormat: contentFormatAfter,
      pageRevision: nextRevision,
      stateHash: stateHashAfter,
      changeGroupId,
      changeGroupType,
      metadata: context.metadata,
    }, { tx: transaction });

    deferredTrigger = await logActivityWithTx({
      userId: context.userId,
      actorEmail: context.actorEmail ?? 'unknown@system',
      actorDisplayName: context.actorDisplayName ?? undefined,
      operation,
      resourceType: context.resourceType ?? 'page',
      resourceId: pageId,
      resourceTitle: nextPageState.title ?? undefined,
      driveId: currentPage.driveId,
      pageId,
      contentSnapshot: shouldSnapshotBefore && !isSheetContentWrite ? previousContent : undefined,
      contentFormat: shouldSnapshotBefore ? contentFormatBefore : undefined,
      contentRef: contentSnapshotRef ?? undefined,
      contentSize: contentSnapshotSize || undefined,
      updatedFields: safeUpdatedFields,
      previousValues: Object.keys(previousValues).length > 0 ? previousValues : undefined,
      newValues: Object.keys(newValues).length > 0 ? newValues : undefined,
      metadata: context.metadata,
      isAiGenerated: context.isAiGenerated,
      aiProvider: context.aiProvider,
      aiModel: context.aiModel,
      aiConversationId: context.aiConversationId,
      streamId: pageId,
      streamSeq: nextRevision,
      changeGroupId,
      changeGroupType,
      stateHashBefore,
      stateHashAfter,
    }, transaction);
  };

  if (tx) {
    await applyMutationInTx(tx);
  } else {
    await db.transaction(async (transaction) => {
      await applyMutationInTx(transaction);
    });
    // Fire workflow trigger after self-managed transaction commits
    deferredTrigger?.();
    deferredTrigger = undefined;
  }

  // Send notifications for newly mentioned users after transaction commits (fire-and-forget)
  if (mentionsResult) {
    const result = mentionsResult as SyncMentionsResult;
    if (result.mentionedByUserId && result.newlyMentionedUserIds.length > 0) {
      for (const targetUserId of result.newlyMentionedUserIds) {
        createMentionNotification(targetUserId, result.sourcePageId, result.mentionedByUserId)
          .catch((error: unknown) => {
            loggers.api.error('Failed to send mention notification:', error as Error);
          });
      }
    }
  }

  return {
    pageId,
    driveId: currentPage.driveId,
    nextRevision,
    stateHashBefore,
    stateHashAfter,
    contentRefBefore: contentRefBefore ?? null,
    contentRefAfter: contentRefAfter ?? null,
    contentFormatBefore,
    contentFormatAfter,
    deferredTrigger,
  };
}
