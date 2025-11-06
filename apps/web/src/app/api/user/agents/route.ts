import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, pages, drives, driveMembers, eq, and, inArray } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

interface AgentInfo {
  id: string;
  title: string | null;
  driveId: string;
  driveName: string;
  driveSlug: string;
  systemPrompt: string | null;
  enabledTools: string[];
  aiProvider: string;
  aiModel: string;
  hasSystemPrompt: boolean;
  enabledToolsCount: number;
}

/**
 * GET /api/user/agents
 * List all AI_CHAT agents the user has access to across all drives
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['jwt', 'mcp'] as const });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    // Get all drives the user has access to
    const userDrives = await db
      .select({
        driveId: driveMembers.driveId,
        driveName: drives.name,
        driveSlug: drives.slug
      })
      .from(driveMembers)
      .innerJoin(drives, eq(driveMembers.driveId, drives.id))
      .where(eq(driveMembers.userId, userId));

    if (userDrives.length === 0) {
      return NextResponse.json({
        success: true,
        agents: [],
        count: 0,
        message: 'No accessible drives found'
      });
    }

    const driveIds = userDrives.map(d => d.driveId);

    // Get all AI_CHAT pages in those drives
    const allAgents = await db
      .select({
        id: pages.id,
        title: pages.title,
        driveId: pages.driveId,
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel
      })
      .from(pages)
      .where(and(
        inArray(pages.driveId, driveIds),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ));

    // Filter agents by view permissions
    const accessibleAgents: AgentInfo[] = [];

    for (const agent of allAgents) {
      const canView = await canUserViewPage(userId, agent.id);
      if (canView) {
        // Find drive info for this agent
        const driveInfo = userDrives.find(d => d.driveId === agent.driveId);

        if (driveInfo) {
          accessibleAgents.push({
            id: agent.id,
            title: agent.title,
            driveId: agent.driveId,
            driveName: driveInfo.driveName,
            driveSlug: driveInfo.driveSlug,
            systemPrompt: agent.systemPrompt,
            enabledTools: Array.isArray(agent.enabledTools) ? agent.enabledTools : [],
            aiProvider: agent.aiProvider || 'default',
            aiModel: agent.aiModel || 'default',
            hasSystemPrompt: !!agent.systemPrompt,
            enabledToolsCount: Array.isArray(agent.enabledTools) ? agent.enabledTools.length : 0
          });
        }
      }
    }

    loggers.api.info('Listed all accessible agents', {
      userId,
      totalAgents: allAgents.length,
      accessibleAgents: accessibleAgents.length,
      drivesChecked: userDrives.length
    });

    return NextResponse.json({
      success: true,
      agents: accessibleAgents,
      count: accessibleAgents.length,
      summary: `Found ${accessibleAgents.length} accessible AI agent(s) across ${userDrives.length} drive(s)`
    });

  } catch (error) {
    loggers.api.error('Error listing user agents:', error as Error);
    return NextResponse.json(
      { error: `Failed to list agents: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
