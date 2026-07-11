import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/machines/files contract + path-confinement tests.
 *
 * The security-critical property under test: the untrusted `path` query param
 * is RELATIVE to the branch checkout root and is confined under it BEFORE the
 * machine filesystem is touched. A `..` escape or an absolute path must be
 * rejected (400) without ever calling listMachineDirectory/readMachineFile, so
 * a viewer cannot read `/etc/passwd` or step outside `/workspace/repo`.
 *
 * `resolvePathWithinSync` (the real confinement helper) is intentionally NOT
 * mocked — it is the code under test. Everything else (auth, access check,
 * handle resolution, the fs primitives) is mocked so the test isolates the
 * route's own request handling.
 */

// Inlined (not a top-level const) because vi.mock factories are hoisted above
// any module-scope variable and cannot close over one.
vi.mock('@pagespace/lib/services/machines/machine-branches', () => ({ BRANCH_REPO_PATH: '/workspace/repo' }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'user-1' })),
  isAuthError: vi.fn(() => false),
}));

type HandleResult =
  | { ok: true; handle: { machineId: string } }
  | { ok: false; reason: 'not_found' | 'vanished' };

const canViewMachine = vi.fn(async () => true);
const resolveBranchMachineHandle = vi.fn(
  async (): Promise<HandleResult> => ({ ok: true, handle: { machineId: 'sbx-1' } }),
);
vi.mock('@/lib/machines/machine-files-runtime', () => ({
  canViewMachine: (...args: unknown[]) => canViewMachine(...(args as [])),
  resolveBranchMachineHandle: (...args: unknown[]) => resolveBranchMachineHandle(...(args as [])),
}));

// Mirrors the real machine-fs result unions, so a test can drive the FAILURE
// arms (which is where the user-facing `error`/`reason` contract lives) — not
// just the success arms the mocks default to.
type ListResult =
  | { ok: true; entries: { name: string; type: 'file' | 'directory' }[] }
  | { ok: false; reason: 'not_found' | 'exec_failed'; detail?: string };
type ReadResult = { ok: true; content: Buffer } | { ok: false; reason: 'not_found' };

const listMachineDirectory = vi.fn(async (): Promise<ListResult> => ({ ok: true, entries: [] }));
const readMachineFile = vi.fn(async (): Promise<ReadResult> => ({ ok: true, content: Buffer.from('hi', 'utf8') }));
vi.mock('@pagespace/lib/services/sandbox/machine-fs', () => ({
  listMachineDirectory: (...args: unknown[]) => listMachineDirectory(...(args as [])),
  readMachineFile: (...args: unknown[]) => readMachineFile(...(args as [])),
}));

import { GET } from '../route';

function get(query: Record<string, string>): Request {
  const params = new URLSearchParams({ machineId: 't1', projectName: 'p1', branchName: 'b1', ...query });
  return new Request(`http://localhost/api/machines/files?${params.toString()}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  canViewMachine.mockResolvedValue(true);
  resolveBranchMachineHandle.mockResolvedValue({ ok: true, handle: { machineId: 'sbx-1' } });
  listMachineDirectory.mockResolvedValue({ ok: true, entries: [] });
  readMachineFile.mockResolvedValue({ ok: true, content: Buffer.from('hi', 'utf8') });
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
    expect(resolveBranchMachineHandle).not.toHaveBeenCalled();
    expect(listMachineDirectory).not.toHaveBeenCalled();
  });

  it('returns 404 when the branch machine has no tracking row', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(404);
  });

  it('returns 503 when the branch Sprite has vanished', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const res = await GET(get({ path: 'src' }));
    expect(res.status).toBe(503);
  });

  // `error` is rendered straight into the UI by at least one client (the Code
  // tab's file tree), so it must read as a sentence to a person — never as the
  // internal token, and never as a bare `exec_failed`.
  it('never puts an internal token in the user-facing `error`', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
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

  // "this branch has no checkout" and "that one file is gone" are BOTH 404s, so
  // a client that cannot tell them apart tells the reader a file vanished when
  // in truth the whole branch did. Distinct reason tokens are what prevent that.
  it('distinguishes a missing FILE from a missing CHECKOUT', async () => {
    readMachineFile.mockResolvedValue({ ok: false, reason: 'not_found' });
    const fileMiss = await (await GET(get({ path: 'src/gone.ts', mode: 'read' }))).json();
    expect(fileMiss.reason).toBe('file_not_found');

    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    const checkoutMiss = await (await GET(get({ path: 'src/gone.ts', mode: 'read' }))).json();
    expect(checkoutMiss.reason).toBe('not_found');
  });
});
