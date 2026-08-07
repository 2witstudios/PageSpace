import { describe, it, expect } from 'vitest';
import { advanceRev } from '../advanceRev';
import { seedEmpty, type ConversationMessagesById } from '../seedEmpty';

const withRev = (rev: number | null): ConversationMessagesById => ({
  c1: { ...seedEmpty(), rev },
});

describe('advanceRev', () => {
  it('given a conversation with no entry, should leave the map untouched', () => {
    // The watermark is a claim about what THIS cache holds — materializing an entry
    // here would assert currency for a message list that was never loaded.
    const byConversationId: ConversationMessagesById = {};
    expect(advanceRev(byConversationId, { conversationId: 'missing', rev: 5 })).toBe(byConversationId);
  });

  it('given an entry with no baseline, should adopt the applied rev', () => {
    const next = advanceRev(withRev(null), { conversationId: 'c1', rev: 5 });
    expect(next.c1.rev).toBe(5);
  });

  it('given a higher applied rev, should advance the watermark', () => {
    const next = advanceRev(withRev(4), { conversationId: 'c1', rev: 5 });
    expect(next.c1.rev).toBe(5);
  });

  it('given a lower or equal applied rev, should keep the watermark and the same object identity', () => {
    // Monotonic: a redelivered event must never walk the watermark backwards into
    // re-applying writes the cache already holds. Identity is preserved so the
    // no-op cannot trigger a store subscriber re-render.
    const before = withRev(9);
    expect(advanceRev(before, { conversationId: 'c1', rev: 9 })).toBe(before);
    expect(advanceRev(before, { conversationId: 'c1', rev: 3 })).toBe(before);
  });

  it('given an unversioned rev (0), should leave a real watermark alone', () => {
    // rev 0 means "the emitter had no conversations row to bump" — it carries content,
    // never a watermark. See `lib/realtime/conversation-apply.ts`.
    const before = withRev(9);
    expect(advanceRev(before, { conversationId: 'c1', rev: 0 })).toBe(before);
    expect(advanceRev(withRev(null), { conversationId: 'c1', rev: 0 }).c1.rev).toBeNull();
  });

  it('given a non-finite rev, should leave the watermark alone', () => {
    const before = withRev(9);
    expect(advanceRev(before, { conversationId: 'c1', rev: Number.NaN })).toBe(before);
  });

  it('given an advance, should not mutate the input map', () => {
    const before = withRev(4);
    const next = advanceRev(before, { conversationId: 'c1', rev: 5 });
    expect(before.c1.rev).toBe(4);
    expect(next).not.toBe(before);
  });
});
