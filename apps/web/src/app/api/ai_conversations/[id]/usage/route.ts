import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, aiUsageLogs, conversations, eq, and, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';

const AUTH_OPTIONS = { allow: ['jwt'] as const };

/**
 * GET - Get AI usage statistics for a specific conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;

    // Verify the conversation belongs to the user
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    if (!conversation) {
      return NextResponse.json({
        error: 'Conversation not found'
      }, { status: 404 });
    }

    // Fetch all usage logs for this conversation
    const logs = await db
      .select({
        id: aiUsageLogs.id,
        timestamp: aiUsageLogs.timestamp,
        userId: aiUsageLogs.userId,
        provider: aiUsageLogs.provider,
        model: aiUsageLogs.model,
        inputTokens: aiUsageLogs.inputTokens,
        outputTokens: aiUsageLogs.outputTokens,
        totalTokens: aiUsageLogs.totalTokens,
        cost: aiUsageLogs.cost,
        conversationId: aiUsageLogs.conversationId,
        messageId: aiUsageLogs.messageId,
        pageId: aiUsageLogs.pageId,
        driveId: aiUsageLogs.driveId,
        success: aiUsageLogs.success,
        error: aiUsageLogs.error,
        // Context tracking fields
        contextSize: aiUsageLogs.contextSize,
        messageCount: aiUsageLogs.messageCount,
        wasTruncated: aiUsageLogs.wasTruncated,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.conversationId, id))
      .orderBy(desc(aiUsageLogs.timestamp));

    // Calculate summary statistics
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let mostRecentModel: string | null = null;
    let mostRecentProvider: string | null = null;

    for (const log of logs) {
      totalInputTokens += log.inputTokens || 0;
      totalOutputTokens += log.outputTokens || 0;
      totalTokens += log.totalTokens || 0;
      totalCost += log.cost || 0;
    }

    // Get most recent model/provider from the first log (most recent due to desc order)
    if (logs.length > 0) {
      mostRecentModel = logs[0].model;
      mostRecentProvider = logs[0].provider;
    }

    // Get context metrics from most recent log (current conversation state)
    const mostRecentLog = logs[0];
    const contextWindowSize = mostRecentModel ? getContextWindow(mostRecentModel) : 200000;
    const currentContextSize = mostRecentLog?.contextSize || 0;
    const contextUsagePercent = currentContextSize > 0 && contextWindowSize > 0
      ? Math.round((currentContextSize / contextWindowSize) * 100)
      : 0;

    return NextResponse.json({
      logs,
      summary: {
        // Billing metrics (cumulative across all calls)
        billing: {
          totalInputTokens,
          totalOutputTokens,
          totalTokens,
          totalCost: Number(totalCost.toFixed(6)),
        },

        // Context metrics (current conversation state)
        context: mostRecentLog ? {
          currentContextSize: currentContextSize,
          messagesInContext: mostRecentLog.messageCount || 0,
          contextWindowSize,
          contextUsagePercent,
          wasTruncated: mostRecentLog.wasTruncated || false,
        } : null,

        // Model info
        mostRecentModel,
        mostRecentProvider,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching AI usage:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch AI usage'
    }, { status: 500 });
  }
}
