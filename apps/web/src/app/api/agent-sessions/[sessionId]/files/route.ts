/**
 * Session Files API — the session's surface onto its sandbox filesystem. Port
 * of `/api/machines/files` re-scoped from the `(machineId, projectName?,
 * branchName?)` tuple to `[sessionId]` + an optional caller-supplied
 * `repoPath`: a session may hold any number of clones, so the CALLER names the
 * tree it is browsing (relative to the sandbox root); absent, the sandbox root
 * itself is the scope. v1 ships no Files UI — this exists, access-gated, so a
 * later read-only tree is a drop-in client.
 *
 * GET    ?[repoPath=][&path=][&mode=list|read|download]
 * POST   { repoPath?, path, kind: 'directory' | 'file', content?, encoding?, overwrite? }
 * PATCH  { repoPath?, op: 'move' | 'copy', fromPath, toPath }
 * DELETE { repoPath?, path }
 *
 * Same failure contract as the machines route (`{ error, reason, detail? }`,
 * disjoint reasons — see that route's doc for the vocabulary); the resolve
 * reasons differ because a session has no branch: `not_started` (404, no
 * sandbox yet — provisioning is the chat/shell surfaces' job, a browse never
 * mints a VM) and `vanished` (503, recorded Sprite gone).
 *
 * Paths are RELATIVE to the scope root and confined TWICE: string confinement
 * under the scope root (`resolvePathWithinSync`), then on-machine `realpath`
 * re-resolution (`verifyMachinePathsWithinScope`) so an in-scope symlink
 * cannot escape onto `/etc`. `repoPath` itself is confined under the sandbox
 * root first — it is as untrusted as any other path field.
 */

import { basename } from 'node:path';
import { StringDecoder } from 'string_decoder';
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { auditSessionAccessDenial } from '@/lib/agent-sessions/session-unavailable-response';
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
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { resolvePathWithinSync } from '@pagespace/lib/security/path-validator';
import type { SandboxHandle } from '@pagespace/lib/services/sandbox/sandbox-host';
import { checkSessionAccess } from '@/lib/agent-sessions/agent-sessions-runtime';
import { resolveSessionSandboxHandle } from '@/lib/agent-sessions/session-sandbox-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const RESOURCE_TYPE = 'agent_session';

const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_MUTATION_REQUEST_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

type RouteContext = { params: Promise<{ sessionId: string }> };

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

/**
 * The scope root for this request: the sandbox root, or a caller-named tree
 * under it. `repoPath` is untrusted — an escape is a 400, same as any path.
 */
function resolveScopeRoot(rawRepoPath: unknown): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (rawRepoPath === undefined || rawRepoPath === null || rawRepoPath === '') {
    return { ok: true, value: SANDBOX_ROOT };
  }
  if (typeof rawRepoPath !== 'string') {
    return { ok: false, error: NextResponse.json({ error: 'repoPath must be a string' }, { status: 400 }) };
  }
  const confined = resolvePathWithinSync(SANDBOX_ROOT, rawRepoPath);
  if (confined === null) {
    return { ok: false, error: NextResponse.json({ error: 'repoPath escapes the sandbox root' }, { status: 400 }) };
  }
  return { ok: true, value: confined };
}

function confineScopedPath(
  scopeRoot: string,
  relativePath: string,
  field: string,
  options?: { forbidRoot?: boolean },
): { ok: true; value: string } | { ok: false; error: NextResponse } {
  const confined = resolvePathWithinSync(scopeRoot, relativePath);
  if (confined === null) {
    return { ok: false, error: NextResponse.json({ error: `${field} escapes the sandbox root` }, { status: 400 }) };
  }
  if (options?.forbidRoot && confined === scopeRoot) {
    return { ok: false, error: NextResponse.json({ error: `${field} must not be the scope root` }, { status: 400 }) };
  }
  return { ok: true, value: confined };
}

/** Second confinement pass, ON the sandbox — see the machines route's symlink rationale. */
async function requireSandboxPathsWithinScope(
  handle: SandboxHandle,
  scopeRoot: string,
  checks: ReadonlyArray<{ field: string; path: string }>,
): Promise<NextResponse | null> {
  const toCheck = checks.filter((c) => c.path !== scopeRoot);
  if (toCheck.length === 0) return null;
  const result = await verifyMachinePathsWithinScope({
    handle,
    boundaryRoot: SANDBOX_ROOT,
    scopeRoot,
    paths: toCheck.map((c) => c.path),
  });
  if (result.ok) return null;
  if (result.reason === 'escapes') {
    const label = result.index === -1 ? 'path' : toCheck[result.index].field;
    return NextResponse.json({ error: `${label} escapes the sandbox root` }, { status: 400 });
  }
  return NextResponse.json(
    { error: 'Failed to complete the operation on the sandbox', reason: 'exec_failed', detail: result.detail },
    { status: 502 },
  );
}

const RESOLVE_DENIAL_STATUS: Record<'not_found' | 'not_started' | 'vanished', number> = {
  not_found: 404,
  not_started: 404,
  vanished: 503,
};

function resolveDenialResponse(reason: 'not_found' | 'not_started' | 'vanished'): NextResponse {
  const error =
    reason === 'vanished' ? 'This session\'s sandbox is unavailable' : 'This session has no sandbox yet';
  return NextResponse.json({ error, reason }, { status: RESOLVE_DENIAL_STATUS[reason] });
}

const ROUTE = 'agent-sessions/[sessionId]/files';

/**
 * Not found and denied answer THE SAME (family policy, review #2261/5) —
 * both `not_started`, never a 403 that would confirm the session id is real.
 */
async function authorize(
  request: Request,
  userId: string,
  sessionId: string,
): Promise<NextResponse | null> {
  const access = await checkSessionAccess(userId, sessionId);
  if (access.allowed) return null;
  auditSessionAccessDenial(request, userId, sessionId, access.reason, ROUTE);
  return NextResponse.json({ error: 'This session has no sandbox yet', reason: 'not_started' }, { status: 404 });
}

function mutateFailureResponse(result: Extract<MutateMachinePathResult, { ok: false }>, notFoundMessage: string): NextResponse {
  if (result.reason === 'already_exists') {
    return NextResponse.json({ error: 'Something already has that name', reason: 'already_exists' }, { status: 409 });
  }
  if (result.reason === 'not_found') {
    return NextResponse.json({ error: notFoundMessage, reason: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(
    { error: 'Failed to complete the operation on the sandbox', reason: 'exec_failed', detail: result.detail },
    { status: 502 },
  );
}

function auditWrite(request: Request, userId: string, sessionId: string, details: Record<string, unknown>): void {
  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: RESOURCE_TYPE,
    resourceId: sessionId,
    details,
  });
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

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

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  // Authorize BEFORE parsing optional params, so a user without access gets a
  // uniform answer and can never probe path/mode handling.
  const deniedResponse = await authorize(request, auth.userId, sessionId);
  if (deniedResponse) return deniedResponse;

  const url = new URL(request.url);
  const scope = resolveScopeRoot(url.searchParams.get('repoPath'));
  if (!scope.ok) return scope.error;

  const mode = url.searchParams.get('mode') ?? 'list';
  if (mode !== 'list' && mode !== 'read' && mode !== 'download') {
    return NextResponse.json({ error: "mode must be 'list', 'read', or 'download'" }, { status: 400 });
  }

  const rawPath = url.searchParams.get('path');
  if ((mode === 'read' || mode === 'download') && (rawPath === null || rawPath.length === 0)) {
    return NextResponse.json({ error: `path is required when mode=${mode}` }, { status: 400 });
  }

  const relativePath = rawPath !== null && rawPath.length > 0 ? rawPath : '';
  const confined = confineScopedPath(scope.value, relativePath, 'path');
  if (!confined.ok) return confined.error;
  const path = confined.value;

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireSandboxPathsWithinScope(resolved.handle, scope.value, [{ field: 'path', path }]);
  if (escape) return escape;

  if (mode === 'read') {
    const result = await readMachineFile({ handle: resolved.handle, path });
    if (!result.ok) {
      return NextResponse.json({ error: 'File not found', reason: 'file_not_found' }, { status: 404 });
    }
    const truncated = result.content.length > MAX_FILE_READ_BYTES;
    const bytes = truncated ? result.content.subarray(0, MAX_FILE_READ_BYTES) : result.content;
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
    // A live sandbox's root is driver-guaranteed, so every missing directory
    // here is just a gone folder — the branch/checkout split the machines
    // route needed has no session analogue.
    if (result.reason === 'not_found') {
      return NextResponse.json(
        { error: 'This folder is no longer in the sandbox', reason: 'dir_not_found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: 'Failed to list the sandbox directory', reason: result.reason, detail: result.detail },
      { status: result.reason === 'exec_failed' ? 502 : 500 },
    );
  }
  return NextResponse.json({ entries: result.entries });
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const deniedResponse = await authorize(request, auth.userId, sessionId);
  if (deniedResponse) return deniedResponse;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const scope = resolveScopeRoot(body.repoPath);
  if (!scope.ok) return scope.error;

  const rawPath = requireString(body.path, 'path');
  if (!rawPath.ok) return rawPath.error;
  const confinedPath = confineScopedPath(scope.value, rawPath.value, 'path', { forbidRoot: true });
  if (!confinedPath.ok) return confinedPath.error;
  const path = confinedPath.value;

  const kind = requireEnum(body.kind, ['directory', 'file'] as const, 'kind');
  if (!kind.ok) return kind.error;

  if (kind.value === 'directory') {
    const resolved = await resolveSessionSandboxHandle(sessionId);
    if (!resolved.ok) return resolveDenialResponse(resolved.reason);
    const escape = await requireSandboxPathsWithinScope(resolved.handle, scope.value, [{ field: 'path', path }]);
    if (escape) return escape;
    const result = await createMachineDirectory({ handle: resolved.handle, path });
    if (!result.ok) return mutateFailureResponse(result, 'The parent folder could not be found');
    auditWrite(request, auth.userId, sessionId, { op: 'create_directory', path: rawPath.value });
    return NextResponse.json({ ok: true });
  }

  const decoded = decodeFileContent(body.content, body.encoding);
  if (!decoded.ok) return decoded.error;
  if (decoded.content.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File is too large to upload', reason: 'too_large' }, { status: 413 });
  }

  if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
    return NextResponse.json({ error: 'overwrite must be a boolean' }, { status: 400 });
  }

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);
  const escape = await requireSandboxPathsWithinScope(resolved.handle, scope.value, [{ field: 'path', path }]);
  if (escape) return escape;
  const result = await writeMachineFile({
    handle: resolved.handle,
    path,
    content: decoded.content,
    noClobber: body.overwrite === false,
  });
  if (!result.ok) return mutateFailureResponse(result, 'The parent folder could not be found');
  auditWrite(request, auth.userId, sessionId, { op: 'write_file', path: rawPath.value });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const deniedResponse = await authorize(request, auth.userId, sessionId);
  if (deniedResponse) return deniedResponse;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const scope = resolveScopeRoot(body.repoPath);
  if (!scope.ok) return scope.error;

  const op = requireEnum(body.op, ['move', 'copy'] as const, 'op');
  if (!op.ok) return op.error;

  const rawFromPath = requireString(body.fromPath, 'fromPath');
  if (!rawFromPath.ok) return rawFromPath.error;
  const rawToPath = requireString(body.toPath, 'toPath');
  if (!rawToPath.ok) return rawToPath.error;

  const fromPath = confineScopedPath(scope.value, rawFromPath.value, 'fromPath', { forbidRoot: true });
  if (!fromPath.ok) return fromPath.error;
  const toPath = confineScopedPath(scope.value, rawToPath.value, 'toPath', { forbidRoot: true });
  if (!toPath.ok) return toPath.error;

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireSandboxPathsWithinScope(resolved.handle, scope.value, [
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

  auditWrite(request, auth.userId, sessionId, { op: op.value, fromPath: rawFromPath.value, toPath: rawToPath.value });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const deniedResponse = await authorize(request, auth.userId, sessionId);
  if (deniedResponse) return deniedResponse;

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.value;

  const scope = resolveScopeRoot(body.repoPath);
  if (!scope.ok) return scope.error;

  const rawPath = requireString(body.path, 'path');
  if (!rawPath.ok) return rawPath.error;
  const confinedPath = confineScopedPath(scope.value, rawPath.value, 'path', { forbidRoot: true });
  if (!confinedPath.ok) return confinedPath.error;
  const path = confinedPath.value;

  const resolved = await resolveSessionSandboxHandle(sessionId);
  if (!resolved.ok) return resolveDenialResponse(resolved.reason);

  const escape = await requireSandboxPathsWithinScope(resolved.handle, scope.value, [{ field: 'path', path }]);
  if (escape) return escape;

  const result = await deleteMachinePath({ handle: resolved.handle, path });
  if (!result.ok) return mutateFailureResponse(result, 'The item to delete could not be found');

  auditWrite(request, auth.userId, sessionId, { op: 'delete', path: rawPath.value });
  return NextResponse.json({ ok: true });
}
