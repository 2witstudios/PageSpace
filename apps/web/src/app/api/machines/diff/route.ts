/**
 * Machine Diff API — the Diff tab's 3-way scope surface (Machine page
 * rebuild, Phase 1). Composes the two merged read primitives (working-tree
 * `/api/machines/files`, git-object `/api/machines/git-blob`) behind one
 * scope-aware endpoint; all scope semantics live in the PURE
 * `machine-diff-scope.ts` and are executed by the DI'd `machine-diff.ts`.
 *
 * GET ?machineId=&projectName=&branchName=&scope=uncommitted|committed|branch
 *   → { notApplicable: false, scope, files: [{ path, status, previousPath? }],
 *       truncated, mergeBase }
 *     the changed-file list for the scope; `mergeBase` (committed/branch
 *     scopes) is the concrete SHA a client may pass as `ref` to
 *     `/api/machines/git-blob` for 'original' sides.
 *
 * GET …&path=<repo-relative file>[&previousPath=<source>][&status=<list status>]
 *   → { notApplicable: false, scope, path, original, modified }
 *     ONE file's diff pair, each side read from the scope's source
 *     (merge-base blob / HEAD blob / working tree); a side is null when the
 *     file does not exist there (added file's original, deleted file's
 *     modified). For a RENAMED file the client passes `previousPath` (the
 *     rename source from the list entry) so the 'original' side is read from
 *     the pre-rename location instead of resolving to null and mis-showing the
 *     rename as an add. The client also passes `status` (the file's list
 *     status) so a deletion's modified side is forced null rather than reading
 *     an untracked file masquerading at the same path (e.g. `git rm --cached`).
 *
 * On the main branch ('master'/'main' — the literal default-branch names,
 * there is no schema flag), the 'committed' and 'branch' scopes are
 * meaningless (a merge-base with itself), so both forms return
 * `{ notApplicable: true }` as an EXPLICIT 200 — not empty data, not a 4xx —
 * so the client renders a disabled scope toggle without inferring anything.
 * That answer needs no sandbox, so it is returned before the machine handle
 * is even resolved — it works while the machine is off.
 *
 * Session-only (no MCP/agent tokens) — a human/UI browsing surface; the git
 * calls go through `runGitInSandbox`, NOT the AI-tool orchestration — same
 * convention as the Files/Git-Blob routes.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listMachineDiffFiles, readMachineDiffPair } from '@pagespace/lib/services/sandbox/machine-diff';
import {
  isMachineDiffFileStatus,
  isMachineDiffScope,
  isMainBranchName,
  resolveDiffScope,
} from '@pagespace/lib/services/sandbox/machine-diff-scope';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import { resolvePathWithinSync } from '@pagespace/lib/security/path-validator';
import {
  canViewMachine,
  resolveBranchMachineHandle,
  resolveMachineActorContext,
  buildDiffActorContext,
  buildDiffGitDepsForHandle,
} from '@/lib/machines/machine-diff-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

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

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const { searchParams } = new URL(request.url);
  const machineId = requireString(searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = requireString(searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireString(searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  // Authorize BEFORE parsing scope/path, so a user without view access gets a
  // uniform 403 and can never probe scope/path handling.
  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const scope = searchParams.get('scope');
  if (scope === null || !isMachineDiffScope(scope)) {
    return NextResponse.json({ error: "scope must be 'uncommitted', 'committed', or 'branch'" }, { status: 400 });
  }

  // The main-branch answer is pure — no handle, no git — so it comes first
  // and holds even while the machine is stopped.
  const isMainBranch = isMainBranchName(branchName.value);
  if ('notApplicable' in resolveDiffScope(branchName.value, isMainBranch, scope)) {
    return NextResponse.json({ notApplicable: true });
  }

  // `path` selects the per-file pair form; it is untrusted and repo-relative,
  // so confine its working-tree resolution under the checkout root before any
  // filesystem access (blob sides resolve inside a ref's own git tree and
  // cannot escape by construction).
  const rawPath = searchParams.get('path');
  const workingTreePath = rawPath !== null && rawPath.length > 0 ? resolvePathWithinSync(BRANCH_REPO_PATH, rawPath) : null;
  if (rawPath !== null && rawPath.length > 0 && workingTreePath === null) {
    return NextResponse.json({ error: 'path escapes the branch checkout root' }, { status: 400 });
  }

  // `previousPath` (the rename source) addresses ONLY the 'original' blob side
  // via git's `<ref>:<path>` syntax, which resolves inside the ref's own tree
  // and cannot escape onto the host filesystem — so it needs no working-tree
  // confinement (unlike `path`, whose working-tree side is a real fs path).
  const rawPreviousPath = searchParams.get('previousPath');
  const previousPath = rawPreviousPath !== null && rawPreviousPath.length > 0 ? rawPreviousPath : undefined;

  // `status` (the file's status from the changed-file list) lets the pair
  // reader skip a side that can't exist — critically, a 'deleted' file's
  // working-tree modified side, which could otherwise surface an untracked
  // file masquerading at the same path (e.g. after `git rm --cached`). Optional
  // but validated when present so a bad value fails fast rather than silently.
  const rawStatus = searchParams.get('status');
  if (rawStatus !== null && rawStatus.length > 0 && !isMachineDiffFileStatus(rawStatus)) {
    return NextResponse.json(
      { error: "status must be 'added', 'modified', 'deleted', or 'renamed'" },
      { status: 400 },
    );
  }
  const status = rawStatus !== null && isMachineDiffFileStatus(rawStatus) ? rawStatus : undefined;

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
  const scopeKey = `${machineId.value}:${projectName.value}:${branchName.value}:diff`;
  const ctx = buildDiffActorContext(scopeKey, actor);
  const deps = buildDiffGitDepsForHandle(resolved.handle);

  if (rawPath !== null && rawPath.length > 0 && workingTreePath !== null) {
    const result = await readMachineDiffPair({
      branchName: branchName.value,
      isMainBranch,
      scope,
      path: rawPath,
      previousPath,
      status,
      workingTreePath,
      cwd: BRANCH_REPO_PATH,
      handle: resolved.handle,
      ctx,
      deps,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.detail ?? result.reason, reason: result.reason },
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
  if (result.notApplicable) return NextResponse.json({ notApplicable: true });
  return NextResponse.json({
    notApplicable: false,
    scope,
    files: result.files,
    truncated: result.truncated,
    mergeBase: result.mergeBase,
  });
}
