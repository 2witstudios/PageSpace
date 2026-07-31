/**
 * GET ?driveId=<id> | (none = every drive) & limit & cursor & direction
 *   → { conversations: PastConversationRow[], pagination: { hasMore, nextCursor, prevCursor, limit } }
 *
 * The Agents surface's default middle-panel view: every conversation the
 * requester owns — session-bound or not, page-agent or global-assistant —
 * newest first, cursor-paginated (see `agent-sessions-conversations-runtime.ts`
 * for why: agent_sessions rows are never deleted, so history is unbounded).
 *
 * Same admin gate as `/api/agent-sessions` (GET) — this is the same
 * admin-only-plus-CODE_EXECUTION surface, just listing conversations instead
 * of sessions.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { listAllConversationsPaginated } from '@/lib/agent-sessions/agent-sessions-conversations-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const driveId = url.searchParams.get('driveId');

  if (auth.role !== 'admin') {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: driveId ? 'drive' : 'agent_sessions',
      resourceId: driveId ?? undefined,
      details: { reason: 'app_admin_required', method: 'GET', route: 'agent-sessions/conversations' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Agent sessions require administrator privileges' }, { status: 403 });
  }

  const limit = parseBoundedIntParam(url.searchParams.get('limit'), {
    defaultValue: 20,
    min: 1,
    max: 100,
  });
  const cursor = url.searchParams.get('cursor') || undefined;
  const directionParam = url.searchParams.get('direction');
  const direction = directionParam === 'after' ? 'after' : 'before';

  try {
    const result = await listAllConversationsPaginated(
      { ownerId: auth.userId, driveId: driveId && driveId.length > 0 ? driveId : undefined },
      { limit, cursor, direction },
    );
    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error(
      'Past conversations list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
