import { db, pages, drives, users, mentions, chatMessages, eq, and, desc, inArray } from '@pagespace/db';
import { canUserViewPage, canUserEditPage, canUserDeletePage } from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import {
  validatePageCreation,
  validateAIChatTools,
  getDefaultContent,
  PageType as PageTypeEnum,
  isAIChatPage,
  isDriveOwnerOrAdmin,
} from '@pagespace/lib';
import { createId } from '@paralleldrive/cuid2';
import * as cheerio from 'cheerio';
import { loggers } from '@pagespace/lib/server';

/**
 * Content sanitization utility - cleans empty TipTap structures
 */
export function sanitizeEmptyContent(content: string): string {
  if (!content || content.trim() === '') {
    return '';
  }

  const trimmedContent = content.trim();

  const emptyParagraphPatterns = [
    /^<p><\/p>$/,
    /^<p><br><\/p>$/,
    /^<p>\s*<\/p>$/,
    /^<p><br\s*\/><\/p>$/
  ];

  for (const pattern of emptyParagraphPatterns) {
    if (pattern.test(trimmedContent)) {
      return '';
    }
  }

  try {
    const parsed = JSON.parse(trimmedContent);
    if (parsed.type === 'doc' &&
        Array.isArray(parsed.content) &&
        parsed.content.length === 1 &&
        parsed.content[0].type === 'paragraph' &&
        (!parsed.content[0].content || parsed.content[0].content.length === 0)) {
      return '';
    }
  } catch {
    // Not JSON, continue
  }

  return content;
}

/**
 * Page types
 */
export type PageType = 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET';

/**
 * Message with user info for page details
 */
export interface MessageWithUser {
  id: string;
  content: string;
  createdAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  } | null;
}

/**
 * Page data structure
 */
export interface PageData {
  id: string;
  title: string | null;
  type: PageType;
  content: string | null;
  parentId: string | null;
  driveId: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  isTrashed: boolean;
  trashedAt: Date | null;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  isPaginated: boolean | null;
}

/**
 * Extended page data with children and messages
 */
export interface PageWithDetails extends PageData {
  children: PageData[];
  messages: MessageWithUser[];
}

/**
 * Result types for page operations
 */
export interface GetPageSuccess {
  success: true;
  page: PageWithDetails;
  driveId: string;
}

export interface GetPageError {
  success: false;
  error: string;
  status: number;
}

export type GetPageResult = GetPageSuccess | GetPageError;

export interface UpdatePageSuccess {
  success: true;
  page: PageWithDetails;
  driveId: string;
  updatedFields: string[];
  isAIChatPage: boolean;
}

export interface UpdatePageError {
  success: false;
  error: string;
  status: number;
}

export type UpdatePageResult = UpdatePageSuccess | UpdatePageError;

export interface TrashPageSuccess {
  success: true;
  driveId: string;
  pageTitle: string | null;
  pageType: PageType;
  parentId: string | null;
  isAIChatPage: boolean;
}

export interface TrashPageError {
  success: false;
  error: string;
  status: number;
}

export type TrashPageResult = TrashPageSuccess | TrashPageError;

export interface CreatePageSuccess {
  success: true;
  page: PageData;
  driveId: string;
  isAIChatPage: boolean;
}

export interface CreatePageError {
  success: false;
  error: string;
  status: number;
}

export type CreatePageResult = CreatePageSuccess | CreatePageError;

/**
 * Create page input parameters
 */
export interface CreatePageParams {
  title: string;
  type: PageType;
  driveId: string;
  parentId?: string | null;
  content?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  aiProvider?: string;
  aiModel?: string;
}

/**
 * Update page input parameters
 */
export interface UpdatePageParams {
  title?: string;
  content?: string;
  aiProvider?: string;
  aiModel?: string;
  parentId?: string | null;
  isPaginated?: boolean;
}

/**
 * Find mention nodes in content (HTML)
 */
function findMentionNodes(content: unknown): string[] {
  const ids: string[] = [];
  const contentStr = Array.isArray(content) ? content.join('\n') : String(content);

  try {
    const $ = cheerio.load(contentStr);
    $('a[data-page-id]').each((_, element) => {
      const pageId = $(element).attr('data-page-id');
      if (pageId) {
        ids.push(pageId);
      }
    });
  } catch (error) {
    loggers.api.error('Error parsing HTML content for mentions:', error as Error);
    const regex = /@\[.*?\]\((.*?)\)/g;
    let match;
    while ((match = regex.exec(contentStr)) !== null) {
      ids.push(match[1]);
    }
  }

  return ids;
}

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;

/**
 * Sync mentions based on content
 */
async function syncMentions(sourcePageId: string, content: unknown, tx: TransactionType | DatabaseType) {
  const mentionedPageIds = findMentionNodes(content);

  const existingMentionsQuery = await tx.select({ targetPageId: mentions.targetPageId }).from(mentions).where(eq(mentions.sourcePageId, sourcePageId));
  const existingMentionIds = new Set(existingMentionsQuery.map(m => m.targetPageId));

  const toCreate = mentionedPageIds.filter(id => !existingMentionIds.has(id));
  const toDelete = Array.from(existingMentionIds).filter(id => !mentionedPageIds.includes(id));

  if (toCreate.length > 0) {
    await tx.insert(mentions).values(toCreate.map(targetPageId => ({
      sourcePageId,
      targetPageId,
    })));
  }

  if (toDelete.length > 0) {
    await tx.delete(mentions).where(and(
      eq(mentions.sourcePageId, sourcePageId),
      inArray(mentions.targetPageId, toDelete)
    ));
  }
}

/**
 * Recursively trash a page and all its children
 */
async function recursivelyTrash(pageId: string, tx: TransactionType | DatabaseType) {
  const children = await tx.select({ id: pages.id }).from(pages).where(eq(pages.parentId, pageId));

  for (const child of children) {
    await recursivelyTrash(child.id, tx);
  }

  await tx.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, pageId));
}

/**
 * Page service - encapsulates all DB operations for page CRUD
 * This is the boundary seam that route tests should mock
 */
export const pageService = {
  /**
   * Check if user can view a page
   */
  async canUserView(userId: string, pageId: string): Promise<boolean> {
    return canUserViewPage(userId, pageId);
  },

  /**
   * Check if user can edit a page
   */
  async canUserEdit(userId: string, pageId: string): Promise<boolean> {
    return canUserEditPage(userId, pageId);
  },

  /**
   * Check if user can delete a page
   */
  async canUserDelete(userId: string, pageId: string): Promise<boolean> {
    return canUserDeletePage(userId, pageId);
  },

  /**
   * Check if user is drive owner or admin
   */
  async isDriveOwnerOrAdmin(userId: string, driveId: string): Promise<boolean> {
    return isDriveOwnerOrAdmin(userId, driveId);
  },

  /**
   * Validate page move to prevent circular references
   */
  async validatePageMove(pageId: string, newParentId: string | null): Promise<{ valid: boolean; error?: string }> {
    return validatePageMove(pageId, newParentId);
  },

  /**
   * Get page with children and messages
   */
  async getPage(pageId: string, userId: string): Promise<GetPageResult> {
    // Check authorization
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return { success: false, error: 'You do not have permission to view this page', status: 403 };
    }

    // Fetch page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return { success: false, error: 'Page not found', status: 404 };
    }

    // Fetch related data in parallel
    const [children, messages] = await Promise.all([
      db.query.pages.findMany({
        where: eq(pages.parentId, pageId)
      }),
      db.query.chatMessages.findMany({
        where: and(eq(chatMessages.pageId, pageId), eq(chatMessages.isActive, true)),
        with: { user: true },
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      })
    ]);

    return {
      success: true,
      page: {
        ...page,
        type: page.type as PageType,
        content: sanitizeEmptyContent(page.content || ''),
        children: children as PageData[],
        messages: messages as unknown as MessageWithUser[],
      },
      driveId: page.driveId,
    };
  },

  /**
   * Update a page
   */
  async updatePage(pageId: string, userId: string, updates: UpdatePageParams): Promise<UpdatePageResult> {
    // Check authorization
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return { success: false, error: 'You need edit permission to modify this page', status: 403 };
    }

    // Validate parent change
    if (updates.parentId !== undefined) {
      const validation = await validatePageMove(pageId, updates.parentId);
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Invalid parent', status: 400 };
      }
    }

    // Sanitize content
    const processedUpdates = { ...updates };
    if (processedUpdates.content) {
      processedUpdates.content = sanitizeEmptyContent(processedUpdates.content);
    }

    // Update in transaction
    await db.transaction(async (tx) => {
      await tx.update(pages).set({ ...processedUpdates }).where(eq(pages.id, pageId));

      if (processedUpdates.content) {
        await syncMentions(pageId, processedUpdates.content, tx);
      }
    });

    // Refetch the page with details
    const [updatedPage, children, messages] = await Promise.all([
      db.query.pages.findFirst({
        where: eq(pages.id, pageId),
      }),
      db.query.pages.findMany({
        where: eq(pages.parentId, pageId)
      }),
      db.query.chatMessages.findMany({
        where: and(eq(chatMessages.pageId, pageId), eq(chatMessages.isActive, true)),
        with: { user: true },
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      })
    ]);

    if (!updatedPage) {
      return { success: false, error: 'Page not found after update', status: 404 };
    }

    return {
      success: true,
      page: {
        ...updatedPage,
        type: updatedPage.type as PageType,
        children: children as PageData[],
        messages: messages as unknown as MessageWithUser[],
      },
      driveId: updatedPage.driveId,
      updatedFields: Object.keys(updates),
      isAIChatPage: updatedPage.type === 'AI_CHAT',
    };
  },

  /**
   * Trash a page (soft delete)
   */
  async trashPage(pageId: string, userId: string, options: { trashChildren: boolean }): Promise<TrashPageResult> {
    // Check authorization
    const canDelete = await canUserDeletePage(userId, pageId);
    if (!canDelete) {
      return { success: false, error: 'You need delete permission to remove this page', status: 403 };
    }

    // Get page info before trashing
    const pageInfo = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: {
          columns: { id: true }
        }
      }
    });

    if (!pageInfo || !pageInfo.drive) {
      return { success: false, error: 'Page not found', status: 404 };
    }

    await db.transaction(async (tx) => {
      if (options.trashChildren) {
        await recursivelyTrash(pageId, tx);
      } else {
        // Move children to grandparent
        const page = await tx.query.pages.findFirst({ where: eq(pages.id, pageId) });
        await tx.update(pages).set({
          parentId: page?.parentId,
          originalParentId: pageId
        }).where(eq(pages.parentId, pageId));

        await tx.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, pageId));
      }
    });

    return {
      success: true,
      driveId: pageInfo.drive.id,
      pageTitle: pageInfo.title,
      pageType: pageInfo.type as PageType,
      parentId: pageInfo.parentId,
      isAIChatPage: pageInfo.type === 'AI_CHAT',
    };
  },

  /**
   * Create a new page
   */
  async createPage(userId: string, params: CreatePageParams): Promise<CreatePageResult> {
    // Validate required fields
    if (!params.title || !params.type || !params.driveId) {
      return { success: false, error: 'Missing required fields', status: 400 };
    }

    // Check drive exists
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, params.driveId),
    });

    if (!drive) {
      return { success: false, error: 'Drive not found', status: 404 };
    }

    // Check authorization
    const hasPermission = await isDriveOwnerOrAdmin(userId, params.driveId);
    if (!hasPermission) {
      return { success: false, error: 'Only drive owners and admins can create pages', status: 403 };
    }

    // Calculate position
    const lastPage = await db.query.pages.findFirst({
      where: and(eq(pages.parentId, params.parentId ?? null), eq(pages.driveId, drive.id)),
      orderBy: [desc(pages.position)],
    });
    const newPosition = (lastPage?.position || 0) + 1;

    // Validate page creation
    const validation = validatePageCreation(params.type as PageTypeEnum, {
      title: params.title,
      systemPrompt: params.systemPrompt,
      enabledTools: params.enabledTools,
      aiProvider: params.aiProvider,
      aiModel: params.aiModel,
    });

    if (!validation.valid) {
      return { success: false, error: validation.errors.join('. '), status: 400 };
    }

    // Validate AI chat tools if applicable
    if (isAIChatPage(params.type) && params.enabledTools && params.enabledTools.length > 0) {
      const { pageSpaceTools } = await import('@/lib/ai/core/ai-tools');
      const availableToolNames = Object.keys(pageSpaceTools);
      const toolValidation = validateAIChatTools(params.enabledTools, availableToolNames);
      if (!toolValidation.valid) {
        return { success: false, error: toolValidation.errors.join('. '), status: 400 };
      }
    }

    // Get default AI settings for AI_CHAT pages
    let defaultAiProvider: string | null = null;
    let defaultAiModel: string | null = null;

    if (isAIChatPage(params.type)) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
          currentAiProvider: true,
          currentAiModel: true,
        },
      });

      if (user) {
        defaultAiProvider = user.currentAiProvider || 'pagespace';
        defaultAiModel = user.currentAiModel || 'qwen/qwen3-coder:free';
      }
    }

    // Create page in transaction
    const newPage = await db.transaction(async (tx) => {
      interface PageInsertData {
        id: string;
        title: string;
        type: PageType;
        parentId: string | null;
        driveId: string;
        content: string;
        position: number;
        updatedAt: Date;
        aiProvider?: string | null;
        aiModel?: string | null;
        systemPrompt?: string | null;
        enabledTools?: string[] | null;
      }

      const pageData: PageInsertData = {
        id: createId(),
        title: params.title,
        type: params.type,
        parentId: params.parentId ?? null,
        driveId: drive.id,
        content: params.content || getDefaultContent(params.type as PageTypeEnum),
        position: newPosition,
        updatedAt: new Date(),
      };

      if (isAIChatPage(params.type)) {
        pageData.aiProvider = params.aiProvider || defaultAiProvider;
        pageData.aiModel = params.aiModel || defaultAiModel;

        if (params.systemPrompt) {
          pageData.systemPrompt = params.systemPrompt;
        }
        if (params.enabledTools && params.enabledTools.length > 0) {
          pageData.enabledTools = params.enabledTools;
        }
      }

      const [page] = await tx.insert(pages).values(pageData).returning();
      return page;
    });

    return {
      success: true,
      page: newPage as PageData,
      driveId: params.driveId,
      isAIChatPage: isAIChatPage(params.type),
    };
  },
};

export type PageService = typeof pageService;
