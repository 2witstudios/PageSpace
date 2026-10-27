import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { refreshConversationSnapshot } from '@/hooks/conversationMessagesLoaders';
import { buildOwnStreamCommitOnFinish } from '../ownStreamCommit';

// Real zustand stores (repo convention — see useOwnStreamMirror.test.tsx: a hand-rolled
// stand-in can hold states the real store cannot). Only the network-touching loader is mocked.
vi.mock('@/hooks/conversationMessagesLoaders', () => ({
  refreshConversationSnapshot: vi.fn().mockResolvedValue(undefined),
}));

const CONV = 'conv-1';
const text = (t: string) => ({ type: 'text' as const, text: t });

const finished = (overrides: Partial<{ id: string; role: string; parts: UIMessage['parts'] }> = {}) =>
  ({
    id: 'reply-1',
    role: 'assistant',
    parts: [text('the full reply')],
    ...overrides,
  }) as UIMessage;

const invoke = (
  onFinish: ReturnType<typeof buildOwnStreamCommitOnFinish>,
  message: UIMessage,
  flags: Partial<{ isAbort: boolean; isDisconnect: boolean; isError: boolean }> = {},
) =>
  onFinish({
    message,
    messages: [message],
    isAbort: false,
    isDisconnect: false,
    isError: false,
    ...flags,
  });

const cachedMessages = () => conversationMessagesActions.getEntry(CONV).messages;

describe('buildOwnStreamCommitOnFinish', () => {
  beforeEach(() => {
    useConversationMessagesStore.setState({ byConversationId: {} });
    usePendingStreamsStore.setState({ streams: new Map() });
    vi.mocked(refreshConversationSnapshot).mockClear();
  });

  it('given a clean finish, should promote the optimistic send FIRST, then commit the reply after it', () => {
    const userMessage = { id: 'user-1', role: 'user', parts: [text('the question')] } as UIMessage;
    conversationMessagesActions.addOptimisticSend(CONV, userMessage);

    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: 'agent-1' });
    invoke(onFinish, finished());

    expect(cachedMessages().map((m) => m.id)).toEqual(['user-1', 'reply-1']);
    expect(conversationMessagesActions.getEntry(CONV).optimisticSends).toEqual([]);
    const reply = cachedMessages()[1] as UIMessage & { status?: string };
    expect(reply.parts).toEqual([text('the full reply')]);
    expect(reply.status).toBe('complete');
  });

  it('given a half-streamed includeStreaming placeholder under the same id, should overwrite it in place', () => {
    const generation = conversationMessagesActions.startLoad(CONV);
    conversationMessagesActions.applyLoad(CONV, generation, [
      { id: 'reply-1', role: 'assistant', parts: [text('half-str')], status: 'streaming' } as UIMessage,
    ]);

    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: null });
    invoke(onFinish, finished());

    expect(cachedMessages()).toHaveLength(1);
    const reply = cachedMessages()[0] as UIMessage & { status?: string };
    expect(reply.parts).toEqual([text('the full reply')]);
    expect(reply.status).toBe('complete');
  });

  it('given the mirror entry still exists at finish time, should thread its startedAt into createdAt', () => {
    usePendingStreamsStore.getState().addStream({
      messageId: 'reply-1',
      pageId: 'page-1',
      conversationId: CONV,
      triggeredBy: { userId: 'u1', displayName: 'Me' },
      isOwn: true,
      startedAt: '2026-08-03T12:00:00.000Z',
    });

    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: null });
    invoke(onFinish, finished());

    expect((cachedMessages()[0] as UIMessage & { createdAt?: Date }).createdAt).toEqual(
      new Date('2026-08-03T12:00:00.000Z'),
    );
  });

  it('given a local Stop with partial parts, should commit the partial with status interrupted', () => {
    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: 'agent-1' });
    invoke(onFinish, finished({ parts: [text('partial')] }), { isAbort: true });

    const reply = cachedMessages()[0] as UIMessage & { status?: string };
    expect(reply.parts).toEqual([text('partial')]);
    expect(reply.status).toBe('interrupted');
  });

  it('given a clean finish, should trigger the background snapshot heal with the surface agentId', () => {
    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: 'agent-1' });
    invoke(onFinish, finished());
    expect(refreshConversationSnapshot).toHaveBeenCalledWith('agent-1', CONV);
  });

  it('given the global assistant surface, should heal via the global endpoint (agentId null)', () => {
    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: null });
    invoke(onFinish, finished());
    expect(refreshConversationSnapshot).toHaveBeenCalledWith(null, CONV);
  });

  it('given an error finish, should commit nothing, promote nothing, and skip the heal', () => {
    conversationMessagesActions.addOptimisticSend(CONV, {
      id: 'user-1',
      role: 'user',
      parts: [text('q')],
    } as UIMessage);

    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: 'agent-1' });
    invoke(onFinish, finished(), { isError: true });

    expect(cachedMessages()).toEqual([]);
    expect(conversationMessagesActions.getEntry(CONV).optimisticSends).toHaveLength(1);
    expect(refreshConversationSnapshot).not.toHaveBeenCalled();
  });

  it('given a network disconnect, should commit nothing', () => {
    const onFinish = buildOwnStreamCommitOnFinish({ conversationId: CONV, agentId: 'agent-1' });
    invoke(onFinish, finished(), { isDisconnect: true });
    expect(cachedMessages()).toEqual([]);
  });
});
