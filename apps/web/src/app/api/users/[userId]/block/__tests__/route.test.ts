import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), info: vi.fn() } } }));
const { blockUser, unblockUser } = vi.hoisted(() => ({ blockUser: vi.fn(), unblockUser: vi.fn() }));
vi.mock('@/lib/repositories/user-block-repository', () => ({ blockUser, unblockUser }));

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const ME = 'user_me';
const auth = (userId = ME): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0,
});
const call = (fn: typeof POST, userId: string) =>
  fn(new Request(`http://localhost/api/users/${userId}/block`, { method: 'POST' }), { params: Promise.resolve({ userId }) });

describe('/api/users/[userId]/block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth());
    blockUser.mockResolvedValue(undefined);
    unblockUser.mockResolvedValue(true);
  });

  it('given a signed-in user blocking someone else, should record the block', async () => {
    const res = await call(POST, 'user_other');
    expect(res.status).toBe(200);
    expect(blockUser).toHaveBeenCalledWith(ME, 'user_other');
  });

  it('given a user trying to block themselves, should refuse', async () => {
    const res = await call(POST, ME);
    expect(res.status).toBe(400);
    expect(blockUser).not.toHaveBeenCalled();
  });

  it('given no session, should refuse without recording anything', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    const res = await call(POST, 'user_other');
    expect(res.status).toBe(401);
    expect(blockUser).not.toHaveBeenCalled();
  });

  it('given the blocker unblocks, should lift the block', async () => {
    const res = await call(DELETE, 'user_other');
    expect(res.status).toBe(200);
    expect(unblockUser).toHaveBeenCalledWith(ME, 'user_other');
  });

  it('given no block by this user exists, should say so', async () => {
    unblockUser.mockResolvedValue(false);
    const res = await call(DELETE, 'user_other');
    expect(res.status).toBe(404);
  });
});
