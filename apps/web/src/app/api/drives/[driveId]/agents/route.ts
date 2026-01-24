import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, pages, drives, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

interface DriveAgentSummary {
  id: string;
  title: string | null;
  parentId: string;
  position: number;
  aiProvider: string;
  aiModel: string;
  hasWelcomeMessage: boolean;
  createdAt: Date;
  updatedAt: Date;
  systemPrompt?: string;
  systemPromptPreview?: string;
  enabledTools?: string[];
  enabledToolsCount?: number;
  hasSystemPrompt: boolean;
}

/**
 * GET /api/drives/{driveId}/agents
 * List all AI agents in a specific drive with their configuration
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['session', 'mcp'] as const });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;
    const { searchParams } = new URL(request.url);

    const includeSystemPrompt = searchParams.get('includeSystemPrompt') === 'true';
    const includeTools = searchParams.get('includeTools') !== 'false'; // Default true

    // Verify drive access
    const hasDriveAccess = await getUserDriveAccess(userId, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to this drive' },
        { status: 403 }
      );
    }

    // Get drive information
    const [drive] = await db
      .select({ id: drives.id, name: drives.name, slug: drives.slug })
      .from(drives)
      .where(eq(drives.id, driveId));

    if (!drive) {
      return NextResponse.json(
        { error: `Drive with ID "${driveId}" not found` },
        { status: 404 }
      );
    }

    // Get all AI_CHAT pages in the drive
    const allAgents = await db
      .select({
        id: pages.id,
        title: pages.title,
        parentId: pages.parentId,
        position: pages.position,
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        content: pages.content,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt
      })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ))
      .orderBy(pages.position);

    // Filter agents by view permissions
    const accessibleAgents: DriveAgentSummary[] = [];
    for (const agent of allAgents) {
      const canView = await canUserViewPage(userId, agent.id);
      if (canView) {
        // Build agent info object
        const agentInfo: DriveAgentSummary = {
          id: agent.id,
          title: agent.title,
          parentId: agent.parentId || 'root',
          position: agent.position,
          aiProvider: agent.aiProvider || 'default',
          aiModel: agent.aiModel || 'default',
          hasWelcomeMessage: !!agent.content,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
          hasSystemPrompt: !!agent.systemPrompt,
        };

        // Add system prompt if requested
        if (includeSystemPrompt && agent.systemPrompt) {
          agentInfo.systemPrompt = agent.systemPrompt;
        } else if (agent.systemPrompt) {
          agentInfo.systemPromptPreview = agent.systemPrompt.substring(0, 100) +
            (agent.systemPrompt.length > 100 ? '...' : '');
        }

        // Add tools information if requested
        if (includeTools) {
          agentInfo.enabledTools = Array.isArray(agent.enabledTools) ? agent.enabledTools : [];
          agentInfo.enabledToolsCount = Array.isArray(agent.enabledTools) ? agent.enabledTools.length : 0;
        }

        accessibleAgents.push(agentInfo);
      }
    }

    loggers.api.info('Listed agents in drive', {
      driveId,
      driveName: drive.name,
      totalAgents: allAgents.length,
      accessibleAgents: accessibleAgents.length,
      userId
    });

    return NextResponse.json({
      success: true,
      driveId: drive.id,
      driveName: drive.name,
      driveSlug: drive.slug,
      agents: accessibleAgents,
      count: accessibleAgents.length,
      summary: `Found ${accessibleAgents.length} accessible AI agent(s) in drive "${drive.name}"`,
      stats: {
        totalInDrive: allAgents.length,
        accessible: accessibleAgents.length,
        withSystemPrompt: accessibleAgents.filter(a => a.hasSystemPrompt).length,
        withTools: accessibleAgents.filter(a => (a.enabledToolsCount || 0) > 0).length
      },
      nextSteps: [
        accessibleAgents.length > 0 ? 'Use read_page to view full agent configurations' : 'No agents found - consider creating one',
        'Use update_agent_config to modify agent settings',
        'Use ask_agent to consult with specific agents',
        `Drive: ${drive.name} (${drive.id})`
      ]
    });

  } catch (error) {
    loggers.api.error('Error listing agents in drive:', error as Error);
    return NextResponse.json(
      { error: `Failed to list agents: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
