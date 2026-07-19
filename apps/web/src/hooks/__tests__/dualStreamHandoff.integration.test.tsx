import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useOwnStreamMirror } from '../useOwnStreamMirror';
import { useConversationSendHandoff } from '@/lib/ai/shared/hooks/useConversationSendHandoff';

// THE dual-stream regression, at the level the bug lived: the REAL mirror and the REAL handoff
// composed over the REAL pending-streams store, driven the way a surface drives them.
//
// The reported bug: two global conversations share ONE useChat instance. Send in chat 1, create
// chat 2, send in chat 2 while chat 1 still streams — chat 1's stream entry (latched conv-1)
// adopted chat 2's assistant content, so conv-1's store entry carried conv-2's reply and the
// wrong conversation rendered it. The handoff makes the second send impossible while the first
// is being consumed: stop → wait for the falling edge → rejoin (socket re-attaches conv-1).

const TRIGGERED_BY = { userId: 'u1', displayName: 'Me' };
const text = (t: string) => ({ type: 'text' as const, text: t });

type Msg = { id: string; role: 'user' | 'assistant'; parts: UIMessage['parts'] };
type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

type HarnessProps = {
  status: ChatStatus;
  ownMessages: Msg[];
  /** The LIVE surface conversation — follows the UI, unlike the mirror's latch. */
  conversationId: string;
};

const streams = () => usePendingStreamsStore.getState().streams;
const entriesByConversation = (conversationId: string) =>
  [...streams().values()].filter((s) => s.conversationId === conversationId);

describe('dual-stream handoff (integration: mirror + handoff + store)', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  it('given a send into chat 2 while chat 1 streams on the same chat instance, should hand chat 1 to the socket and key chat 2 correctly', async () => {
    const stop = vi.fn();
    const rejoin = vi.fn();

    const { result, rerender } = renderHook(
      (props: HarnessProps) => {
        const { getLatchedConversationId } = useOwnStreamMirror({
          status: props.status,
          ownMessages: props.ownMessages,
          pageId: 'user:u1:global',
          conversationId: props.conversationId,
          triggeredBy: TRIGGERED_BY,
        });
        const { prepareSend } = useConversationSendHandoff({
          status: props.status,
          stop,
          getLatchedConversationId,
          rejoin,
        });
        return { prepareSend };
      },
      {
        initialProps: {
          status: 'ready' as ChatStatus,
          ownMessages: [] as Msg[],
          conversationId: 'conv-1',
        },
      },
    );

    // ── Send in chat 1: submitted, then streaming with chat 1's assistant reply.
    act(() => rerender({ status: 'submitted', ownMessages: [{ id: 'u-1', role: 'user', parts: [text('hi')] }], conversationId: 'conv-1' }));
    act(() =>
      rerender({
        status: 'streaming',
        ownMessages: [
          { id: 'u-1', role: 'user', parts: [text('hi')] },
          { id: 'a-1', role: 'assistant', parts: [text('chat one reply')] },
        ],
        conversationId: 'conv-1',
      }),
    );
    expect(streams().get('a-1')).toMatchObject({ conversationId: 'conv-1', isOwn: true });

    // ── User creates chat 2 and selects it. The surface moves; the POST does not.
    act(() =>
      rerender({
        status: 'streaming',
        ownMessages: [
          { id: 'u-1', role: 'user', parts: [text('hi')] },
          { id: 'a-1', role: 'assistant', parts: [text('chat one reply, longer')] },
        ],
        conversationId: 'conv-2',
      }),
    );

    // ── User hits Send in chat 2. The surface awaits prepareSend before sendMessage.
    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    let prepared = false;
    void prepare.then(() => { prepared = true; });

    // The in-flight local read is stopped...
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    // ...and the send waits: chat 1's stream has not settled yet.
    expect(prepared).toBe(false);

    // The abort lands — useChat settles to ready. The mirror's falling edge releases the latch
    // and removes chat 1's LOCAL entry (the socket rejoin re-seeds it as a remote-rendered own
    // stream; that path is covered in useChannelStreamSocket.test.ts).
    act(() =>
      rerender({
        status: 'ready',
        ownMessages: [
          { id: 'u-1', role: 'user', parts: [text('hi')] },
          { id: 'a-1', role: 'assistant', parts: [text('chat one reply, longer')] },
        ],
        conversationId: 'conv-2',
      }),
    );
    await act(async () => { await Promise.resolve(); });

    expect(prepared).toBe(true);
    expect(rejoin).toHaveBeenCalledTimes(1);
    expect(streams().get('a-1')).toBeUndefined();

    // ── The send proceeds: chat 2's own stream on the (now settled) shared chat.
    act(() =>
      rerender({
        status: 'submitted',
        ownMessages: [
          { id: 'u-1', role: 'user', parts: [text('hi')] },
          { id: 'a-1', role: 'assistant', parts: [text('chat one reply, longer')] },
          { id: 'u-2', role: 'user', parts: [text('second chat prompt')] },
        ],
        conversationId: 'conv-2',
      }),
    );
    act(() =>
      rerender({
        status: 'streaming',
        ownMessages: [
          { id: 'u-1', role: 'user', parts: [text('hi')] },
          { id: 'a-1', role: 'assistant', parts: [text('chat one reply, longer')] },
          { id: 'u-2', role: 'user', parts: [text('second chat prompt')] },
          { id: 'a-2', role: 'assistant', parts: [text('chat two reply')] },
        ],
        conversationId: 'conv-2',
      }),
    );

    // THE bug's assertion: chat 2's content is keyed under conv-2 — and NOTHING under conv-1
    // ever holds chat 2's reply. Before the fix, the stuck conv-1 latch adopted a-2 and wrote
    // its parts under conversationId conv-1, which is exactly what rendered in the wrong chat.
    expect(streams().get('a-2')).toMatchObject({ conversationId: 'conv-2', isOwn: true });
    const conv1Entries = entriesByConversation('conv-1');
    expect(conv1Entries).toHaveLength(0);
  });

  it('given a second send in the SAME conversation, should not stop or rejoin anything', async () => {
    const stop = vi.fn();
    const rejoin = vi.fn();

    const { result, rerender } = renderHook(
      (props: HarnessProps) => {
        const { getLatchedConversationId } = useOwnStreamMirror({
          status: props.status,
          ownMessages: props.ownMessages,
          pageId: 'user:u1:global',
          conversationId: props.conversationId,
          triggeredBy: TRIGGERED_BY,
        });
        const { prepareSend } = useConversationSendHandoff({
          status: props.status,
          stop,
          getLatchedConversationId,
          rejoin,
        });
        return { prepareSend };
      },
      {
        initialProps: {
          status: 'streaming' as ChatStatus,
          ownMessages: [
            { id: 'u-1', role: 'user', parts: [text('hi')] },
            { id: 'a-1', role: 'assistant', parts: [text('reply')] },
          ] as Msg[],
          conversationId: 'conv-1',
        },
      },
    );
    void rerender;

    await act(async () => {
      await result.current.prepareSend('conv-1');
    });

    expect(stop).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
    expect(streams().get('a-1')).toBeDefined();
  });
});
