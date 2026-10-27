import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/revoke-adapters', () => ({
  buildRevokePorts: vi.fn(() => ({})),
}));

const revokePipe = vi.fn();
vi.mock('@pagespace/lib/services/invites', () => ({
  revokePendingInvite: vi.fn(() => revokePipe),
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { revokePendingInvite } from '@pagespace/lib/services/invites';
import { buildRevokePorts } from '@/lib/auth/revoke-adapters';
import { loggers } from '@pagespace/lib/logging/logger-config';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string, inviteId: string) => ({
  params: Promise.resolve({ driveId, inviteId }),
});

const createDeleteRequest = () =>
  new Request('https://example.com/api/drives/d1/pending-invites/inv1', {
    method: 'DELETE',
  });

describe('DELETE /api/drives/[driveId]/pending-invites/[inviteId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokePipe.mockReset();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(revokePendingInvite).mockImplementation(() => revokePipe);
    vi.mocked(buildRevokePorts).mockReturnValue({} as never);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const response = await DELETE(createDeleteRequest(), createContext('d1', 'inv1'));
    expect(response.status).toBe(401);
  });

  it('returns 200 with inviteId + driveId on successful revoke', async () => {
    revokePipe.mockResolvedValueOnce({
      ok: true,
      data: { inviteId: 'inv1', driveId: 'd1', email: 't@example.com', role: 'MEMBER' },
    });

    const response = await DELETE(createDeleteRequest(), createContext('d1', 'inv1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ inviteId: 'inv1', driveId: 'd1' });
    expect(revokePipe).toHaveBeenCalledWith({
      inviteId: 'inv1',
      driveId: 'd1',
      actorId: 'user-1',
    });
  });

  it('returns 404 on NOT_FOUND (invite missing or wrong-drive)', async () => {
    revokePipe.mockResolvedValueOnce({ ok: false, error: 'NOT_FOUND' });

    const response = await DELETE(createDeleteRequest(), createContext('d1', 'inv1'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Invite not found');
  });

  // Security guard: a wrong-drive request must NOT distinguish from a
  // never-existed invite — both 404. Otherwise an attacker could enumerate
  // invite IDs across drives.
  it('returns 404 (not 403) when driveId mismatches existing invite', async () => {
    revokePipe.mockResolvedValueOnce({ ok: false, error: 'NOT_FOUND' });

    const response = await DELETE(createDeleteRequest(), createContext('other-drive', 'inv1'));
    expect(response.status).toBe(404);
  });

  it('returns 403 when actor is not an accepted OWNER/ADMIN', async () => {
    revokePipe.mockResolvedValueOnce({ ok: false, error: 'FORBIDDEN' });

    const response = await DELETE(createDeleteRequest(), createContext('d1', 'inv1'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('returns 500 when pipe throws', async () => {
    revokePipe.mockRejectedValueOnce(new Error('database explosion'));

    const response = await DELETE(createDeleteRequest(), createContext('d1', 'inv1'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to revoke invite');
    expect(loggers.api.error).toHaveBeenCalled();
  });
});
