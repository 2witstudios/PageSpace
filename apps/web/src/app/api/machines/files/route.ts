/**
 * Machine Files API — the Machine page's surface onto a branch checkout's
 * WORKING TREE (Machine page rebuild, Phase 1 — file browsing).
 *
 * GET ?machineId=&projectName=&branchName=[&path=][&mode=list|read]
 *   mode=list (default) → { entries: [{ name, type }] } for the directory `path`
 *   mode=read           → { content, encoding, truncated } for the file `path`
 *
 * FAILURES are `{ error, reason, detail? }`. `reason` is the machine-readable
 * fact and is what clients switch on; `error` is a sentence fit to show a human,
 * NEVER an internal token and never our own stderr (which names absolute paths
 * inside the Sprite) — that goes in `detail`, for logs and developers. The
 * reasons are disjoint on purpose:
 *   not_found      (404) — this branch has no checkout (no row, or never cloned)
 *   vanished       (503) — the branch's Sprite is gone
 *   dir_not_found  (404) — the checkout is there; that one directory is not
 *   file_not_found (404) — the checkout is there; that one file is not
 *   exec_failed    (502) — the exec itself failed; see `detail`
 * "no checkout", "no such directory" and "no such file" are THREE different
 * facts. A client that conflates them tells the reader a file vanished when in
 * truth the whole branch did — so each gets its own token.
 *
 * `path` is RELATIVE to the branch checkout root (`/workspace/repo`) and is
 * confined under it before the machine filesystem is touched — an absolute path
 * or a `..` escape is rejected (400), so a viewer cannot read `/etc/passwd` or
 * step out of the checkout. It defaults to the checkout root for a listing and
 * is REQUIRED for a read. Reads the live filesystem only — no git ref (that is
 * a separate git-object service). Session-only (no MCP/agent tokens) — this is
 * a human/UI surface, so it does NOT route through the AI agent tool
 * orchestration; every request re-checks view access for the Machine page,
 * same as the Branches/Agent-Terminals APIs.
 */

import { StringDecoder } from 'string_decoder';
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listMachineDirectory, readMachineFile } from '@pagespace/lib/services/sandbox/machine-fs';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import { resolvePathWithinSync } from '@pagespace/lib/security/path-validator';
import { canViewMachine, resolveBranchMachineHandle } from '@/lib/machines/machine-files-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

/** A single file read is capped so a large blob can't flood the response. */
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

const LIST_DENIAL_STATUS: Record<string, number> = {
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

  // Authorize BEFORE parsing optional params, so a user without view access gets
  // a uniform 403 and can never probe path/mode handling.
  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const mode = url.searchParams.get('mode') ?? 'list';
  if (mode !== 'list' && mode !== 'read') {
    return NextResponse.json({ error: "mode must be 'list' or 'read'" }, { status: 400 });
  }

  const rawPath = url.searchParams.get('path');
  if (mode === 'read' && (rawPath === null || rawPath.length === 0)) {
    return NextResponse.json({ error: 'path is required when mode=read' }, { status: 400 });
  }

  // `path` is untrusted and RELATIVE to the checkout root; confine it under
  // BRANCH_REPO_PATH before any filesystem access. An empty path lists the root
  // itself; an absolute path or a `..` escape resolves to null → 400. Absolute
  // path passed to the filesystem is the confined result, never the raw input.
  const relativePath = rawPath !== null && rawPath.length > 0 ? rawPath : '';
  const path = resolvePathWithinSync(BRANCH_REPO_PATH, relativePath);
  if (path === null) {
    return NextResponse.json({ error: 'path escapes the branch checkout root' }, { status: 400 });
  }

  const resolved = await resolveBranchMachineHandle({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
  });
  if (!resolved.ok) {
    // `error` is user-facing: clients switch on `reason`, and at least one (the
    // Code tab's file tree) renders `error` straight into the UI — so it must
    // never be the internal token. "Branch machine vanished" is a sentence about
    // our internals, not about anything the reader did or can act on.
    return NextResponse.json(
      { error: 'This branch checkout is unavailable', reason: resolved.reason },
      { status: resolved.reason === 'not_found' ? 404 : 503 },
    );
  }

  if (mode === 'read') {
    const result = await readMachineFile({ handle: resolved.handle, path });
    if (!result.ok) {
      // Deliberately NOT `not_found`: that reason already means "this branch has
      // no checkout" (above), and a client that cannot tell the two apart shows
      // "this file is gone" when the whole checkout is gone. Distinct token,
      // distinct fact.
      return NextResponse.json({ error: 'File not found', reason: 'file_not_found' }, { status: 404 });
    }
    const truncated = result.content.length > MAX_FILE_READ_BYTES;
    const bytes = truncated ? result.content.subarray(0, MAX_FILE_READ_BYTES) : result.content;
    // Decode via StringDecoder so a cap landing mid-codepoint drops the trailing
    // partial byte(s) instead of emitting U+FFFD; decoding only the capped slice
    // (not the whole buffer) also bounds the work for a large file.
    const content = new StringDecoder('utf8').write(bytes);
    return NextResponse.json({ content, encoding: 'utf8', truncated });
  }

  const result = await listMachineDirectory({ handle: resolved.handle, path });
  if (!result.ok) {
    // A missing directory means two different things depending on WHICH directory
    // is missing, and a bare `not_found` cannot tell a client which:
    //   the checkout ROOT is missing → this branch was never cloned
    //   a subdirectory is missing    → the checkout is fine; that folder is gone
    //                                  (an agent terminal deleted it a moment ago)
    // The root keeps `not_found`, so it reads as "not checked out yet" alongside
    // the resolve failure above; a subdirectory gets its own token.
    if (result.reason === 'not_found') {
      return NextResponse.json(
        relativePath === ''
          ? { error: 'This branch checkout is unavailable', reason: 'not_found' }
          : { error: 'This folder is no longer in the checkout', reason: 'dir_not_found' },
        { status: 404 },
      );
    }
    // The exec's stderr has real diagnostic value, but it is OUR stderr: it names
    // absolute paths inside the Sprite ("ls: cannot access '/workspace/repo/…'").
    // It belongs in `detail`, for logs and developers — never in `error`, which
    // clients render straight at a person.
    return NextResponse.json(
      { error: 'Failed to list the checkout directory', reason: result.reason, detail: result.detail },
      { status: LIST_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  return NextResponse.json({ entries: result.entries });
}
