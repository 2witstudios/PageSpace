/**
 * Page Repository - Clean seam for page operations
 *
 * Provides testable boundary for page-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq, and, desc, isNull, inArray, isNotNull, lt, not, count, sql, type SQL } from '@pagespace/db/operators';
import { pages, type PageTypeEnum } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';

export type PageTypeValue = PageTypeEnum;

/**
 * True for a page that still points at a Sprite we believe is LIVE — a
 * `machine_sessions` row (the Machine's own persistent Sprite; the row exists
 * only while its Sprite is believed live) or a `machine_branches` row whose
 * `spriteTornDownAt` is still NULL (that row OUTLIVES its Sprite on purpose — it
 * is re-creatable branch config — so its existence alone proves nothing).
 *
 * Both tables FK-cascade off `pages.id`, so hard-deleting the page would take
 * the row with it and destroy the only record of that Sprite's `sandboxId`,
 * leaving a still-running microVM permanently unreachable and permanently
 * billing. The 30-day purge therefore skips such a page (`not(...)`) and leaves
 * it for the orphan reconcile cron, which normally reclaims the Sprite within 30
 * minutes; the next nightly purge then takes the page. An ALREADY-reclaimed
 * branch row never blocks the purge (its Sprite is gone — there is nothing left
 * to strand), so a torn-down Machine cannot become unpurgeable, which would turn
 * this guard into a GDPR Art. 17 retention bug.
 *
 * A no-op filter for the overwhelming majority of pages: neither table is ever
 * populated for a non-Machine page.
 *
 * Built lazily (a function, not a module constant) so importing this repository
 * never evaluates a query builder at module scope.
 */
function hasLiveSpriteTrackingRow(): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM ${machineSessions} WHERE ${machineSessions.pageId} = ${pages.id})
    OR EXISTS (
      SELECT 1 FROM ${machineBranches}
      WHERE ${machineBranches.machineId} = ${pages.id}
        AND ${machineBranches.spriteTornDownAt} IS NULL
    )
  )`;
}

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
   * Excludes any page that still has a live Sprite-tracking row (see
   * {@link hasLiveSpriteTrackingRow}) — without that guard this purge silently
   * destroys the ONLY pointer to an orphaned, still-billing microVM.
   */
  purgeExpiredTrashedPages: async (olderThan: Date): Promise<number> => {
    const result = await db
      .delete(pages)
      .where(
        and(
          eq(pages.isTrashed, true),
          isNotNull(pages.trashedAt),
          lt(pages.trashedAt, olderThan),
          not(hasLiveSpriteTrackingRow())
        )
      )
      .returning({ id: pages.id });

    return result.length;
  },

  /**
   * Health signal for the purge guard: how many trashed pages are OLD enough to
   * have been purged well past their cutoff (`staleOlderThan` — the caller
   * passes an extra grace window on top of the purge cutoff) and are STILL being
   * held back by a live Sprite-tracking row.
   *
   * The orphan reconcile cron normally clears such a row within 30 minutes, so a
   * page still blocked days later means a Sprite that cannot be killed — a
   * genuinely stuck orphan, quietly billing. Surfacing it as a growing number is
   * the whole point: the alternative (what this code used to do) was to
   * cascade-delete the tracking row along with the page, which made the orphan
   * both unbillable-to-anyone and permanently unreachable.
   */
  countStaleBlockedTrashedPages: async (staleOlderThan: Date): Promise<number> => {
    const [row] = await db
      .select({ value: count() })
      .from(pages)
      .where(
        and(
          eq(pages.isTrashed, true),
          isNotNull(pages.trashedAt),
          lt(pages.trashedAt, staleOlderThan),
          hasLiveSpriteTrackingRow()
        )
      );

    return row?.value ?? 0;
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
