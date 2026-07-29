// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockResolveHandle,
  mockReadGitBlob,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockResolveHandle: vi.fn(),
  mockReadGitBlob: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/sandbox/machine-git-blob', () => ({
  readMachineGitBlob: (...args: unknown[]) => mockReadGitBlob(...args),
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-sessions/session-sandbox-runtime', () => ({
  resolveSessionSandboxHandle: (...args: unknown[]) => mockResolveHandle(...args),
  resolveSessionActorContext: vi.fn(async () => ({ userId: 'user-1', tenantId: 'user-1', actorEmail: 'a@b.c', tier: 'free' })),
  buildSessionReadActorCtx: vi.fn((scopeKey: string) => ({ conversationId: scopeKey })),
  buildSessionGitDepsForHandle: vi.fn(() => ({ deps: true })),
}));

import { GET } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const get = (query: string) =>
  GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/git-blob${query}`), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockResolveHandle.mockResolvedValue({ ok: true, handle: { sandboxId: 'sb-1' } });
  mockReadGitBlob.mockResolvedValue({ ok: true, content: 'old content', truncated: false });
});

describe('GET /api/agent-sessions/[sessionId]/git-blob', () => {
  it('should read a blob at a ref from the caller-named repo', async () => {
    const response = await get('?repoPath=clone&ref=abc123&path=src/a.ts');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: 'old content', truncated: false });
    expect(mockReadGitBlob).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'abc123', path: 'src/a.ts', cwd: '/workspace/clone' }),
    );
  });

  it('given a repoPath escape, should 400', async () => {
    const response = await get('?repoPath=../../etc&ref=abc&path=passwd');
    expect(response.status).toBe(400);
    expect(mockReadGitBlob).not.toHaveBeenCalled();
  });

  it('given missing params, should 400 each', async () => {
    expect((await get('?ref=a&path=b')).status).toBe(400);
    expect((await get('?repoPath=c&path=b')).status).toBe(400);
    expect((await get('?repoPath=c&ref=a')).status).toBe(400);
  });

  it('given a denial, should uniform-403 before parsing ref/path, and audit', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await get('');
    expect(response.status).toBe(403);
    expect(mockAuditRequest).toHaveBeenCalled();
  });

  it('given an invalid ref, should map the reason to 400', async () => {
    mockReadGitBlob.mockResolvedValue({ ok: false, reason: 'invalid_ref' });
    const response = await get('?repoPath=clone&ref=$(rm)&path=a');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'invalid_ref' }));
  });

  it('given a vanished sandbox, should 503', async () => {
    mockResolveHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const response = await get('?repoPath=clone&ref=a&path=b');
    expect(response.status).toBe(503);
  });
});
