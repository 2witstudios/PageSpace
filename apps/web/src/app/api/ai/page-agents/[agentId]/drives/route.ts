import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { addAgentToDrive, listAgentDrives } from '@pagespace/lib/services/drive-agent-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

async function getAgentPage(agentId: string) {
  const [agent] = await db
    .select({ id: pages.id, type: pages.type })
    .from(pages)
    .where(eq(pages.id, agentId))
    .limit(1);
  return agent ?? null;
}

/**
 * GET /api/ai/page-agents/[agentId]/drives
 * List the drives this agent can access (its home drive + memberships).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

    const agent = await getAgentPage(agentId);
    if (!agent || agent.type !== 'AI_CHAT') {
      return NextResponse.json({ error: 'AI agent not found' }, { status: 404 });
    }

    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) return scopeError;

    if (!(await canPrincipalViewPage(auth, agentId))) {
      return NextResponse.json({ error: 'Insufficient permissions to view this agent' }, { status: 403 });
    }

    const drives = await listAgentDrives(agentId);
    return NextResponse.json({ drives });
  } catch (error) {
    loggers.api.error('Error listing agent drives:', error as Error);
    return NextResponse.json({ error: 'Failed to list agent drives' }, { status: 500 });
  }
}

const postBodySchema = z.object({
  driveId: z.string().min(1),
  includeContext: z.boolean().optional(),
});

/**
 * POST /api/ai/page-agents/[agentId]/drives
 * Add this agent to a drive the acting user can access. Managing an agent's
 * drives requires edit access to the agent; the role is inherited from (and
 * capped at) the acting user's access to the target drive.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { agentId } = await context.params;

    const agent = await getAgentPage(agentId);
    if (!agent || agent.type !== 'AI_CHAT') {
      return NextResponse.json({ error: 'AI agent not found' }, { status: 404 });
    }

    if (!(await canPrincipalEditPage(auth, agentId))) {
      return NextResponse.json({ error: 'You do not have permission to manage this agent' }, { status: 403 });
    }

    const parsed = postBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const result = await addAgentToDrive({
      actingUserId: userId,
      agentPageId: agentId,
      driveId: parsed.data.driveId,
      includeContext: parsed.data.includeContext,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(request, {
      eventType: 'authz.permission.granted',
      userId,
      resourceType: 'drive',
      resourceId: parsed.data.driveId,
      details: { agentPageId: agentId, role: result.member.role },
    });

    return NextResponse.json({ success: true, member: result.member }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding agent to drive:', error as Error);
    return NextResponse.json({ error: 'Failed to add agent to drive' }, { status: 500 });
  }
}
