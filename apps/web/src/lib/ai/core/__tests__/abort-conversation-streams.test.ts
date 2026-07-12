import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSelectWhere, mockAbortStreamByMessageId } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds) => ({ kind: 'and', conds })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    conversationId: 'ai_stream_sessions.conversation_id',
    userId: 'ai_stream_sessions.user_id',
    status: 'ai_stream_sessions.status',
  },
}));

vi.mock('../stream-abort-registry', () => ({
  abortStreamByMessageId: mockAbortStreamByMessageId,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { abortConversationStreams } from '../abort-conversation-streams';

describe('abortConversationStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([]);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
  });

  // THE WINDOW THIS EXISTS FOR. streamId and messageId are both minted server-side and unknown to
  // the client until the response headers land — but a real agent send spends 0.5-3s before that
  // (auth, rate limit, DB reads, context assembly, provider connect). Stop pressed in that window
  // had NOTHING to name: the abort was a guaranteed no-op, the fetch was cancelled, and the button
  // flipped back to Send — while the server, which deliberately survives client disconnect, kept
  // generating, kept running write tools, and kept billing.
  it('aborts the in-flight stream named only by its conversation', async () => {
    mockSelectWhere.mockResolvedValue([{ messageId: 'msg-1' }]);

    const result = await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

    expect(result.aborted).toEqual(['msg-1']);
    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1', userId: 'user-1' });
  });

  it('aborts every in-flight stream on the conversation', async () => {
    mockSelectWhere.mockResolvedValue([{ messageId: 'msg-1' }, { messageId: 'msg-2' }]);

    const result = await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

    expect(result.aborted).toEqual(['msg-1', 'msg-2']);
  });

  describe('authorization', () => {
    // DELIBERATELY STRICTER THAN THE TAKEOVER. takeOverConversationStreams aborts as the STREAM's
    // owner (row.userId), because a second send on a SHARED conversation must be able to take over
    // a co-member's generation. This is an explicit user STOP, and it may only ever stop the
    // caller's OWN streams — otherwise naming someone else's conversation would kill their agent
    // mid-answer.
    it("scopes the query to the CALLER's own streams — a user cannot stop someone else's by naming their conversation", async () => {
      await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

      const predicate = mockSelectWhere.mock.calls[0][0] as {
        conds: Array<{ field?: string; value?: unknown }>;
      };
      const userCond = predicate.conds.find((c) => c.field === 'ai_stream_sessions.user_id');

      expect(userCond).toBeDefined();
      expect(userCond?.value).toBe('user-1');
    });

    it('passes the CALLER id to the registry, so its ownership re-check is meaningful', async () => {
      mockSelectWhere.mockResolvedValue([{ messageId: 'msg-1' }]);

      await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

      // NOT the row's userId — that is the takeover's rule, and it would defeat the registry's guard.
      expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1', userId: 'user-1' });
    });

    it('only considers rows still streaming', async () => {
      await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

      const predicate = mockSelectWhere.mock.calls[0][0] as {
        conds: Array<{ field?: string; value?: unknown }>;
      };
      const statusCond = predicate.conds.find((c) => c.field === 'ai_stream_sessions.status');
      expect(statusCond?.value).toBe('streaming');
    });
  });

  describe('honest reporting', () => {
    it('given no in-flight stream, says so rather than claiming success', async () => {
      const result = await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

      expect(result.aborted).toEqual([]);
      expect(result.reason).toBe('No in-flight stream on this conversation');
    });

    // The abort registry is in-process. A stream owned by another web instance is real and running
    // but cannot be stopped from here — reporting that as success would be a lie.
    it('given a stream that exists but could not be aborted from this instance, says so', async () => {
      mockSelectWhere.mockResolvedValue([{ messageId: 'msg-elsewhere' }]);
      mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'not found' });

      const result = await abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' });

      expect(result.aborted).toEqual([]);
      expect(result.reason).toContain('none could be aborted from this instance');
    });

    it('given the lookup throws, does not throw at the caller', async () => {
      mockSelectWhere.mockRejectedValue(new Error('db down'));

      await expect(
        abortConversationStreams({ conversationId: 'conv-1', userId: 'user-1' }),
      ).resolves.toEqual({ aborted: [], reason: 'Lookup failed' });
    });
  });
});
