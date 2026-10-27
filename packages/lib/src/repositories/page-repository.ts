/**
 * Page Repository - Clean seam for page operations
 *
 * Provides testable boundary for page-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq, and, desc, isNull, inArray, isNotNull, lt } from '@pagespace/db/operators';
import { pages, type PageTypeEnum } from '@pagespace/db/schema/core';
import { deleteConversationsForPages } from './conversation-cleanup';
import { assertNoContentWrite } from './page-write-guard';

export type PageTypeValue = PageTypeEnum;

// Types for repository operations
export interface PageRecord {
  id: string;
  title: string;
  type: PageTypeValue;
  content: string;
  contentMode: 'html' | 'markdown';
  driveId: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  trashedAt: Date | null;
  revision: number;
  stateHash: string | null;
  mimeType?: string | null;
  // Agent-specific fields
  systemPrompt?: string | null;
  enabledTools?: string[] | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  agentDefinition?: string | null;
  visibleToGlobalAssistant?: boolean;
  includeDrivePrompt?: boolean;
  includePageTree?: boolean;
  pageTreeScope?: 'children' | 'drive';
}

export interface CreatePageInput {
  title: string;
  type: PageTypeValue;
  content: string;
  contentMode?: 'html' | 'markdown';
  driveId: string;
  parentId: string | null;
  position: number;
  isTrashed?: boolean;
  revision?: number;
  stateHash?: string | null;
  updatedAt?: Date;
  extractionMethod?: string;
  extractionMetadata?: Record<string, unknown>;
  contentHash?: string;
  createdBy?: string | null;
}

/**
 * Fields `pageRepository.update` may set.
 *
 * `content` is deliberately absent. This update is a bare `set(...)` with no
 * revision compare-and-swap, no `page_versions` row, no activity entry and no
 * realtime broadcast — writing content through it would silently clobber the
 * authoritative copy. Page content goes through `applyPageMutation`.
 */
export interface UpdatePageInput {
  title?: string;
  isTrashed?: boolean;
  trashedAt?: Date | null;
  parentId?: string | null;
  position?: number;
  updatedAt?: Date;
  // Agent config fields
  systemPrompt?: string | null;
  enabledTools?: string[] | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  agentDefinition?: string | null;
  visibleToGlobalAssistant?: boolean;
  includeDrivePrompt?: boolean;
  includePageTree?: boolean;
  pageTreeScope?: 'children' | 'drive';
}

export const pageRepository = {
  /**
   * Find a page by ID
   */
  findById: async (
    pageId: string,
    options?: { includeTrashed?: boolean }
  ): Promise<PageRecord | null> => {
    const conditions = [eq(pages.id, pageId)];
    if (!options?.includeTrashed) {
      conditions.push(eq(pages.isTrashed, false));
    }

    const page = await db.query.pages.findFirst({
      where: and(...conditions),
    });

    return page as PageRecord | null;
  },

  /**
   * Find a page by ID that is trashed
   */
  findTrashedById: async (pageId: string): Promise<PageRecord | null> => {
    const page = await db.query.pages.findFirst({
      where: and(eq(pages.id, pageId), eq(pages.isTrashed, true)),
    });

    return page as PageRecord | null;
  },

  /**
   * Find an AI agent page by ID (type = AI_CHAT)
   */
  findAgentById: async (agentId: string): Promise<PageRecord | null> => {
    const page = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ),
    });

    return page as PageRecord | null;
  },

  /**
   * Check if a page exists in a drive (not trashed)
   */
  existsInDrive: async (pageId: string, driveId: string): Promise<boolean> => {
    const page = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, pageId),
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false)
      ),
      columns: { id: true },
    });

    return !!page;
  },

  /**
   * Get the next position for a new page in a parent/root
   */
  getNextPosition: async (
    driveId: string,
    parentId: string | null
  ): Promise<number> => {
    const siblingPages = await db
      .select({ position: pages.position })
      .from(pages)
      .where(
        and(
          eq(pages.driveId, driveId),
          parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
          eq(pages.isTrashed, false)
        )
      )
      .orderBy(desc(pages.position));

    return siblingPages.length > 0 ? siblingPages[0].position + 1 : 1;
  },

  /**
   * Create a new page
   */
  create: async (
    data: CreatePageInput
  ): Promise<{ id: string; title: string; type: PageTypeValue }> => {
    const [newPage] = await db
      .insert(pages)
      .values({
        title: data.title,
        type: data.type,
        content: data.content,
        contentMode: data.contentMode ?? 'html',
        driveId: data.driveId,
        parentId: data.parentId,
        position: data.position,
        isTrashed: data.isTrashed ?? false,
        revision: data.revision ?? 0,
        stateHash: data.stateHash ?? null,
        updatedAt: data.updatedAt ?? new Date(),
        createdBy: data.createdBy ?? null,
        ...(data.extractionMethod && { extractionMethod: data.extractionMethod }),
        ...(data.extractionMetadata && { extractionMetadata: data.extractionMetadata }),
        ...(data.contentHash && { contentHash: data.contentHash }),
      })
      .returning({ id: pages.id, title: pages.title, type: pages.type });

    return newPage;
  },

  /**
   * Update a page's fields
   */
  update: async (
    pageId: string,
    data: UpdatePageInput
  ): Promise<{ id: string; title: string; type: PageTypeValue; parentId: string | null }> => {
    assertNoContentWrite(data, 'pageRepository.update');

    const updateData: Record<string, unknown> = {
      ...data,
      updatedAt: data.updatedAt ?? new Date(),
    };

    const [updatedPage] = await db
      .update(pages)
      .set(updateData)
      .where(eq(pages.id, pageId))
      .returning({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        parentId: pages.parentId,
      });

    return updatedPage;
  },

  /**
   * Trash a page (soft delete)
   */
  trash: async (pageId: string): Promise<void> => {
    await db
      .update(pages)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId));
  },

  /**
   * Trash multiple pages by IDs
   */
  trashMany: async (driveId: string, pageIds: string[]): Promise<void> => {
    await db
      .update(pages)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(pages.driveId, driveId), inArray(pages.id, pageIds)));
  },

  /**
   * Restore a page from trash
   */
  restore: async (
    pageId: string
  ): Promise<{ id: string; title: string; type: PageTypeValue; parentId: string | null }> => {
    const [restoredPage] = await db
      .update(pages)
      .set({
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId))
      .returning({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        parentId: pages.parentId,
      });

    return restoredPage;
  },

  /**
   * Hard-delete pages that have been in the trash for longer than the cutoff date.
   * Returns the count of deleted pages.
   *
   * This is an AUTOMATIC Article 17 path (`api/cron/purge-trashed-pages` runs
   * it on a schedule against rows a user asked to be rid of 30 days earlier),
   * and until now it was a bare `DELETE FROM pages` with no chat cleanup at
   * all — so every page it purged left its conversations, messages and stream
   * checkpoints behind. The manual trash route did clean up; the automated
   * sweep over the SAME rows did not, which is the worse half of the pair,
   * because nobody is watching it.
   *
   * SCOPE is exactly the rows this DELETE removes, and no more. `pages.parentId`
   * carries NO foreign key (it is a bare text column), so deleting a trashed
   * parent does not touch its children — they are orphaned, not cascaded, and
   * trashing a page marks only that page. Expanding to the subtree here would
   * therefore delete the chat history of pages that SURVIVE the purge, turning
   * an under-deletion bug into a worse over-deletion one.
   *
   * Runs in a transaction so history and pages go together or not at all.
   */
  purgeExpiredTrashedPages: async (olderThan: Date): Promise<number> => {
    return db.transaction(async (tx) => {
      const expired = await tx
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.isTrashed, true),
            isNotNull(pages.trashedAt),
            lt(pages.trashedAt, olderThan)
          )
        );
      if (expired.length === 0) return 0;

      const expiredIds = expired.map((p) => p.id);

      // BEFORE the delete: `agentPageId` is ON DELETE SET NULL, so a page
      // deleted first can no longer be traced to the API threads that named it.
      await deleteConversationsForPages(tx, expiredIds);

      const result = await tx
        .delete(pages)
        .where(inArray(pages.id, expiredIds))
        .returning({ id: pages.id });

      return result.length;
    });
  },

  /**
   * Get all child page IDs recursively
   */
  getChildIds: async (driveId: string, parentId: string): Promise<string[]> => {
    const children = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.driveId, driveId),
          eq(pages.parentId, parentId),
          eq(pages.isTrashed, false)
        )
      );

    const childIds = children.map((child) => child.id);
    const grandChildIds: string[] = [];

    for (const child of children) {
      const descendants = await pageRepository.getChildIds(driveId, child.id);
      grandChildIds.push(...descendants);
    }

    return [...childIds, ...grandChildIds];
  },

  /** Direct (non-recursive) live children of a page, with revisions for optimistic-concurrency moves. */
  getDirectChildren: async (
    driveId: string,
    parentId: string
  ): Promise<{ id: string; revision: number }[]> => {
    return db
      .select({ id: pages.id, revision: pages.revision })
      .from(pages)
      .where(
        and(
          eq(pages.driveId, driveId),
          eq(pages.parentId, parentId),
          eq(pages.isTrashed, false)
        )
      );
  },
};

export type PageRepository = typeof pageRepository;
