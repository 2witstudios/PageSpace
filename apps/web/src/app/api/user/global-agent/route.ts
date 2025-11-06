import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, users, pages, eq, and } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

/**
 * GET /api/user/global-agent
 * Get the user's currently selected global assistant agent
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['jwt', 'mcp'] as const });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    // Get user's selected global agent
    const [user] = await db
      .select({
        selectedGlobalAgentId: users.selectedGlobalAgentId
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // If no agent selected, return null
    if (!user.selectedGlobalAgentId) {
      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'No global agent currently selected'
      });
    }

    // Fetch the selected agent page details
    const [agentPage] = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        driveId: pages.driveId,
        isTrashed: pages.isTrashed
      })
      .from(pages)
      .where(eq(pages.id, user.selectedGlobalAgentId));

    // Verify agent still exists and is accessible
    if (!agentPage) {
      // Agent was deleted, clear the selection
      await db
        .update(users)
        .set({ selectedGlobalAgentId: null })
        .where(eq(users.id, userId));

      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'Previously selected agent no longer exists'
      });
    }

    // Verify agent is not trashed
    if (agentPage.isTrashed) {
      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'Selected agent is in trash'
      });
    }

    // Verify agent is AI_CHAT type
    if (agentPage.type !== 'AI_CHAT') {
      await db
        .update(users)
        .set({ selectedGlobalAgentId: null })
        .where(eq(users.id, userId));

      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'Selected page is not an AI agent'
      });
    }

    // Verify user still has access to the agent
    const canView = await canUserViewPage(userId, agentPage.id);
    if (!canView) {
      await db
        .update(users)
        .set({ selectedGlobalAgentId: null })
        .where(eq(users.id, userId));

      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'You no longer have access to the selected agent'
      });
    }

    loggers.api.info('Retrieved selected global agent', {
      userId,
      agentId: agentPage.id,
      agentTitle: agentPage.title
    });

    return NextResponse.json({
      success: true,
      selectedAgent: {
        id: agentPage.id,
        title: agentPage.title,
        systemPrompt: agentPage.systemPrompt,
        enabledTools: Array.isArray(agentPage.enabledTools) ? agentPage.enabledTools : [],
        aiProvider: agentPage.aiProvider || 'default',
        aiModel: agentPage.aiModel || 'default',
        driveId: agentPage.driveId
      }
    });

  } catch (error) {
    loggers.api.error('Error getting selected global agent:', error as Error);
    return NextResponse.json(
      { error: `Failed to get selected agent: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/user/global-agent
 * Set the user's selected global assistant agent
 * Body: { agentId: string | null }
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['jwt', 'mcp'] as const });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { agentId } = body;

    // Validate agentId is string or null
    if (agentId !== null && typeof agentId !== 'string') {
      return NextResponse.json(
        { error: 'agentId must be a string or null' },
        { status: 400 }
      );
    }

    // If null, clear the selection
    if (agentId === null) {
      await db
        .update(users)
        .set({ selectedGlobalAgentId: null })
        .where(eq(users.id, userId));

      loggers.api.info('Cleared global agent selection', { userId });

      return NextResponse.json({
        success: true,
        selectedAgent: null,
        message: 'Global agent selection cleared'
      });
    }

    // Verify agent exists and is accessible
    const [agentPage] = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        driveId: pages.driveId,
        isTrashed: pages.isTrashed
      })
      .from(pages)
      .where(eq(pages.id, agentId));

    if (!agentPage) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    if (agentPage.isTrashed) {
      return NextResponse.json(
        { error: 'Cannot select an agent that is in trash' },
        { status: 400 }
      );
    }

    if (agentPage.type !== 'AI_CHAT') {
      return NextResponse.json(
        { error: 'Selected page must be an AI_CHAT agent' },
        { status: 400 }
      );
    }

    // Verify user has access to the agent
    const canView = await canUserViewPage(userId, agentPage.id);
    if (!canView) {
      return NextResponse.json(
        { error: 'You don\'t have access to this agent' },
        { status: 403 }
      );
    }

    // Update user's selection
    await db
      .update(users)
      .set({ selectedGlobalAgentId: agentId })
      .where(eq(users.id, userId));

    loggers.api.info('Updated global agent selection', {
      userId,
      agentId,
      agentTitle: agentPage.title
    });

    return NextResponse.json({
      success: true,
      selectedAgent: {
        id: agentPage.id,
        title: agentPage.title,
        systemPrompt: agentPage.systemPrompt,
        enabledTools: Array.isArray(agentPage.enabledTools) ? agentPage.enabledTools : [],
        aiProvider: agentPage.aiProvider || 'default',
        aiModel: agentPage.aiModel || 'default',
        driveId: agentPage.driveId
      },
      message: `Global agent set to "${agentPage.title}"`
    });

  } catch (error) {
    loggers.api.error('Error setting global agent:', error as Error);
    return NextResponse.json(
      { error: `Failed to set global agent: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
