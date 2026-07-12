import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSelectWhere, mockUpdateWhere, mockUpdateSet, mockAbortStreamByMessageId } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'messageId',
    channelId: 'channelId',
    conversationId: 'conversationId',
    status: 'status',
    parts: 'parts',
    startedAt: 'startedAt',
    lastHeartbeatAt: 'lastHeartbeatAt',
    completedAt: 'completedAt',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStreamByMessageId: mockAbortStreamByMessageId,
}));

import { takeOverConversationStreams } from '../stream-takeover';
import { inArray } from '@pagespace/db/operators';

const ARGS = { conversationId: 'conv-1', channelId: 'page-1' };

describe('takeOverConversationStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
  });

  it('given no in-flight stream on the conversation, should do nothing (the common case must be cheap)', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: [] });
    expect(mockAbortStreamByMessageId).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // The bug this exists for: a second send used to simply start a SECOND generation on
  // the same conversation. Two agents editing the same pages, two assistant rows, two
  // bills. The only pre-existing limiter was the credit gate's per-USER maxInFlight.
  it('given a live stream on the conversation, should abort it and drive its row terminal before the new generation starts', async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-live', userId: 'user-1' });
    expect(result).toEqual({ aborted: ['msg-live'], reconciled: ['msg-live'] });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted', parts: [], completedAt: expect.any(Date) }),
    );
  });

  // A crashed process leaves status='streaming' forever (the terminal write is
  // fire-and-forget). A 409 here would lock the user out of their own conversation for
  // as long as that row survives — strictly worse than the bug being fixed.
  it('given a STALE streaming row (crashed process), should NOT block the send and should reconcile the dead row', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-dead', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: ['msg-dead'] });
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted' }));
  });

  // A liveness guess must never gate the abort. The heartbeat can lag (a slow DB write,
  // a GC pause), and skipping the abort for a row we wrongly called dead would leave a
  // REAL generation running while we start a second one beside it — precisely what this
  // guard exists to prevent. Aborting an unknown messageId is free.
  it('given a row that looks stale, should STILL attempt the abort', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-looks-dead', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo },
    ]);

    await takeOverConversationStreams(ARGS);

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-looks-dead', userId: 'user-1' });
  });

  // The row is beating, so the generation is alive — we simply cannot reach it (it runs
  // on another web instance, or the registry refused a cross-user abort on a shared
  // conversation). Marking it 'aborted' with parts=[] would hide a LIVE stream from
  // every subscriber and destroy its only crash-recovery snapshot.
  it('given a LIVE row the abort registry would not stop, should leave its row untouched rather than lie about it', async () => {
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: [] });
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // On a SHARED conversation, user B sending must actually stop user A's generation.
  // The abort registry authorizes aborts against the stream's OWNER (an IDOR guard for
  // the client-facing /api/ai/abort endpoint), so issuing the abort as the caller would
  // be refused every time — leaving A's generation running, still calling tools, still
  // billing, while B's new one starts beside it. This is a trusted server path; the
  // caller's right to write to the conversation was established upstream.
  it("given a live stream owned by ANOTHER user, should abort it as its OWNER so the takeover actually stops it", async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-other-user', userId: 'user-A', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-other-user', userId: 'user-A' });
    expect(result.aborted).toEqual(['msg-other-user']);
    expect(result.reconciled).toEqual(['msg-other-user']);
  });

  it('given the reconcile UPDATE, should be conditional on status=streaming so a stream that ended on its own is not relabelled', async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);

    await takeOverConversationStreams(ARGS);

    const where = mockUpdateWhere.mock.calls[0][0] as { and: unknown[] };
    expect(where.and).toContainEqual({ eq: ['status', 'streaming'] });
    expect(vi.mocked(inArray)).toHaveBeenCalledWith('messageId', ['msg-live']);
  });

  // A failed takeover must degrade to the OLD behaviour (a concurrent generation), not
  // to a chat the user cannot send in.
  it('given the DB throws, should swallow it and let the send proceed', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('connection reset'));

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: [] });
  });
});
