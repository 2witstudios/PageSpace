/**
 * Contract tests for /api/messages/[conversationId]/[messageId]/follow
 *
 * The repository seam is mocked so the route's authz, validation, and audit
 * behavior are exercised without the ORM chain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

const mockFindConversationForParticipant = vi.fn();
const mockFindActiveMessage = vi.fn();
const mockFindMessageInConversation = vi.fn();
const mockAddDmThreadFollower = vi.fn();
const mockRemoveDmThreadFollower = vi.fn();
vi.mock('@pagespace/lib/services/dm-message-repository', () => ({
  dmMessageRepository: {
    findConversationForParticipant: (...args: unknown[]) => mockFindConversationForParticipant(...args),
    findActiveMessage: (...args: unknown[]) => mockFindActiveMessage(...args),
    findMessageInConversation: (...args: unknown[]) => mockFindMessageInConversation(...args),
    addDmThreadFollower: (...args: unknown[]) => mockAddDmThreadFollower(...args),
    removeDmThreadFollower: (...args: unknown[]) => mockRemoveDmThreadFollower(...args),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const CONV_ID = 'conv_dm';
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
  POST(new Request(`http://localhost/api/messages/${CONV_ID}/${MSG_ID}/follow`, { method: 'POST' }), {
    params: Promise.resolve({ conversationId: CONV_ID, messageId: MSG_ID }),
  });

const callDelete = () =>
  DELETE(new Request(`http://localhost/api/messages/${CONV_ID}/${MSG_ID}/follow`, { method: 'DELETE' }), {
    params: Promise.resolve({ conversationId: CONV_ID, messageId: MSG_ID }),
  });

describe('POST /api/messages/[conversationId]/[messageId]/follow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindConversationForParticipant.mockResolvedValue({
      id: CONV_ID,
      participant1Id: USER_ID,
      participant2Id: 'user_b',
    });
    mockFindActiveMessage.mockResolvedValue({
      id: MSG_ID,
      conversationId: CONV_ID,
      parentId: null,
    });
    mockAddDmThreadFollower.mockResolvedValue(undefined);
  });

  it('adds the caller as a follower for a top-level DM root', async () => {
    const res = await callPost();
    expect(res.status).toBe(200);
    expect(mockAddDmThreadFollower).toHaveBeenCalledWith(MSG_ID, USER_ID);
    expect(await res.json()).toEqual({ following: true });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));
    const res = await callPost();
    expect(res.status).toBe(401);
  });

  it('returns 404 when the caller is not a participant in the conversation', async () => {
    mockFindConversationForParticipant.mockResolvedValueOnce(null);
    const res = await callPost();
    expect(res.status).toBe(404);
    expect(mockAddDmThreadFollower).not.toHaveBeenCalled();
  });

  it('returns 404 when the message does not exist or is soft-deleted', async () => {
    mockFindActiveMessage.mockResolvedValueOnce(null);
    const res = await callPost();
    expect(res.status).toBe(404);
  });

  it('returns 400 with parent_not_top_level when the message is a thread reply (followers attach to roots only)', async () => {
    mockFindActiveMessage.mockResolvedValueOnce({
      id: MSG_ID,
      conversationId: CONV_ID,
      parentId: 'some-other-parent',
    });
    const res = await callPost();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'parent_not_top_level' });
    expect(mockAddDmThreadFollower).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/messages/[conversationId]/[messageId]/follow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindConversationForParticipant.mockResolvedValue({
      id: CONV_ID,
      participant1Id: USER_ID,
      participant2Id: 'user_b',
    });
    mockFindMessageInConversation.mockResolvedValue({
      id: MSG_ID,
      conversationId: CONV_ID,
      parentId: null,
      isActive: true,
    });
    mockRemoveDmThreadFollower.mockResolvedValue(undefined);
  });

  it('removes the caller as a follower', async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(mockRemoveDmThreadFollower).toHaveBeenCalledWith(MSG_ID, USER_ID);
    expect(await res.json()).toEqual({ following: false });
  });

  it('still removes the follower row when the parent has been soft-deleted (idempotent unfollow)', async () => {
    // findMessageInConversation does NOT filter by isActive, so the route can
    // unfollow a tombstoned thread root (which findActiveMessage would have
    // returned null for, leaving stale subscriptions impossible to clear).
    mockFindMessageInConversation.mockResolvedValueOnce({
      id: MSG_ID,
      conversationId: CONV_ID,
      parentId: null,
      isActive: false,
    });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(mockRemoveDmThreadFollower).toHaveBeenCalledWith(MSG_ID, USER_ID);
  });

  it('returns 404 when the caller is not a participant', async () => {
    mockFindConversationForParticipant.mockResolvedValueOnce(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));
    const res = await callDelete();
    expect(res.status).toBe(401);
    expect(mockRemoveDmThreadFollower).not.toHaveBeenCalled();
  });

  it('returns 404 when the message does not belong to this conversation', async () => {
    mockFindMessageInConversation.mockResolvedValueOnce(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(mockRemoveDmThreadFollower).not.toHaveBeenCalled();
  });
});
