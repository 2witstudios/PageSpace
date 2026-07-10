/**
 * Machine Files API — the Machine page's surface onto a branch checkout's
 * WORKING TREE (Machine page rebuild, Phase 1 — file browsing).
 *
 * GET ?machineId=&projectName=&branchName=[&path=][&mode=list|read]
 *   mode=list (default) → { entries: [{ name, type }] } for the directory `path`
 *   mode=read           → { content, encoding, truncated } for the file `path`
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
    return NextResponse.json(
      { error: `Branch machine ${resolved.reason}`, reason: resolved.reason },
      { status: resolved.reason === 'not_found' ? 404 : 503 },
    );
  }

  if (mode === 'read') {
    const result = await readMachineFile({ handle: resolved.handle, path });
    if (!result.ok) {
      return NextResponse.json({ error: 'File not found', reason: result.reason }, { status: 404 });
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
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: LIST_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  return NextResponse.json({ entries: result.entries });
}
