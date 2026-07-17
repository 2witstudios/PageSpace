import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/machines/files contract + path-confinement tests.
 *
 * The security-critical property under test: every untrusted path field
 * (`path`, `fromPath`, `toPath`) is RELATIVE to the scope root and is confined
 * under it BEFORE the machine filesystem is touched. A `..` escape or an
 * absolute path must be rejected (400) without ever calling a machine-fs
 * primitive, so a caller cannot read/write `/etc/passwd` or step outside the
 * scope root.
 *
 * `resolvePathWithinSync` (the real confinement helper) is intentionally NOT
 * mocked — it is the code under test. Everything else (auth, access checks,
 * handle resolution, the fs primitives, audit) is mocked so the tests isolate
 * the route's own request handling.
 */

// Inlined (not a top-level const) because vi.mock factories are hoisted above
// any module-scope variable and cannot close over one.
vi.mock('@pagespace/lib/services/machines/machine-branches', () => ({ BRANCH_REPO_PATH: '/workspace/repo' }));

type AuthResult = { userId: string } | { error: Response };
const authenticateRequestWithOptions = vi.fn(async (): Promise<AuthResult> => ({ userId: 'user-1' }));
const isAuthError = vi.fn((result: AuthResult) => 'error' in result);
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => authenticateRequestWithOptions(...(args as [])),
  isAuthError: (...args: unknown[]) => isAuthError(...(args as [AuthResult])),
}));

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => auditRequest(...(args as [])),
}));

type HandleResult =
  | { ok: true; handle: { machineId: string } }
  | { ok: false; reason: 'not_found' | 'vanished' | 'not_started' };

const canViewMachine = vi.fn(async () => true);
const canEditMachine = vi.fn(async () => true);
const resolveMachineFilesHandle = vi.fn(
  async (): Promise<HandleResult> => ({ ok: true, handle: { machineId: 'sbx-1' } }),
);
vi.mock('@/lib/machines/machine-files-runtime', () => ({
  canViewMachine: (...args: unknown[]) => canViewMachine(...(args as [])),
  canEditMachine: (...args: unknown[]) => canEditMachine(...(args as [])),
  resolveMachineFilesHandle: (...args: unknown[]) => resolveMachineFilesHandle(...(args as [])),
}));

// Mirrors the real machine-fs result unions, so a test can drive the FAILURE
// arms (which is where the user-facing `error`/`reason` contract lives) — not
// just the success arms the mocks default to.
type ListResult =
  | { ok: true; entries: { name: string; type: 'file' | 'directory' }[] }
  | { ok: false; reason: 'not_found' | 'exec_failed'; detail?: string };
type ReadResult = { ok: true; content: Buffer } | { ok: false; reason: 'not_found' };
type MutateResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_exists' | 'exec_failed'; detail?: string };
type ScopeCheckResult =
  | { ok: true }
  | { ok: false; reason: 'escapes'; index: number }
  | { ok: false; reason: 'exec_failed'; detail?: string };

const listMachineDirectory = vi.fn(async (): Promise<ListResult> => ({ ok: true, entries: [] }));
const readMachineFile = vi.fn(async (): Promise<ReadResult> => ({ ok: true, content: Buffer.from('hi', 'utf8') }));
const createMachineDirectory = vi.fn(async (): Promise<MutateResult> => ({ ok: true }));
const writeMachineFile = vi.fn(async (): Promise<MutateResult> => ({ ok: true }));
const moveMachinePath = vi.fn(async (): Promise<MutateResult> => ({ ok: true }));
const copyMachinePath = vi.fn(async (): Promise<MutateResult> => ({ ok: true }));
const deleteMachinePath = vi.fn(async (): Promise<MutateResult> => ({ ok: true }));
const verifyMachinePathsWithinScope = vi.fn(async (): Promise<ScopeCheckResult> => ({ ok: true }));
vi.mock('@pagespace/lib/services/sandbox/machine-fs', () => ({
  listMachineDirectory: (...args: unknown[]) => listMachineDirectory(...(args as [])),
  readMachineFile: (...args: unknown[]) => readMachineFile(...(args as [])),
  createMachineDirectory: (...args: unknown[]) => createMachineDirectory(...(args as [])),
  writeMachineFile: (...args: unknown[]) => writeMachineFile(...(args as [])),
  moveMachinePath: (...args: unknown[]) => moveMachinePath(...(args as [])),
  copyMachinePath: (...args: unknown[]) => copyMachinePath(...(args as [])),
  deleteMachinePath: (...args: unknown[]) => deleteMachinePath(...(args as [])),
  verifyMachinePathsWithinScope: (...args: unknown[]) => verifyMachinePathsWithinScope(...(args as [])),
}));

import { GET, POST, PATCH, DELETE } from '../route';

function get(query: Record<string, string>): Request {
  const params = new URLSearchParams({ machineId: 't1', projectName: 'p1', branchName: 'b1', ...query });
  return new Request(`http://localhost/api/machines/files?${params.toString()}`);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://localhost/api/machines/files', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function rawRequest(method: string, rawBody: string): Request {
  return new Request('http://localhost/api/machines/files', {
    method,
    body: rawBody,
    headers: { 'content-type': 'application/json' },
  });
}

const post = (body: unknown) => jsonRequest('POST', body);
const patch = (body: unknown) => jsonRequest('PATCH', body);
const del = (body: unknown) => jsonRequest('DELETE', body);

const BRANCH_BODY = { machineId: 't1', projectName: 'p1', branchName: 'b1' };
const ROOT_BODY = { machineId: 't1' };

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue({ userId: 'user-1' });
  isAuthError.mockImplementation((result: AuthResult) => 'error' in result);
  canViewMachine.mockResolvedValue(true);
  canEditMachine.mockResolvedValue(true);
  resolveMachineFilesHandle.mockResolvedValue({ ok: true, handle: { machineId: 'sbx-1' } });
  listMachineDirectory.mockResolvedValue({ ok: true, entries: [] });
  readMachineFile.mockResolvedValue({ ok: true, content: Buffer.from('hi', 'utf8') });
  createMachineDirectory.mockResolvedValue({ ok: true });
  writeMachineFile.mockResolvedValue({ ok: true });
  moveMachinePath.mockResolvedValue({ ok: true });
  copyMachinePath.mockResolvedValue({ ok: true });
  deleteMachinePath.mockResolvedValue({ ok: true });
  verifyMachinePathsWithinScope.mockResolvedValue({ ok: true });
});

describe('/api/machines/files machine-side symlink confinement', () => {
  it('re-verifies the read path ON the machine and 400s an escape without reading', async () => {
    verifyMachinePathsWithinScope.mockResolvedValue({ ok: false, reason: 'escapes', index: 0 });

    const res = await GET(get({ mode: 'read', path: 'link/etc-passwd' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'path escapes the machine filesystem root' });
    expect(verifyMachinePathsWithinScope).toHaveBeenCalledWith({
      handle: { machineId: 'sbx-1' },
      scopeRoot: '/workspace/repo',
      paths: ['/workspace/repo/link/etc-passwd'],
    });
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('skips the extra exec for a bare scope-root listing — no intermediate component to hijack', async () => {
    const res = await GET(get({}));

    expect(res.status).toBe(200);
    expect(verifyMachinePathsWithinScope).not.toHaveBeenCalled();
    expect(listMachineDirectory).toHaveBeenCalled();
  });

  it('verifies BOTH move operands in one call and names the escaping field', async () => {
    verifyMachinePathsWithinScope.mockResolvedValue({ ok: false, reason: 'escapes', index: 1 });

    const res = await PATCH(patch({ ...BRANCH_BODY, op: 'move', fromPath: 'a.txt', toPath: 'link/b.txt' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'toPath escapes the machine filesystem root' });
    expect(verifyMachinePathsWithinScope).toHaveBeenCalledWith({
      handle: { machineId: 'sbx-1' },
      scopeRoot: '/workspace/repo',
      paths: ['/workspace/repo/a.txt', '/workspace/repo/link/b.txt'],
    });
    expect(moveMachinePath).not.toHaveBeenCalled();
  });

  it('blocks a root-scope write through an escaping symlink without writing', async () => {
    verifyMachinePathsWithinScope.mockResolvedValue({ ok: false, reason: 'escapes', index: 0 });

    const res = await POST(post({ ...ROOT_BODY, path: 'link/x.txt', kind: 'file', content: 'x' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'path escapes the machine filesystem root' });
    expect(verifyMachinePathsWithinScope).toHaveBeenCalledWith({
      handle: { machineId: 'sbx-1' },
      scopeRoot: '/workspace',
      paths: ['/workspace/link/x.txt'],
    });
    expect(writeMachineFile).not.toHaveBeenCalled();
  });

  it('blocks delete through an escaping symlink without deleting', async () => {
    verifyMachinePathsWithinScope.mockResolvedValue({ ok: false, reason: 'escapes', index: 0 });

    const res = await DELETE(del({ ...BRANCH_BODY, path: 'link' }));

    expect(res.status).toBe(400);
    expect(deleteMachinePath).not.toHaveBeenCalled();
  });

  it('fails CLOSED as 502 when the machine-side check itself cannot run', async () => {
    verifyMachinePathsWithinScope.mockResolvedValue({ ok: false, reason: 'exec_failed', detail: 'realpath: not found' });

    const res = await GET(get({ mode: 'read', path: 'a.txt' }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe('exec_failed');
    expect(readMachineFile).not.toHaveBeenCalled();
  });
});

describe('/api/machines/files write parent-preflight contract', () => {
  it('maps writeMachineFile not_found (parent deleted on the live machine) to the documented 404', async () => {
    writeMachineFile.mockResolvedValue({ ok: false, reason: 'not_found' });

    const res = await POST(post({ ...BRANCH_BODY, path: 'gone/x.txt', kind: 'file', content: 'x' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'The parent folder could not be found', reason: 'not_found' });
  });
});

describe('/api/machines/files path confinement', () => {
  it('rejects a `..` traversal without touching the filesystem', async () => {
    const res = await GET(get({ mode: 'read', path: '../../etc/passwd' }));
    expect(res.status).toBe(400);
    expect(listMachineDirectory).not.toHaveBeenCalled();
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('rejects an absolute path without touching the filesystem', async () => {
    const res = await GET(get({ mode: 'read', path: '/etc/passwd' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('rejects a URL-encoded traversal without touching the filesystem', async () => {
    const res = await GET(get({ mode: 'read', path: '%2e%2e%2fetc%2fpasswd' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('confines a valid relative path under the checkout root before listing', async () => {
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(200);
    expect(listMachineDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/src' }),
    );
  });

  it('defaults an empty path to the checkout root for a listing', async () => {
    const res = await GET(get({}));
    expect(res.status).toBe(200);
    expect(listMachineDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo' }),
    );
  });

  it('confines a valid relative path before reading a file', async () => {
    const res = await GET(get({ mode: 'read', path: 'src/index.ts' }));
    expect(res.status).toBe(200);
    expect(readMachineFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/src/index.ts' }),
    );
  });

  it('truncates a large file without corrupting a multi-byte char at the boundary', async () => {
    // A >2MB buffer of only 3-byte '€' glyphs: whatever byte the 2MB cap lands
    // on, it splits a codepoint. The response must still be clean UTF-8 (no
    // U+FFFD) and end on a whole '€', proving the partial trailing byte was
    // dropped rather than decoded into a replacement char.
    readMachineFile.mockResolvedValue({ ok: true, content: Buffer.from('€'.repeat(1_000_000), 'utf8') });
    const res = await GET(get({ mode: 'read', path: 'big.txt' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.content.includes('�')).toBe(false);
    expect(body.content.endsWith('€')).toBe(true);
  });
});

describe('/api/machines/files request contract', () => {
  it('requires a path when mode=read', async () => {
    const res = await GET(get({ mode: 'read' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode', async () => {
    const res = await GET(get({ mode: 'delete' }));
    expect(res.status).toBe(400);
  });

  it('denies a user without view access before resolving the machine', async () => {
    canViewMachine.mockResolvedValue(false);
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(403);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
    expect(listMachineDirectory).not.toHaveBeenCalled();
  });

  it('returns 404 when the branch machine has no tracking row', async () => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(404);
  });

  it('returns 503 when the branch Sprite has vanished', async () => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(503);
  });

  // `error` is rendered straight into the UI by at least one client (the Code
  // tab's file tree), so it must read as a sentence to a person — never as the
  // internal token, and never as a bare `exec_failed`.
  it('never puts an internal token in the user-facing `error`', async () => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const body = await (await GET(get({ path: 'src' }))).json();
    expect(body.reason).toBe('vanished'); // machine-readable fact: unchanged
    expect(body.error).toBe('This branch checkout is unavailable');
    expect(body.error).not.toMatch(/vanished|not_found|Branch machine/);
  });

  it('falls back to a readable message when a failed exec produced no stderr', async () => {
    listMachineDirectory.mockResolvedValue({ ok: false, reason: 'exec_failed', detail: undefined });
    const body = await (await GET(get({ path: 'src' }))).json();
    expect(body.reason).toBe('exec_failed');
    expect(body.error).toBe('Failed to list the checkout directory');
  });

  // The exec's stderr names absolute paths INSIDE the Sprite. The file tree
  // renders `error` straight into a row, so stderr must never land there.
  it("keeps the exec's stderr out of the user-facing `error`", async () => {
    listMachineDirectory.mockResolvedValue({
      ok: false,
      reason: 'exec_failed',
      detail: "ls: cannot access '/workspace/repo/src': Permission denied",
    });
    const body = await (await GET(get({ path: 'src' }))).json();
    expect(body.error).toBe('Failed to list the checkout directory');
    expect(body.error).not.toMatch(/workspace\/repo/);
    expect(body.detail).toMatch(/Permission denied/); // still available to logs/devs
  });

  // Same trap as the read arm: "this branch has no checkout" and "that folder is
  // gone" are different facts, and the root vs subdirectory is what tells them
  // apart. Conflating them makes an un-cloned branch and a deleted folder
  // indistinguishable to the client.
  it('distinguishes a missing SUBDIRECTORY from a missing CHECKOUT', async () => {
    listMachineDirectory.mockResolvedValue({ ok: false, reason: 'not_found' });

    const subdir = await (await GET(get({ path: 'src/generated' }))).json();
    expect(subdir.reason).toBe('dir_not_found');
    expect(subdir.error).toBe('This folder is no longer in the checkout');

    const root = await (await GET(get({}))).json(); // no `path` => the checkout root
    expect(root.reason).toBe('not_found');
    expect(root.error).toBe('This branch checkout is unavailable');
  });

  // "this branch has no checkout" and "that one file is gone" are BOTH 404s, so
  // a client that cannot tell them apart tells the reader a file vanished when
  // in truth the whole branch did. Distinct reason tokens are what prevent that.
  it('distinguishes a missing FILE from a missing CHECKOUT', async () => {
    readMachineFile.mockResolvedValue({ ok: false, reason: 'not_found' });
    const fileMiss = await (await GET(get({ path: 'src/gone.ts', mode: 'read' }))).json();
    expect(fileMiss.reason).toBe('file_not_found');

    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    const checkoutMiss = await (await GET(get({ path: 'src/gone.ts', mode: 'read' }))).json();
    expect(checkoutMiss.reason).toBe('not_found');
  });

  it('resolves branch scope with the right dispatcher shape', async () => {
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(200);
    expect(resolveMachineFilesHandle).toHaveBeenCalledWith({
      scope: 'branch',
      machineId: 't1',
      projectName: 'p1',
      branchName: 'b1',
    });
  });
});

// Root scope omits projectName/branchName entirely — `get` (above) always
// supplies both, so these tests build the query directly.
function getRoot(query: Record<string, string> = {}): Request {
  const params = new URLSearchParams({ machineId: 't1', ...query });
  return new Request(`http://localhost/api/machines/files?${params.toString()}`);
}

describe('/api/machines/files root scope', () => {
  it('resolves root scope when projectName/branchName are absent', async () => {
    const res = await GET(getRoot());
    expect(res.status).toBe(200);
    expect(resolveMachineFilesHandle).toHaveBeenCalledWith({ scope: 'root', machineId: 't1' });
    expect(listMachineDirectory).toHaveBeenCalledWith(expect.objectContaining({ path: '/workspace' }));
  });

  it('confines a relative path under /workspace (SANDBOX_ROOT), not the branch checkout root', async () => {
    const res = await GET(getRoot({ path: 'repo/src' }));
    expect(res.status).toBe(200);
    expect(listMachineDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/src' }),
    );
  });

  it('rejects a `..` traversal in root scope without touching the filesystem', async () => {
    const res = await GET(getRoot({ path: '../etc' }));
    expect(res.status).toBe(400);
    expect(listMachineDirectory).not.toHaveBeenCalled();
  });

  it('rejects an absolute path in root scope without touching the filesystem', async () => {
    const res = await GET(getRoot({ mode: 'read', path: '/etc/passwd' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('maps a null root handle to 404 not_started with no internal token in `error`', async () => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason: 'not_started' });
    const res = await GET(getRoot());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.reason).toBe('not_started');
    expect(body.error).toBe("This machine hasn't been started yet");
    expect(body.error).not.toMatch(/not_started/);
  });

  it('400s when only projectName is present (root/branch pair broken)', async () => {
    const res = await GET(getRoot({ projectName: 'p1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'projectName and branchName must be provided together' });
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s when only branchName is present (root/branch pair broken)', async () => {
    const res = await GET(getRoot({ branchName: 'b1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'projectName and branchName must be provided together' });
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s when only projectName is present as an empty string', async () => {
    const res = await GET(getRoot({ projectName: '', branchName: 'b1' }));
    expect(res.status).toBe(400);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s when only branchName is present as an empty string', async () => {
    const res = await GET(getRoot({ projectName: 'p1', branchName: '' }));
    expect(res.status).toBe(400);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  // The branch arm's "empty relativePath => not_found" remap encodes "never
  // cloned" — a BRANCH-only fact. A live root Sprite's /workspace always
  // exists, so root scope must never emit that remap, even at the root path.
  it("does not leak the branch arm's root-missing remap into root scope", async () => {
    listMachineDirectory.mockResolvedValue({ ok: false, reason: 'not_found' });
    const body = await (await GET(getRoot())).json();
    expect(body.reason).toBe('dir_not_found');
    expect(body.error).toBe('This folder is no longer on the machine');
  });
});

describe('/api/machines/files GET mode=download', () => {
  it('requires a path', async () => {
    const res = await GET(get({ mode: 'download' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('is a read — view access is enough, no CSRF requirement', async () => {
    await GET(get({ mode: 'download', path: 'src/index.ts' }));
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCSRF: false }),
    );
    expect(canViewMachine).toHaveBeenCalled();
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('confines the path under the scope root before touching the filesystem', async () => {
    const res = await GET(get({ mode: 'download', path: '../../etc/passwd' }));
    expect(res.status).toBe(400);
    expect(readMachineFile).not.toHaveBeenCalled();
  });

  it('returns 404 file_not_found when the file is missing', async () => {
    readMachineFile.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await GET(get({ mode: 'download', path: 'gone.bin' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'File not found', reason: 'file_not_found' });
  });

  it('returns 413 when the file exceeds the 50 MiB download cap', async () => {
    readMachineFile.mockResolvedValue({ ok: true, content: Buffer.alloc(50 * 1024 * 1024 + 1) });
    const res = await GET(get({ mode: 'download', path: 'huge.bin' }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'File is too large to download', reason: 'too_large' });
  });

  it('returns byte-faithful binary content with octet-stream headers', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 253]);
    readMachineFile.mockResolvedValue({ ok: true, content: bytes });
    const res = await GET(get({ mode: 'download', path: 'src/blob.bin' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(bytes)).toBe(true);
  });

  it('sanitizes the filename to a basename, stripping directories and quotes', async () => {
    const res = await GET(get({ mode: 'download', path: 'a/b"c.txt' }));
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="[^"/\\]*"; filename\*=UTF-8''/);
    expect(disposition).not.toMatch(/a\/b/);
    expect(disposition).not.toContain('"c.txt"; filename'); // no stray embedded quote from the raw name
  });
});

describe('/api/machines/files POST (create/upload)', () => {
  it('returns the auth error when unauthenticated', async () => {
    const authError = { error: new Response(null, { status: 401 }) };
    authenticateRequestWithOptions.mockResolvedValueOnce(authError);
    isAuthError.mockReturnValueOnce(true);
    const res = await POST(post({ ...BRANCH_BODY, path: 'a', kind: 'directory' }));
    expect(res.status).toBe(401);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('requires session auth with CSRF enforced', async () => {
    await POST(post({ ...BRANCH_BODY, path: 'a', kind: 'directory' }));
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      { allow: ['session'], requireCSRF: true },
    );
  });

  it('rejects a null JSON body with 400, not a crash', async () => {
    const res = await POST(rawRequest('POST', 'null'));
    expect(res.status).toBe(400);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await POST(rawRequest('POST', '{not json'));
    expect(res.status).toBe(400);
  });

  it('403s when canEditMachine is false, even though canViewMachine is true (view-only is not enough)', async () => {
    canViewMachine.mockResolvedValue(true);
    canEditMachine.mockResolvedValue(false);
    const res = await POST(post({ ...BRANCH_BODY, path: 'a', kind: 'directory' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'You do not have edit access to this machine' });
    expect(createMachineDirectory).not.toHaveBeenCalled();
  });

  it('403s before validating field shape (unauthorized caller cannot distinguish well-formed from malformed)', async () => {
    canEditMachine.mockResolvedValue(false);
    const res = await POST(post({ machineId: 't1', kind: 'not-a-real-kind' }));
    expect(res.status).toBe(403);
  });

  it('400s when only one of projectName/branchName is present', async () => {
    const res = await POST(post({ machineId: 't1', projectName: 'p1', path: 'a', kind: 'directory' }));
    expect(res.status).toBe(400);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s when path is the scope root (empty string)', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: '', kind: 'directory' }));
    expect(res.status).toBe(400);
    expect(createMachineDirectory).not.toHaveBeenCalled();
  });

  it('400s and never calls the primitive when path escapes the scope root', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: '../../etc', kind: 'directory' }));
    expect(res.status).toBe(400);
    expect(createMachineDirectory).not.toHaveBeenCalled();
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s on an invalid kind', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: 'a', kind: 'symlink' }));
    expect(res.status).toBe(400);
  });

  it.each(['not_found', 'vanished', 'not_started'] as const)('maps resolver denial %s to the GET-equivalent status', async (reason) => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason });
    const res = await POST(post({ ...BRANCH_BODY, path: 'a', kind: 'directory' }));
    expect(res.status).toBe(reason === 'vanished' ? 503 : 404);
    expect(createMachineDirectory).not.toHaveBeenCalled();
  });

  it('creates a directory (branch scope) with the confined absolute path and audits the write', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: 'newdir', kind: 'directory' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(createMachineDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/newdir' }),
    );
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', userId: 'user-1', resourceId: 't1' }),
    );
  });

  it('creates a directory (root scope) with the confined absolute path under SANDBOX_ROOT', async () => {
    const res = await POST(post({ ...ROOT_BODY, path: 'newdir', kind: 'directory' }));
    expect(res.status).toBe(200);
    expect(createMachineDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/newdir' }),
    );
  });

  it('409s when the directory already exists', async () => {
    createMachineDirectory.mockResolvedValue({ ok: false, reason: 'already_exists' });
    const res = await POST(post({ ...BRANCH_BODY, path: 'newdir', kind: 'directory' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Something already has that name', reason: 'already_exists' });
  });

  it('404s when the parent folder is missing', async () => {
    createMachineDirectory.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await POST(post({ ...BRANCH_BODY, path: 'gone/newdir', kind: 'directory' }));
    expect(res.status).toBe(404);
  });

  it('writes a file with default utf8 encoding and empty content, and overwrite is allowed (save)', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: 'a.txt', kind: 'file' }));
    expect(res.status).toBe(200);
    expect(writeMachineFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/a.txt', content: Buffer.from('', 'utf8') }),
    );
  });

  it('writes utf8 content verbatim', async () => {
    await POST(post({ ...BRANCH_BODY, path: 'a.txt', kind: 'file', content: 'hello world', encoding: 'utf8' }));
    expect(writeMachineFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: Buffer.from('hello world', 'utf8') }),
    );
  });

  it('decodes base64 content', async () => {
    const b64 = Buffer.from('binary payload', 'utf8').toString('base64');
    await POST(post({ ...BRANCH_BODY, path: 'a.bin', kind: 'file', content: b64, encoding: 'base64' }));
    expect(writeMachineFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: Buffer.from('binary payload', 'utf8') }),
    );
  });

  it('400s on malformed base64 content without calling writeMachineFile', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: 'a.bin', kind: 'file', content: 'not-valid-base64!!', encoding: 'base64' }));
    expect(res.status).toBe(400);
    expect(writeMachineFile).not.toHaveBeenCalled();
  });

  it('400s on an invalid encoding', async () => {
    const res = await POST(post({ ...BRANCH_BODY, path: 'a.txt', kind: 'file', content: 'x', encoding: 'latin1' }));
    expect(res.status).toBe(400);
  });

  it('413s when decoded content exceeds the 10 MiB upload cap, without calling writeMachineFile', async () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    const res = await POST(post({ ...BRANCH_BODY, path: 'big.txt', kind: 'file', content: big, encoding: 'utf8' }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'File is too large to upload', reason: 'too_large' });
    expect(writeMachineFile).not.toHaveBeenCalled();
  });

  it('audits the file write with the op and relative path (never the absolute sprite path)', async () => {
    await POST(post({ ...BRANCH_BODY, path: 'a.txt', kind: 'file', content: 'hi' }));
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ op: 'write_file', path: 'a.txt' }) }),
    );
  });
});

describe('/api/machines/files PATCH (move/copy)', () => {
  const BASE = { ...BRANCH_BODY, fromPath: 'a.txt', toPath: 'b.txt' };

  it('returns the auth error when unauthenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValueOnce({ error: new Response(null, { status: 401 }) });
    isAuthError.mockReturnValueOnce(true);
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(401);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('requires session auth with CSRF enforced', async () => {
    await PATCH(patch({ ...BASE, op: 'move' }));
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      { allow: ['session'], requireCSRF: true },
    );
  });

  it('rejects a null JSON body with 400', async () => {
    const res = await PATCH(rawRequest('PATCH', 'null'));
    expect(res.status).toBe(400);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('403s when canEditMachine is false (view-only is not enough)', async () => {
    canViewMachine.mockResolvedValue(true);
    canEditMachine.mockResolvedValue(false);
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(403);
    expect(moveMachinePath).not.toHaveBeenCalled();
  });

  it('400s when only one of projectName/branchName is present', async () => {
    const res = await PATCH(patch({ machineId: 't1', projectName: 'p1', fromPath: 'a', toPath: 'b', op: 'move' }));
    expect(res.status).toBe(400);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s on an invalid op', async () => {
    const res = await PATCH(patch({ ...BASE, op: 'rename' }));
    expect(res.status).toBe(400);
  });

  it('400s when fromPath is the scope root (empty string)', async () => {
    const res = await PATCH(patch({ ...BRANCH_BODY, fromPath: '', toPath: 'b.txt', op: 'move' }));
    expect(res.status).toBe(400);
    expect(moveMachinePath).not.toHaveBeenCalled();
  });

  it('400s when toPath is the scope root (empty string)', async () => {
    const res = await PATCH(patch({ ...BRANCH_BODY, fromPath: 'a.txt', toPath: '', op: 'move' }));
    expect(res.status).toBe(400);
    expect(moveMachinePath).not.toHaveBeenCalled();
  });

  it('400s and never calls the primitive when fromPath escapes the scope root', async () => {
    const res = await PATCH(patch({ ...BRANCH_BODY, fromPath: '../../etc/passwd', toPath: 'b.txt', op: 'move' }));
    expect(res.status).toBe(400);
    expect(moveMachinePath).not.toHaveBeenCalled();
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s and never calls the primitive when toPath escapes the scope root', async () => {
    const res = await PATCH(patch({ ...BRANCH_BODY, fromPath: 'a.txt', toPath: '/etc/passwd', op: 'move' }));
    expect(res.status).toBe(400);
    expect(moveMachinePath).not.toHaveBeenCalled();
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'vanished', 'not_started'] as const)('maps resolver denial %s to the GET-equivalent status', async (reason) => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason });
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(reason === 'vanished' ? 503 : 404);
    expect(moveMachinePath).not.toHaveBeenCalled();
  });

  it('moves a path (branch scope) with confined absolute from/to paths and audits the write', async () => {
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(moveMachinePath).toHaveBeenCalledWith(
      expect.objectContaining({ fromPath: '/workspace/repo/a.txt', toPath: '/workspace/repo/b.txt' }),
    );
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        details: expect.objectContaining({ op: 'move', fromPath: 'a.txt', toPath: 'b.txt' }),
      }),
    );
  });

  it('copies a path (root scope) with confined absolute paths under SANDBOX_ROOT', async () => {
    const res = await PATCH(patch({ machineId: 't1', fromPath: 'a.txt', toPath: 'b.txt', op: 'copy' }));
    expect(res.status).toBe(200);
    expect(copyMachinePath).toHaveBeenCalledWith(
      expect.objectContaining({ fromPath: '/workspace/a.txt', toPath: '/workspace/b.txt' }),
    );
  });

  it('409s when the destination already exists', async () => {
    moveMachinePath.mockResolvedValue({ ok: false, reason: 'already_exists' });
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Something already has that name', reason: 'already_exists' });
  });

  it('404s when the source is missing', async () => {
    moveMachinePath.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await PATCH(patch({ ...BASE, op: 'move' }));
    expect(res.status).toBe(404);
  });

  it('502s with detail (not error) when the exec fails', async () => {
    copyMachinePath.mockResolvedValue({ ok: false, reason: 'exec_failed', detail: 'cp: Permission denied on /workspace/repo/a.txt' });
    const res = await PATCH(patch({ ...BASE, op: 'copy' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/workspace/);
    expect(body.detail).toMatch(/Permission denied/);
  });
});

describe('/api/machines/files DELETE', () => {
  it('returns the auth error when unauthenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValueOnce({ error: new Response(null, { status: 401 }) });
    isAuthError.mockReturnValueOnce(true);
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(res.status).toBe(401);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('requires session auth with CSRF enforced', async () => {
    await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      { allow: ['session'], requireCSRF: true },
    );
  });

  it('rejects a null JSON body with 400', async () => {
    const res = await DELETE(rawRequest('DELETE', 'null'));
    expect(res.status).toBe(400);
    expect(canEditMachine).not.toHaveBeenCalled();
  });

  it('403s when canEditMachine is false (view-only is not enough)', async () => {
    canViewMachine.mockResolvedValue(true);
    canEditMachine.mockResolvedValue(false);
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(res.status).toBe(403);
    expect(deleteMachinePath).not.toHaveBeenCalled();
  });

  it('400s when only one of projectName/branchName is present', async () => {
    const res = await DELETE(del({ machineId: 't1', branchName: 'b1', path: 'a.txt' }));
    expect(res.status).toBe(400);
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it('400s when path is the scope root (empty string), never calling the primitive', async () => {
    const res = await DELETE(del({ ...BRANCH_BODY, path: '' }));
    expect(res.status).toBe(400);
    expect(deleteMachinePath).not.toHaveBeenCalled();
  });

  it('400s and never calls the primitive when path escapes the scope root', async () => {
    const res = await DELETE(del({ ...BRANCH_BODY, path: '../../etc/passwd' }));
    expect(res.status).toBe(400);
    expect(deleteMachinePath).not.toHaveBeenCalled();
    expect(resolveMachineFilesHandle).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'vanished', 'not_started'] as const)('maps resolver denial %s to the GET-equivalent status', async (reason) => {
    resolveMachineFilesHandle.mockResolvedValue({ ok: false, reason });
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(res.status).toBe(reason === 'vanished' ? 503 : 404);
    expect(deleteMachinePath).not.toHaveBeenCalled();
  });

  it('deletes a path (branch scope) with the confined absolute path and audits the write', async () => {
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMachinePath).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/repo/a.txt' }),
    );
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        details: expect.objectContaining({ op: 'delete', path: 'a.txt' }),
      }),
    );
  });

  it('deletes a path (root scope) with the confined absolute path under SANDBOX_ROOT', async () => {
    const res = await DELETE(del({ machineId: 't1', path: 'a.txt' }));
    expect(res.status).toBe(200);
    expect(deleteMachinePath).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/a.txt' }),
    );
  });

  it('deleting an already-missing path is idempotent success (rm -rf semantics)', async () => {
    deleteMachinePath.mockResolvedValue({ ok: true });
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'already-gone.txt' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('502s with detail (not error) when the exec fails', async () => {
    deleteMachinePath.mockResolvedValue({ ok: false, reason: 'exec_failed', detail: 'rm: Permission denied on /workspace/repo/a.txt' });
    const res = await DELETE(del({ ...BRANCH_BODY, path: 'a.txt' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/workspace/);
    expect(body.detail).toMatch(/Permission denied/);
  });
});
