/**
 * useConversationMessagesStore Tests
 *
 * Wiring-only smoke tests: each action is a one-line shell over a pure
 * `applyX` transition (see `stores/conversationMessages/__tests__/` for the
 * exhaustive, mock-free behavioral coverage of those functions).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useConversationMessagesStore } from '../useConversationMessagesStore';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('useConversationMessagesStore', () => {
  beforeEach(() => {
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  it('given a conversation never seen before, getEntry should return a seeded empty entry without mutating the store', () => {
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [] });
    expect(useConversationMessagesStore.getState().byConversationId.c1).toBeUndefined();
  });

  it('given startLoad then applyLoad with the returned generation, should commit the loaded messages', () => {
    const { startLoad, applyLoad, getEntry } = useConversationMessagesStore.getState();
    const generation = startLoad('c1');
    applyLoad('c1', generation, [msg('m1')]);
    expect(getEntry('c1').messages).toEqual([msg('m1')]);
  });

  it('given failLoad after startLoad, should leave the prior entry unchanged', () => {
    const { startLoad, applyLoad, failLoad, getEntry } = useConversationMessagesStore.getState();
    const gen1 = startLoad('c1');
    applyLoad('c1', gen1, [msg('m1')]);
    const gen2 = startLoad('c1');
    failLoad('c1', gen2);
    expect(getEntry('c1').messages).toEqual([msg('m1')]);
  });

  it('given addOptimisticSend, should track the message in optimisticSends', () => {
    const { addOptimisticSend, getEntry } = useConversationMessagesStore.getState();
    addOptimisticSend('c1', msg('opt1'));
    expect(getEntry('c1').optimisticSends).toEqual([msg('opt1')]);
  });

  it('given applyRemoteUserMessage for an id matching an optimistic send, should reconcile it into messages', () => {
    const { addOptimisticSend, applyRemoteUserMessage, getEntry } = useConversationMessagesStore.getState();
    addOptimisticSend('c1', msg('opt1'));
    applyRemoteUserMessage('c1', msg('opt1'));
    const entry = getEntry('c1');
    expect(entry.messages).toEqual([msg('opt1')]);
    expect(entry.optimisticSends).toEqual([]);
  });

  it('given applyEdit for a confirmed message, should update its parts', () => {
    const { startLoad, applyLoad, applyEdit, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1')]);
    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    applyEdit('c1', { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt });
    expect(getEntry('c1').messages[0]).toMatchObject({ parts: [{ type: 'text', text: 'edited' }], editedAt });
  });

  it('given applyDelete for a confirmed message, should remove it', () => {
    const { startLoad, applyLoad, applyDelete, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1'), msg('m2')]);
    applyDelete('c1', 'm1');
    expect(getEntry('c1').messages).toEqual([msg('m2')]);
  });

  it('given actions against one conversation, should not affect another conversation entry', () => {
    const { addOptimisticSend, getEntry } = useConversationMessagesStore.getState();
    addOptimisticSend('c1', msg('opt1'));
    expect(getEntry('c2')).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [] });
  });
});
