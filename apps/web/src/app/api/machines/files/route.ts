/**
 * Machine Files API — the Machine page's surface onto a WORKING TREE: either a
 * branch checkout, or (when `projectName`/`branchName` are absent) the root
 * Machine's own persistent Sprite (Machine page rebuild, Phase 1 — file
 * browsing; root scope added for the Machine Files Manager epic; Phase 2 adds
 * mutating verbs — create/upload, move/copy, delete, download).
 *
 * GET    ?machineId=[&projectName=&branchName=][&path=][&mode=list|read|download]
 *   projectName/branchName BOTH present → branch scope (a branch checkout)
 *   projectName/branchName BOTH absent  → root scope (the Machine's own tree)
 *   exactly one present                 → 400 (they are a pair)
 *   mode=list (default) → { entries: [{ name, type }] } for the directory `path`
 *   mode=read           → { content, encoding, truncated } for the file `path`
 *   mode=download       → raw bytes, `Content-Disposition: attachment`, for the file `path`
 *
 * POST   { machineId, projectName?, branchName?, path, kind: 'directory' }
 *        { machineId, projectName?, branchName?, path, kind: 'file', content?, encoding?, overwrite? }
 *   Creates a directory, or creates/overwrites a file (overwrite IS allowed by
 *   default — this is also how "save" works). `overwrite: false` switches the
 *   file arm to CREATE semantics: an existing entry at `path` is a 409, never
 *   a silent truncation (the "New File" flow). `path` may not resolve to the
 *   scope root.
 *
 * PATCH  { machineId, projectName?, branchName?, op: 'move' | 'copy', fromPath, toPath }
 *   Moves or copies a path within the same scope. Neither `fromPath` nor
 *   `toPath` may be `''` (the scope root is never itself the operand).
 *
 * DELETE { machineId, projectName?, branchName?, path }
 *   Removes a path, recursively and idempotently (a missing target is
 *   success). `path` may not be `''` (the scope root is never deleted).
 *
 * Every mutating verb requires edit access (`canEditMachine`), CSRF, and is
 * audited on success (`auditRequest` with `eventType: 'data.write'`). GET
 * (including `mode=download`) requires only view access — it is a read.
 *
 * FAILURES are `{ error, reason, detail? }`. `reason` is the machine-readable
 * fact and is what clients switch on; `error` is a sentence fit to show a human,
 * NEVER an internal token and never our own stderr (which names absolute paths
 * inside the Sprite) — that goes in `detail`, for logs and developers. The
 * reasons are disjoint on purpose:
 *   not_found      (404) — no checkout (branch: no row, or never cloned), or
 *                          (mutations) the item being moved/copied/created-under is gone
 *   not_started    (404) — root scope only: the Machine has no live session
 *   vanished       (503) — the resolved Sprite is gone
 *   dir_not_found  (404) — the tree is there; that one directory is not
 *   file_not_found (404) — the tree is there; that one file is not
 *   already_exists (409) — the mutation's destination already has something there
 *   too_large      (413) — uploaded/downloaded content exceeds the size cap
 *   exec_failed    (502) — the exec itself failed; see `detail`
 * "no checkout", "no such directory" and "no such file" are different facts. A
 * client that conflates them tells the reader a file vanished when in truth
 * the whole branch did — so each gets its own token.
 *
 * `path`/`fromPath`/`toPath` are RELATIVE to the scope's root — the branch
 * checkout root (`/workspace/repo`) for branch scope, `/workspace`
 * (`SANDBOX_ROOT`) for root scope — and each is individually confined under it
 * before the machine filesystem is touched — an absolute path or a `..` escape
 * is rejected (400), so a caller cannot read/write `/etc/passwd` or step out of
 * the tree. Root scope confines via `resolvePathWithinSync(SANDBOX_ROOT, …)`
 * directly rather than `resolveSandboxPath` — the latter's
 * `/workspace`-prefix-stripping leniency is an agent-tool affordance that has
 * no place here and would break symmetry with the branch arm. `path` defaults
 * to the scope root for a listing and is REQUIRED for a read/download/mutation.
 * Confined absolute paths are what reach the `machine-fs` primitives — NEVER
 * re-derived from the raw input once confined (PR #2039 TOCTOU lesson).
 *
 * Confinement is TWO passes because string confinement alone cannot see the
 * Sprite's symlinks: after the handle resolves, every non-root path is
 * re-resolved ON the machine (`verifyMachinePathsWithinScope`, `realpath -m`)
 * and rejected (400) if following links lands it outside the scope root — an
 * in-scope symlink pointing at `/etc` cannot be used to read or write there.
 *
 * Operates on the live filesystem only — no git ref (that is a separate
 * git-object service). Session-only (no MCP/agent tokens) — this is a
 * human/UI surface, so it does NOT route through the AI agent tool
 * orchestration; every request re-checks access for the Machine page, same as
 * the Branches/Agent-Terminals APIs.
 */

import { basename } from 'node:path';
import { StringDecoder } from 'string_decoder';
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
import {
  listMachineDirectory,
  readMachineFile,
  createMachineDirectory,
  writeMachineFile,
  moveMachinePath,
  copyMachinePath,
  deleteMachinePath,
  verifyMachinePathsWithinScope,
  type MutateMachinePathResult,
} from '@pagespace/lib/services/sandbox/machine-fs';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { resolvePathWithinSync } from '@pagespace/lib/security/path-validator';
import type { MachineHandle } from '@pagespace/lib/services/sandbox/machine-host';
import { canViewMachine, canEditMachine, resolveMachineFilesHandle } from '@/lib/machines/machine-files-runtime';
import type { MachineFilesScope } from '@/lib/machines/machine-files-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const RESOURCE_TYPE = 'machine';

/** A single file read/download is capped so a large blob can't flood the response. */
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * Request-body ceiling for the mutating verbs, checked against Content-Length
 * BEFORE `request.json()` buffers anything: base64 inflates the 10 MiB content
 * cap by 4/3, plus slack for the JSON envelope. An oversized declared body is
 * rejected without ever being read, so it cannot spike memory just to be
 * turned away by the post-decode cap. (A chunked request without
 * Content-Length still falls through to the post-decode cap — the declared-
 * length check is a fast-path bound, not the only line.)
 */
const MAX_MUTATION_REQUEST_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

/** 413 for a declared body size over the ceiling, before any buffering. */
function rejectOversizedBody(request: Request): NextResponse | null {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MUTATION_REQUEST_BYTES) {
    return NextResponse.json({ error: 'File is too large to upload', reason: 'too_large' }, { status: 413 });
  }
  return null;
}

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): { ok: true; value: T } | { ok: false; error: NextResponse } {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    error: NextResponse.json(
      { error: `${field} must be ${allowed.map((a) => `'${a}'`).join(' or ')}` },
      { status: 400 },
    ),
  };
}

/** `request.json()` resolves (not throws) for a body like `null` or `42` — guard so that's a 400, not a 500. */
async function parseJsonBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/** `null`/`''`/non-string all normalize to absent — mirrors the search-param handling below. */
function normalizeScopePart(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * projectName/branchName are a pair: both present → branch scope, both absent
 * → root scope. Shared by every verb so query-param (GET) and JSON-body
 * (POST/PATCH/DELETE) callers get identical pairing semantics.
 */
function buildScope(
  machineId: string,
  rawProjectName: unknown,
  rawBranchName: unknown,
): { ok: true; scope: MachineFilesScope } | { ok: false; error: NextResponse } {
  const projectName = normalizeScopePart(rawProjectName);
  const branchName = normalizeScopePart(rawBranchName);
  if ((projectName === null) !== (branchName === null)) {
    return {
      ok: false,
      error: NextResponse.json({ error: 'projectName and branchName must be provided together' }, { status: 400 }),
    };
  }
  const scope: MachineFilesScope =
    projectName !== null && branchName !== null
      ? { scope: 'branch', machineId, projectName, branchName }
      : { scope: 'root', machineId };
  return { ok: true, scope };
}

function scopeRoot(scope: MachineFilesScope): string {
  return scope.scope === 'branch' ? BRANCH_REPO_PATH : SANDBOX_ROOT;
}

/**
 * Confines one relative path field under the scope root. Returns the confined
 * absolute path, or a 400 response naming `field`.
 *
 * `forbidRoot` (every mutating verb): reject when the CONFINED result is the
 * scope root itself. The raw-input non-empty check alone cannot guarantee this
 * — `resolvePathWithinSync` strips NUL bytes, so a NUL-only `path` (or
 * anything else that sanitizes to empty) is non-empty on the wire yet resolves
 * to the scope root, which would let a DELETE reach `rm -rf` on `/workspace`
 * itself. The refusal must live at the confined level, not the raw level.
 */
function confineScopedPath(
  scope: MachineFilesScope,
  relativePath: string,
  field: string,
  options?: { forbidRoot?: boolean },
): { ok: true; value: string } | { ok: false; error: NextResponse } {
  const confined = resolvePathWithinSync(scopeRoot(scope), relativePath);
  if (confined === null) {
    return { ok: false, error: NextResponse.json({ error: `${field} escapes the machine filesystem root` }, { status: 400 }) };
  }
  if (options?.forbidRoot && confined === scopeRoot(scope)) {
    return { ok: false, error: NextResponse.json({ error: `${field} must not be the scope root` }, { status: 400 }) };
  }
  return { ok: true, value: confined };
}

/**
 * Second confinement pass, ON the machine: string confinement above cannot see
 * the Sprite's symlinks, so `/workspace/link/x` with `link → /etc` passes it
 * and every later fs op on the machine would follow the link out of scope.
 * `verifyMachinePathsWithinScope` re-resolves each path with the machine's own
 * `realpath` and rejects any that escape once links are followed. Returns null
 * when every path is in scope, else the response to send. `checks` pairs each
 * confined absolute path with the request field it came from so the 400 names
 * the offending field, same as the string-confinement 400s.
 */
async function requireMachinePathsWithinScope(
  handle: MachineHandle,
  scope: MachineFilesScope,
  checks: ReadonlyArray<{ field: string; path: string }>,
): Promise<NextResponse | null> {
  // The scope root itself has no intermediate components to traverse — nothing
  // a symlink could hijack — so a bare root listing skips the extra exec.
  const toCheck = checks.filter((c) => c.path !== scopeRoot(scope));
  if (toCheck.length === 0) return null;
  const result = await verifyMachinePathsWithinScope({
    handle,
    // SANDBOX_ROOT is the outermost trust boundary regardless of scope: a
    // branch checkout root replaced by a symlink out of /workspace must reject
    // as a whole, not re-anchor containment at the link's target.
    boundaryRoot: SANDBOX_ROOT,
    scopeRoot: scopeRoot(scope),
    paths: toCheck.map((c) => c.path),
  });
  if (result.ok) return null;
  if (result.reason === 'escapes') {
    // index -1 = the scope root itself escaped the boundary; there is no single
    // offending field to name.
    const label = result.index === -1 ? 'path' : toCheck[result.index].field;
    return NextResponse.json(
      { error: `${label} escapes the machine filesystem root` },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { error: 'Failed to complete the operation on the machine', reason: 'exec_failed', detail: result.detail },
    { status: 502 },
  );
}

const RESOLVE_DENIAL_STATUS: Record<'not_found' | 'vanished' | 'not_started', number> = {
  not_found: 404,
  vanished: 503,
  not_started: 404,
};

/**
 * `error` is user-facing: clients switch on `reason`, and at least one (the
 * Code tab's file tree) renders `error` straight into the UI — so it must
 * never be the internal token. "Branch machine vanished" is a sentence about
 * our internals, not about anything the reader did or can act on.
 */
function resolveDenialResponse(reason: 'not_found' | 'vanished' | 'not_started'): NextResponse {
  const error = reason === 'not_started' ? "This machine hasn't been started yet" : 'This branch checkout is unavailable';
  return NextResponse.json({ error, reason }, { status: RESOLVE_DENIAL_STATUS[reason] });
}

/**
 * Maps a `MutateMachinePathResult` failure to a response. `notFoundMessage` is
 * op-specific ("the parent folder" vs "the item to move") because a bare
 * `not_found` here can mean either "the destination's parent is missing" or
 * "the source doesn't exist" depending on the verb.
 */
function mutateFailureResponse(result: Extract<MutateMachinePathResult, { ok: false }>, notFoundMessage: string): NextResponse {
  if (result.reason === 'already_exists') {
    return NextResponse.json({ error: 'Something already has that name', reason: 'already_exists' }, { status: 409 });
  }
  if (result.reason === 'not_found') {
    return NextResponse.json({ error: notFoundMessage, reason: 'not_found' }, { status: 404 });
  }
  // The exec's stderr has real diagnostic value, but it is OUR stderr: it names
  // absolute paths inside the Sprite. It belongs in `detail`, for logs and
  // developers — never in `error`, which clients render straight at a person.
  return NextResponse.json(
    { error: 'Failed to complete the operation on the machine', reason: 'exec_failed', detail: result.detail },
    { status: 502 },
  );
}

function auditWrite(request: Request, userId: string, machineId: string, details: Record<string, unknown>): void {
  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: RESOURCE_TYPE,
    resourceId: machineId,
    details,
  });
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Node's `Buffer.from(str, 'base64')` is lenient — it silently drops invalid
 * characters rather than throwing, so a malformed upload must be rejected
 * before decoding, not caught after.
 */
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

function decodeFileContent(
  rawContent: unknown,
  rawEncoding: unknown,
): { ok: true; content: Buffer } | { ok: false; error: NextResponse } {
  if (rawContent !== undefined && typeof rawContent !== 'string') {
    return { ok: false, error: NextResponse.json({ error: 'content must be a string' }, { status: 400 }) };
  }
  if (rawEncoding !== undefined && rawEncoding !== 'utf8' && rawEncoding !== 'base64') {
    return { ok: false, error: NextResponse.json({ error: "encoding must be 'utf8' or 'base64'" }, { status: 400 }) };
  }
  const content = rawContent ?? '';
  const encoding = rawEncoding ?? 'utf8';
  if (encoding === 'base64') {
    if (!isValidBase64(content)) {
      return { ok: false, error: NextResponse.json({ error: 'content is not valid base64' }, { status: 400 }) };
    }
    return { ok: true, content: Buffer.from(content, 'base64') };
  }
  return { ok: true, content: Buffer.from(content, 'utf8') };
}

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireString(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;

  // Authorize BEFORE parsing optional params, so a user without view access gets
  // a uniform 403 and can never probe path/mode/scope handling.
  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const scopeResult = buildScope(machineId.value, url.searchParams.get('projectName'), url.searchParams.get('branchName'));
  if (!scopeResult.ok) return scopeResult.error;
  const scope = scopeResult.scope;

  const mode = url.searchParams.get('mode') ?? 'list';
  if (mode !== 'list' && mode !== 'read' && mode !== 'download') {
    return NextResponse.json({ error: "mode must be 'list', 'read', or 'download'" }, { status: 400 });
  }

  const rawPath = url.searchParams.get('path');
  if ((mode === 'read' || mode === 'download') && (rawPath === null || rawPath.length === 0)) {
    return NextResponse.json({ error: `path is required when mode=${mode}` }, { status: 400 });
  }

  // `path` is untrusted and RELATIVE to the scope's root; confine it before any
  // filesystem access. An empty path lists the root itself; an absolute path or
  // a `..` escape resolves to null → 400. Absolute path passed to the
  // filesystem is the confined result, never the raw input.
  const relativePath = rawPath !== null && rawPath.length > 0 ? rawPath : '';
  const confined = confineScopedPath(scope, relativePath, 'path');
  if (!confined.ok) return confined.error;
  const path = confined.value;

  const resolved = await resolveMachineFilesHandle(scope);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireMachinePathsWithinScope(resolved.handle, scope, [{ field: 'path', path }]);
  if (escape) return escape;

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

  if (mode === 'download') {
    const result = await readMachineFile({ handle: resolved.handle, path });
    if (!result.ok) {
      return NextResponse.json({ error: 'File not found', reason: 'file_not_found' }, { status: 404 });
    }
    if (result.content.length > MAX_DOWNLOAD_BYTES) {
      return NextResponse.json({ error: 'File is too large to download', reason: 'too_large' }, { status: 413 });
    }
    // Basename only (strip directories), then strip quotes/control chars via the
    // shared header sanitizer; the ASCII fallback feeds `filename=`, the
    // sanitized-but-unicode-preserved name feeds RFC 5987 `filename*`.
    const safeName = sanitizeFilenameForHeader(basename(path));
    const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_');
    const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
    return new NextResponse(new Uint8Array(result.content), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': disposition,
        'Content-Length': String(result.content.length),
      },
    });
  }

  const result = await listMachineDirectory({ handle: resolved.handle, path });
  if (!result.ok) {
    // A missing directory means two different things depending on WHICH directory
    // is missing, and a bare `not_found` cannot tell a client which:
    //   the checkout ROOT is missing → this branch was never cloned
    //   a subdirectory is missing    → the checkout is fine; that folder is gone
    //                                  (an agent terminal deleted it a moment ago)
    // The root keeps `not_found`, so it reads as "not checked out yet" alongside
    // the resolve failure above; a subdirectory gets its own token. This split is
    // a BRANCH fact only — a live Sprite's `/workspace` is driver-guaranteed, so
    // in root scope every missing directory (root path included) is just a gone
    // folder, never "never checked out".
    if (result.reason === 'not_found') {
      if (scope.scope === 'branch' && relativePath === '') {
        return NextResponse.json({ error: 'This branch checkout is unavailable', reason: 'not_found' }, { status: 404 });
      }
      const error = scope.scope === 'root' ? 'This folder is no longer on the machine' : 'This folder is no longer in the checkout';
      return NextResponse.json({ error, reason: 'dir_not_found' }, { status: 404 });
    }
    // The exec's stderr has real diagnostic value, but it is OUR stderr: it names
    // absolute paths inside the Sprite ("ls: cannot access '/workspace/repo/…'").
    // It belongs in `detail`, for logs and developers — never in `error`, which
    // clients render straight at a person.
    return NextResponse.json(
      { error: 'Failed to list the checkout directory', reason: result.reason, detail: result.detail },
      { status: result.reason === 'exec_failed' ? 502 : 500 },
    );
  }
  return NextResponse.json({ entries: result.entries });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const machineId = requireString(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;

  // Authorize BEFORE validating field shapes so an unauthorized caller can't
  // distinguish a well-formed request (would-be success) from a malformed one
  // (400) — same invariant as the settings route.
  if (!(await canEditMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have edit access to this machine' }, { status: 403 });
  }

  const scopeResult = buildScope(machineId.value, body.projectName, body.branchName);
  if (!scopeResult.ok) return scopeResult.error;
  const scope = scopeResult.scope;

  // `forbidRoot`, not just `requireString`: a NUL-only (or otherwise
  // sanitized-to-empty) path is non-empty on the wire yet confines to the
  // scope root — the root can never itself be the thing being created.
  const rawPath = requireString(body.path, 'path');
  if (!rawPath.ok) return rawPath.error;
  const confinedPath = confineScopedPath(scope, rawPath.value, 'path', { forbidRoot: true });
  if (!confinedPath.ok) return confinedPath.error;
  const path = confinedPath.value;

  const kind = requireEnum(body.kind, ['directory', 'file'] as const, 'kind');
  if (!kind.ok) return kind.error;

  if (kind.value === 'directory') {
    const resolved = await resolveMachineFilesHandle(scope);
    if (!resolved.ok) return resolveDenialResponse(resolved.reason);
    const escape = await requireMachinePathsWithinScope(resolved.handle, scope, [{ field: 'path', path }]);
    if (escape) return escape;
    const result = await createMachineDirectory({ handle: resolved.handle, path });
    if (!result.ok) return mutateFailureResponse(result, 'The parent folder could not be found');
    auditWrite(request, auth.userId, machineId.value, { op: 'create_directory', path: rawPath.value });
    return NextResponse.json({ ok: true });
  }

  const decoded = decodeFileContent(body.content, body.encoding);
  if (!decoded.ok) return decoded.error;
  if (decoded.content.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File is too large to upload', reason: 'too_large' }, { status: 413 });
  }

  // `overwrite: false` = CREATE semantics (the "New File" flow): an existing
  // entry is a 409, never a silent truncation. Absent/`true` keeps
  // overwrite-is-save semantics for editor saves and uploads.
  if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
    return NextResponse.json({ error: 'overwrite must be a boolean' }, { status: 400 });
  }

  const resolved = await resolveMachineFilesHandle(scope);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);
  const escape = await requireMachinePathsWithinScope(resolved.handle, scope, [{ field: 'path', path }]);
  if (escape) return escape;
  const result = await writeMachineFile({
    handle: resolved.handle,
    path,
    content: decoded.content,
    noClobber: body.overwrite === false,
  });
  if (!result.ok) return mutateFailureResponse(result, 'The parent folder could not be found');
  auditWrite(request, auth.userId, machineId.value, { op: 'write_file', path: rawPath.value });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const machineId = requireString(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;

  if (!(await canEditMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have edit access to this machine' }, { status: 403 });
  }

  const scopeResult = buildScope(machineId.value, body.projectName, body.branchName);
  if (!scopeResult.ok) return scopeResult.error;
  const scope = scopeResult.scope;

  const op = requireEnum(body.op, ['move', 'copy'] as const, 'op');
  if (!op.ok) return op.error;

  // Empty rejected by `requireString` too — the scope root can never itself be
  // an operand of move/copy.
  const rawFromPath = requireString(body.fromPath, 'fromPath');
  if (!rawFromPath.ok) return rawFromPath.error;
  const rawToPath = requireString(body.toPath, 'toPath');
  if (!rawToPath.ok) return rawToPath.error;

  const fromPath = confineScopedPath(scope, rawFromPath.value, 'fromPath', { forbidRoot: true });
  if (!fromPath.ok) return fromPath.error;
  const toPath = confineScopedPath(scope, rawToPath.value, 'toPath', { forbidRoot: true });
  if (!toPath.ok) return toPath.error;

  const resolved = await resolveMachineFilesHandle(scope);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireMachinePathsWithinScope(resolved.handle, scope, [
    { field: 'fromPath', path: fromPath.value },
    { field: 'toPath', path: toPath.value },
  ]);
  if (escape) return escape;

  const notFoundMessage = `The item to ${op.value} could not be found`;
  const result =
    op.value === 'move'
      ? await moveMachinePath({ handle: resolved.handle, fromPath: fromPath.value, toPath: toPath.value })
      : await copyMachinePath({ handle: resolved.handle, fromPath: fromPath.value, toPath: toPath.value });
  if (!result.ok) return mutateFailureResponse(result, notFoundMessage);

  auditWrite(request, auth.userId, machineId.value, { op: op.value, fromPath: rawFromPath.value, toPath: rawToPath.value });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const machineId = requireString(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;

  if (!(await canEditMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have edit access to this machine' }, { status: 403 });
  }

  const scopeResult = buildScope(machineId.value, body.projectName, body.branchName);
  if (!scopeResult.ok) return scopeResult.error;
  const scope = scopeResult.scope;

  // `forbidRoot`, not just `requireString`: a NUL-only path is non-empty on
  // the wire yet confines to the scope root — the scope root is never deleted.
  const rawPath = requireString(body.path, 'path');
  if (!rawPath.ok) return rawPath.error;
  const confinedPath = confineScopedPath(scope, rawPath.value, 'path', { forbidRoot: true });
  if (!confinedPath.ok) return confinedPath.error;
  const path = confinedPath.value;

  const resolved = await resolveMachineFilesHandle(scope);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireMachinePathsWithinScope(resolved.handle, scope, [{ field: 'path', path }]);
  if (escape) return escape;

  const result = await deleteMachinePath({ handle: resolved.handle, path });
  if (!result.ok) return mutateFailureResponse(result, 'The item to delete could not be found');

  auditWrite(request, auth.userId, machineId.value, { op: 'delete', path: rawPath.value });
  return NextResponse.json({ ok: true });
}
