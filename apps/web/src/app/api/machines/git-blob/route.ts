/**
 * Machine Git Blob API — the Diff tab's surface onto ONE file's content as it
 * existed at a git ref, read from the branch checkout's git OBJECT STORE (not
 * the working tree — that's `/api/machines/files`; see `machine-git-blob.ts`'s
 * scope-boundary note for why these stay separate primitives).
 *
 * GET ?machineId=&projectName=&branchName=&ref=&path=
 *   → { content, truncated }
 *
 * `ref` is a resolved commit-ish (a branch, tag, SHA, or a merge-base the
 * caller already computed — see `sandbox-git-tools.ts`'s `gitDiff` three-dot
 * `base...head` composition for how a caller derives one); this route does not
 * itself resolve merge-bases or compound ref expressions, it only reads `path`
 * as of the given `ref`. `path` is resolved INSIDE `ref`'s own git tree, not
 * the host filesystem, so a `..` or absolute `path` cannot escape onto disk —
 * it only ever misses (404). The Diff tab's 'Uncommitted' scope does NOT call
 * this route for its modified side — that side is the working tree, served by
 * `/api/machines/files` instead.
 *
 * Session-only (no MCP/agent tokens) — a human/UI browsing surface, so this
 * does NOT route through the AI agent tool orchestration (billing holds,
 * injection screening) — same convention as the Files/Settings routes.
 */

import { NextResponse } from 'next/server';
import { readMachineGitBlob } from '@pagespace/lib/services/sandbox/machine-git-blob';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import {
  canViewMachine,
  resolveBranchMachineHandle,
  resolveMachineActorContext,
  buildGitBlobActorContext,
  buildGitBlobDepsForHandle,
} from '@/lib/machines/machine-git-blob-runtime';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

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

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireString(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = requireString(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireString(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  // Authorize BEFORE parsing ref/path, so a user without view access gets a
  // uniform 403 and can never probe ref/path handling.
  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const ref = requireString(url.searchParams.get('ref'), 'ref');
  if (!ref.ok) return ref.error;
  const path = requireString(url.searchParams.get('path'), 'path');
  if (!path.ok) return path.error;

  const resolved = await resolveBranchMachineHandle({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
  });
  if (!resolved.ok) {
    return NextResponse.json(
      { error: `Branch machine ${resolved.reason}`, reason: resolved.reason },
      { status: resolved.reason === 'not_found' ? 404 : 503 },
    );
  }

  const actor = await resolveMachineActorContext(auth.userId);
  const scopeKey = `${machineId.value}:${projectName.value}:${branchName.value}:git-blob`;
  const ctx = buildGitBlobActorContext(scopeKey, actor);
  const deps = buildGitBlobDepsForHandle(resolved.handle);

  const result = await readMachineGitBlob({
    ref: ref.value,
    path: path.value,
    cwd: BRANCH_REPO_PATH,
    ctx,
    deps,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  return NextResponse.json({ content: result.content, truncated: result.truncated });
}
