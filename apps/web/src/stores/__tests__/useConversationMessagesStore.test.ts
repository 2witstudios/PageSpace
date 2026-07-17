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
    expect(entry).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'idle' });
    expect(useConversationMessagesStore.getState().byConversationId.c1).toBeUndefined();
  });

  it('given applyServerSnapshot, should commit the messages as loaded truth in one step', () => {
    const { applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    applyServerSnapshot('c1', [msg('m1'), msg('m2')]);
    const entry = getEntry('c1');
    expect(entry.messages).toEqual([msg('m1'), msg('m2')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given applyServerSnapshot, should supersede an in-flight load (its later applyLoad is dropped as stale)', () => {
    const { startLoad, applyServerSnapshot, applyLoad, getEntry } = useConversationMessagesStore.getState();
    const inFlight = startLoad('c1');
    applyServerSnapshot('c1', [msg('snapshot')]);
    applyLoad('c1', inFlight, [msg('stale')]);
    expect(getEntry('c1').messages).toEqual([msg('snapshot')]);
  });

  it('given a live delete recorded while the snapshot fetch was in flight, applyServerSnapshot must not resurrect the deleted message', () => {
    // The snapshot was FETCHED before this call, so a mutation recorded in the
    // window between fetch and commit is newer than the snapshot — it must be
    // replayed onto it, not cleared by the generation bump (CodeRabbit P2, PR #2098).
    const { startLoad, applyLoad, applyDelete, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1'), msg('m2')]);
    // tryRecover's fetch is in flight; another tab deletes m2 (recorded as a pending mutation).
    applyDelete('c1', 'm2');
    // The recovery snapshot resolves — it still contains m2.
    applyServerSnapshot('c1', [msg('m1'), msg('m2')]);
    expect(getEntry('c1').messages).toEqual([msg('m1')]);
  });

  it('given a live remote append recorded while the snapshot fetch was in flight, applyServerSnapshot must keep it', () => {
    const { applyRemoteUserMessage, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    applyRemoteUserMessage('c1', msg('live-append'));
    applyServerSnapshot('c1', [msg('m1')]);
    expect(getEntry('c1').messages).toEqual([msg('m1'), msg('live-append')]);
  });

  it('given applyServerSnapshot containing an optimistic send id, should reconcile it out of optimisticSends', () => {
    const { addOptimisticSend, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    addOptimisticSend('c1', msg('opt1'));
    applyServerSnapshot('c1', [msg('opt1')]);
    const entry = getEntry('c1');
    expect(entry.optimisticSends).toEqual([]);
    expect(entry.messages).toEqual([msg('opt1')]);
  });

  it('given seedConversation for a freshly minted id, should mark the entry loaded-empty so no fetch is pending for it', () => {
    const { seedConversation, getEntry } = useConversationMessagesStore.getState();
    seedConversation('c-new');
    const entry = getEntry('c-new');
    expect(entry.messages).toEqual([]);
    expect(entry.loadStatus).toBe('loaded');
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
    expect(getEntry('c2')).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'idle' });
  });

  it('given isLoadCurrent with the generation returned by startLoad, should return true; with a stale generation, should return false', () => {
    const { startLoad, isLoadCurrent } = useConversationMessagesStore.getState();
    const gen1 = startLoad('c1');
    expect(isLoadCurrent('c1', gen1)).toBe(true);
    const gen2 = startLoad('c1');
    expect(isLoadCurrent('c1', gen1)).toBe(false);
    expect(isLoadCurrent('c1', gen2)).toBe(true);
  });

  it('given applyConfirmedMessage for a new id, should append it; for an existing id, should replace its content in place', () => {
    const { startLoad, applyLoad, applyConfirmedMessage, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1')]);
    applyConfirmedMessage('c1', { id: 'm2', role: 'assistant', parts: [] });
    expect(getEntry('c1').messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    applyConfirmedMessage('c1', { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'confirmed' }] });
    expect(getEntry('c1').messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'confirmed' }] });
  });
});
