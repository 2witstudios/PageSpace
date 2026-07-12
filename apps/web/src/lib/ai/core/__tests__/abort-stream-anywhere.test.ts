import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockAbortStream,
  mockAbortStreamByMessageId,
  mockAbortConversationStreams,
  mockMarkAbortRequested,
  mockAwaitAbortSettled,
  mockReconcileDead,
} = vi.hoisted(() => ({
  mockAbortStream: vi.fn(),
  mockAbortStreamByMessageId: vi.fn(),
  mockAbortConversationStreams: vi.fn(),
  mockMarkAbortRequested: vi.fn(),
  mockAwaitAbortSettled: vi.fn(),
  mockReconcileDead: vi.fn(),
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStream: mockAbortStream,
  abortStreamByMessageId: mockAbortStreamByMessageId,
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
  mockMarkAbortRequested.mockResolvedValue([]);
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
  it('reports a locally-owned stream as aborted without waiting on anything', async () => {
    mockAbortStreamByMessageId.mockReturnValue(HIT);

    const result = await abortStreamAnywhere({ messageId: 'msg-1', userId: 'user-a' });

    expect(mockAwaitAbortSettled).not.toHaveBeenCalled();
    assert({
      given: 'a stream this instance owns',
      should: 'abort it locally and confirm immediately',
      actual: { aborted: result.aborted, code: result.code },
      expected: { aborted: true, code: 'aborted' },
    });
  });

  // THE BUG. The registry is in-process: an abort that lands on an instance which does not own the
  // stream used to find nothing and give up, while the generation ran on to completion — still
  // calling write tools, still billing.
  it('escalates to the owning instance when the local registry misses', async () => {
    mockAbortStreamByMessageId.mockReturnValue(MISS);
    mockMarkAbortRequested.mockResolvedValue(['msg-1']);
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
    mockMarkAbortRequested.mockResolvedValue(['msg-1']);
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
    mockMarkAbortRequested.mockResolvedValue([]);

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
    mockMarkAbortRequested.mockResolvedValue(['msg-1']);
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
