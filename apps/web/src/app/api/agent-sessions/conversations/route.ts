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
import {
  listAllConversationsPaginated,
  encodeCursor,
  type PastConversationRow,
} from '@/lib/agent-sessions/agent-sessions-conversations-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

/**
 * Drive-scoped requests DROP inaccessible page rows entirely (see the
 * flatMap below) rather than masking them — so a single DB-level page of
 * `limit` rows can filter down to fewer, or even zero, visible rows while
 * `hasMore`/`nextCursor` still describe the unfiltered DB page. Returning
 * that directly breaks the frontend: an empty `conversations` array on the
 * first page renders the terminal "no history" empty state and hides
 * Prev/Next entirely, permanently hiding any later, actually-visible row
 * (review finding). Keep fetching subsequent DB pages — filtering each the
 * same way — until either `limit` visible rows have been collected or the
 * underlying data is exhausted. Bounded by `MAX_INTERNAL_FETCHES` so a
 * pathological history (long unbroken run of now-inaccessible pages) can't
 * turn one request into an unbounded scan.
 */
const MAX_INTERNAL_FETCHES = 5;

function maskOrDrop(
  row: PastConversationRow,
  canViewPage: (agentPageId: string) => boolean,
  scopedDriveId: string | undefined,
): PastConversationRow[] {
  if (row.type !== 'page' || row.agentPageId === null || canViewPage(row.agentPageId)) return [row];
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
  return [{ ...row, pageTitle: null, driveId: null }];
}

async function fetchVisiblePage(
  ownerId: string,
  scopedDriveId: string | undefined,
  limit: number,
  initialCursor: string | undefined,
): Promise<{ conversations: PastConversationRow[]; hasMore: boolean; nextCursor: string | null }> {
  const visible: PastConversationRow[] = [];
  let cursor = initialCursor;
  let hasMore = true;

  for (let i = 0; i < MAX_INTERNAL_FETCHES && visible.length < limit && hasMore; i++) {
    const result = await listAllConversationsPaginated({ ownerId, driveId: scopedDriveId }, { limit, cursor });
    hasMore = result.pagination.hasMore;
    cursor = result.pagination.nextCursor ?? undefined;

    const pageIds = Array.from(
      new Set(
        result.conversations
          .filter((c) => c.type === 'page')
          .map((c) => c.agentPageId)
          .filter((id): id is string => id !== null),
      ),
    );
    const pagePermissions = pageIds.length > 0 ? await getBatchPagePermissions(ownerId, pageIds) : null;
    const canViewPage = (agentPageId: string) => pagePermissions?.get(agentPageId)?.canView ?? false;

    for (const row of result.conversations) {
      visible.push(...maskOrDrop(row, canViewPage, scopedDriveId));
    }
  }

  const page = visible.slice(0, limit);
  const truncated = visible.length > limit;
  const lastRow = truncated ? page[page.length - 1] : null;

  return {
    conversations: page,
    hasMore: truncated || hasMore,
    // A row we truncated off ourselves is a real, already-fetched row — its
    // own cursor is exactly as valid a boundary as one the DB query would
    // have produced, so the next request resumes from it correctly (any
    // rows dropped alongside it get re-fetched-and-refiltered next call,
    // harmlessly). Otherwise carry forward wherever the internal loop
    // itself left off (still `hasMore` but hit the fetch cap, or genuinely
    // out of data).
    nextCursor: lastRow ? encodeCursor(lastRow.lastMessageAt ?? lastRow.createdAt, lastRow.conversationId) : (hasMore ? cursor ?? null : null),
  };
}

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
    // App-admin status alone does not prove the requester can still see a
    // page's CURRENT title/drive — they may have authored this conversation
    // back when they were a member of that page's drive, and lost that
    // membership since (review finding: the join surfaced the page's live
    // metadata keyed only on conversation ownership). Batch-checked inside
    // `fetchVisiblePage`, once per internal DB fetch.
    const { conversations, hasMore, nextCursor } = await fetchVisiblePage(
      auth.userId,
      scopedDriveId,
      limit,
      cursor,
    );

    return NextResponse.json({ conversations, pagination: { hasMore, nextCursor, limit } });
  } catch (error) {
    loggers.api.error(
      'Past conversations list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
