import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSelectWhere,
  mockUpdateSet,
  mockUpdateWhere,
  mockAbortStreamByMessageId,
  mockLoggerInfo,
  mockLoggerWarn,
  mockMarkAsOwner,
  mockWasRecentlyFinishedHere,
  mockAwaitAbortSettled,
  mockReconcileDead,
  mockMaterializeInterruptedStream,
} = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
  mockMarkAsOwner: vi.fn(),
  mockWasRecentlyFinishedHere: vi.fn(),
  mockAwaitAbortSettled: vi.fn(),
  mockReconcileDead: vi.fn(),
  mockMaterializeInterruptedStream: vi.fn(),
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

// The cross-instance mark is its own unit, with its own tests (stream-abort-mark.test.ts — where
// the `user_id` predicate that authorizes the whole mechanism is asserted). Stubbed here so these
// tests exercise what the TAKEOVER decides, not how the mark is written.
vi.mock('@/lib/ai/core/stream-abort-mark', () => ({
  markAbortRequestedAsOwner: mockMarkAsOwner,
  awaitAbortSettled: mockAwaitAbortSettled,
  reconcileDeadStreamRows: mockReconcileDead,
}));

// Materialization is its own unit with its own tests (materialize-interrupted-stream.test.ts —
// where the #2022 never-overwrite-complete guard and the settle/broadcast steps are asserted).
// Stubbed here so these tests exercise what the TAKEOVER decides to reconcile, not how a row is
// turned into an interrupted message.
vi.mock('@/lib/ai/core/materialize-interrupted-stream', () => ({
  materializeInterruptedStream: mockMaterializeInterruptedStream,
}));

vi.mock('@/lib/ai/core/stream-abort-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  abortStreamByMessageId: mockAbortStreamByMessageId,
  wasRecentlyFinishedHere: mockWasRecentlyFinishedHere,
}));

import { takeOverConversationStreams } from '../stream-takeover';

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
    mockAbortStreamByMessageId.mockReturnValue({ aborted: true, reason: '' });
    mockWasRecentlyFinishedHere.mockReturnValue(false);
    mockMarkAsOwner.mockImplementation(async ({ messageIds }: { messageIds: string[] }) => ({
      marked: messageIds,
      failed: false,
    }));
    mockAwaitAbortSettled.mockResolvedValue(settled());
    mockReconcileDead.mockResolvedValue(undefined);
    mockMaterializeInterruptedStream.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it('given no in-flight stream on the conversation, should do nothing (the common case must be cheap)', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: [] });
    expect(mockAbortStreamByMessageId).not.toHaveBeenCalled();
    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });

  // The bug this exists for: a second send used to simply start a SECOND generation on
  // the same conversation. Two agents editing the same pages, two assistant rows, two
  // bills. The only pre-existing limiter was the credit gate's per-USER maxInFlight.
  it('given a live stream on the conversation, should abort it and drive its session row terminal before the new generation starts', async () => {
    const parts = [{ type: 'text', text: 'partial' }];
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date(), parts },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-live', userId: 'user-1' });
    expect(result).toEqual({ aborted: ['msg-live'], reconciled: ['msg-live'] });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted', parts: [] }),
    );
  });

  // THE regression this fix guards against: a row we JUST aborted ourselves, in THIS process, is
  // NOT provably dead — its own generation is moments from running its own onFinish, which
  // persists the full, correct content as status='interrupted' via the normal execute-end path.
  // Materializing here too would race that natural write with an OLDER debounced checkpoint and
  // could silently overwrite fresher content with staler content — the exact silent-loss bug this
  // whole feature exists to prevent, reintroduced by conflating "we stopped it" with "it is dead".
  it('given a row we just aborted ourselves (fresh heartbeat — its own onFinish is about to persist the real content), must NOT materialize it', async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date(), parts: [{ type: 'text', text: 'stale-checkpoint' }] },
    ]);

    await takeOverConversationStreams(ARGS);

    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });

  // The other half of the same fix: a row whose heartbeat is ALREADY stale (the process died
  // before we ever tried to abort it) has no generation left to persist anything — this is the
  // only chance its content gets saved, so it materializes even though `abortStreamByMessageId`
  // also reports it (the abort is a free no-op against an unknown/dead registry entry).
  it('given a row whose heartbeat was ALREADY stale before this takeover touched it, materializes it (no generation is left to do it)', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-abandoned', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo, parts: [{ type: 'text', text: 'last known content' }] },
    ]);

    await takeOverConversationStreams(ARGS);

    expect(mockMaterializeInterruptedStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-abandoned' }),
    );
    // And the cheap session-row wipe must NOT ALSO run for this row — materialize already
    // settles the session row itself; a second bulk wipe here would be redundant.
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // A crashed process leaves status='streaming' forever (the terminal write is
  // fire-and-forget). A 409 here would lock the user out of their own conversation for
  // as long as that row survives — strictly worse than the bug being fixed.
  it('given a STALE streaming row (crashed process), should NOT block the send and should materialize the dead row', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-dead', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo, parts: [] },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: ['msg-dead'] });
    expect(mockMaterializeInterruptedStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-dead' }),
    );
  });

  // A liveness guess must never gate the abort. The heartbeat can lag (a slow DB write,
  // a GC pause), and skipping the abort for a row we wrongly called dead would leave a
  // REAL generation running while we start a second one beside it — precisely what this
  // guard exists to prevent. Aborting an unknown messageId is free.
  it('given a row that looks stale, should STILL attempt the abort', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-looks-dead', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo, parts: [] },
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
  it('given a LIVE row on another instance that has not stopped yet, should mark it but never materialize its row', async () => {
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date(), parts: [] },
    ]);
    mockAwaitAbortSettled.mockResolvedValue(settled({ stillLive: ['msg-elsewhere'], code: 'unconfirmed' }));

    const result = await takeOverConversationStreams(ARGS);

    expect(mockMarkAsOwner).toHaveBeenCalledWith({ messageIds: ['msg-elsewhere'] });
    expect(result).toEqual({ aborted: [], reconciled: [] });
    // The reconcile write — the one that would materialize the row. It must not have run.
    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });

  // The capability this whole change exists to add. Before it, this send would have started a
  // SECOND generation beside a first that was still running: two agents, two sets of write tools,
  // two bills.
  it('given a live row on another instance that DOES stop, should report it as taken over', async () => {
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), startedAt: new Date(), parts: [] },
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
      { messageId: 'msg-other-user', userId: 'user-A', lastHeartbeatAt: new Date(), startedAt: new Date(), parts: [] },
    ]);

    const result = await takeOverConversationStreams(ARGS);

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-other-user', userId: 'user-A' });
    expect(result.aborted).toEqual(['msg-other-user']);
    expect(result.reconciled).toEqual(['msg-other-user']);
    // Fresh heartbeat, just aborted by us — its own onFinish will persist the real content.
    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });

  // Multiple in-flight rows reconciled in the same takeover must each get their OWN
  // materialization call, carrying their OWN parts snapshot — a shared/blended write here
  // would cross-contaminate two different replies.
  it('given two dead rows in the same takeover, should materialize each independently with its own parts', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockAbortStreamByMessageId.mockReturnValue({ aborted: false, reason: 'Stream not found or already completed' });
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-a', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo, parts: [{ type: 'text', text: 'A' }] },
      { messageId: 'msg-b', userId: 'user-1', lastHeartbeatAt: longAgo, startedAt: longAgo, parts: [{ type: 'text', text: 'B' }] },
    ]);

    await takeOverConversationStreams(ARGS);

    expect(mockMaterializeInterruptedStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-a', parts: [{ type: 'text', text: 'A' }] }),
    );
    expect(mockMaterializeInterruptedStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-b', parts: [{ type: 'text', text: 'B' }] }),
    );
  });

  // A failed takeover must degrade to the OLD behaviour (a concurrent generation), not
  // to a chat the user cannot send in.
  it('given the DB throws, should swallow it and let the send proceed', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('connection reset'));

    const result = await takeOverConversationStreams(ARGS);

    expect(result).toEqual({ aborted: [], reconciled: [] });
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

  // A log that misreports is a signal that attests to nothing — the same defect as a test that
  // cannot fail. This one used to lie at exactly the moment an operator most needed the truth.
  describe('what the logs actually claim', () => {
    it('given a stream that was asked to stop and has not, must NOT claim it took over', async () => {
      // The successor to "could not be aborted from this instance". We CAN reach it now — but it
      // has not confirmed, so it is still generating, and this send is about to start a second
      // generation beside it. That is the moment an operator most needs the truth.
      mockSelectWhere.mockResolvedValue([
        { messageId: 'msg-elsewhere', userId: 'user-1', lastHeartbeatAt: new Date(), parts: [] },
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
        { messageId: 'msg-live', userId: 'user-1', lastHeartbeatAt: new Date(), parts: [] },
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
