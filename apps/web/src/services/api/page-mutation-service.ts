import { db, pages, eq, and } from '@pagespace/db';
import {
  logActivityWithTx,
  type ActivityOperation,
  type ActivityResourceType,
  inferChangeGroupType,
  createChangeGroupId,
} from '@pagespace/lib/monitoring';
import {
  computePageStateHash,
  createPageVersion,
  type PageVersionSource,
  loggers,
} from '@pagespace/lib/server';
import { writePageContent } from '@pagespace/lib/server';
import { detectPageContentFormat, type PageContentFormat } from '@pagespace/lib/content';
import { hashWithPrefix } from '@pagespace/lib/server';
import { syncMentions, type SyncMentionsResult } from '@/services/api/page-mention-service';
import { createMentionNotification } from '@pagespace/lib/notifications';

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

  const previousContent = currentPage.content ?? '';
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
  };

  const stateHashAfter = computePageStateHash(nextPageState);

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
    if (field in currentPage) {
      previousValues[field] = (currentPage as Record<string, unknown>)[field];
    }
    newValues[field] = updates[field];
  }

  // Track newly mentioned users to send notifications after transaction commits
  let mentionsResult: SyncMentionsResult | null = null;

  const applyMutationInTx = async (transaction: typeof db) => {
    const updateWhere = expectedRevision !== undefined
      ? and(eq(pages.id, pageId), eq(pages.revision, expectedRevision))
      : eq(pages.id, pageId);

    const [updated] = await transaction
      .update(pages)
      .set({
        ...updates,
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
      mentionsResult = await syncMentions(pageId, nextContent, transaction, { mentionedByUserId: context.userId });
    }

    await logActivityWithTx({
      userId: context.userId,
      actorEmail: context.actorEmail ?? 'unknown@system',
      actorDisplayName: context.actorDisplayName ?? undefined,
      operation,
      resourceType: context.resourceType ?? 'page',
      resourceId: pageId,
      resourceTitle: nextPageState.title ?? undefined,
      driveId: currentPage.driveId,
      pageId,
      contentSnapshot: shouldSnapshotBefore ? previousContent : undefined,
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

    await createPageVersion({
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
  };

  if (tx) {
    await applyMutationInTx(tx);
  } else {
    await db.transaction(async (transaction) => {
      await applyMutationInTx(transaction);
    });
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
  };
}
