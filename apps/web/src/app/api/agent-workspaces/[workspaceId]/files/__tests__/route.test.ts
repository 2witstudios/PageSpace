// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockResolveSessionSandboxHandle,
  mockListMachineDirectory,
  mockReadMachineFile,
  mockWriteMachineFile,
  mockDeleteMachinePath,
  mockVerifyPaths,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockResolveSessionSandboxHandle: vi.fn(),
  mockListMachineDirectory: vi.fn(),
  mockReadMachineFile: vi.fn(),
  mockWriteMachineFile: vi.fn(),
  mockDeleteMachinePath: vi.fn(),
  mockVerifyPaths: vi.fn(),
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
// resolvePathWithinSync (the real confinement helper) is intentionally NOT
// mocked — it is the code under test for the escape cases.
vi.mock('@pagespace/lib/services/sandbox/machine-fs', () => ({
  listMachineDirectory: (...args: unknown[]) => mockListMachineDirectory(...args),
  readMachineFile: (...args: unknown[]) => mockReadMachineFile(...args),
  createMachineDirectory: vi.fn(),
  writeMachineFile: (...args: unknown[]) => mockWriteMachineFile(...args),
  moveMachinePath: vi.fn(),
  copyMachinePath: vi.fn(),
  deleteMachinePath: (...args: unknown[]) => mockDeleteMachinePath(...args),
  verifyMachinePathsWithinScope: (...args: unknown[]) => mockVerifyPaths(...args),
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-sandbox-runtime', () => ({
  resolveSessionSandboxHandle: (...args: unknown[]) => mockResolveSessionSandboxHandle(...args),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const HANDLE = { sandboxId: 'sb-1' };
const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };

const get = (query: string) =>
  GET(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/files${query}`), params);
const jsonRequest = (method: string, body: unknown) =>
  new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/files`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockResolveSessionSandboxHandle.mockResolvedValue({ ok: true, handle: HANDLE });
  mockVerifyPaths.mockResolvedValue({ ok: true });
  mockListMachineDirectory.mockResolvedValue({ ok: true, entries: [{ name: 'a.txt', type: 'file' }] });
  mockReadMachineFile.mockResolvedValue({ ok: true, content: Buffer.from('hello') });
  mockWriteMachineFile.mockResolvedValue({ ok: true });
  mockDeleteMachinePath.mockResolvedValue({ ok: true });
});

describe('GET /api/agent-workspaces/[workspaceId]/files', () => {
  it('should list the sandbox root when no repoPath and no path are given', async () => {
    const response = await get('');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [{ name: 'a.txt', type: 'file' }] });
    expect(mockListMachineDirectory).toHaveBeenCalledWith({ handle: HANDLE, path: '/workspace' });
  });

  it('should scope everything under a caller-supplied repoPath', async () => {
    await get('?repoPath=my-clone&path=src');
    expect(mockListMachineDirectory).toHaveBeenCalledWith({ handle: HANDLE, path: '/workspace/my-clone/src' });
  });

  it('given a repoPath that escapes the sandbox root, should 400', async () => {
    const response = await get('?repoPath=../../etc');
    expect(response.status).toBe(400);
    expect(mockResolveSessionSandboxHandle).not.toHaveBeenCalled();
  });

  it('given a path that escapes its repo scope, should 400', async () => {
    const response = await get('?repoPath=my-clone&path=../other-clone/secret');
    expect(response.status).toBe(400);
    expect(mockListMachineDirectory).not.toHaveBeenCalled();
  });

  it('should read a file with mode=read', async () => {
    const response = await get('?path=a.txt&mode=read');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: 'hello', encoding: 'utf8', truncated: false });
  });

  it('given a session with no sandbox yet, should answer not_started (a browse never provisions)', async () => {
    mockResolveSessionSandboxHandle.mockResolvedValue({ ok: false, reason: 'not_started' });
    const response = await get('');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'not_started' }));
  });

  it('given a vanished sandbox, should 503', async () => {
    mockResolveSessionSandboxHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const response = await get('');
    expect(response.status).toBe(503);
  });

  it('given an access denial, should answer not_started 404 (SAME as not-found, review #2261/5) BEFORE parsing any params, and audit', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'page_access_denied' });
    const response = await get('?path=../escape&mode=bogus');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'not_started' }));
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('given no session row at all, should read as not_started', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get('');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'not_started' }));
  });

  it('given the on-machine symlink check reporting an escape, should 400', async () => {
    mockVerifyPaths.mockResolvedValue({ ok: false, reason: 'escapes', index: 0 });
    const response = await get('?path=link/etc-passwd&mode=read');
    expect(response.status).toBe(400);
    expect(mockReadMachineFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-workspaces/[workspaceId]/files', () => {
  it('should write a file and audit the mutation', async () => {
    const response = await POST(jsonRequest('POST', { path: 'notes.txt', kind: 'file', content: 'hi' }), params);
    expect(response.status).toBe(200);
    expect(mockWriteMachineFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/notes.txt', noClobber: false }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write' }),
    );
  });

  it('given a path that confines to the scope root, should 400 (the root is never the operand)', async () => {
    const response = await POST(jsonRequest('POST', { path: '.', kind: 'file', content: 'x' }), params);
    expect(response.status).toBe(400);
    expect(mockWriteMachineFile).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/agent-workspaces/[workspaceId]/files', () => {
  it('should delete a path inside the scope', async () => {
    const response = await DELETE(jsonRequest('DELETE', { repoPath: 'clone', path: 'tmp' }), params);
    expect(response.status).toBe(200);
    expect(mockDeleteMachinePath).toHaveBeenCalledWith({ handle: HANDLE, path: '/workspace/clone/tmp' });
  });

  it('given an access denial, should 404 (SAME as not-found, review #2261/5) and delete nothing', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await DELETE(jsonRequest('DELETE', { path: 'tmp' }), params);
    expect(response.status).toBe(404);
    expect(mockDeleteMachinePath).not.toHaveBeenCalled();
  });
});
