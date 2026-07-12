import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSelectWhere,
  mockUpdateWhere,
  mockUpdateSet,
  mockAbortStreamByMessageId,
  mockLoggerInfo,
  mockLoggerWarn,
  mockMarkAsOwner,
  mockAwaitAbortSettled,
  mockReconcileDead,
} = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
  mockMarkAsOwner: vi.fn(),
  mockAwaitAbortSettled: vi.fn(),
  mockReconcileDead: vi.fn(),
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
  loggers: { ai: { info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStreamByMessageId: mockAbortStreamByMessageId,
}));

// The cross-instance mark is its own unit, with its own tests (stream-abort-mark.test.ts — where
// the `user_id` predicate that authorizes the whole mechanism is asserted). Stubbed here so these
// tests exercise what the TAKEOVER decides, not how the mark is written.
vi.mock('@/lib/ai/core/stream-abort-mark', () => ({
  markAbortRequestedAsOwner: mockMarkAsOwner,
  awaitAbortSettled: mockAwaitAbortSettled,
  reconcileDeadStreamRows: mockReconcileDead,
  TAKEOVER_SETTLE_TIMEOUT_MS: 1500,
}));

import { takeOverConversationStreams } from '../stream-takeover';
import { inArray } from '@pagespace/db/operators';

const ARGS = { conversationId: 'conv-1', channelId: 'page-1' };

const settled = (
  over: Partial<{
    aborted: string[];
    reconcile: string[];
    stillLive: string[];
    code: 'aborted' | 'not_found' | 'unconfirmed';
  }> = {},
) => ({
  aborted: [] as string[],
  reconcile: [] as string[],
  stillLive: [] as string[],
  code: 'not_found' as 'aborted' | 'not_found' | 'unconfirmed',
  ...over,
});

describe('takeOverConversationStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
    mockMarkAsOwner.mockImplementation(async ({ messageIds }: { messageIds: string[] }) => messageIds);
    mockAwaitAbortSettled.mockResolvedValue(settled());
    mockReconcileDead.mockResolvedValue(undefined);
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
  // A live row the local registry cannot stop belongs to ANOTHER WEB INSTANCE. It is asked to stop
  // (the mark), but until it confirms, its row must be left exactly as it is. Writing
  // `status='aborted', parts=[]` over a stream that is still generating would hide it from every
  // subscriber and destroy its only crash-recovery snapshot — while it kept calling tools and
  // kept billing. The mark is the ONLY write allowed here.
  it('given a LIVE row on another instance that has not stopped yet, should mark it but never terminal-write its row', async () => {
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);
    mockAwaitAbortSettled.mockResolvedValue(settled({ stillLive: ['msg-elsewhere'], code: 'unconfirmed' }));

    const result = await takeOverConversationStreams(ARGS);

    expect(mockMarkAsOwner).toHaveBeenCalledWith({ messageIds: ['msg-elsewhere'] });
    expect(result).toEqual({ aborted: [], reconciled: [] });
    // The reconcile UPDATE — the one that would write status/parts. It must not have run.
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // The capability this whole change exists to add. Before it, this send would have started a
  // SECOND generation beside a first that was still running: two agents, two sets of write tools,
  // two bills.
  it('given a live row on another instance that DOES stop, should report it as taken over', async () => {
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date() },
    ]);
    mockAwaitAbortSettled.mockResolvedValue(settled({ aborted: ['msg-elsewhere'], code: 'aborted' }));

    const result = await takeOverConversationStreams(ARGS);

    expect(result.aborted).toEqual(['msg-elsewhere']);
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

  // Partial failure. The aborts land FIRST — real in-process generations are stopped — and only
  // then does the reconcile UPDATE run. A single try/catch around the whole function reported
  // `{aborted: [], reconciled: []}` when that UPDATE threw: "nothing happened", while streams had
  // in fact been stopped. The caller and the logs were told the exact opposite of the truth.
  describe('partial failure: aborts landed but the reconcile UPDATE throws', () => {
    it('reports what it ACTUALLY aborted, rather than claiming nothing happened', async () => {
      mockSelectWhere.mockResolvedValue([
        { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date() },
      ]);
      mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));

      const result = await takeOverConversationStreams({
        conversationId: 'conv-1',
        channelId: 'page-1',
      });

      // The stream IS stopped. Saying otherwise is the bug.
      expect(result.aborted).toEqual(['msg-live']);
      // ...but its row was NOT driven terminal, and we must not pretend it was.
      expect(result.reconciled).toEqual([]);
    });

    it('still does not block the send — a failed takeover must never lock the conversation', async () => {
      mockSelectWhere.mockResolvedValue([
        { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date() },
      ]);
      mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));

      await expect(
        takeOverConversationStreams({ conversationId: 'conv-1', channelId: 'page-1' }),
      ).resolves.toBeDefined();
    });

    // The SELECT failing is different: nothing was stopped, so reporting nothing is correct.
    it('given the SELECT itself fails, reports nothing aborted — because nothing was', async () => {
      mockSelectWhere.mockRejectedValueOnce(new Error('db down'));

      const result = await takeOverConversationStreams({
        conversationId: 'conv-1',
        channelId: 'page-1',
      });

      expect(result).toEqual({ aborted: [], reconciled: [] });
    });
  });


  // A log that misreports is a signal that attests to nothing — the same defect as a test that
  // cannot fail. This one used to lie at exactly the moment an operator most needed the truth.
  describe('what the logs actually claim', () => {
    it('given a stream that was asked to stop and has not, must NOT claim it took over', async () => {
      // The successor to "could not be aborted from this instance". We CAN reach it now — but it
      // has not confirmed, so it is still generating, and this send is about to start a second
      // generation beside it. That is the moment an operator most needs the truth.
      mockSelectWhere.mockResolvedValue([
        { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date() },
      ]);
      mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'not found' });
      mockAwaitAbortSettled.mockResolvedValue(settled({ stillLive: ['msg-elsewhere'], code: 'unconfirmed' }));

      const result = await takeOverConversationStreams({
        conversationId: 'conv-1',
        channelId: 'page-1',
      });

      expect(result).toEqual({ aborted: [], reconciled: [] });

      // The warn tells the truth...
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('not confirmed stopped'),
        expect.objectContaining({ messageIds: ['msg-elsewhere'] }),
      );
      // ...and nothing may contradict it by claiming a takeover happened.
      const claimedTakeover = mockLoggerInfo.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('took over'),
      );
      expect(claimedTakeover).toBe(false);
    });

    it('given a stream it DID stop, says so', async () => {
      mockSelectWhere.mockResolvedValue([
        { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date() },
      ]);
      mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });

      await takeOverConversationStreams({ conversationId: 'conv-1', channelId: 'page-1' });

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('took over'),
        expect.objectContaining({ aborted: ['msg-live'] }),
      );
    });
  });

});
