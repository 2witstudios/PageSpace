import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useOwnStreamMirror } from '../useOwnStreamMirror';

// No store mock. usePendingStreamsStore is a pure zustand store with no process boundary to fake,
// and the behaviour under test IS the interaction with it — including the subscription that makes a
// third-party wipe repair itself. A hand-rolled stand-in cannot exhibit that, and an earlier
// version of this file proved the point: its mock could hold states the real store cannot.
const streams = () => usePendingStreamsStore.getState().streams;
const entry = (id: string) => streams().get(id);

const TRIGGERED_BY = { userId: 'u1', displayName: 'Me' };
const text = (t: string) => ({ type: 'text' as const, text: t });

type Props = {
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  ownAssistantMessage: { id: string; parts: ReturnType<typeof text>[] } | undefined;
  pageId: string;
  conversationId: string;
};

const render = (initialProps: Props) =>
  renderHook((props: Props) => useOwnStreamMirror({ ...props, triggeredBy: TRIGGERED_BY }), {
    initialProps,
  });

describe('useOwnStreamMirror', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  // THE regression this exists to prevent, end to end. useChat's id is constant per surface, so
  // switching conversation mid-flight does NOT abort the POST — the stream keeps running while the
  // surface moves. A real send spends 0.5-3s in 'submitted' before the first chunk, which is
  // exactly long enough for the user to switch. Reading conversationId live at addStream time
  // recorded C's stream under D: Stop in C then found nothing while C kept generating and billing.
  it('given the surface switches conversation during the submitted window, should record the stream under the conversation it was SENT from', () => {
    const { rerender } = render({
      status: 'ready',
      ownAssistantMessage: undefined,
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    // Send in C. useChat flips to 'submitted' before issuing the request; no assistant message yet.
    act(() => rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-C' }));
    expect(streams().size).toBe(0);

    // The user switches to D while the request is still in flight.
    act(() => rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-D' }));

    // First chunk lands. The surface now says D — the stream is still C's.
    act(() => rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    }));

    expect(entry('m1')).toMatchObject({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
  });

  // An external setMessages() — a surface's load-on-select writing ANOTHER conversation's history
  // into this chat while our stream runs. Its last entry is typically an assistant message. If the
  // mirror re-targeted onto it, it would remove our live stream (killing its Stop and its SWR
  // protection while the server bills on) and add a phantom on a message that finished long ago,
  // whose Stop reports not_found — silent by design.
  it('given another conversation history replaces the array mid-send, should keep the live stream and add no phantom', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(entry('m1')).toBeDefined();

    act(() => rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'old-history-message', parts: [text('a reply from last week')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    }));

    expect(entry('m1')).toBeDefined();
    expect(entry('old-history-message')).toBeUndefined();
  });

  // GlobalAssistantView clears agent messages on agent deselect (setAgentMessages([])) and never
  // calls agentStop() on that path, so the chat stays 'streaming' with an empty array. Treating an
  // empty array as "the stream ended" removed a live stream's entry — and the local stop it implies
  // would not have stopped the server anyway.
  it('given the message array is emptied mid-send, should NOT remove the live stream', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    act(() => rerender({ status: 'streaming', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-C' }));

    expect(entry('m1')).toBeDefined();
  });

  // The falling edge: when the LOCAL read genuinely ends, this tab's mirror of it ends too.
  // Anything that outlives the local read is the socket path's to own.
  it('given the send ends, should remove the mirrored stream', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    act(() => rerender({
      status: 'ready',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    }));

    expect(entry('m1')).toBeUndefined();
  });

  // ...and the NEXT send must start clean, under the conversation it is actually sent from — what
  // releasing the latches on the falling edge buys.
  it('given a second send in a different conversation, should latch the new conversation', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('one')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    act(() => rerender({ status: 'ready', ownAssistantMessage: { id: 'm1', parts: [text('one')] }, pageId: 'page-1', conversationId: 'conv-C' }));

    // The user is now in D and sends again.
    act(() => rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-D' }));
    act(() => rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'm2', parts: [text('two')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    }));

    expect(entry('m2')).toMatchObject({ messageId: 'm2', conversationId: 'conv-D' });
  });

  // THE store-wipe repair. `useChannelStreamSocket`'s cleanup calls clearPageStreams(channelId) on
  // every re-run of its effect, and both a token refresh and a reconnect after a network blip mint
  // a new socket — so an ordinary event wipes our own live entry mid-send. Nothing else restores
  // it: the socket's DB bootstrap re-runs but DECLINES its own consuming stream by design
  // (shouldAttachStream), because attaching would render every token twice.
  //
  // And the repair must be driven by the WIPE, not by the next token: during a tool call no parts
  // stream for tens of seconds. In that window `activeStream` is undefined and the pendingSend has
  // long been handed off, so the UI would show Send while the generation ran its write tools and
  // billed, with Stop resolving to 'none'.
  it('given a third party wipes the live entry mid-send, should re-assert it WITHOUT waiting for another token', () => {
    render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('calling a tool...')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(entry('m1')).toBeDefined();

    // A socket swap wipes the channel. No new token arrives — we are mid tool call.
    act(() => usePendingStreamsStore.getState().clearPageStreams('page-1'));

    expect(entry('m1')).toMatchObject({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
  });

  // The worst case, and the one that cannot heal itself: a load-on-select moves the array off our
  // stream while an auth refresh wipes the channel. No further token will ever arrive for a message
  // that has left the array, so if this moment is missed the entry is gone for the rest of the
  // send — no Stop, no SWR protection, generation still running and billing. Restore the LATCHED
  // stream (with the content we last mirrored) and still refuse to adopt the history message.
  it('given the array moved onto another message AND the entry was wiped, should restore the latched stream and adopt nothing', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    act(() => {
      usePendingStreamsStore.getState().clearPageStreams('page-1');
      rerender({
        status: 'streaming',
        ownAssistantMessage: { id: 'old-history-message', parts: [text('old')] },
        pageId: 'page-1',
        conversationId: 'conv-C',
      });
    });

    expect(entry('m1')).toMatchObject({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
    expect(entry('m1')?.parts).toEqual([text('He')]);
    expect(entry('old-history-message')).toBeUndefined();
  });
});
