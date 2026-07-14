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
 * (chatgpt-codex-connector, apps/web/src/stores/conversationMessages/applyLoad.ts:34):
 * a conversation load reads a DB snapshot BEFORE a live socket mutation lands,
 * but resolves (calls applyLoad) AFTER it. Because the load's `generation`
 * still matched, applyLoad used to unconditionally overwrite `messages` with
 * its (now-stale) snapshot, silently dropping the live mutation until the
 * next reload. Fixed by having every live-mutation transition
 * (applyRemoteUserMessage/applyConversationEdit/applyConversationDelete)
 * bump `loadGeneration` on an actual change, so the in-flight load's
 * generation goes stale and applyLoad correctly rejects it instead.
 */
describe('applyLoad race with concurrent live mutations', () => {
  it('given a remote user message arrives while a load is in flight, should NOT be clobbered when the stale load resolves', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    // Socket broadcast lands before the fetch resolves.
    store = applyRemoteUserMessage(store, { conversationId: 'c1', message: msg('live-1', 'hello') });

    // The in-flight fetch resolves with the pre-broadcast DB snapshot.
    const staleSnapshot: UIMessage[] = [msg('m0', 'existing')];
    store = applyLoad(store, { conversationId: 'c1', generation, messages: staleSnapshot });

    expect(store.c1.messages.some((m) => m.id === 'live-1')).toBe(true);
  });

  it('given an edit lands while a load is in flight, should NOT be undone when the stale load resolves', () => {
    let store: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'original')], optimisticSends: [], loadGeneration: 0 },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    store = applyConversationEdit(store, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt },
    });

    // Stale load resolves with the pre-edit snapshot.
    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1', 'original')] });

    expect(store.c1.messages[0].parts).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it('given a delete lands while a load is in flight, should NOT be resurrected when the stale load resolves', () => {
    let store: ConversationMessagesById = {
      c1: { messages: [msg('m1'), msg('m2')], optimisticSends: [], loadGeneration: 0 },
    };
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyConversationDelete(store, { conversationId: 'c1', messageId: 'm1' });

    // Stale load resolves with the pre-delete snapshot (m1 still present).
    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1'), msg('m2')] });

    expect(store.c1.messages.some((m) => m.id === 'm1')).toBe(false);
  });

  it('given NO live mutation lands during the load, the load should still commit normally (generation still matches)', () => {
    let store: ConversationMessagesById = {};
    const { byConversationId: afterStart, generation } = applyStartLoad(store, 'c1');
    store = afterStart;

    store = applyLoad(store, { conversationId: 'c1', generation, messages: [msg('m1', 'from-db')] });

    expect(store.c1.messages).toEqual([msg('m1', 'from-db')]);
  });

  it('given a second startLoad supersedes the first (rapid conversation switch), the first stale load should still be rejected as before', () => {
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
});
