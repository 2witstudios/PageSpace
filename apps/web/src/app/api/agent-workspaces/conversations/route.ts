/**
 * GET ?driveId=<id> | (none = every drive) & limit & cursor
 *   → `PastConversationsResponseDTO` — see `past-conversation-dto.ts`, the
 *     single declaration of this wire shape that the client imports too.
 *
 * The Agents surface's default middle-panel view: every conversation the
 * requester owns — session-bound or not, page-agent or global-assistant —
 * newest first, cursor-paginated (see `workspace-conversations-runtime.ts`
 * for why: agent_workspaces rows are never deleted, so history is unbounded).
 * `cursor` always means "older than this" — the only direction the surface's
 * Prev/Next actually needs (Prev replays an already-fetched, SWR-cached page
 * rather than asking the server to go forward).
 *
 * Open to every authenticated user, same as `/api/agent-workspaces` (GET) —
 * sessions/chat/panes are free; only the sandbox itself is tier-gated,
 * further down the call chain, not at this listing level.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import { resolveDriveMembership } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { listAllConversationsPaginated } from '@/lib/agent-workspaces/workspace-conversations-runtime';
import { encodeCursor } from '@/lib/conversations/conversation-recency';
import { toWireRow, type PastConversationServerRow } from '@/lib/agent-workspaces/past-conversation-dto';

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
  row: PastConversationServerRow,
  canViewPage: (agentPageId: string) => boolean,
  canAccessSessionDrive: (driveId: string) => boolean,
  scopedDriveId: string | undefined,
): PastConversationServerRow[] {
  if (row.type === 'page' && row.agentPageId !== null && !canViewPage(row.agentPageId)) {
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

  // A `type: 'global'` conversation can be bound to a DRIVE-SCOPED agent
  // session — any accepted drive member may create their own global
  // conversation inside another member's session (`decideAgentSessionAccess`
  // grants access by drive membership, not session ownership), so
  // `conversations.userId` and the joined `agent_workspaces.ownerId` can
  // legitimately differ. Conversation OWNERSHIP never lapses, but the
  // requester's membership in that session's drive can — the identical
  // "authored it once, current access unproven" gap already fixed above for
  // pages, with the identical oracle risk: a drive-scoped `?driveId=X`
  // request that still returns this row already confirms "this session
  // currently belongs to drive X". Caught proactively (not yet a reviewer
  // finding) by re-applying the exact fix this PR already established for
  // pages, to the one other row shape with the same shared-resource shape.
  if (row.type === 'global' && row.workspaceId !== null && row.driveId !== null && !canAccessSessionDrive(row.driveId)) {
    if (scopedDriveId) return [];
    // Masking (not dropping) is safe unscoped: the global-assistant message
    // GET gates purely on `conversations.userId` — never session or drive
    // membership (`/api/ai/global/[id]/messages` route) — so the
    // conversation's own content stays fully readable. Nulling the
    // session-derived fields just stops it from presenting as session-bound;
    // `resolveNavigationTarget` then falls through to the ordinary
    // `case 'global'` branch on its own, no extra signal needed.
    return [{ ...row, workspaceId: null, driveId: null, sessionName: null, sessionEndedAt: null }];
  }

  return [row];
}

async function getBatchDriveMembership(userId: string, driveIds: string[]): Promise<Map<string, boolean>> {
  const distinct = Array.from(new Set(driveIds));
  const entries = await Promise.all(
    distinct.map(async (driveId): Promise<[string, boolean]> => [
      driveId,
      (await resolveDriveMembership({ userId, driveId })) !== 'none',
    ]),
  );
  return new Map(entries);
}

async function fetchVisiblePage(
  ownerId: string,
  scopedDriveId: string | undefined,
  limit: number,
  initialCursor: string | undefined,
): Promise<{ conversations: PastConversationServerRow[]; hasMore: boolean; nextCursor: string | null }> {
  const visible: PastConversationServerRow[] = [];
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

    const sessionDriveIds = result.conversations
      .filter((c) => c.type === 'global' && c.workspaceId !== null && c.driveId !== null)
      .map((c) => c.driveId as string);
    const driveMembership = sessionDriveIds.length > 0 ? await getBatchDriveMembership(ownerId, sessionDriveIds) : null;
    const canAccessSessionDrive = (driveId: string) => driveMembership?.get(driveId) ?? false;

    for (const row of result.conversations) {
      visible.push(...maskOrDrop(row, canViewPage, canAccessSessionDrive, scopedDriveId));
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
    nextCursor: lastRow ? encodeCursor(lastRow.sortKeyValue, lastRow.conversationId) : (hasMore ? cursor ?? null : null),
  };
}

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const driveId = url.searchParams.get('driveId');

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

    return NextResponse.json({
      conversations: conversations.map(toWireRow),
      pagination: { hasMore, nextCursor, limit },
    });
  } catch (error) {
    loggers.api.error(
      'Past conversations list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
