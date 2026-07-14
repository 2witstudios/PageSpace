import { describe, it, expect } from 'vitest';
import { evictStalePartial, canEvictStalePartial } from '../evictStalePartial';

const liveId = 'srv-msg-1';
const messages = [
  { id: 'u1', role: 'user' },
  { id: liveId, role: 'assistant' }, // the frozen half-streamed bubble
];
const seededParts = [{ type: 'text', text: 'partial reply' }];

describe('evictStalePartial', () => {
  it('given a checkpoint the bootstrap can seed from, should drop the local partial carrying the live messageId', () => {
    // Without this, the pending stream the rejoin adds under `liveId` is deduped straight back out
    // (dedupRemoteStreams / ChatMessagesArea drop a stream whose messageId is already in
    // `messages`), so the rejoined stream renders not one token and the user stares at a frozen
    // partial.
    expect(evictStalePartial(messages, liveId, seededParts)).toEqual([{ id: 'u1', role: 'user' }]);
  });

  it('should never touch the user turn — only the one message the server named', () => {
    const out = evictStalePartial(messages, liveId, seededParts);
    expect(out.some((m) => m.role === 'user')).toBe(true);
  });

  it('given an EMPTY checkpoint, should keep the partial and return the same reference', () => {
    // The checkpoint is debounced, so it is empty for a stream only a few parts old. Evicting
    // against it and then losing the SSE join (multi-instance: the multicast lives in another
    // process) makes the bootstrap drop the stream — leaving the user with NOTHING, which is
    // strictly worse than the frozen partial. Same reference so callers can pass this to a
    // setMessages updater without forcing a needless write.
    expect(evictStalePartial(messages, liveId, [])).toBe(messages);
  });

  it('given no checkpoint at all, should keep the partial', () => {
    expect(evictStalePartial(messages, liveId, undefined)).toBe(messages);
  });

  it('given a checkpoint of MALFORMED frames, should keep the partial', () => {
    // The gate must use the same predicate the bootstrap seeds with (isValidPartFrame). Counting
    // raw array length would call this checkpoint "safe to evict" while it in fact seeds nothing —
    // and a failed join would then leave an empty screen.
    const junk = [{ nope: true }, 'not-a-frame', null, 42];
    expect(evictStalePartial(messages, liveId, junk)).toBe(messages);
  });

  it('given a checkpoint that is only PARTLY malformed, should still evict — the valid frames will render', () => {
    expect(evictStalePartial(messages, liveId, [{ bogus: 1 }, ...seededParts])).toEqual([
      { id: 'u1', role: 'user' },
    ]);
  });

  it('given no message matching the live id, should return the list unchanged', () => {
    expect(evictStalePartial(messages, 'some-other-id', seededParts)).toEqual(messages);
  });

  describe('canEvictStalePartial (the gate the call sites ask before writing)', () => {
    it('given a checkpoint with seedable frames, should allow the eviction', () => {
      expect(canEvictStalePartial(seededParts)).toBe(true);
    });

    it('given an empty, absent, or all-malformed checkpoint, should refuse', () => {
      expect(canEvictStalePartial([])).toBe(false);
      expect(canEvictStalePartial(undefined)).toBe(false);
      expect(canEvictStalePartial([{ nope: true }, 'junk', null])).toBe(false);
    });

    it('should agree with evictStalePartial — the helper self-guards on the same rule', () => {
      // The gate exists so an unsafe checkpoint costs no state write; it must never disagree with
      // the helper it is gating, or a caller could evict against a checkpoint that seeds nothing.
      for (const parts of [seededParts, [], undefined, [{ bogus: 1 }]]) {
        const evicted = evictStalePartial(messages, liveId, parts);
        expect(evicted !== messages).toBe(canEvictStalePartial(parts));
      }
    });
  });
});
