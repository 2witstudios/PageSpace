import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { driveAgentMembers, driveRoles } from '@pagespace/db/schema/members';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

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

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'drive_agent', resourceId: driveId, details: { action: 'list_agents', count: accessibleAgents.length } });

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

const postBodySchema = z.object({
  agentPageId: z.string().min(1),
  role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
  customRoleId: z.string().min(1).optional(),
});

/**
 * POST /api/drives/{driveId}/agents
 * Add an AI agent page as a drive member with RBAC role
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: true });
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can add agent members' }, { status: 403 });
    }

    const rawBody = await request.json();
    const parsed = postBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { agentPageId, role, customRoleId } = parsed.data;

    // Verify agentPageId is an AI_CHAT page belonging to this drive
    const agentPage = await db
      .select({ id: pages.id, type: pages.type, driveId: pages.driveId })
      .from(pages)
      .where(eq(pages.id, agentPageId))
      .limit(1);

    if (agentPage.length === 0) {
      return NextResponse.json({ error: 'Agent page not found' }, { status: 404 });
    }
    if (agentPage[0].type !== 'AI_CHAT') {
      return NextResponse.json({ error: 'agentPageId must reference an AI_CHAT page' }, { status: 400 });
    }
    if (agentPage[0].driveId !== driveId) {
      return NextResponse.json({ error: 'Agent page does not belong to this drive' }, { status: 400 });
    }

    // Validate customRoleId if provided
    if (customRoleId) {
      const roleExists = await db
        .select({ id: driveRoles.id })
        .from(driveRoles)
        .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
        .limit(1);
      if (roleExists.length === 0) {
        return NextResponse.json({ error: 'Custom role not found in this drive' }, { status: 404 });
      }
    }

    let newMember;
    try {
      [newMember] = await db
        .insert(driveAgentMembers)
        .values({
          driveId,
          agentPageId,
          role,
          customRoleId: customRoleId ?? null,
          addedBy: userId,
        })
        .returning();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Agent is already a member of this drive' }, { status: 409 });
      }
      throw err;
    }

    auditRequest(request, {
      eventType: 'authz.permission.granted',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { agentPageId, role, customRoleId },
    });

    return NextResponse.json({ success: true, member: newMember }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding drive agent member:', error as Error);
    return NextResponse.json({ error: 'Failed to add agent member' }, { status: 500 });
  }
}
