import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthResult, SessionAuthResult, MCPAuthResult } from '@/lib/auth';

const { mockIsDriveOwnerOrAdmin } = vi.hoisted(() => ({ mockIsDriveOwnerOrAdmin: vi.fn() }));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: (...args: unknown[]) => mockIsDriveOwnerOrAdmin(...args),
}));
vi.mock('@/lib/auth', () => ({
  isSessionAuthResult: (auth: { tokenType?: string }) => auth?.tokenType === 'session',
}));

import { authorizeToolApprovalModeChange } from '../tool-approval-mode-authority';

const session: SessionAuthResult = {
  userId: 'u1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 's1',
  role: 'user',
  adminRoleVersion: 0,
};
const mcp = { userId: 'u1', tokenType: 'mcp' } as unknown as MCPAuthResult;
const asAuth = (a: AuthResult) => a;

describe('authorizeToolApprovalModeChange', () => {
  beforeEach(() => {
    mockIsDriveOwnerOrAdmin.mockReset();
  });

  it('rejects a mode that is neither "ask" nor "auto" with 400', async () => {
    const result = await authorizeToolApprovalModeChange(asAuth(session), 'd1', 'never');
    expect(result).toEqual({ ok: false, status: 400, error: 'toolApprovalMode must be "ask" or "auto"' });
  });

  it('lets any editor set "ask" — it only makes the agent safer', async () => {
    expect(await authorizeToolApprovalModeChange(asAuth(mcp), 'd1', 'ask')).toEqual({ ok: true, mode: 'ask' });
    expect(mockIsDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });

  it('lets a drive owner/admin on a session set "auto"', async () => {
    mockIsDriveOwnerOrAdmin.mockResolvedValue(true);
    expect(await authorizeToolApprovalModeChange(asAuth(session), 'd1', 'auto')).toEqual({ ok: true, mode: 'auto' });
    expect(mockIsDriveOwnerOrAdmin).toHaveBeenCalledWith('u1', 'd1');
  });

  it('refuses "auto" to a session editor who is not drive owner or admin with 403', async () => {
    mockIsDriveOwnerOrAdmin.mockResolvedValue(false);
    const result = await authorizeToolApprovalModeChange(asAuth(session), 'd1', 'auto');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses "auto" to a non-session principal (MCP/OAuth/service) even when the user is the owner', async () => {
    mockIsDriveOwnerOrAdmin.mockResolvedValue(true);
    const result = await authorizeToolApprovalModeChange(asAuth(mcp), 'd1', 'auto');
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(mockIsDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });
});
