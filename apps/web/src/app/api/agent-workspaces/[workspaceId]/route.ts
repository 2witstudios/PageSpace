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
 * DELETE → 200 { ok, spriteTornDown, hadOtherOpenConversations } — end the
 *   session: instance-guarded Sprite kill, row RETAINED (re-provisionable
 *   under the same key). Gated by the END access check: the OWNER may always
 *   end (release-of-compute — no membership or capability needed to stop
 *   paying); everyone else faces the full decision, real capability included.
 *   Ending is unconditional by design (the sidebar's own "End session" is
 *   reachable with any number of open conversations) — `hadOtherOpenConversations`
 *   is informational only, a plain lock-free read taken right before
 *   teardown, so a caller whose confirm was based on a stale "this looks
 *   empty" premise (a conversation minted elsewhere between an earlier
 *   `last_conversation` 409 and this confirm) can warn the user after the
 *   fact instead of destroying it in total silence.
 *
 * Access decisions live in `decideAgentSessionAccess` (packages/lib) — these
 * handlers map its verdicts onto ONE not-found/denied policy for the whole
 * `[workspaceId]` family (`session-unavailable-response.ts`, review #2261/5):
 * an unknown id and a denied one answer IDENTICALLY (the null-session 200 on
 * GET, a uniform 404 on POST/DELETE) — service failure is the only distinct
 * outcome, at 502.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { sessionQuotaExceeded } from '@/lib/agent-workspaces/quota-response';
import { auditSessionAccessDenial, sessionNotFoundOrDenied } from '@/lib/agent-workspaces/session-unavailable-response';
import {
  checkSessionAccess,
  checkSessionEndAccess,
  countOpenConversationsForSession,
  endSession,
  findSessionRecord,
  provisionSessionSandbox,
  toAgentSessionDTO,
} from '@/lib/agent-workspaces/agent-sessions-runtime';
import { canRunCodeForSession } from '@pagespace/lib/services/agent-workspaces/agent-session-tenant';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]';

type RouteContext = { params: Promise<{ workspaceId: string }> };

/**
 * A denial AFTER the not-found/denied family gate has already passed — the
 * caller already knows this session exists (the session-access check above
 * succeeded and its row was found). This is a DIFFERENT question
 * (`ensureAgentSessionSandbox`'s own authorization, re-checked at provision
 * time) that leaks nothing new by staying a genuine 403.
 */
function provisioningDenied(request: Request, userId: string, workspaceId: string, reason: string, detail?: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { reason, ...(detail ? { detail } : {}), route: ROUTE },
    riskScore: 0.5,
  });
  // The session surface is free for every drive member, so a free-tier payer
  // legitimately reaches this point — name the plan gate instead of implying
  // an access problem they could never resolve.
  const error =
    detail === 'tier_ineligible'
      ? 'Running the agent sandbox requires a Pro plan or above'
      : 'You do not have access to this session';
  return NextResponse.json({ error }, { status: 403 });
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    // Not found and denied answer THE SAME — null, never a 404 or a 403 —
    // so a probe learns nothing from the difference (family policy above).
    auditSessionAccessDenial(request, auth.userId, workspaceId, access.reason, ROUTE);
    return NextResponse.json({ session: null });
  }

  const row = await findSessionRecord(workspaceId);
  if (!row) return NextResponse.json({ session: null });
  // Whether THIS REQUESTER may run the sandbox here — the full centralized
  // `canRunCode` verdict (kill switch + the PAYER's tier + the requester's
  // own drive edit access), not payer tier alone (review #2326): a
  // VIEWER-role member of a Pro-owned drive, or anyone while the kill
  // switch is off, would otherwise see enabled Shell/reattach controls that
  // every enforcement point (shells POST, realtime attach) then 403s.
  // Payer-based tier resolution still means a free-tier EDITOR in a
  // Pro-owned drive sees the sandbox as available — client-side `useAuth()`
  // only knows the viewer's own tier, the wrong axis; this is the one place
  // that resolves the real answer.
  const sandboxEligible = await canRunCodeForSession({
    userId: auth.userId,
    driveId: row.driveId,
    ownerId: row.ownerId,
  });
  return NextResponse.json({ session: toAgentSessionDTO(row), sandboxEligible });
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
  const { workspaceId } = await context.params;

  // The session must already exist — spawning one is the collection route's
  // POST. This POST (re-)provisions an EXISTING workspace's sandbox: cold
  // start, or resume after an end.
  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  const existing = await findSessionRecord(workspaceId);
  if (!existing) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const provisioned = await provisionSessionSandbox(existing, auth.userId);
  if (!provisioned.ok) {
    if (provisioned.reason === 'denied') {
      // A plan-limit refusal is not an access denial — separate response and
      // separate audit event (see quotaExceeded).
      if (provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, workspaceId, ROUTE, {
          reasonCode: provisioned.detail,
        });
      }
      return provisioningDenied(request, auth.userId, workspaceId, provisioned.denial ?? 'denied', provisioned.detail);
    }
    loggers.api.error('Agent session provision failed', undefined, {
      workspaceId,
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
    resourceId: workspaceId,
    details: { op: 'provision_session', resumed: provisioned.resumed },
  });

  const row = await findSessionRecord(workspaceId);
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
  const { workspaceId } = await context.params;

  const access = await checkSessionEndAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  // Purely informational — never blocks teardown (ending is unconditional by
  // design; see the DELETE docstring above). Best-effort: a failure here must
  // never fail the actual end-session request.
  let hadOtherOpenConversations = false;
  try {
    hadOtherOpenConversations = (await countOpenConversationsForSession(workspaceId)) > 1;
  } catch (error) {
    loggers.api.error('Could not read open-conversation count before ending session', undefined, {
      workspaceId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const ended = await endSession(workspaceId);
  if (!ended.ok) {
    if (ended.reason === 'not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    loggers.api.error('Agent session teardown failed', undefined, { workspaceId, detail: ended.detail });
    return NextResponse.json(
      { error: 'Could not end this session', reason: ended.reason },
      { status: 502 },
    );
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { op: 'end_session', spriteTornDown: ended.spriteTornDown, hadOtherOpenConversations },
  });

  return NextResponse.json({ ok: true, spriteTornDown: ended.spriteTornDown, hadOtherOpenConversations });
}
