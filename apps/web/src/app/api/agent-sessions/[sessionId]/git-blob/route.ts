/**
 * Session Git Blob API — port of `/api/machines/git-blob` re-scoped to the
 * session's sandbox: ONE file's content as it existed at a git ref, read from
 * a caller-named repo's OBJECT STORE (`repoPath`, relative to the sandbox
 * root; a session may hold any number of clones). v1 ships no Diff UI — this
 * exists, access-gated, for the later drop-in client.
 *
 * GET ?repoPath=&ref=&path= → { content, truncated }
 *
 * `path` resolves INSIDE `ref`'s own git tree, never the host filesystem, so
 * it cannot escape onto disk — it only ever misses (404). Same
 * `{ error, reason }` contract as the machines route; stderr is only logged.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { readMachineGitBlob } from '@pagespace/lib/services/sandbox/machine-git-blob';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { resolvePathWithinSync } from '@pagespace/lib/security/path-validator';
import { checkSessionAccess } from '@/lib/agent-sessions/agent-sessions-runtime';
import {
  buildSessionGitDepsForHandle,
  buildSessionReadActorCtx,
  resolveSessionActorContext,
  resolveSessionSandboxHandle,
} from '@/lib/agent-sessions/session-sandbox-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

type RouteContext = { params: Promise<{ sessionId: string }> };

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

const DENIAL_STATUS: Record<string, number> = {
  invalid_ref: 400,
  not_found: 404,
  exec_failed: 502,
};

const DENIAL_MESSAGE: Record<string, string> = {
  invalid_ref: 'That git reference is not valid',
  not_found: 'File not found at this ref',
  exec_failed: 'Failed to read the file at this ref',
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  // Authorize BEFORE parsing ref/path — a user without access can never probe
  // ref/path handling.
  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') {
      return NextResponse.json({ error: 'This session has no sandbox yet', reason: 'not_started' }, { status: 404 });
    }
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { reason: access.reason, route: 'agent-sessions/[sessionId]/git-blob' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
  }

  const url = new URL(request.url);
  const repoPath = requireString(url.searchParams.get('repoPath'), 'repoPath');
  if (!repoPath.ok) return repoPath.error;
  const ref = requireString(url.searchParams.get('ref'), 'ref');
  if (!ref.ok) return ref.error;
  const path = requireString(url.searchParams.get('path'), 'path');
  if (!path.ok) return path.error;

  const repoRoot = resolvePathWithinSync(SANDBOX_ROOT, repoPath.value);
  if (repoRoot === null) {
    return NextResponse.json({ error: 'repoPath escapes the sandbox root' }, { status: 400 });
  }

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) {
    const error =
      resolved.reason === 'vanished' ? 'This session\'s sandbox is unavailable' : 'This session has no sandbox yet';
    return NextResponse.json(
      { error, reason: resolved.reason },
      { status: resolved.reason === 'vanished' ? 503 : 404 },
    );
  }

  const actor = await resolveSessionActorContext(auth.userId);
  const ctx = buildSessionReadActorCtx(`${sessionId}:${repoPath.value}:git-blob`, actor);
  const deps = buildSessionGitDepsForHandle(resolved.handle);

  const result = await readMachineGitBlob({
    ref: ref.value,
    path: path.value,
    cwd: repoRoot,
    ctx,
    deps,
  });
  if (!result.ok) {
    const status = DENIAL_STATUS[result.reason] ?? 500;
    if (status >= 500 || result.detail !== undefined) {
      const meta = {
        sessionId,
        repoPath: repoPath.value,
        ref: ref.value,
        path: path.value,
        reason: result.reason,
        detail: result.detail,
      };
      if (status >= 500) {
        loggers.api.error('Session git-blob read failed', undefined, meta);
      } else {
        loggers.api.warn('Session git-blob read failed', meta);
      }
    }
    return NextResponse.json(
      { error: DENIAL_MESSAGE[result.reason] ?? 'Failed to read the file at this ref', reason: result.reason },
      { status },
    );
  }
  return NextResponse.json({ content: result.content, truncated: result.truncated });
}
