import { describe, it, expect } from 'vitest';
import { applyStartLoad } from '../applyStartLoad';
import { applyLoad } from '../applyLoad';
import { applyRemoteUserMessage } from '../applyRemoteUserMessage';
import { applyConversationEdit } from '../applyConversationEdit';
import { applyConversationDelete } from '../applyConversationDelete';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string, text = ''): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });

/**
 * Regression coverage for a race identified in PR #2075 review
 * (chatgpt-codex-connector). There is no ordering guarantee between a
 * conversation load's DB snapshot and a live socket mutation for the same
 * conversation — either can "win the race" against the other:
 *
 * - A first fix bumped `loadGeneration` on every live mutation so any
 *   in-flight load became stale and got rejected. That closed the original
 *   finding (a stale load clobbering a live append/edit/delete) but
 *   over-corrected: a live mutation now also invalidated a load whose
 *   response already reflected that same mutation (or was otherwise a
 *   fully valid, later snapshot), discarding the ENTIRE load response —
 *   including unrelated history the mutation knew nothing about.
 * - The actual fix (`replayPendingMutations`): `loadGeneration` only guards
 *   against a load superseded by a *newer `startLoad`* (unchanged, original
 *   purpose). Live mutations no longer touch `loadGeneration` at all —
 *   instead they're recorded in `pendingMutationsSinceLoad` and replayed
 *   onto the load's snapshot when it resolves, so the result always
 *   reflects both sources regardless of which arrived first.
 */
describe('applyLoad reconciliation with concurrent live mutations', () => {
  it('given a remote user message arrives while a load is in flight and the stale snapshot predates it, should NOT be clobbered', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyRemoteUserMessage(store, { conversationId: 'c1', message: msg('live-1', 'hello') });

    const staleSnapshot: UIMessage[] = [msg('m0', 'existing')];
    store = applyLoad(store, { conversationId: 'c1', generation, messages: staleSnapshot });

    expect(store.c1.messages.map((m) => m.id)).toEqual(['m0', 'live-1']);
  });

  it('given a remote user message arrives and the load response ALSO already includes it (Codex finding: over-aggressive invalidation), should keep the full load response with no duplicate', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyRemoteUserMessage(store, { conversationId: 'c1', message: msg('shared-1', 'hi') });

    // The fetch response is a fully fresh snapshot that independently already
    // contains shared-1, plus unrelated history the live mutation never saw.
    const freshSnapshot: UIMessage[] = [msg('historical-1'), msg('historical-2'), msg('shared-1', 'hi')];
    store = applyLoad(store, { conversationId: 'c1', generation, messages: freshSnapshot });

    expect(store.c1.messages.map((m) => m.id)).toEqual(['historical-1', 'historical-2', 'shared-1']);
  });

  it('given an edit lands while a load is in flight, should NOT be undone when the stale load resolves', () => {
    let store: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'original')], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [] },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    store = applyConversationEdit(store, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt },
    });

    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1', 'original')] });

    expect(store.c1.messages[0].parts).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it('given a delete lands while a load is in flight, should NOT be resurrected when the stale load resolves', () => {
    let store: ConversationMessagesById = {
      c1: {
        messages: [msg('m1'), msg('m2')],
        optimisticSends: [],
        loadGeneration: 0,
        pendingMutationsSinceLoad: [],
      },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyConversationDelete(store, { conversationId: 'c1', messageId: 'm1' });

    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1'), msg('m2')] });

    expect(store.c1.messages.some((m) => m.id === 'm1')).toBe(false);
  });

  it('given NO live mutation lands during the load, the load should still commit the snapshot as-is', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1', 'from-db')] });

    expect(store.c1.messages).toEqual([msg('m1', 'from-db')]);
  });

  it('given a second startLoad supersedes the first (rapid conversation switch), the first stale load should still be rejected', () => {
    let store: ConversationMessagesById = {};
    const first = applyStartLoad(store, 'c1');
    store = first.byConversationId;
    const second = applyStartLoad(store, 'c1');
    store = second.byConversationId;

    store = applyLoad(store, { conversationId: 'c1', generation: first.generation, messages: [msg('stale-load')] });
    expect(store.c1.messages).toEqual([]);

    store = applyLoad(store, { conversationId: 'c1', generation: second.generation, messages: [msg('fresh-load')] });
    expect(store.c1.messages).toEqual([msg('fresh-load')]);
  });

  it('given multiple live mutations of different kinds land during one load, all should be reflected after the load resolves', () => {
    let store: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'v1'), msg('m2')], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [] },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyRemoteUserMessage(store, { conversationId: 'c1', message: msg('m3', 'new') });
    store = applyConversationEdit(store, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'v2' }], editedAt: new Date() },
    });
    store = applyConversationDelete(store, { conversationId: 'c1', messageId: 'm2' });

    // Stale snapshot: pre-edit m1, still has m2, doesn't know about m3 yet.
    store = applyLoad(store, {
      conversationId: 'c1',
      generation,
      messages: [msg('m1', 'v1'), msg('m2')],
    });

    expect(store.c1.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(store.c1.messages[0].parts).toEqual([{ type: 'text', text: 'v2' }]);
  });

  it('given an edit broadcast arrives for a message not yet present locally (conversation still loading), should still apply once the load introduces it (Codex finding #4)', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    // Edit arrives before this client has ever seen m1 — messages is still empty.
    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    store = applyConversationEdit(store, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt },
    });
    expect(store.c1.messages).toEqual([]);

    // The in-flight load's stale snapshot predates the edit.
    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1', 'original')] });

    expect(store.c1.messages[0].parts).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it('given a delete broadcast arrives for an id that only exists in optimisticSends locally, should still exclude it once the load resolves (Codex finding #5)', () => {
    let store: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [] },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    // opt1 was actually already persisted server-side by the time it's deleted,
    // but this client hasn't reconciled it into `messages` yet — the delete
    // only visibly changes optimisticSends.
    store = applyConversationDelete(store, { conversationId: 'c1', messageId: 'opt1' });
    expect(store.c1.messages).toEqual([]);
    expect(store.c1.optimisticSends).toEqual([]);

    // The in-flight load's snapshot independently includes opt1 (it really was persisted).
    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('opt1')] });

    expect(store.c1.messages.some((m) => m.id === 'opt1')).toBe(false);
  });

  it('given a delete broadcast arrives for an id this client has never seen at all, should still exclude it once a stale load resolves', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyConversationDelete(store, { conversationId: 'c1', messageId: 'never-seen' });

    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('never-seen'), msg('m2')] });

    expect(store.c1.messages.map((m) => m.id)).toEqual(['m2']);
  });
});
