import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, getAllowedDriveIds, getPrincipalDriveAccess, canPrincipalViewPage } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };
import { db } from '@pagespace/db/db'
import { eq, and, inArray, isNotNull } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { computeSandboxEligibilityByDrive, resolveEditableDriveIds } from './sandbox-eligibility-by-drive';

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
  defaultEnvId?: string | null;
}

/**
 * GET /api/ai/page-agents/multi-drive
 * List all AI agents across all accessible drives
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent', resourceId: 'multi_drive_list', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
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
      const hasAccess = await getPrincipalDriveAccess(auth, drive.id);
      if (hasAccess) {
        accessibleDrives.push(drive);
      }
    }

    // Batch-fetch each accessible drive's OWNER tier, once for the whole
    // request — a drive's sandbox eligibility is the PAYER's tier (the
    // owner), not the requester's, same rule agent-sessions billing/quota
    // already apply. Several drives commonly share one owner, so this is
    // deduped by ownerId, not one query per drive.
    const ownerIds = Array.from(new Set(accessibleDrives.map((d) => d.ownerId)));
    const ownerRows = ownerIds.length
      ? await db.select({ id: users.id, subscriptionTier: users.subscriptionTier }).from(users).where(inArray(users.id, ownerIds))
      : [];
    // The requester's edit-capable memberships, batched — the flag is "can
    // THIS requester use the sandbox there" (payer tier AND actor edit access
    // AND the kill switch), not payer tier alone (review #2326): a
    // viewer-role member would otherwise be offered shell affordances every
    // enforcement point then 403s. Custom roles bound a MEMBER's drive-wide
    // edit exactly as `getUserDrivePermissions` does (codex round 13): the
    // role's driveWidePermissions must grant canEdit explicitly, an
    // unresolvable role fails closed, and ADMINs bypass custom roles —
    // otherwise a view-only custom-role member sees an enabled Shell item
    // that provisioning then rejects with insufficient_role.
    const accessibleDriveIds = accessibleDrives.map((d) => d.id);
    const membershipRows = accessibleDriveIds.length
      ? await db
          .select({ driveId: driveMembers.driveId, role: driveMembers.role, customRoleId: driveMembers.customRoleId })
          .from(driveMembers)
          .where(and(eq(driveMembers.userId, userId), inArray(driveMembers.driveId, accessibleDriveIds), isNotNull(driveMembers.acceptedAt)))
      : [];
    const customRoleIds = Array.from(
      new Set(membershipRows.filter((row) => row.role !== 'ADMIN' && row.customRoleId).map((row) => row.customRoleId as string)),
    );
    const customRoleRows = customRoleIds.length
      ? await db
          .select({ id: driveRoles.id, driveId: driveRoles.driveId, driveWidePermissions: driveRoles.driveWidePermissions })
          .from(driveRoles)
          .where(inArray(driveRoles.id, customRoleIds))
      : [];
    const editableDriveIds = resolveEditableDriveIds(
      membershipRows,
      customRoleRows.map((row) => ({
        ...row,
        driveWidePermissions: row.driveWidePermissions as { canEdit?: boolean } | null,
      })),
    );
    const sandboxEligibleByDrive = computeSandboxEligibilityByDrive(accessibleDrives, ownerRows, {
      userId,
      editableDriveIds,
      codeExecutionEnabled: isCodeExecutionEnabled(),
    });

    // Filter by MCP token scope (if scoped)
    const allowedDriveIds = getAllowedDriveIds(auth);
    const scopedDrives = allowedDriveIds.length > 0
      ? accessibleDrives.filter(d => allowedDriveIds.includes(d.id))
      : accessibleDrives;

    let totalAgentCount = 0;
    const agentsByDrive: {
      driveId: string;
      driveName: string;
      driveSlug: string;
      agentCount: number;
      agents: AgentSummary[];
      /** Whether THIS REQUESTER can use the sandbox in this drive (payer tier + actor edit access + kill switch). */
      sandboxEligible: boolean;
    }[] = [];
    const allAccessibleAgents: AgentSummary[] = [];

    // Get agents from each accessible drive (filtered by MCP scope)
    for (const drive of scopedDrives) {
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
          updatedAt: pages.updatedAt,
          defaultEnvId: pages.defaultEnvId
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
        const canView = await canPrincipalViewPage(auth, agent.id);
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
            defaultEnvId: agent.defaultEnvId,
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
          agents: accessibleAgentsInDrive,
          sandboxEligible: sandboxEligibleByDrive.get(drive.id) ?? false,
        });
      }
    }

    loggers.api.info('Listed agents across all drives', {
      driveCount: scopedDrives.length,
      totalAgents: totalAgentCount,
      userId
    });

    const baseResult = {
      success: true,
      totalCount: totalAgentCount,
      driveCount: scopedDrives.length,
      summary: `Found ${totalAgentCount} accessible AI agent(s) across ${scopedDrives.length} drive(s)`,
      stats: {
        accessibleDrives: scopedDrives.length,
        totalAgents: totalAgentCount,
        withSystemPrompt: allAccessibleAgents.filter(a => a.hasSystemPrompt).length,
        withTools: allAccessibleAgents.filter(a => (a.enabledToolsCount || 0) > 0).length,
        averageAgentsPerDrive: scopedDrives.length > 0 ? Math.round((totalAgentCount / scopedDrives.length) * 10) / 10 : 0
      },
      nextSteps: [
        totalAgentCount > 0 ? 'Use read_page to view full agent configurations' : 'No agents found - consider creating some',
        'Use spawn_session (with the agent id as `agent`) to delegate to specific agents',
        'Use list_agents for drive-specific agent listings',
        `Accessible drives: ${scopedDrives.map(d => d.name).join(', ')}`
      ]
    };

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'page_agent', resourceId: 'list', details: {
      action: 'list_agents_multi_drive',
      driveCount: scopedDrives.length,
      agentCount: totalAgentCount,
    } });

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
