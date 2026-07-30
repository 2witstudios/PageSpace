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
 * POST   → 200 { session } — provision the EXISTING session's sandbox,
 *   idempotent by the session id (a re-POST resumes). No body: sessions are
 *   born through the collection route's spawn; this route never mints one, so
 *   an unknown id is a 404, not an ensure.
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
import { sessionQuotaExceeded } from '@/lib/agent-sessions/quota-response';
import {
  checkSessionAccess,
  checkSessionEndAccess,
  endSession,
  findSessionRecord,
  provisionSessionSandbox,
  toAgentSessionDTO,
} from '@/lib/agent-sessions/agent-sessions-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ sessionId: string }> };


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

  // The session must already exist — spawning one is the collection route's
  // POST. This POST (re-)provisions an EXISTING workspace's sandbox: cold
  // start, or resume after an end.
  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return denied(request, auth.userId, sessionId, access.reason);
  }

  const existing = await findSessionRecord(sessionId);
  if (!existing) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const provisioned = await provisionSessionSandbox(existing, auth.userId);
  if (!provisioned.ok) {
    if (provisioned.reason === 'denied') {
      // A plan-limit refusal is not an access denial — separate response and
      // separate audit event (see quotaExceeded).
      if (provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, sessionId, 'agent-sessions/[sessionId]', provisioned.detail);
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
    details: { op: 'provision_session', resumed: provisioned.resumed },
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
