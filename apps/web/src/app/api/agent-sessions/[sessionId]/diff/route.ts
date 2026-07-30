/**
 * Session Diff API — port of `/api/machines/diff` re-scoped to the session's
 * sandbox. The machines route addressed a branch checkout at a fixed path; a
 * session may hold any number of clones, so the CALLER names the repo
 * (`repoPath`, relative to the sandbox root) and the branch its working tree
 * has checked out (`branchName` — the scope semantics in the pure
 * `machine-diff-scope.ts` need it to resolve merge-bases). v1 ships no Diff UI
 * — this exists, access-gated, for the later drop-in client.
 *
 * GET ?repoPath=&branchName=&scope=uncommitted|committed|branch
 *     [&path=&previousPath=&status=]
 *
 * Same response/failure contract as the machines route (`{ error, reason }`,
 * stderr only ever logged); the resolve reasons are the session ones
 * (`not_started` 404 / `vanished` 503 — a browse never provisions).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { listMachineDiffFiles, readMachineDiffPair } from '@pagespace/lib/services/sandbox/machine-diff';
import {
  isMachineDiffFileStatus,
  isMachineDiffScope,
  isMainBranchName,
  resolveDiffScope,
} from '@pagespace/lib/services/sandbox/machine-diff-scope';
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
  exec_failed: 502,
  merge_base_failed: 502,
};

const RESOLVE_DENIAL_STATUS: Record<'not_found' | 'not_started' | 'vanished', number> = {
  not_found: 404,
  not_started: 404,
  vanished: 503,
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  // Authorize BEFORE parsing scope/path params — a user without access gets a
  // uniform answer and can never probe them.
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
      details: { reason: access.reason, route: 'agent-sessions/[sessionId]/diff' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const repoPath = requireString(searchParams.get('repoPath'), 'repoPath');
  if (!repoPath.ok) return repoPath.error;
  const branchName = requireString(searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  // The repo root is a real filesystem path on the sandbox — confined like any
  // other untrusted path field.
  const repoRoot = resolvePathWithinSync(SANDBOX_ROOT, repoPath.value);
  if (repoRoot === null) {
    return NextResponse.json({ error: 'repoPath escapes the sandbox root' }, { status: 400 });
  }

  const scope = searchParams.get('scope');
  if (scope === null || !isMachineDiffScope(scope)) {
    return NextResponse.json({ error: "scope must be 'uncommitted', 'committed', or 'branch'" }, { status: 400 });
  }

  // The main-branch answer is pure — no handle, no git — so it comes first and
  // holds even while the sandbox is hibernating.
  const isMainBranch = isMainBranchName(branchName.value);
  if ('notApplicable' in resolveDiffScope(branchName.value, isMainBranch, scope)) {
    return NextResponse.json({ notApplicable: true });
  }

  const rawPath = searchParams.get('path');
  const workingTreePath = rawPath !== null && rawPath.length > 0 ? resolvePathWithinSync(repoRoot, rawPath) : null;
  if (rawPath !== null && rawPath.length > 0 && workingTreePath === null) {
    return NextResponse.json({ error: 'path escapes the repo root' }, { status: 400 });
  }

  const rawPreviousPath = searchParams.get('previousPath');
  const previousPath = rawPreviousPath !== null && rawPreviousPath.length > 0 ? rawPreviousPath : undefined;

  const rawStatus = searchParams.get('status');
  if (rawStatus !== null && rawStatus.length > 0 && !isMachineDiffFileStatus(rawStatus)) {
    return NextResponse.json(
      { error: "status must be 'added', 'modified', 'deleted', or 'renamed'" },
      { status: 400 },
    );
  }
  const status = rawStatus !== null && isMachineDiffFileStatus(rawStatus) ? rawStatus : undefined;

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) {
    const error =
      resolved.reason === 'vanished' ? 'This session\'s sandbox is unavailable' : 'This session has no sandbox yet';
    return NextResponse.json({ error, reason: resolved.reason }, { status: RESOLVE_DENIAL_STATUS[resolved.reason] });
  }

  const actor = await resolveSessionActorContext(auth.userId);
  const ctx = buildSessionReadActorCtx(`${sessionId}:${repoPath.value}:diff`, actor);
  const deps = buildSessionGitDepsForHandle(resolved.handle, sessionId);

  const logDiffFailure = (message: string, extra: Record<string, unknown>) =>
    loggers.api.error(message, undefined, {
      sessionId,
      repoPath: repoPath.value,
      branchName: branchName.value,
      scope,
      ...extra,
    });

  if (rawPath !== null && rawPath.length > 0 && workingTreePath !== null) {
    const result = await readMachineDiffPair({
      branchName: branchName.value,
      isMainBranch,
      scope,
      path: rawPath,
      previousPath,
      status,
      workingTreePath,
      cwd: repoRoot,
      handle: resolved.handle,
      ctx,
      deps,
    });
    if (!result.ok) {
      logDiffFailure('Session diff pair read failed', { path: rawPath, reason: result.reason, detail: result.detail });
      return NextResponse.json(
        { error: 'Failed to read the diff for this file', reason: result.reason },
        { status: DENIAL_STATUS[result.reason] ?? 500 },
      );
    }
    if (result.notApplicable) return NextResponse.json({ notApplicable: true });
    if (result.original === null && result.modified === null) {
      return NextResponse.json({ error: 'File not found in this diff scope' }, { status: 404 });
    }
    return NextResponse.json({
      notApplicable: false,
      scope,
      path: rawPath,
      original: result.original,
      modified: result.modified,
    });
  }

  const result = await listMachineDiffFiles({
    branchName: branchName.value,
    isMainBranch,
    scope,
    cwd: repoRoot,
    ctx,
    deps,
  });
  if (!result.ok) {
    logDiffFailure('Session diff list failed', { reason: result.reason, detail: result.detail });
    return NextResponse.json(
      { error: 'Failed to compute the changed-file list', reason: result.reason },
      { status: DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  if (result.notApplicable) return NextResponse.json({ notApplicable: true });
  return NextResponse.json({
    notApplicable: false,
    scope,
    files: result.files,
    truncated: result.truncated,
    mergeBase: result.mergeBase,
  });
}
