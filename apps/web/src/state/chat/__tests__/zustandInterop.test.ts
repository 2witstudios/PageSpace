/**
 * SPIKE (@adobe/data adoption evidence) — incremental adoption alongside the
 * ~two dozen untouched zustand stores.
 *
 * Spike question: "should @adobe/data adopt incrementally (one Database.Plugin
 * hosting chat state while zustand persists elsewhere) without dual-source
 * bugs?"
 *
 * The scenario driven here is a real ask_user answer + failed send, which
 * crosses BOTH containers in one flow: the message state lives in the ported
 * Database, the answering mutex (`useAskUserAnsweringStore`) and the typed
 * error (`useChatErrorStore`) stay in untouched zustand. Neither store is
 * modified for this test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { useChatErrorStore } from '@/stores/useChatErrorStore';
import type { AIErrorCause } from '@/lib/ai/shared/aiErrorCause';
import { createChatDatabase } from '../createChatDatabase';
import { createConversationMessagesFacade } from '../facade/conversationMessagesFacade';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const OUT_OF_CREDITS: AIErrorCause = {
  code: 'out_of_credits',
  httpStatus: 402,
  message: 'Out of credits.',
  retryable: false,
};

describe('@adobe/data chat container alongside untouched zustand stores', () => {
  beforeEach(() => {
    useAskUserAnsweringStore.setState({ answeringToolCallIds: new Set<string>() });
    useChatErrorStore.setState({ byConversationId: {} });
  });

  it('given a send that fails after an ask_user claim, both containers should hold their own half of the state', () => {
    const facade = createConversationMessagesFacade(createChatDatabase().db);

    // zustand: claim the answering mutex (unchanged store, unchanged call site).
    expect(useAskUserAnsweringStore.getState().claimAnswering('tool-1')).toBe(true);
    // @adobe/data: the optimistic send.
    facade.getState().addOptimisticSend('c1', msg('m1'));
    // zustand: the POST rejects with a typed cause.
    useChatErrorStore.getState().setError('c1', OUT_OF_CREDITS);
    // @adobe/data: roll the optimistic bubble back.
    facade.getState().removeOptimisticSendOnFailure('c1', 'm1');

    expect(facade.getState().getEntry('c1').optimisticSends).toEqual([]);
    expect(useChatErrorStore.getState().getError('c1')).toEqual(OUT_OF_CREDITS);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tool-1')).toBe(true);
  });

  it('given two chat Databases, the zustand stores should stay global while chat state stays per-container', () => {
    const a = createConversationMessagesFacade(createChatDatabase().db);
    const b = createConversationMessagesFacade(createChatDatabase().db);

    a.getState().addOptimisticSend('c1', msg('m1'));
    useChatErrorStore.getState().setError('c1', OUT_OF_CREDITS);

    expect(a.getState().getEntry('c1').optimisticSends.map((m) => m.id)).toEqual(['m1']);
    expect(b.getState().getEntry('c1').optimisticSends).toEqual([]);
    // The zustand singleton is shared by construction — that is exactly the
    // property that lets un-migrated stores keep working untouched.
    expect(useChatErrorStore.getState().getError('c1')).toEqual(OUT_OF_CREDITS);
  });

  it('given the facade, every zustand call site keeps its exact shape (getState().action(...))', () => {
    const facade = createConversationMessagesFacade(createChatDatabase().db);

    const generation = facade.getState().startLoad('c1');
    facade.getState().applyLoad('c1', generation, [msg('m1')], { hasMore: false, nextCursor: null });

    expect(facade.getState().isLoadCurrent('c1', generation)).toBe(true);
    expect(facade.getState().byConversationId.c1.messages).toEqual([msg('m1')]);
  });
});
