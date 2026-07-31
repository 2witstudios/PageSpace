/**
 * GET ?driveId=<id> | (none = every drive) & limit & cursor
 *   → { conversations: PastConversationRow[], pagination: { hasMore, nextCursor, limit } }
 *
 * The Agents surface's default middle-panel view: every conversation the
 * requester owns — session-bound or not, page-agent or global-assistant —
 * newest first, cursor-paginated (see `agent-sessions-conversations-runtime.ts`
 * for why: agent_sessions rows are never deleted, so history is unbounded).
 * `cursor` always means "older than this" — the only direction the surface's
 * Prev/Next actually needs (Prev replays an already-fetched, SWR-cached page
 * rather than asking the server to go forward).
 *
 * Same admin gate as `/api/agent-sessions` (GET) — this is the same
 * admin-only-plus-CODE_EXECUTION surface, just listing conversations instead
 * of sessions.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
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

  const scopedDriveId = driveId && driveId.length > 0 ? driveId : undefined;

  try {
    const result = await listAllConversationsPaginated(
      { ownerId: auth.userId, driveId: scopedDriveId },
      { limit, cursor },
    );

    // App-admin status alone does not prove the requester can still see a
    // page's CURRENT title/drive — they may have authored this conversation
    // back when they were a member of that page's drive, and lost that
    // membership since (review finding: the join surfaced the page's live
    // metadata keyed only on conversation ownership). Batch-check once.
    const pageIds = Array.from(
      new Set(
        result.conversations
          .filter((c) => c.type === 'page')
          .map((c) => c.agentPageId)
          .filter((id): id is string => id !== null),
      ),
    );
    const pagePermissions = pageIds.length > 0 ? await getBatchPagePermissions(auth.userId, pageIds) : null;
    const canViewPage = (agentPageId: string) => pagePermissions?.get(agentPageId)?.canView ?? false;

    const conversations = result.conversations.flatMap((c) => {
      if (c.type !== 'page' || c.agentPageId === null || canViewPage(c.agentPageId)) return [c];
      // Drive-scoped requests must DROP the row entirely, not just mask its
      // fields: the drive filter itself runs against the page's CURRENT
      // `driveId` before any permission check, so a masked-but-present row in
      // a `?driveId=X` result already confirms "this inaccessible page
      // currently belongs to drive X" — an oracle a caller could probe across
      // candidate drive ids (review finding). Un-scoped (global) requests
      // don't have this problem — presence there isn't tied to any specific
      // drive being asked about — so masking (keep the row, as the
      // requester's own history, but hide the page-derived fields) is still
      // correct there, matching the `storage/info/route.ts` pattern.
      if (scopedDriveId) return [];
      return [{ ...c, pageTitle: null, driveId: null }];
    });

    return NextResponse.json({ ...result, conversations });
  } catch (error) {
    loggers.api.error(
      'Past conversations list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
