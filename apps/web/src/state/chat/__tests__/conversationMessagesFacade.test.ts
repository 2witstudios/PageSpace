/**
 * SPIKE (@adobe/data adoption evidence) — the container-swap proof.
 *
 * This is `apps/web/src/stores/__tests__/useConversationMessagesStore.test.ts` with EXACTLY ONE
 * change: the container it drives. The zustand store import and its
 * `setState`-based reset become a freshly-created @adobe/data Database wrapped
 * in `createConversationMessagesFacade`. Every `it(...)` title, every arrangement and
 * every assertion below is byte-identical to the zustand suite.
 *
 * DO NOT "fix" a failure here by editing an assertion — a red test is the port
 * being wrong, which is the whole point of running this file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { createChatDatabase } from '../createChatDatabase';
import {
  createConversationMessagesFacade,
  type ConversationMessagesFacade,
} from '../facade/conversationMessagesFacade';

let useConversationMessagesStore: ConversationMessagesFacade;


const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('useConversationMessagesStore', () => {
  beforeEach(() => {
    useConversationMessagesStore = createConversationMessagesFacade(createChatDatabase().db);
  });

  it('given a conversation never seen before, getEntry should return a seeded empty entry without mutating the store', () => {
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'idle', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false });
    expect(useConversationMessagesStore.getState().byConversationId.c1).toBeUndefined();
  });

  it('given applyServerSnapshot with a current token, should commit the messages as loaded truth', () => {
    const { beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const token = beginServerSnapshot('c1');
    applyServerSnapshot('c1', token, [msg('m1'), msg('m2')]);
    const entry = getEntry('c1');
    expect(entry.messages).toEqual([msg('m1'), msg('m2')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a loud load starting AFTER the snapshot fetch began, the stale snapshot commit must be dropped (the loud load is fresher)', () => {
    const { startLoad, beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const token = beginServerSnapshot('c1');
    startLoad('c1');
    applyServerSnapshot('c1', token, [msg('snapshot')]);
    expect(getEntry('c1').messages).toEqual([]);
  });

  it('given a snapshot committing while a loud load is still in flight, the loud load later resolving stale is dropped', () => {
    const { startLoad, beginServerSnapshot, applyServerSnapshot, applyLoad, getEntry } = useConversationMessagesStore.getState();
    const inFlight = startLoad('c1');
    // Snapshot fetch begins AFTER the loud load started — it holds the newer view.
    const token = beginServerSnapshot('c1');
    applyServerSnapshot('c1', token, [msg('snapshot')]);
    applyLoad('c1', inFlight, [msg('stale')]);
    expect(getEntry('c1').messages).toEqual([msg('snapshot')]);
  });

  // CR4 (CodeRabbit round 2): two concurrent background heals — the one whose fetch
  // started FIRST must not overwrite the one that committed with fresher data, and
  // replay cannot recover rows the newer snapshot introduced (its commit clears the
  // pending queue). The token is captured BEFORE each fetch; a commit whose token no
  // longer matches the entry's generation is dropped.
  it('given two racing snapshots, the older-fetched one must not overwrite the newer committed one', () => {
    const { beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const tokenA = beginServerSnapshot('c1');
    const tokenB = beginServerSnapshot('c1');
    // B (fresher fetch) commits first.
    applyServerSnapshot('c1', tokenB, [msg('m1'), msg('reply2')]);
    // A (older fetch, missing reply2) resolves late — must be dropped.
    applyServerSnapshot('c1', tokenA, [msg('m1')]);
    expect(getEntry('c1').messages).toEqual([msg('m1'), msg('reply2')]);
  });

  it('given a live delete recorded while the snapshot fetch was in flight, applyServerSnapshot must not resurrect the deleted message', () => {
    // The snapshot was FETCHED before this call, so a mutation recorded in the
    // window between fetch and commit is newer than the snapshot — it must be
    // replayed onto it, not cleared by the generation bump (CodeRabbit P2, PR #2098).
    const { startLoad, applyLoad, applyDelete, beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1'), msg('m2')]);
    // tryRecover's fetch begins; another tab deletes m2 (recorded as a pending mutation).
    const token = beginServerSnapshot('c1');
    applyDelete('c1', 'm2');
    // The recovery snapshot resolves — it still contains m2.
    applyServerSnapshot('c1', token, [msg('m1'), msg('m2')]);
    expect(getEntry('c1').messages).toEqual([msg('m1')]);
  });

  it('given a live remote append recorded while the snapshot fetch was in flight, applyServerSnapshot must keep it', () => {
    const { applyRemoteUserMessage, beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const token = beginServerSnapshot('c1');
    applyRemoteUserMessage('c1', msg('live-append'));
    applyServerSnapshot('c1', token, [msg('m1')]);
    expect(getEntry('c1').messages).toEqual([msg('m1'), msg('live-append')]);
  });

  it('given applyServerSnapshot containing an optimistic send id, should reconcile it out of optimisticSends', () => {
    const { addOptimisticSend, beginServerSnapshot, applyServerSnapshot, getEntry } = useConversationMessagesStore.getState();
    const token = beginServerSnapshot('c1');
    addOptimisticSend('c1', msg('opt1'));
    applyServerSnapshot('c1', token, [msg('opt1')]);
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
    expect(getEntry('c2')).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'idle', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false });
  });

  it('given isLoadCurrent with the generation returned by startLoad, should return true; with a stale generation, should return false', () => {
    const { startLoad, isLoadCurrent } = useConversationMessagesStore.getState();
    const gen1 = startLoad('c1');
    expect(isLoadCurrent('c1', gen1)).toBe(true);
    const gen2 = startLoad('c1');
    expect(isLoadCurrent('c1', gen1)).toBe(false);
    expect(isLoadCurrent('c1', gen2)).toBe(true);
  });

  it('given startLoadingOlder for a conversation never seen before, should no-op (nothing to mark loading on)', () => {
    const { startLoadingOlder, getEntry } = useConversationMessagesStore.getState();
    startLoadingOlder('never-seeded');
    expect(useConversationMessagesStore.getState().byConversationId['never-seeded']).toBeUndefined();
    expect(getEntry('never-seeded').isLoadingOlder).toBe(false);
  });

  it('given startLoadingOlder for a tracked conversation, should set isLoadingOlder true', () => {
    const { startLoad, applyLoad, startLoadingOlder, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1')]);
    startLoadingOlder('c1');
    expect(getEntry('c1').isLoadingOlder).toBe(true);
  });

  it('given failLoadingOlder for a conversation never seen before, should no-op', () => {
    const { failLoadingOlder } = useConversationMessagesStore.getState();
    failLoadingOlder('never-seeded', 1);
    expect(useConversationMessagesStore.getState().byConversationId['never-seeded']).toBeUndefined();
  });

  it('given failLoadingOlder with a STALE generation (a newer load has since started), should leave isLoadingOlder untouched', () => {
    const { startLoad, applyLoad, startLoadingOlder, failLoadingOlder, getEntry } = useConversationMessagesStore.getState();
    const gen1 = startLoad('c1');
    applyLoad('c1', gen1, [msg('m1')]);
    startLoad('c1'); // bumps generation — gen1 is now stale
    startLoadingOlder('c1'); // a NEW load-older fetch under the current generation
    failLoadingOlder('c1', gen1); // the OLD (stale) fetch's failure handler fires late
    expect(getEntry('c1').isLoadingOlder).toBe(true);
  });

  it('given failLoadingOlder with the CURRENT generation, should clear isLoadingOlder', () => {
    const { startLoad, applyLoad, startLoadingOlder, failLoadingOlder, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    applyLoad('c1', gen, [msg('m1')]);
    startLoadingOlder('c1');
    failLoadingOlder('c1', gen);
    expect(getEntry('c1').isLoadingOlder).toBe(false);
  });

  it('given removeOptimisticSendOnFailure for a tracked optimistic send, should remove it from optimisticSends', () => {
    const { addOptimisticSend, removeOptimisticSendOnFailure, getEntry } = useConversationMessagesStore.getState();
    addOptimisticSend('c1', msg('opt1'));
    removeOptimisticSendOnFailure('c1', 'opt1');
    expect(getEntry('c1').optimisticSends).toEqual([]);
  });

  it('given applyAskUserAnswer then revertAskUserAnswer for the same tool call, should patch to output-available then back to input-available with output dropped', () => {
    const { startLoad, applyLoad, applyAskUserAnswer, revertAskUserAnswer, getEntry } = useConversationMessagesStore.getState();
    const gen = startLoad('c1');
    const askUserMessage: UIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'tool-ask_user', toolCallId: 'tc1', state: 'input-available', input: { questions: [] } } as UIMessage['parts'][number]],
    };
    applyLoad('c1', gen, [askUserMessage]);

    applyAskUserAnswer('c1', { messageId: 'm1', toolCallId: 'tc1', output: { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] } });
    expect(getEntry('c1').messages[0].parts[0]).toMatchObject({ state: 'output-available' });

    revertAskUserAnswer('c1', { messageId: 'm1', toolCallId: 'tc1' });
    const revertedPart = getEntry('c1').messages[0].parts[0] as Record<string, unknown>;
    expect(revertedPart.state).toBe('input-available');
    expect(revertedPart.output).toBeUndefined();
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
