import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { mergeServerMessagesWithOwnStream } from '@/hooks/useActiveStream';

// The real store: this helper's whole job is reading it, and there is no process boundary to fake.
const seedStream = (over: { messageId: string; conversationId: string; isOwn: boolean }) => {
  usePendingStreamsStore.getState().addStream({
    pageId: 'page-1',
    triggeredBy: { userId: 'u1', displayName: 'Me' },
    startedAt: '2024-01-01T00:00:00.000Z',
    parts: [{ type: 'text', text: 'live so far' }],
    ...over,
  });
};

const msg = (id: string, role: 'user' | 'assistant'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage;

describe('mergeServerMessagesWithOwnStream', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  it('given no own stream for the conversation, should return the server list untouched', () => {
    const server = [msg('u1', 'user'), msg('a1', 'assistant')];
    expect(mergeServerMessagesWithOwnStream(server, 'conv-C', [])).toBe(server);
  });

  it('given no conversation resolved, should return the server list untouched', () => {
    seedStream({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
    const server = [msg('u1', 'user')];
    expect(mergeServerMessagesWithOwnStream(server, null, [msg('m1', 'assistant')])).toBe(server);
  });

  // THE reason this helper exists. A whole-array write landing mid-send hands useOwnStreamMirror an
  // array whose newest row is somebody else's message — the previous turn's, or another TAB of this
  // same user (`isOwn` is browserSessionId-scoped, so no collaborator needed). The mirror reads
  // that as the SDK renaming our stream, re-targets onto a finished message, and Stop then aborts
  // an id the server has no stream for: not_found, silent, while the generation keeps billing.
  it('given we are locally streaming and the DB history ends with a FOREIGN assistant, should put OUR message last', () => {
    seedStream({ messageId: 'mine', conversationId: 'conv-C', isOwn: true });
    const server = [msg('u1', 'user'), msg('their-finished-reply', 'assistant')];

    const merged = mergeServerMessagesWithOwnStream(server, 'conv-C', [msg('mine', 'assistant')]);

    expect(merged[merged.length - 1].id).toBe('mine');
    expect(merged.map((m) => m.id)).toEqual(['u1', 'their-finished-reply', 'mine']);
  });

  // THE case that must NOT merge. A stream this tab is not locally producing — rejoined by the
  // bootstrap after a refresh — renders straight from the pending-streams store, and both renderers
  // drop a store stream whose messageId already appears in `messages`. Synthesizing that id INTO
  // `messages` dedupes the live bubble out of the renderer and freezes it at the merged snapshot
  // for the rest of the generation. (Not merging cannot mislead the mirror either: it never latches
  // while our status is idle, which is precisely when a stream is bootstrapped rather than local.)
  it('given the own stream is BOOTSTRAPPED (not in our local array), should NOT merge — that would freeze its live bubble', () => {
    seedStream({ messageId: 'rejoined', conversationId: 'conv-C', isOwn: true });
    const server = [msg('u1', 'user')];

    // Our local array does not contain the stream: useChat is idle, the store is the live bubble.
    expect(mergeServerMessagesWithOwnStream(server, 'conv-C', [msg('u1', 'user')])).toBe(server);
  });

  it('given a REMOTE stream for the conversation, should not merge it — it is not ours to reconcile', () => {
    seedStream({ messageId: 'theirs', conversationId: 'conv-C', isOwn: false });
    const server = [msg('u1', 'user')];
    expect(mergeServerMessagesWithOwnStream(server, 'conv-C', [msg('theirs', 'assistant')])).toBe(server);
  });

  it('given an own stream in a DIFFERENT conversation, should not merge it', () => {
    seedStream({ messageId: 'mine', conversationId: 'conv-OTHER', isOwn: true });
    const server = [msg('u1', 'user')];
    expect(mergeServerMessagesWithOwnStream(server, 'conv-C', [msg('mine', 'assistant')])).toBe(server);
  });
});
