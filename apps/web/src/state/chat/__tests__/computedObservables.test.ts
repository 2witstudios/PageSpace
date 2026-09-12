/**
 * SPIKE (@adobe/data adoption evidence) — selectors as `computed` Observe.
 *
 * The render path under adoption is `useObservableValues(() => ({ entry:
 * db.computed.conversationEntry(id) }))`. These tests drive the same
 * observables the React harness binds to, without React — so the propagation
 * semantics are proven in an environment where render tests are known-broken
 * (.pu worktree, dual-React dispatcher).
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { createChatDatabase } from '../createChatDatabase';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const collect = <T>(observe: (notify: (value: T) => void) => () => void) => {
  const values: T[] = [];
  const unobserve = observe((value) => values.push(value));
  return { values, unobserve };
};

describe('computed conversationEntry', () => {
  it('given a subscription, should emit the seeded empty entry immediately for an unknown conversation', () => {
    const { db } = createChatDatabase();

    const { values, unobserve } = collect(db.computed.conversationEntry('c1'));

    expect(values).toHaveLength(1);
    expect(values[0].messages).toEqual([]);
    expect(values[0].loadStatus).toBe('idle');
    unobserve();
  });

  it('given a committed transaction, should emit the new entry', () => {
    const { db } = createChatDatabase();
    const { values, unobserve } = collect(db.computed.conversationEntry('c1'));

    db.transactions.applyServerSnapshot({ conversationId: 'c1', generationToken: 0, messages: [msg('m1')] });

    expect(values[values.length - 1].messages).toEqual([msg('m1')]);
    expect(values[values.length - 1].loadStatus).toBe('loaded');
    unobserve();
  });

  it('given a transaction that changes another conversation, should not re-emit', () => {
    const { db } = createChatDatabase();
    db.transactions.seedConversation('c1');
    const { values, unobserve } = collect(db.computed.conversationEntry('c1'));
    const before = values.length;

    db.transactions.seedConversation('c2');

    expect(values).toHaveLength(before);
    unobserve();
  });

  it('given a no-op transaction, should not re-emit', () => {
    const { db } = createChatDatabase();
    db.transactions.applyServerSnapshot({ conversationId: 'c1', generationToken: 0, messages: [msg('m1')] });
    const { values, unobserve } = collect(db.computed.conversationEntry('c1'));
    const before = values.length;

    // Stale generation → applyLoad returns its input unchanged → zero writes.
    db.transactions.applyLoad({ conversationId: 'c1', generation: 999, messages: [msg('ignored')] });

    expect(values).toHaveLength(before);
    unobserve();
  });

  it('given unobserve, should stop emitting', () => {
    const { db } = createChatDatabase();
    const { values, unobserve } = collect(db.computed.conversationEntry('c1'));
    unobserve();
    const before = values.length;

    db.transactions.seedConversation('c1');

    expect(values).toHaveLength(before);
  });
});

describe('computed pageStreams', () => {
  const stream = (messageId: string, pageId: string, isOwn: boolean) => ({
    messageId,
    pageId,
    conversationId: 'c1',
    triggeredBy: { userId: 'u1', displayName: 'Alice' },
    isOwn,
  });

  it('given streams added on a page, should emit them', () => {
    const { db } = createChatDatabase();
    const { values, unobserve } = collect(db.computed.pageStreams('page-a'));

    db.transactions.addStream(stream('s1', 'page-a', false));

    expect(values[values.length - 1].map((s) => s.messageId)).toEqual(['s1']);
    unobserve();
  });

  it('given a stream added on another page, should not include it', () => {
    const { db } = createChatDatabase();
    const { values, unobserve } = collect(db.computed.pageStreams('page-a'));

    db.transactions.addStream(stream('s1', 'page-b', false));

    expect(values[values.length - 1]).toEqual([]);
    unobserve();
  });

  it('given a streamed token, should emit the appended parts', () => {
    const { db } = createChatDatabase();
    db.transactions.addStream(stream('s1', 'page-a', false));
    const { values, unobserve } = collect(db.computed.pageStreams('page-a'));

    db.transactions.appendPart({ messageId: 's1', part: { type: 'text', text: 'tok' } });

    expect(values[values.length - 1][0].parts).toEqual([{ type: 'text', text: 'tok' }]);
    unobserve();
  });

  it('given mixed own/remote streams, ownPageStreams should emit only the own ones', () => {
    const { db } = createChatDatabase();
    db.transactions.addStream(stream('s1', 'page-a', false));
    db.transactions.addStream(stream('s2', 'page-a', true));

    const { values, unobserve } = collect(db.computed.ownPageStreams('page-a'));

    expect(values[values.length - 1].map((s) => s.messageId)).toEqual(['s2']);
    unobserve();
  });
});
