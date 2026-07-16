import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockAddStream, mockSetStreamParts, mockRemoveStream, mockStreams } = vi.hoisted(() => ({
  mockAddStream: vi.fn(),
  mockSetStreamParts: vi.fn(),
  mockRemoveStream: vi.fn(),
  mockStreams: new Map<string, { lastSeq?: number }>(),
}));

vi.mock('@/stores/usePendingStreamsStore', () => {
  const state = () => ({
    streams: mockStreams,
    addStream: mockAddStream,
    setStreamParts: mockSetStreamParts,
    removeStream: mockRemoveStream,
  });
  const hook = (selector?: (s: ReturnType<typeof state>) => unknown) =>
    selector ? selector(state()) : state();
  hook.getState = state;
  return { usePendingStreamsStore: hook };
});

import { useOwnStreamMirror } from '../useOwnStreamMirror';

const TRIGGERED_BY = { userId: 'u1', displayName: 'Me' };
const text = (t: string) => ({ type: 'text' as const, text: t });

type Props = {
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  ownAssistantMessage: { id: string; parts: ReturnType<typeof text>[] } | undefined;
  pageId: string;
  conversationId: string;
};

const render = (initial: Props) =>
  renderHook((props: Props) => useOwnStreamMirror({ ...props, triggeredBy: TRIGGERED_BY }), {
    initialProps: initial,
  });

const addedStream = () => mockAddStream.mock.calls[0]?.[0];

describe('useOwnStreamMirror — identity is latched at the send, not read live', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreams.clear();
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
    rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-C' });
    expect(mockAddStream).not.toHaveBeenCalled();

    // User switches to D while the request is still in flight.
    rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-D' });

    // First chunk lands. The surface now says D — the stream is still C's.
    rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    });

    expect(addedStream()).toMatchObject({ messageId: 'm1', conversationId: 'conv-C', isOwn: true });
  });

  // An external setMessages() — a surface's load-on-select writing ANOTHER conversation's history
  // into this chat while our stream runs. Its last entry is typically an assistant message. If the
  // mirror re-targeted onto it, it would removeStream our live stream (killing its Stop and its
  // SWR protection while the server bills on) and addStream a phantom on a message that finished
  // long ago, whose Stop reports not_found — silent by design.
  it('given another conversation history replaces the array mid-send, should keep the live stream and add no phantom', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    expect(addedStream()).toMatchObject({ messageId: 'm1', conversationId: 'conv-C' });
    mockAddStream.mockClear();

    rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'old-history-message', parts: [text('a reply from last week')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    });

    expect(mockRemoveStream).not.toHaveBeenCalled();
    expect(mockAddStream).not.toHaveBeenCalled();
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
    mockAddStream.mockClear();

    rerender({ status: 'streaming', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-C' });

    expect(mockRemoveStream).not.toHaveBeenCalled();
  });

  // The falling edge still works: when the LOCAL read genuinely ends, this tab's mirror of it ends
  // too. Anything that outlives the local read is the socket path's to own.
  it('given the send ends, should remove the mirrored stream', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    rerender({
      status: 'ready',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });

    expect(mockRemoveStream).toHaveBeenCalledWith('m1');
  });

  // ...and the NEXT send must start clean, under the conversation it is actually sent from. This is
  // what the falling-edge latch release buys: turn 2 in a DIFFERENT conversation must not inherit
  // turn 1's identity.
  it('given a second send in a different conversation, should latch the new conversation', () => {
    const { rerender } = render({
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('one')] },
      pageId: 'page-1',
      conversationId: 'conv-C',
    });
    rerender({ status: 'ready', ownAssistantMessage: { id: 'm1', parts: [text('one')] }, pageId: 'page-1', conversationId: 'conv-C' });
    mockAddStream.mockClear();

    // User is now in D and sends again.
    rerender({ status: 'submitted', ownAssistantMessage: undefined, pageId: 'page-1', conversationId: 'conv-D' });
    rerender({
      status: 'streaming',
      ownAssistantMessage: { id: 'm2', parts: [text('two')] },
      pageId: 'page-1',
      conversationId: 'conv-D',
    });

    expect(addedStream()).toMatchObject({ messageId: 'm2', conversationId: 'conv-D' });
  });
});
