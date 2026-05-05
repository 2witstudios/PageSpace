/**
 * Contract tests for /api/channels/[pageId]/messages/[messageId]/follow
 *
 * The repository seam (`channelMessageRepository`) is mocked so the route's
 * authz, validation, and audit-log behavior are exercised without touching the
 * ORM chain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));

const mockFindChannelMessageInPage = vi.fn();
const mockAddChannelThreadFollower = vi.fn();
const mockRemoveChannelThreadFollower = vi.fn();
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    findChannelMessageInPage: (...args: unknown[]) => mockFindChannelMessageInPage(...args),
    addChannelThreadFollower: (...args: unknown[]) => mockAddChannelThreadFollower(...args),
    removeChannelThreadFollower: (...args: unknown[]) => mockRemoveChannelThreadFollower(...args),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const PAGE_ID = 'page_chan';
const MSG_ID = 'msg_root';
const USER_ID = 'user_a';

const sessionAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

const authError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const callPost = () =>
  POST(new Request(`http://localhost/api/channels/${PAGE_ID}/messages/${MSG_ID}/follow`, { method: 'POST' }), {
    params: Promise.resolve({ pageId: PAGE_ID, messageId: MSG_ID }),
  });

const callDelete = () =>
  DELETE(new Request(`http://localhost/api/channels/${PAGE_ID}/messages/${MSG_ID}/follow`, { method: 'DELETE' }), {
    params: Promise.resolve({ pageId: PAGE_ID, messageId: MSG_ID }),
  });

describe('POST /api/channels/[pageId]/messages/[messageId]/follow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    mockFindChannelMessageInPage.mockResolvedValue({
      id: MSG_ID,
      pageId: PAGE_ID,
      parentId: null,
      isActive: true,
    });
    mockAddChannelThreadFollower.mockResolvedValue(undefined);
  });

  it('adds the caller as a follower when the message is a top-level root', async () => {
    const res = await callPost();
    expect(res.status).toBe(200);
    expect(mockAddChannelThreadFollower).toHaveBeenCalledWith(MSG_ID, USER_ID);
    expect(await res.json()).toEqual({ following: true });
  });

  it('is idempotent — a second POST does not error (delegated to onConflictDoNothing)', async () => {
    await callPost();
    await callPost();
    expect(mockAddChannelThreadFollower).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));
    const res = await callPost();
    expect(res.status).toBe(401);
    expect(mockAddChannelThreadFollower).not.toHaveBeenCalled();
  });

  it('returns 403 when caller lacks view permission on the channel', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);
    const res = await callPost();
    expect(res.status).toBe(403);
    expect(mockAddChannelThreadFollower).not.toHaveBeenCalled();
  });

  it('returns 404 when the message does not exist in this channel', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce(null);
    const res = await callPost();
    expect(res.status).toBe(404);
  });

  it('returns 404 when the message is soft-deleted', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce({
      id: MSG_ID,
      pageId: PAGE_ID,
      parentId: null,
      isActive: false,
    });
    const res = await callPost();
    expect(res.status).toBe(404);
  });

  it('returns 400 when the message is itself a thread reply (followers attach to roots only)', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce({
      id: MSG_ID,
      pageId: PAGE_ID,
      parentId: 'some-other-parent',
      isActive: true,
    });
    const res = await callPost();
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/channels/[pageId]/messages/[messageId]/follow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    mockFindChannelMessageInPage.mockResolvedValue({
      id: MSG_ID,
      pageId: PAGE_ID,
      parentId: null,
      isActive: true,
    });
    mockRemoveChannelThreadFollower.mockResolvedValue(undefined);
  });

  it('removes the caller as a follower', async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(mockRemoveChannelThreadFollower).toHaveBeenCalledWith(MSG_ID, USER_ID);
    expect(await res.json()).toEqual({ following: false });
  });

  it('is idempotent — DELETE on a non-followed root succeeds silently', async () => {
    await callDelete();
    await callDelete();
    expect(mockRemoveChannelThreadFollower).toHaveBeenCalledTimes(2);
  });

  it('returns 403 when caller lacks view permission', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);
    const res = await callDelete();
    expect(res.status).toBe(403);
  });

  it('returns 404 when the message does not belong to this channel', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
  });
});
