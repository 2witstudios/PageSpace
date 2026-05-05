/**
 * Contract tests for POST/DELETE /api/messages/[conversationId]/[messageId]/reactions
 *
 * Mirrors the channel-side reaction route at parity. Tests mock the
 * dmMessageRepository seam so assertions exercise authz, validation,
 * persistence delegation, and the realtime broadcast contract — not ORM
 * internals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

const mockFindConversationForParticipant = vi.fn();
const mockFindDmMessageInConversation = vi.fn();
const mockAddDmReaction = vi.fn();
const mockLoadDmReactionWithUser = vi.fn();
const mockRemoveDmReaction = vi.fn();
vi.mock('@pagespace/lib/services/dm-message-repository', () => ({
  dmMessageRepository: {
    findConversationForParticipant: (...args: unknown[]) =>
      mockFindConversationForParticipant(...args),
    findDmMessageInConversation: (...args: unknown[]) =>
      mockFindDmMessageInConversation(...args),
    addDmReaction: (...args: unknown[]) => mockAddDmReaction(...args),
    loadDmReactionWithUser: (...args: unknown[]) =>
      mockLoadDmReactionWithUser(...args),
    removeDmReaction: (...args: unknown[]) => mockRemoveDmReaction(...args),
  },
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    realtime: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const SENDER_ID = 'user_sender';
const OTHER_ID = 'user_other';
const STRANGER_ID = 'user_stranger';
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

const mockMessage = () => ({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: SENDER_ID,
  content: 'hello',
  fileId: null,
  attachmentMeta: null,
  isRead: false,
  readAt: null,
  isEdited: false,
  editedAt: null,
  isActive: true,
  deletedAt: null,
  createdAt: new Date('2026-05-02T00:00:00Z'),
});

const mockReactionRow = () => ({ id: 'reaction_1' });

const mockReactionWithUser = () => ({
  id: 'reaction_1',
  messageId: MESSAGE_ID,
  userId: SENDER_ID,
  emoji: '👍',
  createdAt: new Date('2026-05-02T00:00:01Z'),
  user: { id: SENDER_ID, name: 'Sender' },
});

function makePostRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}/${MESSAGE_ID}/reactions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeDeleteRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}/${MESSAGE_ID}/reactions`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

const callPost = (body: unknown) =>
  POST(makePostRequest(body), {
    params: Promise.resolve({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
    }),
  });

const callDelete = (body: unknown) =>
  DELETE(makeDeleteRequest(body), {
    params: Promise.resolve({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
    }),
  });

function setupHappyPath() {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
  mockFindConversationForParticipant.mockResolvedValue(mockConversation());
  mockFindDmMessageInConversation.mockResolvedValue(mockMessage());
  mockAddDmReaction.mockResolvedValue(mockReactionRow());
  mockLoadDmReactionWithUser.mockResolvedValue(mockReactionWithUser());
  mockRemoveDmReaction.mockResolvedValue(1);
}

function captureRealtimeBroadcasts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'))
    .map(([, init]) => {
      const body = (init as RequestInit).body;
      if (typeof body !== 'string') return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })
    .filter(
      (p): p is { channelId: string; event: string; payload: unknown } => p !== null
    );
}

describe('POST /api/messages/[conversationId]/[messageId]/reactions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setupHappyPath();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRealtimeUrl === undefined) {
      delete process.env.INTERNAL_REALTIME_URL;
    } else {
      process.env.INTERNAL_REALTIME_URL = originalRealtimeUrl;
    }
  });

  it('persists the reaction via the repository and returns the row with user joined', async () => {
    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'a participant adding 👍 to a DM message',
      should: 'delegate the insert to addDmReaction with the (messageId, userId, emoji) triple and return 201',
      actual: {
        status: res.status,
        addArgs: mockAddDmReaction.mock.calls[0]?.[0],
      },
      expected: {
        status: 201,
        addArgs: { messageId: MESSAGE_ID, userId: SENDER_ID, emoji: '👍' },
      },
    });

    const body = await res.json();
    assert({
      given: 'a successful reaction add',
      should: 'return the loaded reaction row including the user relation',
      actual: body,
      expected: {
        ...mockReactionWithUser(),
        createdAt: mockReactionWithUser().createdAt.toISOString(),
      },
    });
  });

  it('broadcasts reaction_added on the dm:{conversationId} room with the loaded reaction payload', async () => {
    await callPost({ emoji: '👍' });

    const broadcasts = captureRealtimeBroadcasts(fetchMock);
    assert({
      given: 'a successful DM reaction add',
      should: 'emit one reaction_added event on dm:{conversationId} carrying the loaded reaction (parity with channels)',
      actual: {
        count: broadcasts.length,
        first: broadcasts[0] && {
          channelId: broadcasts[0].channelId,
          event: broadcasts[0].event,
          payload: broadcasts[0].payload,
        },
      },
      expected: {
        count: 1,
        first: {
          channelId: `dm:${CONVERSATION_ID}`,
          event: 'reaction_added',
          payload: {
            messageId: MESSAGE_ID,
            // Reaction goes through JSON.stringify which converts Date to ISO string.
            reaction: {
              ...mockReactionWithUser(),
              createdAt: mockReactionWithUser().createdAt.toISOString(),
            },
          },
        },
      },
    });
  });

  it('returns 404 when the caller is not a participant of the conversation', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth(STRANGER_ID));
    mockFindConversationForParticipant.mockResolvedValue(null);

    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'a non-participant attempting to react',
      should: 'reject with 404 (centralized via findConversationForParticipant) without ever calling addDmReaction',
      actual: {
        status: res.status,
        addCalled: mockAddDmReaction.mock.calls.length,
      },
      expected: { status: 404, addCalled: 0 },
    });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));

    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'an unauthenticated request',
      should: 'short-circuit with 401 before any repository call',
      actual: {
        status: res.status,
        findConvCalled: mockFindConversationForParticipant.mock.calls.length,
        addCalled: mockAddDmReaction.mock.calls.length,
      },
      expected: { status: 401, findConvCalled: 0, addCalled: 0 },
    });
  });

  it('returns 400 when emoji is missing', async () => {
    const res = await callPost({});

    assert({
      given: 'a body with no emoji',
      should: 'return 400 without inserting',
      actual: {
        status: res.status,
        addCalled: mockAddDmReaction.mock.calls.length,
      },
      expected: { status: 400, addCalled: 0 },
    });
  });

  it('returns 404 when the message belongs to a different conversation', async () => {
    mockFindDmMessageInConversation.mockResolvedValue(null);

    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'a stolen messageId from a different conversation',
      should: 'return 404 because findDmMessageInConversation scopes by conversationId',
      actual: {
        status: res.status,
        addCalled: mockAddDmReaction.mock.calls.length,
      },
      expected: { status: 404, addCalled: 0 },
    });
  });

  it('returns 409 when the unique index rejects a duplicate (messageId, userId, emoji)', async () => {
    // The DB layer — not the route — enforces no-dup. The route just maps the
    // 23505 unique-violation back to a 409.
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockAddDmReaction.mockRejectedValueOnce(dupErr);

    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'a duplicate reaction (Postgres 23505 from the unique index)',
      should: 'return 409 — never pre-check in app code',
      actual: res.status,
      expected: 409,
    });
  });

  it('does not broadcast when INTERNAL_REALTIME_URL is unset', async () => {
    delete process.env.INTERNAL_REALTIME_URL;

    const res = await callPost({ emoji: '👍' });

    assert({
      given: 'a deployment without the realtime sidecar configured',
      should: 'still persist the reaction (201) but skip the broadcast hop entirely',
      actual: {
        status: res.status,
        broadcasts: captureRealtimeBroadcasts(fetchMock).length,
      },
      expected: { status: 201, broadcasts: 0 },
    });
  });
});

describe('DELETE /api/messages/[conversationId]/[messageId]/reactions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setupHappyPath();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRealtimeUrl === undefined) {
      delete process.env.INTERNAL_REALTIME_URL;
    } else {
      process.env.INTERNAL_REALTIME_URL = originalRealtimeUrl;
    }
  });

  it('removes the reaction via the repository scoped to the caller', async () => {
    const res = await callDelete({ emoji: '👍' });

    assert({
      given: 'a participant removing their own 👍',
      should: 'delegate to removeDmReaction with (messageId, userId, emoji) and return 200',
      actual: {
        status: res.status,
        removeArgs: mockRemoveDmReaction.mock.calls[0]?.[0],
      },
      expected: {
        status: 200,
        removeArgs: { messageId: MESSAGE_ID, userId: SENDER_ID, emoji: '👍' },
      },
    });
  });

  it('broadcasts reaction_removed on the dm:{conversationId} room', async () => {
    await callDelete({ emoji: '👍' });

    const broadcasts = captureRealtimeBroadcasts(fetchMock);
    assert({
      given: 'a successful DM reaction removal',
      should: 'emit one reaction_removed event with messageId+emoji+userId so peers can drop the chip without a re-fetch',
      actual: broadcasts[0] && {
        channelId: broadcasts[0].channelId,
        event: broadcasts[0].event,
        payload: broadcasts[0].payload,
      },
      expected: {
        channelId: `dm:${CONVERSATION_ID}`,
        event: 'reaction_removed',
        payload: { messageId: MESSAGE_ID, emoji: '👍', userId: SENDER_ID },
      },
    });
  });

  it('returns 404 when the reaction did not exist (no-op delete)', async () => {
    mockRemoveDmReaction.mockResolvedValue(0);

    const res = await callDelete({ emoji: '👍' });

    assert({
      given: 'a delete that matched no rows',
      should: 'return 404 instead of pretending success — and emit no broadcast',
      actual: {
        status: res.status,
        broadcasts: captureRealtimeBroadcasts(fetchMock).length,
      },
      expected: { status: 404, broadcasts: 0 },
    });
  });

  it('returns 404 when caller is not a participant', async () => {
    mockFindConversationForParticipant.mockResolvedValue(null);

    const res = await callDelete({ emoji: '👍' });

    assert({
      given: 'a non-participant attempting to remove a reaction',
      should: 'reject with 404 without calling removeDmReaction',
      actual: {
        status: res.status,
        removeCalled: mockRemoveDmReaction.mock.calls.length,
      },
      expected: { status: 404, removeCalled: 0 },
    });
  });
});
