/**
 * Machine Git Blob API — the Diff tab's surface onto ONE file's content as it
 * existed at a git ref, read from the branch checkout's git OBJECT STORE (not
 * the working tree — that's `/api/machines/files`; see `machine-git-blob.ts`'s
 * scope-boundary note for why these stay separate primitives).
 *
 * GET ?machineId=&projectName=&branchName=&ref=&path=
 *   → { content, truncated }
 *
 * FAILURES are `{ error, reason }` — `reason` is the machine-readable token
 * clients switch on; `error` is a sentence fit to show a human, NEVER git's
 * stderr (which names absolute paths inside the Sprite). The stderr goes to
 * the server log. Same `error`/`reason` split as the Files route, but stricter
 * on the stderr: `detail` is only ever logged here, never returned.
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
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { readMachineGitBlob } from '@pagespace/lib/services/sandbox/machine-git-blob';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import {
  canViewMachine,
  resolveBranchMachineHandle,
  resolveMachineActorContext,
  buildGitBlobActorContext,
  buildGitBlobDepsForHandle,
} from '@/lib/machines/machine-git-blob-runtime';

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

// `error` is user-facing (clients render it straight into the UI), so it is a
// sentence per reason token — never the token itself and never git's stderr,
// which names absolute paths inside the Sprite (that goes to the server log).
const DENIAL_MESSAGE: Record<string, string> = {
  invalid_ref: 'That git reference is not valid',
  not_found: 'File not found at this ref',
  exec_failed: 'Failed to read the file at this ref',
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
    const status = DENIAL_STATUS[result.reason] ?? 500;
    // A 5xx is an operational failure and is ALWAYS logged — even when git died
    // with empty stderr, the meta is what makes the 502 diagnosable. An expected
    // miss (400/404) is logged only when it carries stderr detail, at warn so it
    // never pages anyone. Level follows the response status, the same >=500
    // convention as logger-config's logResponse.
    if (status >= 500 || result.detail !== undefined) {
      const meta = {
        machineId: machineId.value,
        projectName: projectName.value,
        branchName: branchName.value,
        ref: ref.value,
        path: path.value,
        reason: result.reason,
        detail: result.detail,
      };
      if (status >= 500) {
        loggers.api.error('Machine git-blob read failed', undefined, meta);
      } else {
        loggers.api.warn('Machine git-blob read failed', meta);
      }
    }
    return NextResponse.json(
      { error: DENIAL_MESSAGE[result.reason] ?? 'Failed to read the file at this ref', reason: result.reason },
      { status },
    );
  }
  return NextResponse.json({ content: result.content, truncated: result.truncated });
}
