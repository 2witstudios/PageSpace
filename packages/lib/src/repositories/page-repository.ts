/**
 * Page Repository - Clean seam for page operations
 *
 * Provides testable boundary for page-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db, pages, eq, and, desc, isNull, inArray } from '@pagespace/db';

// Page type enum values that match the database schema
export type PageTypeValue =
  | 'FOLDER'
  | 'DOCUMENT'
  | 'CHANNEL'
  | 'AI_CHAT'
  | 'CANVAS'
  | 'FILE'
  | 'SHEET'
  | 'TASK_LIST';

// Types for repository operations
export interface PageRecord {
  id: string;
  title: string;
  type: PageTypeValue;
  content: string;
  driveId: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  trashedAt: Date | null;
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
  driveId: string;
  parentId: string | null;
  position: number;
  isTrashed?: boolean;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
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
        driveId: data.driveId,
        parentId: data.parentId,
        position: data.position,
        isTrashed: data.isTrashed ?? false,
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
};

export type PageRepository = typeof pageRepository;
