import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };
import { db, pages, drives, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

interface AgentSummary {
  id: string;
  title: string | null;
  parentId: string;
  position: number;
  aiProvider: string;
  aiModel: string;
  hasWelcomeMessage: boolean;
  createdAt: Date;
  updatedAt: Date;
  driveId: string;
  driveName: string;
  driveSlug: string;
  systemPrompt?: string;
  systemPromptPreview?: string;
  enabledTools?: string[];
  enabledToolsCount?: number;
  hasSystemPrompt: boolean;
}

/**
 * GET /api/ai/page-agents/multi-drive
 * List all AI agents across all accessible drives
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { searchParams } = new URL(request.url);

    const includeSystemPrompt = searchParams.get('includeSystemPrompt') === 'true';
    const includeTools = searchParams.get('includeTools') !== 'false'; // Default true
    const groupByDrive = searchParams.get('groupByDrive') !== 'false'; // Default true

    // Get all drives
    const allDrives = await db
      .select({ id: drives.id, name: drives.name, slug: drives.slug, ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.isTrashed, false));

    // Filter drives by access
    const accessibleDrives = [];
    for (const drive of allDrives) {
      const hasAccess = await getUserDriveAccess(userId, drive.id);
      if (hasAccess) {
        accessibleDrives.push(drive);
      }
    }

    let totalAgentCount = 0;
    const agentsByDrive: {
      driveId: string;
      driveName: string;
      driveSlug: string;
      agentCount: number;
      agents: AgentSummary[];
    }[] = [];
    const allAccessibleAgents: AgentSummary[] = [];

    // Get agents from each accessible drive
    for (const drive of accessibleDrives) {
      // Get all AI_CHAT pages in this drive
      const driveAgents = await db
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
          eq(pages.driveId, drive.id),
          eq(pages.type, 'AI_CHAT'),
          eq(pages.isTrashed, false)
        ))
        .orderBy(pages.position);

      // Filter by view permissions and build agent info
      const accessibleAgentsInDrive: AgentSummary[] = [];
      for (const agent of driveAgents) {
        const canView = await canUserViewPage(userId, agent.id);
        if (canView) {
          // Build agent info object
          const agentInfo: AgentSummary = {
            id: agent.id,
            title: agent.title,
            parentId: agent.parentId || 'root',
            position: agent.position,
            aiProvider: agent.aiProvider || 'default',
            aiModel: agent.aiModel || 'default',
            hasWelcomeMessage: !!agent.content,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
            driveId: drive.id,
            driveName: drive.name,
            driveSlug: drive.slug,
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

          accessibleAgentsInDrive.push(agentInfo);
          allAccessibleAgents.push(agentInfo);
        }
      }

      totalAgentCount += accessibleAgentsInDrive.length;

      // Add drive entry if groupByDrive is enabled
      if (groupByDrive) {
        agentsByDrive.push({
          driveId: drive.id,
          driveName: drive.name,
          driveSlug: drive.slug,
          agentCount: accessibleAgentsInDrive.length,
          agents: accessibleAgentsInDrive
        });
      }
    }

    loggers.api.info('Listed agents across all drives', {
      driveCount: accessibleDrives.length,
      totalAgents: totalAgentCount,
      userId
    });

    const baseResult = {
      success: true,
      totalCount: totalAgentCount,
      driveCount: accessibleDrives.length,
      summary: `Found ${totalAgentCount} accessible AI agent(s) across ${accessibleDrives.length} drive(s)`,
      stats: {
        accessibleDrives: accessibleDrives.length,
        totalAgents: totalAgentCount,
        withSystemPrompt: allAccessibleAgents.filter(a => a.hasSystemPrompt).length,
        withTools: allAccessibleAgents.filter(a => (a.enabledToolsCount || 0) > 0).length,
        averageAgentsPerDrive: accessibleDrives.length > 0 ? Math.round((totalAgentCount / accessibleDrives.length) * 10) / 10 : 0
      },
      nextSteps: [
        totalAgentCount > 0 ? 'Use read_page to view full agent configurations' : 'No agents found - consider creating some',
        'Use ask_agent to consult with specific agents',
        'Use list_agents for drive-specific agent listings',
        `Accessible drives: ${accessibleDrives.map(d => d.name).join(', ')}`
      ]
    };

    if (groupByDrive) {
      return NextResponse.json({ ...baseResult, agentsByDrive });
    }

    return NextResponse.json({ ...baseResult, agents: allAccessibleAgents });

  } catch (error) {
    loggers.api.error('Error listing agents across drives:', error as Error);
    return NextResponse.json(
      { error: `Failed to list agents across drives: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
