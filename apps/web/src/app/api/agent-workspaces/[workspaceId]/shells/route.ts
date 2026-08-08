/**
 * A session's shells — the named PTYs inside its ONE shared sandbox.
 *
 * GET  → 200 { shells: ShellDTO[] } — a session with no row yet has no shells
 *   ({ shells: [] }), same "cold is a normal answer" rule as the session GET.
 *
 * POST { name? } → 201 { shell: ShellDTO } — reserve a shell row. On a COLD
 *   session this lazily ensures the session row AND provisions the sandbox
 *   first (opening a shell is the second of the two sanctioned first-touch
 *   provisioning sites; the other is the first sandbox tool call). An absent
 *   name auto-labels `shell-N` via the pure `planSpawnShell`; a requested
 *   duplicate is a 409, never a silent rename.
 *
 * The PTY itself is NOT started here — the realtime bridge opens it lazily on
 * first connect ({ shellId } is the whole connect payload, contract.ts).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  checkSessionAccess,
  findSessionRecord,
  provisionSessionSandbox,
} from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { listShells, spawnShell } from '@/lib/agent-workspaces/workspace-shells-runtime';
import { sessionQuotaExceeded } from '@/lib/agent-workspaces/quota-response';
import { auditSessionAccessDenial, workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/shells';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    // Not found and denied answer THE SAME empty list (family policy, review
    // #2261/5) — never a 403 that would tell a caller the session is real.
    auditSessionAccessDenial(request, auth.userId, workspaceId, access.reason, ROUTE);
    return NextResponse.json({ shells: [] });
  }

  return NextResponse.json({ shells: await listShells(workspaceId) });
}

/**
 * A denial AFTER the not-found/denied family gate has already passed — the
 * caller already knows this session exists. This is `ensureAgentSessionSandbox`'s
 * OWN authorization, re-checked at provision time, and leaks nothing new by
 * staying a genuine 403.
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

const SPAWN_DENIAL_STATUS: Record<string, number> = {
  invalid_name: 400,
  name_taken: 409,
  invalid_agent_type: 400,
  invalid_command: 400,
  error: 500,
};

const SPAWN_DENIAL_MESSAGE: Record<string, string> = {
  invalid_name: 'That is not a valid shell name — use letters, digits, "-" and "_", starting with a letter or digit',
  name_taken: 'A shell with that name already exists in this session',
  invalid_agent_type: 'That shell type is not available',
  invalid_command: 'That shell command is not valid',
  error: 'Could not open a shell',
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body opens a shell with an auto-label — one act, not a naming step.
  }
  const rawName = body !== null && typeof body === 'object' ? (body as { name?: unknown }).name : undefined;
  if (rawName !== undefined && typeof rawName !== 'string') {
    return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
  }

  // The session must already EXIST — a shell opens inside a workspace, it
  // never mints one (spawning a session is an explicit act on the collection
  // route, and a session is born with its first conversation, not a shell).
  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  const row = await findSessionRecord(workspaceId);
  if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // A shell needs a sandbox to run in: cold sessions lazily acquire theirs
  // HERE, through the same one provisioning path every surface shares.
  const provisioned = await provisionSessionSandbox(row, auth.userId);
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
    loggers.api.error('Shell spawn: session sandbox provision failed', undefined, {
      workspaceId,
      reason: provisioned.reason,
      detail: provisioned.detail,
    });
    return NextResponse.json(
      { error: 'Could not provision a sandbox for this session', reason: provisioned.reason },
      { status: 502 },
    );
  }

  const spawned = await spawnShell({ workspaceId, ownerId: auth.userId, name: rawName });
  if (!spawned.ok) {
    return NextResponse.json(
      {
        // Same split the tool surface draws: with no requested name, a
        // `name_taken` can only mean a concurrent spawn won the auto-label
        // race, and "a shell with that name already exists" names a name the
        // caller never chose.
        error:
          spawned.reason === 'name_taken' && rawName === undefined
            ? 'Another shell was created at the same moment. Try again.'
            : SPAWN_DENIAL_MESSAGE[spawned.reason],
        reason: spawned.reason,
      },
      { status: SPAWN_DENIAL_STATUS[spawned.reason] ?? 500 },
    );
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { op: 'spawn_shell', shellId: spawned.shell.shellId, name: spawned.shell.name },
  });

  return NextResponse.json({ shell: spawned.shell }, { status: 201 });
}
