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

type Msg = { id: string; role: 'user' | 'assistant'; parts: ReturnType<typeof text>[] };

type Props = {
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  ownMessages: Msg[];
  pageId: string;
  conversationId: string;
};

/** The chat's array with our streaming assistant message last — the ordinary case. */
const streamingAs = (id: string, t: string): Msg[] => [
  { id: 'u1', role: 'user', parts: [text('ask')] },
  { id, role: 'assistant', parts: [text(t)] },
];

const render = (initialProps: Props) =>
  renderHook((props: Props) => useOwnStreamMirror({ ...props, triggeredBy: TRIGGERED_BY } as Parameters<typeof useOwnStreamMirror>[0]), {
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
      ownMessages: [],
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    // Send in C. useChat flips to 'submitted' before issuing the request; no assistant message yet.
    act(() => rerender({ status: 'submitted', ownMessages: [], pageId: 'page-1', conversationId: 'conv-C' }));
    expect(streams().size).toBe(0);

    // The user switches to D while the request is still in flight.
    act(() => rerender({ status: 'submitted', ownMessages: [], pageId: 'page-1', conversationId: 'conv-D' }));

    // First chunk lands. The surface now says D — the stream is still C's.
    act(() => rerender({
      status: 'streaming',
      ownMessages: streamingAs('m1', 'He'),
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
      ownMessages: streamingAs('m1', 'He'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(entry('m1')).toBeDefined();

    act(() => rerender({
      status: 'streaming',
      ownMessages: streamingAs('old-history-message', 'a reply from last week'),
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
      ownMessages: streamingAs('m1', 'He'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    act(() => rerender({ status: 'streaming', ownMessages: [], pageId: 'page-1', conversationId: 'conv-C' }));

    expect(entry('m1')).toBeDefined();
  });

  // The falling edge: when the LOCAL read genuinely ends, this tab's mirror of it ends too.
  // Anything that outlives the local read is the socket path's to own.
  it('given the send ends, should remove the mirrored stream', () => {
    const { rerender } = render({
      status: 'streaming',
      ownMessages: streamingAs('m1', 'Hello'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    act(() => rerender({
      status: 'ready',
      ownMessages: streamingAs('m1', 'Hello'),
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
      ownMessages: streamingAs('m1', 'one'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    act(() => rerender({ status: 'ready', ownMessages: streamingAs('m1', 'one'), pageId: 'page-1', conversationId: 'conv-C' }));

    // The user is now in D and sends again.
    act(() => rerender({ status: 'submitted', ownMessages: [], pageId: 'page-1', conversationId: 'conv-D' }));
    act(() => rerender({
      status: 'streaming',
      ownMessages: streamingAs('m2', 'two'),
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
      ownMessages: streamingAs('m1', 'calling a tool...'),
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
      ownMessages: streamingAs('m1', 'He'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    // The array moves because the user selected conversation D and its history loaded — so the
    // surface has moved off C. That is what makes this an external write rather than the SDK
    // renaming our own stream.
    act(() => {
      usePendingStreamsStore.getState().clearPageStreams('page-1');
      rerender({
        status: 'streaming',
        ownMessages: streamingAs('old-history-message', 'old'),
        pageId: 'page-1',
        conversationId: 'conv-D',
      });
    });

    expect(entry('m1')).toMatchObject({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
    expect(entry('m1')?.parts).toEqual([text('He')]);
    expect(entry('old-history-message')).toBeUndefined();
  });

  // THE SDK's server-id adoption, end to end. The route writes a data part before the `start`
  // chunk (the ungated `data-command-execution` path — any message carrying a command token), so
  // useChat pushes the assistant message under a CLIENT id, React renders, and the mirror latches
  // it. `start` then swaps in the server id, with the surface sitting exactly where it was.
  //
  // Refusing to follow that rename froze the entry under a name the server has never heard of:
  // Stop took the isOwn branch (outranking the pendingSend fallback that WOULD have worked),
  // aborted a nonexistent stream, got not_found, and said nothing — while the generation kept
  // running its write tools and kept billing.
  it('given the SDK swaps in the server-issued id mid-send, should re-target onto it and drop the client-id entry', () => {
    const { rerender } = render({
      status: 'streaming',
      ownMessages: streamingAs('client-generated-id', 'running command...'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(entry('client-generated-id')).toBeDefined();

    // The `start` chunk lands. Same conversation — this is a rename, not the array moving.
    act(() => rerender({
      status: 'streaming',
      ownMessages: streamingAs('server-issued-id', 'running command...'),
      pageId: 'page-1',
      conversationId: 'conv-C',
    }));

    expect(entry('server-issued-id')).toMatchObject({ conversationId: 'conv-C', isOwn: true });
    expect(entry('client-generated-id')).toBeUndefined();
  });

  // THE lesson the deleted `holdForStream` module documented, which this mirror must not lose:
  // NEVER resolve a messageId during the submitted window. useChat sets status='submitted' BEFORE
  // issuing the request and pushes the stream's assistant message only on the flip to 'streaming',
  // so anything that looks like an assistant message during submitted is the PREVIOUS turn's — or,
  // if a load/refresh lands inside the 0.5-3s TTFB, a DB history message.
  //
  // Latching one is how the old code aborted a message that finished minutes ago while the real
  // generation kept billing. Selecting by latched id makes it worse: the history id stays in the
  // array, so the latch would be STICKY and the real stream would never get an entry at all.
  //
  // The submitted window is meant to have NO store entry — selectActiveStream's spec says exactly
  // that, and Stop covers it with the send-time conversationId instead.
  it('given DB history lands during the submitted window, should latch NOTHING (the submitted window has no entry by design)', () => {
    const { rerender } = render({
      status: 'submitted',
      ownMessages: [{ id: 'u1', role: 'user', parts: [text('ask')] }],
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    // A refresh/load writes DB history while the request is still in flight. Its last message is a
    // long-finished assistant reply.
    act(() => rerender({
      status: 'submitted',
      ownMessages: [
        { id: 'u1', role: 'user', parts: [text('ask')] },
        { id: 'old-db-reply', role: 'assistant', parts: [text('last week')] },
      ],
      pageId: 'page-1',
      conversationId: 'conv-C',
    }));

    expect(entry('old-db-reply')).toBeUndefined();
    expect(usePendingStreamsStore.getState().streams.size).toBe(0);

    // ...and the real stream, once it actually starts, still gets its entry.
    act(() => rerender({
      status: 'streaming',
      ownMessages: [
        { id: 'u1', role: 'user', parts: [text('ask')] },
        { id: 'old-db-reply', role: 'assistant', parts: [text('last week')] },
        { id: 'real-stream', role: 'assistant', parts: [text('He')] },
      ],
      pageId: 'page-1',
      conversationId: 'conv-C',
    }));

    expect(entry('real-stream')).toMatchObject({ conversationId: 'conv-C', isOwn: true });
    expect(entry('old-db-reply')).toBeUndefined();
  });

  // THE STALE CLONE. Selecting our message by the latched id looks obviously safer than taking the
  // last one — and it is wrong, because the SDK does not keep our message at a stable identity.
  //
  // The route writes ONE data part per resolved command plan before the `start` chunk
  // (`commandPlans.forEach` — ungated, so any message with two command tokens does this). useChat's
  // FIRST write pushes the live message object by reference; its SECOND takes the `replaceMessage`
  // path, which structuredClones. The array is then holding a clone under the client-generated id
  // while the live object goes on to adopt the server id at `start` and is pushed separately.
  //
  // So the array ends up [user, <stale client-id clone>, <live server-id message>]. Selecting by
  // latched id locked onto the dead clone for the rest of the send: Stop aborted an id the server
  // never issued → not_found → silent → generation kept billing, and the entry's parts froze at the
  // command chips. Positional selection follows the SDK's own active message.
  it('given the SDK leaves a stale client-id clone behind (2+ pre-start data parts), should mirror the LIVE server-id message', () => {
    const { rerender } = render({
      status: 'streaming',
      ownMessages: [
        { id: 'u1', role: 'user', parts: [text('run two commands')] },
        { id: 'client-generated-id', role: 'assistant', parts: [text('chip one')] },
      ],
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(entry('client-generated-id')).toBeDefined();

    // `start` lands: the live object adopted the server id and was PUSHED, leaving the clone behind.
    act(() => rerender({
      status: 'streaming',
      ownMessages: [
        { id: 'u1', role: 'user', parts: [text('run two commands')] },
        { id: 'client-generated-id', role: 'assistant', parts: [text('chip one')] },
        { id: 'server-issued-id', role: 'assistant', parts: [text('the actual reply')] },
      ],
      pageId: 'page-1',
      conversationId: 'conv-C',
    }));

    // The entry Stop reads must name the stream the SERVER knows.
    expect(entry('server-issued-id')).toMatchObject({ conversationId: 'conv-C', isOwn: true });
    expect(entry('server-issued-id')?.parts).toEqual([text('the actual reply')]);
    expect(entry('client-generated-id')).toBeUndefined();
  });
});
