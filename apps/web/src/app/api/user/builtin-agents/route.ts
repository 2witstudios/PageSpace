import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { BUILTIN_AGENTS, type BuiltinAgentKey } from '@pagespace/lib/agents/builtin-agents';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * One built-in Imago agent as the viewer sees it. `pageId` is null when the
 * agent has not been provisioned for the viewer yet (or its page is in the
 * trash, which the next provisioning replaces). Deliberately carries no system
 * prompt or tool list: those stay server-side in the registry.
 */
export type BuiltinAgentPointer = {
  key: BuiltinAgentKey;
  pageId: string | null;
  title: string;
};

/**
 * The session viewer's built-in agent pointers, one per registry key, in
 * registry order. Read-only: provisioning happens at sign-in, never here. The
 * user is the authenticated session's — nothing in the request can name
 * another.
 */
export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  auditRequest(req, { eventType: 'data.read', userId, resourceType: 'builtin_agents', resourceId: 'self' });

  try {
    const rows = await db
      .select({ key: userBuiltinAgents.key, pageId: userBuiltinAgents.pageId, isTrashed: pages.isTrashed })
      .from(userBuiltinAgents)
      .innerJoin(pages, eq(pages.id, userBuiltinAgents.pageId))
      .where(eq(userBuiltinAgents.userId, userId));

    const livePageIdByKey = new Map(rows.filter((row) => !row.isTrashed).map((row) => [row.key, row.pageId]));

    const agents: BuiltinAgentPointer[] = BUILTIN_AGENTS.map((agent) => ({
      key: agent.key,
      pageId: livePageIdByKey.get(agent.key) ?? null,
      title: agent.title,
    }));

    return NextResponse.json({ agents });
  } catch (error) {
    loggers.api.error('Error fetching built-in agents:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch built-in agents' }, { status: 500 });
  }
}
