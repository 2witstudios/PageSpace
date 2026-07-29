/**
 * One agent session — status / ensure+provision / end.
 *
 * GET    → 200 { session: AgentSessionDTO | null }
 *   A NEVER-PROVISIONED session is `{ session: null }` (the client derives
 *   status 'none'), NOT a 404: "this conversation has no sandbox" is the
 *   common, expected answer, and it is the same answer whether the
 *   conversation exists, is someone else's, or was never minted — so a probe
 *   learns nothing from it.
 *
 * POST   → 200 { session } — ensure the row + provision its sandbox,
 *   idempotent by the PK (a re-POST resumes). No body: the session's whole
 *   identity is READ off the conversation row (sessionId ≡ conversationId;
 *   anchor via the pure `sessionAnchorForConversation`), never claimed by a
 *   client. The row's owner is the CONVERSATION's owner even when a shared
 *   requester ensures first — otherwise the owner would flunk their own
 *   session's ownership cross-check forever.
 *
 * DELETE → 200 { ok, spriteTornDown } — end the session: instance-guarded
 *   Sprite kill, row RETAINED (re-provisionable under the same key). Gated by
 *   the END access check, which deliberately omits the capability gate: an
 *   actor who just lost `canRunCode` must still be able to release compute.
 *
 * Access decisions live in `decideAgentSessionAccess` (packages/lib) — these
 * handlers only map its verdicts onto statuses: not_found → 404 (or the
 * null-session 200 on GET), denial → 403, service failure → 502.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { sessionAnchorForConversation } from '@/lib/agent-sessions/session-anchor';
import {
  checkAccessForSubject,
  checkSessionAccess,
  checkSessionEndAccess,
  endSession,
  ensureSession,
  findSessionConversation,
  findSessionRecord,
  provisionSessionSandbox,
  toAgentSessionDTO,
} from '@/lib/agent-sessions/agent-sessions-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ sessionId: string }> };

/**
 * A plan-limit refusal, which is NOT an authorization failure: the caller has
 * every right to this session and has simply run out of allowance. Kept apart
 * from `denied()` so the user is told what actually happened (with the limit in
 * the message), and so routine quota events stop being filed as
 * `authz.access.denied` — a free-tier user clicking "new session" should not
 * read as repeated access violations in the security audit.
 *
 * 429, not 403: it is a rate/quantity limit, and it clears by ending a session.
 */
function quotaExceeded(request: Request, userId: string, sessionId: string, detail?: string): NextResponse {
  auditRequest(request, {
    eventType: 'data.read',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason: 'session_limit_reached', route: 'agent-sessions/[sessionId]' },
    riskScore: 0,
  });
  return NextResponse.json(
    { error: detail ?? 'Live agent-session limit reached for your plan — end an existing session before starting another.' },
    { status: 429 },
  );
}

function denied(request: Request, userId: string, sessionId: string, reason: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason, route: 'agent-sessions/[sessionId]' },
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    // No row = no sandbox = status 'none' — the expected cold answer, not an
    // error and not a fact worth distinguishing from "not yours to ask about".
    if (access.reason === 'session_not_found') return NextResponse.json({ session: null });
    return denied(request, auth.userId, sessionId, access.reason);
  }

  const row = await findSessionRecord(sessionId);
  if (!row) return NextResponse.json({ session: null });
  return NextResponse.json({ session: toAgentSessionDTO(row) });
}

const PROVISION_FAILURE_STATUS: Record<string, number> = {
  egress_denied: 503,
  provision_failed: 502,
  persist_failed: 502,
  race_lost: 409,
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const conversation = await findSessionConversation(sessionId);
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const anchor = sessionAnchorForConversation(conversation);
  if (!anchor.ok) {
    return NextResponse.json(
      { error: 'This conversation cannot host an agent session', reason: anchor.reason },
      { status: 409 },
    );
  }

  // The subject is the row-to-be: owner = the CONVERSATION's owner, so a
  // shared requester ensuring first can never claim someone else's session.
  const access = await checkAccessForSubject(auth.userId, {
    sessionId,
    ownerId: conversation.userId,
    agentPageId: anchor.agentPageId,
  });
  if (!access.allowed) return denied(request, auth.userId, sessionId, access.reason);

  const ensured = await ensureSession({
    conversationId: sessionId,
    userId: conversation.userId,
    agentPageId: anchor.agentPageId,
  });
  if (!ensured.ok) {
    return NextResponse.json(
      { error: 'This conversation cannot host an agent session', reason: ensured.reason },
      { status: 409 },
    );
  }

  const provisioned = await provisionSessionSandbox(ensured.session, auth.userId);
  if (!provisioned.ok) {
    if (provisioned.reason === 'denied') {
      // A plan-limit refusal is not an access denial — separate response and
      // separate audit event (see quotaExceeded).
      if (provisioned.denial === 'session_limit_reached') {
        return quotaExceeded(request, auth.userId, sessionId, provisioned.detail);
      }
      return denied(request, auth.userId, sessionId, provisioned.denial ?? 'denied');
    }
    loggers.api.error('Agent session provision failed', undefined, {
      sessionId,
      reason: provisioned.reason,
      detail: provisioned.detail,
    });
    return NextResponse.json(
      { error: 'Could not provision a sandbox for this session', reason: provisioned.reason },
      { status: PROVISION_FAILURE_STATUS[provisioned.reason] ?? 500 },
    );
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'ensure_session', resumed: provisioned.resumed },
  });

  const row = await findSessionRecord(sessionId);
  if (!row) {
    // Provision succeeded a moment ago; a vanished row here is a genuine
    // server-side inconsistency, not a client-addressable state.
    return NextResponse.json({ error: 'Failed to load the session' }, { status: 500 });
  }
  return NextResponse.json({ session: toAgentSessionDTO(row) });
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionEndAccess(auth.userId, sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return denied(request, auth.userId, sessionId, access.reason);
  }

  const ended = await endSession(sessionId);
  if (!ended.ok) {
    if (ended.reason === 'not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    loggers.api.error('Agent session teardown failed', undefined, { sessionId, detail: ended.detail });
    return NextResponse.json(
      { error: 'Could not end this session', reason: ended.reason },
      { status: 502 },
    );
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'end_session', spriteTornDown: ended.spriteTornDown },
  });

  return NextResponse.json({ ok: true, spriteTornDown: ended.spriteTornDown });
}
