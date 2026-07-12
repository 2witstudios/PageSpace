import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockAbortStream,
  mockAbortStreamByMessageId,
  mockWasRecentlyFinishedHere,
  mockAbortConversationStreams,
  mockMarkAbortRequested,
  mockAwaitAbortSettled,
  mockReconcileDead,
} = vi.hoisted(() => ({
  mockAbortStream: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
  mockWasRecentlyFinishedHere: vi.fn(),
  mockAbortConversationStreams: vi.fn(),
  mockMarkAbortRequested: vi.fn(),
  mockAwaitAbortSettled: vi.fn(),
  mockReconcileDead: vi.fn(),
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStream: mockAbortStream,
  abortStreamByMessageId: mockAbortStreamByMessageId,
  wasRecentlyFinishedHere: mockWasRecentlyFinishedHere,
}));

vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({
  abortConversationStreams: mockAbortConversationStreams,
}));

vi.mock('@/lib/ai/core/stream-abort-mark', () => ({
  markAbortRequested: mockMarkAbortRequested,
  awaitAbortSettled: mockAwaitAbortSettled,
  reconcileDeadStreamRows: mockReconcileDead,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { abortStreamAnywhere } from '../abort-stream-anywhere';

const MISS = { aborted: false, reason: 'Stream not found or already completed' };
const HIT = { aborted: true, reason: 'Stream aborted by user request' };

beforeEach(() => {
  vi.clearAllMocks();
  mockAbortStream.mockReturnValue(MISS);
  mockAbortStreamByMessageId.mockReturnValue(MISS);
  mockAbortConversationStreams.mockResolvedValue({ aborted: [] });
  mockWasRecentlyFinishedHere.mockReturnValue(false);
  mockMarkAbortRequested.mockResolvedValue({ marked: [], failed: false });
  mockAwaitAbortSettled.mockResolvedValue({ aborted: [], reconcile: [], stillLive: [], code: 'not_found' });
  mockReconcileDead.mockResolvedValue(undefined);
});

describe('abortStreamAnywhere — naming precedence', () => {
  // messageId names the stream exactly; conversationId is only the fallback for the window before
  // either server-minted name exists client-side. Preferring the fallback would abort EVERY stream
  // on the conversation, not the one the user pointed at.
  it('prefers messageId over both other names', async () => {
    await abortStreamAnywhere({
      messageId: 'msg-1',
      streamId: 'stream-1',
      conversationId: 'conv-1',
      userId: 'user-a',
    });

    expect(mockAbortStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1', userId: 'user-a' });
    expect(mockAbortStream).not.toHaveBeenCalled();
    expect(mockAbortConversationStreams).not.toHaveBeenCalled();
  });

  it('prefers streamId over conversationId', async () => {
    await abortStreamAnywhere({ streamId: 'stream-1', conversationId: 'conv-1', userId: 'user-a' });

    expect(mockAbortStream).toHaveBeenCalledWith({ streamId: 'stream-1', userId: 'user-a' });
    expect(mockAbortConversationStreams).not.toHaveBeenCalled();
  });

  it('falls back to conversationId when it is the only name the client has', async () => {
    await abortStreamAnywhere({ conversationId: 'conv-1', userId: 'user-a' });

    expect(mockAbortConversationStreams).toHaveBeenCalledWith({ conversationId: 'conv-1', userId: 'user-a' });
  });
});

describe('abortStreamAnywhere — local first, then cross-instance', () => {
  // The common case, and it must stay instant: the stream is owned by THIS instance, so the abort
  // is a synchronous registry call. No DB round trip, no waiting.
  //
  // AND IT MUST NOT FALL THROUGH TO THE CROSS-INSTANCE PATH. Aborting the controller is what stops
  // the generation; the row's status is only bookkeeping, written fire-and-forget by
  // lifecycle.finish. If we marked and then polled for a terminal status our own abort had already
  // guaranteed, a slow or failed bookkeeping write would time the poll out against a heartbeat
  // that is still FRESH (it beat seconds ago) — reporting 'unconfirmed' and warning the user that
  // a generation is "still running and still billing" immediately after we killed it in-process.
  // That false alarm would fire on the most common path there is.
  it('never marks or waits on a precisely-named stream it aborted itself', async () => {
    mockAbortStreamByMessageId.mockReturnValue(HIT);

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockMarkAbortRequested).not.toHaveBeenCalled();
    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'a stream this instance owns, named by messageId',
      should: 'abort it locally and confirm immediately — no DB round trip, no poll',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: true, code: 'aborted' },
    });
  });

  it('never marks or waits on a stream named by streamId that it aborted itself', async () => {
    mockAbortStream.mockReturnValue(HIT);

    const result = await abortStreamAnywhere({ streamId: 'stream-1', userId: 'user-a' });

    expect(mockMarkAbortRequested).not.toHaveBeenCalled();
    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'a stream this instance owns, named by streamId',
      should: 'abort it locally and confirm immediately',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: true, code: 'aborted' },
    });
  });

  // The conversation path names a SET, so it cannot short-circuit wholesale — a sibling stream may
  // be running on another instance. But the rows we DID stop must be dropped from the wait, or
  // they bring the same false alarm back through the side door.
  it('does not wait on the conversation rows it aborted itself', async () => {
    mockAbortConversationStreams.mockResolvedValue({ aborted: ['msg-mine'] });
    // The mark still catches it: its terminal write is fire-and-forget, so the row can still read
    // 'streaming' at this instant.
    mockMarkAbortRequested.mockResolvedValue({ marked: ['msg-mine', 'msg-elsewhere'], failed: false });
    mockAwaitAbortSettled.mockResolvedValue({
      aborted: ['msg-elsewhere'], reconcile: [], stillLive: [], code: 'aborted',
    });

    await abortStreamAnywhere({ conversationId: 'conv-1', userId: 'user-a' });

    assert({
      given: 'a conversation with one stream we stopped and one owned elsewhere',
      should: 'wait only on the one we could not stop ourselves',
      actual: mockAwaitAbortSettled.mock.calls[0][0].messageIds,
      expected: ['msg-elsewhere'],
    });
  });

  it('confirms the abort when every stream on the conversation was stopped locally', async () => {
    mockAbortConversationStreams.mockResolvedValue({ aborted: ['msg-mine'] });
    mockMarkAbortRequested.mockResolvedValue({ marked: ['msg-mine'], failed: false });

    const result = await abortStreamAnywhere({ conversationId: 'conv-1', userId: 'user-a' });

    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'a conversation whose only stream this instance owned and stopped',
      should: 'confirm it stopped without polling for a row it does not need',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: true, code: 'aborted' },
    });
  });

  // The most common Stop of all: pressed as the last tokens render. `onFinish` has already
  // unregistered the controller (there is nothing left to abort) but has NOT yet written the
  // terminal status — that happens after message persistence and per-tool billing. So the registry
  // misses and the row still reads 'streaming' with a live heartbeat: it looks EXACTLY like a
  // stream owned by another instance.
  //
  // Escalate it and we mark a row nobody will ever consume, time out against that live heartbeat,
  // and tell the user their agent is "still running and still billing" — about a generation that
  // has already completed. It finished. Say nothing.
  it('stays silent about a stream that finished on this instance moments ago', async () => {
    mockAbortStreamByMessageId.mockReturnValue(MISS);
    mockWasRecentlyFinishedHere.mockReturnValue(true);

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockMarkAbortRequested).not.toHaveBeenCalled();
    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'a Stop pressed while the generation was finishing on THIS instance',
      should: 'report not_found — which the client treats as silent — never a false "still billing"',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: false, code: 'not_found' },
    });
  });

  // A Stop that could not even be RECORDED is not the benign "nothing was in flight". The client
  // stays silent on not_found by design, so collapsing the two means: the DB is down, the abort
  // reaches nobody, and the agent keeps generating and billing while the user is told nothing.
  it('warns when the abort request could not be recorded at all', async () => {
    mockMarkAbortRequested.mockResolvedValue({ marked: [], failed: true });

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    assert({
      given: 'the database refusing the write that records the abort',
      should: 'report unconfirmed, never the silent not_found',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: false, code: 'unconfirmed' },
    });
  });

  // THE BUG. The registry is in-process: an abort that lands on an instance which does not own the
  // stream used to find nothing and give up, while the generation ran on to completion — still
  // calling write tools, still billing.
  it('escalates to the owning instance when the local registry misses', async () => {
    mockAbortStreamByMessageId.mockReturnValue(MISS);
    mockMarkAbortRequested.mockResolvedValue({ marked: ['msg-1'], failed: false });
    mockAwaitAbortSettled.mockResolvedValue({
      aborted: ['msg-1'], reconcile: [], stillLive: [], code: 'aborted',
    });

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockMarkAbortRequested).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', userId: 'user-a' }),
    );
    assert({
      given: 'a stream running on another web instance',
      should: 'mark it, wait for its owner to stop it, and confirm',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: true, code: 'aborted' },
    });
  });

  it('reports a stream that could not be confirmed stopped as unconfirmed', async () => {
    mockMarkAbortRequested.mockResolvedValue({ marked: ['msg-1'], failed: false });
    mockAwaitAbortSettled.mockResolvedValue({
      aborted: [], reconcile: [], stillLive: ['msg-1'], code: 'unconfirmed',
    });

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    assert({
      given: 'a stream that was asked to stop and has not',
      should: 'refuse to claim it stopped — it is still running and still billing',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: false, code: 'unconfirmed' },
    });
  });

  // Nothing matched the mark's WHERE clause: either nothing was in flight, or the stream belongs
  // to someone else. The two are deliberately indistinguishable — telling them apart would confirm
  // the existence of another user's stream.
  it('reports not_found when nothing of the caller\'s was in flight', async () => {
    mockWasRecentlyFinishedHere.mockReturnValue(false);
  mockMarkAbortRequested.mockResolvedValue({ marked: [], failed: false });

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'an abort naming nothing the caller owns and has in flight',
      should: 'report not_found, which the client treats as silent',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: false, code: 'not_found' },
    });
  });

  // The owning process died without writing its terminal status. Nothing is running — but nothing
  // will ever settle the row either, so the caller has to do it, exactly as a takeover would.
  it('drives the row terminal when the owning instance is gone', async () => {
    mockMarkAbortRequested.mockResolvedValue({ marked: ['msg-1'], failed: false });
    mockAwaitAbortSettled.mockResolvedValue({
      aborted: ['msg-1'], reconcile: ['msg-1'], stillLive: [], code: 'aborted',
    });

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockReconcileDead).toHaveBeenCalledWith({ messageIds: ['msg-1'] });
    assert({
      given: 'a stream whose owning process crashed',
      should: 'report it stopped — and NOT warn the user that it is still running',
      actual: result.code,
      expected: 'aborted',
    });
  });
});
