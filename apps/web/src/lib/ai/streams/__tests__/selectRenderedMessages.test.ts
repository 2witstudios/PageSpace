import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { selectRenderedMessages } from '../selectRenderedMessages';
import type { ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const stream = (overrides: Partial<PendingStream> & { messageId: string }): PendingStream => ({
  pageId: 'page-1',
  conversationId: 'c1',
  triggeredBy: { userId: 'u1', displayName: 'User' },
  parts: [{ type: 'text', text: 'streaming...' }],
  isOwn: true,
  ...overrides,
});

const emptyEntry: ConversationCacheEntry = { messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'idle' };

describe('selectRenderedMessages', () => {
  it('given an empty cache and no streams, should return an empty array', () => {
    expect(selectRenderedMessages(emptyEntry, [])).toEqual([]);
  });

  it('given only confirmed messages, should render them all in mode "confirmed"', () => {
    const entry: ConversationCacheEntry = { ...emptyEntry, messages: [msg('m1'), msg('m2')] };
    const result = selectRenderedMessages(entry, []);
    expect(result).toEqual([
      { message: msg('m1'), mode: 'confirmed' },
      { message: msg('m2'), mode: 'confirmed' },
    ]);
  });

  it('given optimistic sends, should render them in mode "optimistic" after confirmed messages', () => {
    const entry: ConversationCacheEntry = {
      ...emptyEntry,
      messages: [msg('m1')],
      optimisticSends: [msg('opt1')],
    };
    const result = selectRenderedMessages(entry, []);
    expect(result.map((r) => r.mode)).toEqual(['confirmed', 'optimistic']);
    expect(result[1].message.id).toBe('opt1');
  });

  it('given an active stream whose id is not in the cache, should render it in mode "streaming"', () => {
    const result = selectRenderedMessages(emptyEntry, [stream({ messageId: 's1' })]);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe('streaming');
    expect(result[0].message.id).toBe('s1');
    expect(result[0].message.role).toBe('assistant');
  });

  // SPEC CHANGE (PR 5B, leaf 5.2 + absorbed E2 D task): a LIVE stream colliding with a
  // confirmed row is by definition fresher than the cached copy — the cached row is a
  // DB streaming-placeholder (loads carry includeStreaming=1 so history-rejoin can see
  // in-flight conversations). Cache-wins here froze the bubble at the placeholder
  // snapshot for the rest of the generation (the #2092 failure class, moved into the
  // cache). The stream renders IN PLACE of the cached row, so ordering is stable.
  it('given a stream whose messageId matches a confirmed row (includeStreaming placeholder), should render the live stream IN PLACE of the cached row', () => {
    const entry: ConversationCacheEntry = { ...emptyEntry, messages: [msg('m1'), msg('s1'), msg('m2')] };
    const result = selectRenderedMessages(entry, [
      stream({ messageId: 's1', parts: [{ type: 'text', text: 'live tokens' }] }),
    ]);
    expect(result.map((r) => r.message.id)).toEqual(['m1', 's1', 'm2']);
    expect(result[1].mode).toBe('streaming');
    expect(result[1].message.parts).toEqual([{ type: 'text', text: 'live tokens' }]);
    expect(result[1].message.role).toBe('assistant');
  });

  it('given a colliding stream rendered in place, should not ALSO append it at the end', () => {
    const entry: ConversationCacheEntry = { ...emptyEntry, messages: [msg('s1')] };
    const result = selectRenderedMessages(entry, [stream({ messageId: 's1' })]);
    expect(result).toHaveLength(1);
  });

  it('given one colliding and one fresh stream, should render the collision in place and append the fresh one', () => {
    const entry: ConversationCacheEntry = { ...emptyEntry, messages: [msg('s1'), msg('m1')] };
    const result = selectRenderedMessages(entry, [
      stream({ messageId: 's1', parts: [{ type: 'text', text: 'rejoined' }] }),
      stream({ messageId: 's2' }),
    ]);
    expect(result.map((r) => r.message.id)).toEqual(['s1', 'm1', 's2']);
    expect(result.map((r) => r.mode)).toEqual(['streaming', 'confirmed', 'streaming']);
  });

  it('given a stream whose messageId already appears in optimisticSends, should drop the stream (cache wins)', () => {
    const entry: ConversationCacheEntry = { ...emptyEntry, optimisticSends: [msg('s1')] };
    const result = selectRenderedMessages(entry, [stream({ messageId: 's1' })]);
    expect(result).toEqual([{ message: msg('s1'), mode: 'optimistic' }]);
  });

  it('given multiple concurrent streams, should order them by startedAt ascending', () => {
    const result = selectRenderedMessages(emptyEntry, [
      stream({ messageId: 'later', startedAt: '2024-01-01T00:00:02.000Z' }),
      stream({ messageId: 'earlier', startedAt: '2024-01-01T00:00:01.000Z' }),
    ]);
    expect(result.map((r) => r.message.id)).toEqual(['earlier', 'later']);
  });

  it('given a stream with no startedAt among others that have one, should not throw and should include it', () => {
    const result = selectRenderedMessages(emptyEntry, [
      stream({ messageId: 'has-time', startedAt: '2024-01-01T00:00:01.000Z' }),
      stream({ messageId: 'no-time' }),
    ]);
    expect(result.map((r) => r.message.id).sort()).toEqual(['has-time', 'no-time']);
  });

  it('given the no-startedAt stream first and the timestamped one second, should still not throw', () => {
    const result = selectRenderedMessages(emptyEntry, [
      stream({ messageId: 'no-time' }),
      stream({ messageId: 'has-time', startedAt: '2024-01-01T00:00:01.000Z' }),
    ]);
    expect(result.map((r) => r.message.id).sort()).toEqual(['has-time', 'no-time']);
  });

  it('given multiple streams with no startedAt at all, should not throw', () => {
    const result = selectRenderedMessages(emptyEntry, [stream({ messageId: 'a' }), stream({ messageId: 'b' })]);
    expect(result.map((r) => r.message.id).sort()).toEqual(['a', 'b']);
  });

  it('given a stream, should synthesize its assistant message from parts and startedAt', () => {
    const result = selectRenderedMessages(emptyEntry, [
      stream({ messageId: 's1', parts: [{ type: 'text', text: 'hi' }], startedAt: '2024-01-01T00:00:00.000Z' }),
    ]);
    expect(result[0].message.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect((result[0].message as UIMessage & { createdAt?: Date }).createdAt).toEqual(
      new Date('2024-01-01T00:00:00.000Z'),
    );
  });

  it('given confirmed, optimistic, and streaming entries together, should order them confirmed, optimistic, then streaming', () => {
    const entry: ConversationCacheEntry = {
      ...emptyEntry,
      messages: [msg('m1')],
      optimisticSends: [msg('opt1')],
    };
    const result = selectRenderedMessages(entry, [stream({ messageId: 's1' })]);
    expect(result.map((r) => r.mode)).toEqual(['confirmed', 'optimistic', 'streaming']);
  });

  it('switch-away/back: selecting a different conversation entry does not leak the first conversation streams', () => {
    const convA: ConversationCacheEntry = { ...emptyEntry, messages: [msg('a1')] };
    const convB: ConversationCacheEntry = { ...emptyEntry, messages: [msg('b1')] };
    const streamsForA = [stream({ messageId: 'a-stream', conversationId: 'a' })];

    const resultB = selectRenderedMessages(convB, []);
    expect(resultB).toEqual([{ message: msg('b1'), mode: 'confirmed' }]);

    // caller is responsible for pre-filtering streams by conversationId (selectChannelRemoteStreams);
    // re-selecting A with its own streams still works after B was rendered in between.
    const resultA = selectRenderedMessages(convA, streamsForA);
    expect(resultA.map((r) => r.message.id)).toEqual(['a1', 'a-stream']);
  });

  it('switch-away/back: while the completed stream entry lingers, it renders in place under the confirmed row position; once removed, the cache row renders confirmed', () => {
    const streamingEntry: ConversationCacheEntry = emptyEntry;
    const liveStreams = [stream({ messageId: 's1', parts: [{ type: 'text', text: 'full reply' }] })];
    const first = selectRenderedMessages(streamingEntry, liveStreams);
    expect(first.map((r) => r.mode)).toEqual(['streaming']);

    // stream_complete commits the confirmed row; the store entry's removal can lag one
    // render. In that window the (complete) stream parts render in place — identical
    // content, no flash. Once the entry is gone the cache row renders as confirmed.
    const settledEntry: ConversationCacheEntry = { ...emptyEntry, messages: [msg('s1')] };
    const during = selectRenderedMessages(settledEntry, liveStreams);
    expect(during.map((r) => r.message.id)).toEqual(['s1']);
    expect(during[0].mode).toBe('streaming');
    expect(during[0].message.parts).toEqual([{ type: 'text', text: 'full reply' }]);

    const after = selectRenderedMessages(settledEntry, []);
    expect(after).toEqual([{ message: msg('s1'), mode: 'confirmed' }]);
  });
});
