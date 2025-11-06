import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, aiUsageLogs, pages, eq, and, desc } from '@pagespace/db';
import { getUserAccessLevel, loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET - Get AI usage statistics for a specific page (across all conversations)
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { pageId } = await context.params;

    // Verify the user has access to this page
    const [page] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, pageId));

    if (!page) {
      return NextResponse.json({
        error: 'Page not found'
      }, { status: 404 });
    }

    // Check permissions
    const accessLevel = await getUserAccessLevel(userId, pageId);
    if (!accessLevel || accessLevel === 'none') {
      return NextResponse.json({
        error: 'Access denied'
      }, { status: 403 });
    }

    // Fetch all usage logs for this page
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
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.pageId, pageId))
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

    return NextResponse.json({
      logs,
      summary: {
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        totalCost: Number(totalCost.toFixed(6)),
        mostRecentModel,
        mostRecentProvider,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching page AI usage:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch AI usage'
    }, { status: 500 });
  }
}
