/**
 * One agent session — status / ensure+provision / end.
 *
 * GET    → 200 { session: AgentSessionDTO | null }
 *   `{ session: null }` whether the session never existed OR is someone
 *   else's — never a 404 or a 403: the same answer either way, so a probe
 *   learns nothing from it. (Post-unconflation every spawned session has a
 *   row from birth; null here means the id resolves to nothing you may see.)
 *
 * POST   → 200 { session } — provision the EXISTING session's sandbox,
 *   idempotent by the session id (a re-POST resumes). No body: sessions are
 *   born through the collection route's spawn; this route never mints one.
 *
 * DELETE → 200 { ok, spriteTornDown } — end the session: instance-guarded
 *   Sprite kill, row RETAINED (re-provisionable under the same key). Gated by
 *   the END access check: the OWNER may always end (release-of-compute — no
 *   membership or capability needed to stop paying); everyone else faces the
 *   full decision, real capability included.
 *
 * Access decisions live in `decideAgentSessionAccess` (packages/lib) — these
 * handlers map its verdicts onto ONE not-found/denied policy for the whole
 * `[sessionId]` family (`session-unavailable-response.ts`, review #2261/5):
 * an unknown id and a denied one answer IDENTICALLY (the null-session 200 on
 * GET, a uniform 404 on POST/DELETE) — service failure is the only distinct
 * outcome, at 502.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { sessionQuotaExceeded } from '@/lib/agent-sessions/quota-response';
import { auditSessionAccessDenial, sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';
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

const ROUTE = 'agent-sessions/[sessionId]';

type RouteContext = { params: Promise<{ sessionId: string }> };

/**
 * A denial AFTER the not-found/denied family gate has already passed — the
 * caller already knows this session exists (the session-access check above
 * succeeded and its row was found). This is a DIFFERENT question
 * (`ensureAgentSessionSandbox`'s own authorization, re-checked at provision
 * time) that leaks nothing new by staying a genuine 403.
 */
function provisioningDenied(request: Request, userId: string, sessionId: string, reason: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason, route: ROUTE },
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
    // Not found and denied answer THE SAME — null, never a 404 or a 403 —
    // so a probe learns nothing from the difference (family policy above).
    auditSessionAccessDenial(request, auth.userId, sessionId, access.reason, ROUTE);
    return NextResponse.json({ session: null });
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
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  const existing = await findSessionRecord(sessionId);
  if (!existing) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const provisioned = await provisionSessionSandbox(existing, auth.userId);
  if (!provisioned.ok) {
    if (provisioned.reason === 'denied') {
      // A plan-limit refusal is not an access denial — separate response and
      // separate audit event (see quotaExceeded).
      if (provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, sessionId, ROUTE, {
          reasonCode: provisioned.detail,
        });
      }
      return provisioningDenied(request, auth.userId, sessionId, provisioned.denial ?? 'denied');
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
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
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
