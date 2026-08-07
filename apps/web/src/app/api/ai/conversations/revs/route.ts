import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';

/**
 * `POST /api/ai/conversations/revs` — the reconnect watermark check
 * (Agent-Session Single Source of Truth epic, Phase 2; spec
 * `docs/2.0-architecture/agent-sessions.md` §3 clause 3).
 *
 * Broadcast transport is best-effort by design: a socket that was disconnected
 * for ten seconds simply did not receive the events emitted in those ten
 * seconds, and nothing will replay them. Correctness comes from the rev
 * watermark, not from delivery — so on reconnect a client asks, in ONE
 * round-trip for every conversation it is subscribed to, "what rev are these
 * at?" and refetches only the ones whose answer disagrees with its watermark.
 *
 * POST, not GET: the id list is unbounded-ish (a session can have many panes
 * open) and belongs in a body rather than a query string that proxies truncate
 * and access logs retain.
 *
 * AUTHORIZATION is the shared `canAccessConversation` predicate — the same
 * implementation the realtime `join_conversation` handler, `/stream-join` and
 * `/active-streams` enforce, so the four cannot drift. Ids the caller may not
 * access are simply ABSENT from the response rather than 403-ing the whole
 * batch: a client asking about a conversation that was un-shared out from under
 * it is an expected state (its room membership was kicked at the same moment),
 * not an attack, and one stale id must not blind the client to the other
 * nineteen. Absence is also not an oracle — a nonexistent id and a forbidden id
 * are indistinguishable in the response.
 */

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * Ceiling on ids per request. Comfortably above any real subscriber count (one
 * per open pane) while keeping the `IN (...)` bounded — the findMany-limit rule's
 * concern in query form.
 */
const MAX_IDS = 200;

interface RevsRequestBody {
  ids?: unknown;
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'ai_conversation',
        resourceId: 'revs',
        details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason },
        riskScore: 0.5,
      });
      return auth.error;
    }
    const userId = auth.userId;

    let body: RevsRequestBody;
    try {
      body = (await request.json()) as RevsRequestBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!Array.isArray(body.ids)) {
      return NextResponse.json({ error: 'ids must be an array of conversation ids' }, { status: 400 });
    }

    // De-duplicated, string-only, bounded. A client that somehow asks about the
    // same id twice gets one answer; anything non-string never reaches the query.
    const ids = [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) {
      return NextResponse.json({ revs: {} });
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `At most ${MAX_IDS} conversation ids per request` }, { status: 400 });
    }

    const rows = await db
      .select({
        id: conversations.id,
        rev: conversations.rev,
        userId: conversations.userId,
        isShared: conversations.isShared,
        type: conversations.type,
        contextId: conversations.contextId,
      })
      .from(conversations)
      .where(inArray(conversations.id, ids))
      .limit(MAX_IDS);

    const revs: Record<string, number> = {};
    // Sequential rather than Promise.all: `canAccessConversation` short-circuits
    // with NO io for the owner (the overwhelmingly common case here — a user's
    // own panes), so the parallelism would only buy a fan-out of page-access
    // queries for the rare shared row while costing an unbounded burst.
    for (const row of rows) {
      const allowed = await canAccessConversation(userId, {
        userId: row.userId,
        isShared: row.isShared,
        type: row.type,
        contextId: row.contextId,
      });
      if (allowed) revs[row.id] = row.rev;
    }

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'ai_conversation',
      resourceId: 'revs',
      details: { action: 'check_revs', requested: ids.length, returned: Object.keys(revs).length },
    });

    return NextResponse.json({ revs });
  } catch (error) {
    loggers.api.error('Error checking conversation revs:', error as Error);
    return NextResponse.json({ error: 'Failed to check conversation revs' }, { status: 500 });
  }
}
