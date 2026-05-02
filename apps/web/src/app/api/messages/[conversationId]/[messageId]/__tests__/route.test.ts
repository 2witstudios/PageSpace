/**
 * Contract tests for DELETE / PATCH /api/messages/[conversationId]/[messageId]
 *
 * After PR 7 (DM lifecycle + orphan GC), DELETE is a soft-delete (UPDATE
 * isActive=false) so attached files are not cascade-ripped from inbox previews
 * and other live messages. PATCH and the message lookup must skip soft-deleted
 * rows so a re-edit or second delete returns 404.
 *
 * Tests mock the dmMessageRepository seam (per unit-test-rubric §4) and assert
 * the persistence call payloads + audit emission, not ORM chain trivia.
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
const mockSoftDeleteMessage = vi.fn();
const mockEditActiveMessage = vi.fn();
vi.mock('@pagespace/lib/services/dm-message-repository', () => ({
  dmMessageRepository: {
    findConversationForParticipant: (...args: unknown[]) =>
      mockFindConversationForParticipant(...args),
    findActiveMessage: (...args: unknown[]) => mockFindActiveMessage(...args),
    softDeleteMessage: (...args: unknown[]) => mockSoftDeleteMessage(...args),
    editActiveMessage: (...args: unknown[]) => mockEditActiveMessage(...args),
  },
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

import { DELETE, PATCH } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const SENDER_ID = 'user_sender';
const OTHER_ID = 'user_other';
const CONVERSATION_ID = 'conv_1';
const MESSAGE_ID = 'msg_1';

const sessionAuth = (userId = SENDER_ID): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

const authError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockConversation = () => ({
  id: CONVERSATION_ID,
  participant1Id: SENDER_ID,
  participant2Id: OTHER_ID,
});

const mockMessage = (overrides: Partial<{
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? MESSAGE_ID,
  conversationId: overrides.conversationId ?? CONVERSATION_ID,
  senderId: overrides.senderId ?? SENDER_ID,
  content: overrides.content ?? 'hello',
  fileId: null,
  attachmentMeta: null,
  isRead: false,
  readAt: null,
  isEdited: false,
  editedAt: null,
  isActive: overrides.isActive ?? true,
  createdAt: new Date('2026-05-02T00:00:00Z'),
});

function makeDeleteRequest(): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}/${MESSAGE_ID}`,
    { method: 'DELETE' }
  );
}

function makePatchRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}/${MESSAGE_ID}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

const callDelete = () =>
  DELETE(makeDeleteRequest(), {
    params: Promise.resolve({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID }),
  });

const callPatch = (body: unknown) =>
  PATCH(makePatchRequest(body), {
    params: Promise.resolve({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID }),
  });

function setupHappyPath() {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
  mockFindConversationForParticipant.mockResolvedValue(mockConversation());
  mockFindActiveMessage.mockResolvedValue(mockMessage());
  mockSoftDeleteMessage.mockResolvedValue(1);
  mockEditActiveMessage.mockResolvedValue(1);
}

describe('DELETE /api/messages/[conversationId]/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it('DELETE_dmMessage_byOwner_softDeletesViaRepo_andDoesNotHardDelete', async () => {
    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(mockSoftDeleteMessage).toHaveBeenCalledWith(MESSAGE_ID);
    expect(mockSoftDeleteMessage).toHaveBeenCalledTimes(1);
  });

  it('DELETE_dmMessage_alreadySoftDeleted_returns404', async () => {
    // Repository signals "no active row found" for the lookup.
    mockFindActiveMessage.mockResolvedValue(null);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(mockSoftDeleteMessage).not.toHaveBeenCalled();
  });

  it('DELETE_dmMessage_byNonOwner_returns403_andDoesNotSoftDelete', async () => {
    mockFindActiveMessage.mockResolvedValue(mockMessage({ senderId: OTHER_ID }));

    const res = await callDelete();

    expect(res.status).toBe(403);
    expect(mockSoftDeleteMessage).not.toHaveBeenCalled();
  });

  it('DELETE_dmMessage_emitsAuditWithSoftTrue_soSiemCanDistinguish', async () => {
    await callDelete();

    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.delete',
        userId: SENDER_ID,
        resourceType: 'direct_message',
        resourceId: MESSAGE_ID,
        details: expect.objectContaining({
          conversationId: CONVERSATION_ID,
          soft: true,
        }),
      })
    );
  });

  it('DELETE_dmMessage_lookupSkipsSoftDeleted_byUsingFindActiveMessage', async () => {
    // Document the boundary obligation: the route must use the active-only
    // lookup so a second DELETE on the same message returns 404 deterministically.
    await callDelete();

    expect(mockFindActiveMessage).toHaveBeenCalledWith({
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  it('DELETE_dmMessage_whenNotParticipant_returns404', async () => {
    mockFindConversationForParticipant.mockResolvedValue(null);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(mockSoftDeleteMessage).not.toHaveBeenCalled();
  });

  it('DELETE_dmMessage_whenUnauthenticated_returns401', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));

    const res = await callDelete();

    expect(res.status).toBe(401);
    expect(mockSoftDeleteMessage).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/messages/[conversationId]/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it('PATCH_softDeletedMessage_returns404_withoutEditing', async () => {
    // Repository signals "no active row found" — soft-deleted rows are invisible
    // to edits, mirroring "message not found".
    mockFindActiveMessage.mockResolvedValue(null);

    const res = await callPatch({ content: 'edited' });

    expect(res.status).toBe(404);
    expect(mockEditActiveMessage).not.toHaveBeenCalled();
  });

  it('PATCH_dmMessage_byOwner_editsViaRepo_andReturnsUpdatedRow', async () => {
    const res = await callPatch({ content: 'edited' });

    expect(res.status).toBe(200);
    expect(mockEditActiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: MESSAGE_ID,
        content: 'edited',
        editedAt: expect.any(Date),
      })
    );

    const body = await res.json();
    expect(body).toMatchObject({
      id: MESSAGE_ID,
      content: 'edited',
      isEdited: true,
    });
  });

  it('PATCH_dmMessage_byNonOwner_returns403_andDoesNotEdit', async () => {
    mockFindActiveMessage.mockResolvedValue(mockMessage({ senderId: OTHER_ID }));

    const res = await callPatch({ content: 'sneaky edit' });

    expect(res.status).toBe(403);
    expect(mockEditActiveMessage).not.toHaveBeenCalled();
  });

  it('PATCH_emptyContent_returns400_andDoesNotEdit', async () => {
    const res = await callPatch({ content: '   ' });

    expect(res.status).toBe(400);
    expect(mockEditActiveMessage).not.toHaveBeenCalled();
  });
});
