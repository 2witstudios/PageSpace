/**
 * Utility functions for tracking AI operations
 *
 * Provides comprehensive tracking of AI agent actions with full context.
 */

import {
  db,
  aiOperations,
  aiAgentType,
  eq,
  and,
  desc,
  gte,
  lte,
  count,
  sum,
  avg,
} from '@pagespace/db';

type AiAgentType = typeof aiAgentType.enumValues[number];

export interface TrackAiOperationParams {
  userId: string;
  agentType: AiAgentType;
  provider: string;
  model: string;
  operationType: string;
  prompt?: string;
  systemPrompt?: string;
  conversationId?: string;
  messageId?: string;
  driveId?: string;
  pageId?: string;
  toolsCalled?: any[];
  toolResults?: any[];
  metadata?: Record<string, any>;
}

export interface AiOperationController {
  id: string;
  complete: (params: {
    completion: string;
    actionsPerformed: any;
    tokens: {
      input: number;
      output: number;
      cost: number;
    };
  }) => Promise<void>;
  fail: (error: string) => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Starts tracking an AI operation
 *
 * Returns a controller object with methods to complete, fail, or cancel the operation.
 *
 * @param params - AI operation parameters
 * @returns Operation controller
 *
 * @example
 * ```typescript
 * const operation = await trackAiOperation({
 *   userId: 'user123',
 *   agentType: 'EDITOR',
 *   provider: 'openai',
 *   model: 'gpt-4',
 *   operationType: 'edit',
 *   prompt: 'Improve this paragraph',
 *   driveId: 'drive123',
 *   pageId: 'page456'
 * });
 *
 * try {
 *   // Perform AI operation...
 *   const result = await performAiEdit();
 *
 *   await operation.complete({
 *     completion: result.text,
 *     actionsPerformed: { edited: true },
 *     tokens: { input: 100, output: 200, cost: 50 }
 *   });
 * } catch (error) {
 *   await operation.fail(error.message);
 * }
 * ```
 */
export async function trackAiOperation(
  params: TrackAiOperationParams
): Promise<AiOperationController> {
  const {
    userId,
    agentType,
    provider,
    model,
    operationType,
    prompt,
    systemPrompt,
    conversationId,
    messageId,
    driveId,
    pageId,
    toolsCalled,
    toolResults,
    metadata,
  } = params;

  const [operation] = await db
    .insert(aiOperations)
    .values({
      userId,
      agentType,
      provider,
      model,
      operationType,
      prompt,
      systemPrompt,
      conversationId,
      messageId,
      driveId,
      pageId,
      toolsCalled: toolsCalled || null,
      toolResults: toolResults || null,
      metadata: metadata || null,
      status: 'in_progress',
      createdAt: new Date(),
    })
    .returning();

  const startTime = Date.now();

  return {
    id: operation.id,

    async complete({
      completion,
      actionsPerformed,
      tokens,
    }: {
      completion: string;
      actionsPerformed: any;
      tokens: {
        input: number;
        output: number;
        cost: number;
      };
    }) {
      await db
        .update(aiOperations)
        .set({
          completion,
          actionsPerformed,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          totalCost: tokens.cost,
          status: 'completed',
          completedAt: new Date(),
          duration: Date.now() - startTime,
        })
        .where(eq(aiOperations.id, operation.id));
    },

    async fail(error: string) {
      await db
        .update(aiOperations)
        .set({
          error,
          status: 'failed',
          completedAt: new Date(),
          duration: Date.now() - startTime,
        })
        .where(eq(aiOperations.id, operation.id));
    },

    async cancel() {
      await db
        .update(aiOperations)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          duration: Date.now() - startTime,
        })
        .where(eq(aiOperations.id, operation.id));
    },
  };
}

/**
 * Gets AI operations for a user
 *
 * @param userId - User ID
 * @param limit - Maximum number of operations to return
 * @returns Array of AI operations
 */
export async function getUserAiOperations(userId: string, limit = 100) {
  return await db.query.aiOperations.findMany({
    where: eq(aiOperations.userId, userId),
    orderBy: [desc(aiOperations.createdAt)],
    limit,
    with: {
      drive: {
        columns: {
          id: true,
          name: true,
        },
      },
      page: {
        columns: {
          id: true,
          title: true,
        },
      },
    },
  });
}

/**
 * Gets AI operations for a drive
 *
 * @param driveId - Drive ID
 * @param limit - Maximum number of operations to return
 * @returns Array of AI operations
 */
export async function getDriveAiOperations(driveId: string, limit = 100) {
  return await db.query.aiOperations.findMany({
    where: eq(aiOperations.driveId, driveId),
    orderBy: [desc(aiOperations.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      page: {
        columns: {
          id: true,
          title: true,
        },
      },
    },
  });
}

/**
 * Gets AI operations for a specific page
 *
 * @param pageId - Page ID
 * @param limit - Maximum number of operations to return
 * @returns Array of AI operations
 */
export async function getPageAiOperations(pageId: string, limit = 100) {
  return await db.query.aiOperations.findMany({
    where: eq(aiOperations.pageId, pageId),
    orderBy: [desc(aiOperations.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });
}

/**
 * Gets AI usage statistics for a user
 *
 * @param userId - User ID
 * @param startDate - Start of date range
 * @param endDate - End of date range
 * @returns Usage statistics grouped by agent type and model
 */
export async function getAiUsageReport(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  return await db
    .select({
      agentType: aiOperations.agentType,
      provider: aiOperations.provider,
      model: aiOperations.model,
      operationCount: count(aiOperations.id),
      totalInputTokens: sum(aiOperations.inputTokens),
      totalOutputTokens: sum(aiOperations.outputTokens),
      totalCost: sum(aiOperations.totalCost),
      avgDuration: avg(aiOperations.duration),
    })
    .from(aiOperations)
    .where(
      and(
        eq(aiOperations.userId, userId),
        gte(aiOperations.createdAt, startDate),
        lte(aiOperations.createdAt, endDate)
      )
    )
    .groupBy(
      aiOperations.agentType,
      aiOperations.provider,
      aiOperations.model
    );
}

/**
 * Gets AI operations for a conversation
 *
 * @param conversationId - Conversation ID
 * @returns Array of AI operations in chronological order
 */
export async function getConversationAiOperations(conversationId: string) {
  return await db.query.aiOperations.findMany({
    where: eq(aiOperations.conversationId, conversationId),
    orderBy: [desc(aiOperations.createdAt)],
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });
}

/**
 * Gets the most recent AI operation
 *
 * @param userId - User ID
 * @returns Most recent AI operation, or null
 */
export async function getLatestAiOperation(userId: string) {
  return await db.query.aiOperations.findFirst({
    where: eq(aiOperations.userId, userId),
    orderBy: [desc(aiOperations.createdAt)],
  });
}

/**
 * Gets failed AI operations for debugging
 *
 * @param userId - User ID (optional)
 * @param limit - Maximum number of operations to return
 * @returns Array of failed AI operations
 */
export async function getFailedAiOperations(
  userId?: string,
  limit = 50
) {
  const where = userId
    ? and(
        eq(aiOperations.userId, userId),
        eq(aiOperations.status, 'failed')
      )
    : eq(aiOperations.status, 'failed');

  return await db.query.aiOperations.findMany({
    where,
    orderBy: [desc(aiOperations.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      page: {
        columns: {
          id: true,
          title: true,
        },
      },
    },
  });
}

/**
 * Gets AI usage summary for a user
 *
 * @param userId - User ID
 * @param days - Number of days to look back (default: 30)
 * @returns Usage summary
 */
export async function getAiUsageSummary(userId: string, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const operations = await db.query.aiOperations.findMany({
    where: and(
      eq(aiOperations.userId, userId),
      gte(aiOperations.createdAt, startDate)
    ),
    columns: {
      status: true,
      inputTokens: true,
      outputTokens: true,
      totalCost: true,
      duration: true,
    },
  });

  const total = operations.length;
  const completed = operations.filter((op) => op.status === 'completed').length;
  const failed = operations.filter((op) => op.status === 'failed').length;
  const cancelled = operations.filter((op) => op.status === 'cancelled').length;

  const totalInputTokens = operations.reduce(
    (sum, op) => sum + (op.inputTokens || 0),
    0
  );
  const totalOutputTokens = operations.reduce(
    (sum, op) => sum + (op.outputTokens || 0),
    0
  );
  const totalCost = operations.reduce(
    (sum, op) => sum + (op.totalCost || 0),
    0
  );
  const totalDuration = operations.reduce(
    (sum, op) => sum + (op.duration || 0),
    0
  );

  return {
    total,
    completed,
    failed,
    cancelled,
    successRate: total > 0 ? (completed / total) * 100 : 0,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCost, // in cents
    totalCostDollars: totalCost / 100,
    avgDuration: total > 0 ? Math.round(totalDuration / total) : 0,
  };
}
