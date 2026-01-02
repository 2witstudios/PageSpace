import { db, pages, drives, users, chatMessages, eq, and, desc, isNull } from '@pagespace/db';
import {
  canUserViewPage,
  canUserEditPage,
  canUserDeletePage,
  getActorInfo,
  detectPageContentFormat,
  hashWithPrefix,
  computePageStateHash,
  createPageVersion,
  type PageVersionSource,
} from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import {
  validatePageCreation,
  validateAIChatTools,
  getDefaultContent,
  PageType as PageTypeEnum,
  isAIChatPage,
  isDriveOwnerOrAdmin,
} from '@pagespace/lib';
import { createChangeGroupId, inferChangeGroupType, logActivityWithTx } from '@pagespace/lib/monitoring';
import { createId } from '@paralleldrive/cuid2';
import { applyPageMutation, PageRevisionMismatchError, type PageMutationContext } from './page-mutation-service';

/**
 * Helper to convert DB page result to PageData type
 */
function toPageData(dbPage: {
  id: string;
  title: string | null;
  type: string;
  content: string | null;
  parentId: string | null;
  driveId: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
  stateHash: string | null;
  isTrashed: boolean;
  trashedAt: Date | null;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: unknown;
  isPaginated: boolean | null;
}): PageData {
  return {
    id: dbPage.id,
    title: dbPage.title,
    type: dbPage.type as PageType,
    content: dbPage.content,
    parentId: dbPage.parentId,
    driveId: dbPage.driveId,
    position: dbPage.position,
    createdAt: dbPage.createdAt,
    updatedAt: dbPage.updatedAt,
    revision: dbPage.revision,
    stateHash: dbPage.stateHash,
    isTrashed: dbPage.isTrashed,
    trashedAt: dbPage.trashedAt,
    aiProvider: dbPage.aiProvider,
    aiModel: dbPage.aiModel,
    systemPrompt: dbPage.systemPrompt,
    enabledTools: dbPage.enabledTools as string[] | null,
    isPaginated: dbPage.isPaginated,
  };
}

/**
 * Content sanitization utility - cleans empty TipTap structures
 * Internal utility - not exported from module
 */
function sanitizeEmptyContent(content: string): string {
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
export type PageType = 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET' | 'TASK_LIST';

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
  revision: number;
  stateHash: string | null;
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
  currentRevision?: number;
  expectedRevision?: number;
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

export interface CreatePageOptions {
  context?: Omit<PageMutationContext, 'userId'>;
  source?: PageVersionSource;
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

export interface UpdatePageOptions {
  expectedRevision?: number;
  context?: Omit<PageMutationContext, 'userId'>;
  source?: PageVersionSource;
}

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;

/**
 * Recursively trash a page and all its children
 */
async function recursivelyTrash(
  pageId: string,
  tx: TransactionType | DatabaseType,
  context: PageMutationContext
) {
  const children = await tx.select({ id: pages.id }).from(pages).where(eq(pages.parentId, pageId));

  for (const child of children) {
    await recursivelyTrash(child.id, tx, context);
  }

  const [pageRecord] = await tx
    .select({ revision: pages.revision })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!pageRecord) {
    return;
  }

  await applyPageMutation({
    pageId,
    operation: 'trash',
    updates: { isTrashed: true, trashedAt: new Date() },
    updatedFields: ['isTrashed', 'trashedAt'],
    expectedRevision: pageRecord.revision,
    context,
    tx,
  });
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

    const pageData = toPageData(page);
    return {
      success: true,
      page: {
        ...pageData,
        content: sanitizeEmptyContent(pageData.content || ''),
        children: children.map(toPageData),
        messages: messages as unknown as MessageWithUser[],
      },
      driveId: page.driveId,
    };
  },

  /**
   * Update a page
   */
  async updatePage(
    pageId: string,
    userId: string,
    updates: UpdatePageParams,
    options?: UpdatePageOptions
  ): Promise<UpdatePageResult> {
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
    if (processedUpdates.content !== undefined) {
      processedUpdates.content = sanitizeEmptyContent(processedUpdates.content);
    }

    const updatedFields = Object.keys(processedUpdates);

    if (updatedFields.length > 0) {
      try {
        const actorInfo = options?.context?.actorEmail
          ? {
              actorEmail: options.context.actorEmail,
              actorDisplayName: options.context.actorDisplayName ?? undefined,
            }
          : await getActorInfo(userId);

        const mutationContext: PageMutationContext = {
          userId,
          actorEmail: options?.context?.actorEmail ?? actorInfo.actorEmail,
          actorDisplayName: options?.context?.actorDisplayName ?? actorInfo.actorDisplayName,
          isAiGenerated: options?.context?.isAiGenerated,
          aiProvider: options?.context?.aiProvider,
          aiModel: options?.context?.aiModel,
          aiConversationId: options?.context?.aiConversationId,
          changeGroupId: options?.context?.changeGroupId,
          changeGroupType: options?.context?.changeGroupType,
          metadata: options?.context?.metadata,
          resourceType: options?.context?.resourceType,
        };

        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: processedUpdates,
          updatedFields,
          expectedRevision: options?.expectedRevision,
          context: mutationContext,
          source: options?.source,
        });
      } catch (error) {
        if (error instanceof PageRevisionMismatchError) {
          return {
            success: false,
            error: error.message,
            status: error.expectedRevision === undefined ? 428 : 409,
            currentRevision: error.currentRevision,
            expectedRevision: error.expectedRevision,
          };
        }
        throw error;
      }
    }

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

    const pageData = toPageData(updatedPage);
    return {
      success: true,
      page: {
        ...pageData,
        children: children.map(toPageData),
        messages: messages as unknown as MessageWithUser[],
      },
      driveId: updatedPage.driveId,
      updatedFields,
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

    const actorInfo = await getActorInfo(userId);
    const changeGroupId = createChangeGroupId();
    const changeGroupType = inferChangeGroupType({ isAiGenerated: false });
    const mutationContext: PageMutationContext = {
      userId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName ?? undefined,
      changeGroupId,
      changeGroupType,
      metadata: { trashChildren: options.trashChildren },
    };

    await db.transaction(async (tx) => {
      if (options.trashChildren) {
        await recursivelyTrash(pageId, tx, mutationContext);
      } else {
        const children = await tx
          .select({ id: pages.id, revision: pages.revision })
          .from(pages)
          .where(eq(pages.parentId, pageId));

        for (const child of children) {
          await applyPageMutation({
            pageId: child.id,
            operation: 'move',
            updates: {
              parentId: pageInfo.parentId,
              originalParentId: pageId,
            },
            updatedFields: ['parentId', 'originalParentId'],
            expectedRevision: child.revision,
            context: mutationContext,
            tx,
          });
        }

        await applyPageMutation({
          pageId,
          operation: 'trash',
          updates: { isTrashed: true, trashedAt: new Date() },
          updatedFields: ['isTrashed', 'trashedAt'],
          expectedRevision: pageInfo.revision,
          context: mutationContext,
          tx,
        });
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
  async createPage(userId: string, params: CreatePageParams, options?: CreatePageOptions): Promise<CreatePageResult> {
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

    // Calculate position - use isNull when parentId is null/undefined
    const parentIdCondition = params.parentId
      ? eq(pages.parentId, params.parentId)
      : isNull(pages.parentId);
    const lastPage = await db.query.pages.findFirst({
      where: and(parentIdCondition, eq(pages.driveId, drive.id)),
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
    if (isAIChatPage(params.type as PageTypeEnum) && params.enabledTools && params.enabledTools.length > 0) {
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

    if (isAIChatPage(params.type as PageTypeEnum)) {
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

    const actorInfo = options?.context?.actorEmail
      ? {
          actorEmail: options.context.actorEmail,
          actorDisplayName: options.context.actorDisplayName ?? undefined,
        }
      : await getActorInfo(userId);
    const changeGroupId = options?.context?.changeGroupId ?? createChangeGroupId();
    const changeGroupType = options?.context?.changeGroupType
      ?? inferChangeGroupType({ isAiGenerated: options?.context?.isAiGenerated });

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
        revision: number;
        stateHash: string;
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
        revision: 0,
        stateHash: '',
      };

      if (isAIChatPage(params.type as PageTypeEnum)) {
        pageData.aiProvider = params.aiProvider || defaultAiProvider;
        pageData.aiModel = params.aiModel || defaultAiModel;

        if (params.systemPrompt) {
          pageData.systemPrompt = params.systemPrompt;
        }
        if (params.enabledTools && params.enabledTools.length > 0) {
          pageData.enabledTools = params.enabledTools;
        }
      }

      const contentFormat = detectPageContentFormat(pageData.content);
      const contentRef = hashWithPrefix(contentFormat, pageData.content);
      const stateHash = computePageStateHash({
        title: pageData.title,
        contentRef,
        parentId: pageData.parentId,
        position: pageData.position,
        isTrashed: false,
        type: pageData.type,
        driveId: pageData.driveId,
        aiProvider: pageData.aiProvider,
        aiModel: pageData.aiModel,
        systemPrompt: pageData.systemPrompt,
        enabledTools: pageData.enabledTools,
      });
      pageData.stateHash = stateHash;

      const [page] = await tx.insert(pages).values(pageData).returning();

      await logActivityWithTx({
        userId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName,
        operation: 'create',
        resourceType: options?.context?.resourceType ?? 'page',
        resourceId: page.id,
        resourceTitle: page.title ?? undefined,
        driveId: page.driveId,
        pageId: page.id,
        isAiGenerated: options?.context?.isAiGenerated,
        aiProvider: options?.context?.aiProvider,
        aiModel: options?.context?.aiModel,
        aiConversationId: options?.context?.aiConversationId,
        metadata: options?.context?.metadata,
        contentRef,
        contentSize: Buffer.byteLength(pageData.content, 'utf8'),
        contentFormat,
        streamId: page.id,
        streamSeq: 0,
        changeGroupId,
        changeGroupType,
        stateHashAfter: stateHash,
      }, tx);

      await createPageVersion({
        pageId: page.id,
        driveId: page.driveId,
        createdBy: userId,
        source: options?.source ?? 'system',
        content: pageData.content,
        contentFormat,
        pageRevision: 0,
        stateHash,
        changeGroupId,
        changeGroupType,
        metadata: options?.context?.metadata,
      }, { tx });

      return page;
    });

    return {
      success: true,
      page: toPageData(newPage),
      driveId: drive.id,
      isAIChatPage: isAIChatPage(params.type as PageTypeEnum),
    };
  },
};

export type PageService = typeof pageService;
