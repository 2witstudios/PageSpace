import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';

const fetchWithAuth = vi.fn();
const openStreamSession = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: () => 'session-A',
}));

vi.mock('@/lib/ai/streams/streamSessionRegistry', () => ({
  openStreamSession: (descriptor: unknown) => openStreamSession(descriptor),
}));

import {
  ADMISSION_ENVELOPE_CONTENT_TYPE,
  STREAM_MODE_DETACHED,
  STREAM_MODE_HEADER,
} from '@/lib/ai/core/detached-stream-mode';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useChatSession } from '../useChatSession';

const envelope = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      mode: STREAM_MODE_DETACHED,
      messageId: 'msg-1',
      conversationId: 'conv-1',
      channelId: 'page-1',
      streamId: 'stream-1',
      startedAt: '2026-08-14T10:00:00.000Z',
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE } },
  );

/**
 * A legacy body in REAL SSE framing: every `data:` record is terminated by a blank line.
 *
 * The fixture used single `\n` separators, which the parser also happens to accept — so it
 * never exercised the framing the server actually emits (review: coderabbitai on PR #2410).
 */
const sseResponse = (records: string[]) =>
  new Response(records.map((r) => `data: ${r}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const userMessage = (text: string): UIMessage =>
  ({ id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

const mount = (overrides: Partial<Parameters<typeof useChatSession>[0]> = {}) => {
  const base: UIMessage[] = [];
  return renderHook(() =>
    useChatSession({
      api: '/api/ai/chat',
      channelId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-1', displayName: 'Ada' },
      getBaseMessages: () => base,
      ...overrides,
    }),
  );
};

const requestInit = (call = 0) => fetchWithAuth.mock.calls[call][1] as RequestInit;
const requestBody = (call = 0) => JSON.parse(String(requestInit(call).body));

beforeEach(() => {
  vi.clearAllMocks();
  usePendingStreamsStore.setState({ streams: new Map() });
  fetchWithAuth.mockResolvedValue(envelope());
});

describe('useChatSession — the send', () => {
  it('asks for a detached stream and identifies the tab', async () => {
    // `X-Browser-Session-Id` moved here from `createStreamTrackingFetch` — it is what the
    // server stamps on broadcasts so the originating TAB can filter its own echoes.
    const { result } = mount();

    await act(async () => {
      await result.current.sendMessage(userMessage('hi'), 'conv-1');
    });

    const headers = requestInit().headers as Record<string, string>;
    expect(headers[STREAM_MODE_HEADER]).toBe(STREAM_MODE_DETACHED);
    expect(headers['X-Browser-Session-Id']).toBe('session-A');
  });

  it('given an admission envelope, opens ONE session from the id the server STATED', async () => {
    const { result } = mount();

    await act(async () => {
      await result.current.sendMessage(userMessage('hi'), 'conv-1');
    });

    expect(openStreamSession).toHaveBeenCalledTimes(1);
    expect(openStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        channelId: 'page-1',
        isOwn: true,
        triggeredBy: { userId: 'user-1', displayName: 'Ada' },
      }),
    );
  });

  it('given an OLD SERVER answering text/event-stream, RELEASES the body and writes nothing', async () => {
    // What makes this client safe to deploy FIRST — but not by reading the body.
    //
    // The old server broadcasts `chat:stream_start` and serves `/stream-join`, so
    // `useChannelStreamSocket` already opens a registry session for this messageId and
    // subscribes to it. Reading the body as well made this tab TWO writers on one store entry
    // with independent counters, and `applySetStreamParts` silently drops whichever falls
    // behind (review finding). So the shell cancels the body and leaves rendering to the
    // socket, exactly as for a remote or bootstrapped stream.
    const body = sseResponse([
      '{"type":"start","messageId":"msg-legacy"}',
      '{"type":"text-delta","id":"t1","delta":"hello"}',
    ]);
    fetchWithAuth.mockResolvedValue(body);
    const { result } = mount();

    await act(async () => {
      await result.current.sendMessage(userMessage('hi'), 'conv-1');
    });

    expect(openStreamSession, 'no envelope, so no send-driven session').not.toHaveBeenCalled();
    expect(
      usePendingStreamsStore.getState().streams.size,
      'the shell must not become a second writer',
    ).toBe(0);
    expect(body.bodyUsed || body.body?.locked, 'the body is released, not left dangling').toBeTruthy();
  });

  it('given an old server, the send still RESOLVES at admission rather than at end-of-stream', async () => {
    // Reading the body meant `dispatch` awaited the whole generation: `status` stayed
    // 'submitted' throughout, and a mid-stream failure rejected the send — which rolls back the
    // user's own message via `rollbackOptimisticSendOnFailure`, even though the server had
    // persisted it and the generation was still running.
    fetchWithAuth.mockResolvedValue(sseResponse(['{"type":"start","messageId":"msg-legacy"}']));
    const { result } = mount();

    await act(async () => {
      await result.current.sendMessage(userMessage('hi'), 'conv-1');
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.error).toBeUndefined();
  });

  it('given a non-ok response, throws a typed cause and reports an error status', async () => {
    // Moved from `createStreamTrackingFetch`: read the body ONCE, where the status and the real
    // JSON are both in hand, rather than letting a bare Error be built from a re-read.
    fetchWithAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: 'out of credits' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const { result } = mount({ onError });

    await act(async () => {
      await expect(result.current.sendMessage(userMessage('hi'), 'conv-1')).rejects.toThrow();
    });

    expect(onError).toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('given a MALFORMED admission envelope, fails the send instead of reporting success', async () => {
    // The body is already spent by `response.json()`, so there is no legacy stream to fall back
    // to. Before this, the send fell off the end of an if/else into `setSendState(null)` — a
    // clean-looking send that started no generation and rendered nothing (review: coderabbitai
    // on PR #2410).
    fetchWithAuth.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE },
      }),
    );
    const onError = vi.fn();
    const { result } = mount({ onError });

    await act(async () => {
      await expect(result.current.sendMessage(userMessage('hi'), 'conv-1')).rejects.toThrow(
        /admission/i,
      );
    });

    expect(openStreamSession).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('sends the base messages plus the new one', async () => {
    const base = [userMessage('earlier')];
    const { result } = mount({ getBaseMessages: () => base });

    await act(async () => {
      await result.current.sendMessage(userMessage('now'), 'conv-1');
    });

    const sent = requestBody().messages as UIMessage[];
    expect(sent.map((m) => m.id)).toEqual(['u-earlier', 'u-now']);
  });
});

describe('useChatSession — two conversations at once', () => {
  it('leaves the first send running and does not stop, wait, or refuse the second', async () => {
    // THE acceptance sentence. Under the shared `Chat` this required
    // `useConversationSendHandoff`: a `stop()` on the first read, a wait of up to 1.5s for the
    // status to settle, and a refusal ("The previous response is still wrapping up") if it did
    // not. None of that exists now, so this test's real subject is what is ABSENT.
    let resolveFirst: ((r: Response) => void) | undefined;
    fetchWithAuth
      .mockImplementationOnce(() => new Promise<Response>((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => Promise.resolve(envelope({ messageId: 'msg-B', conversationId: 'conv-B' })));

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useChatSession({
          api: '/api/ai/chat',
          channelId: 'page-1',
          conversationId,
          triggeredBy: { userId: 'user-1', displayName: 'Ada' },
          getBaseMessages: () => [],
        }),
      { initialProps: { conversationId: 'conv-A' } },
    );

    // Send in A — still in flight.
    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.sendMessage(userMessage('a'), 'conv-A');
      void firstSend;
    });
    await waitFor(() => expect(result.current.status).toBe('submitted'));

    // Switch to B and send. No handoff, no settle wait, no refusal.
    rerender({ conversationId: 'conv-B' });
    await act(async () => {
      await result.current.sendMessage(userMessage('b'), 'conv-B');
    });

    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    // B admitted and rendering...
    expect(openStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-B', conversationId: 'conv-B' }),
    );
    // ...while A is STILL GENERATING, untouched.
    expect(requestBody(0).messages).toBeDefined();

    // Switching back shows A's send state, not B's — each conversation's status is its own.
    rerender({ conversationId: 'conv-A' });
    expect(result.current.status).toBe('submitted');

    // And A completes normally when the server answers.
    await act(async () => {
      resolveFirst!(envelope({ messageId: 'msg-A', conversationId: 'conv-A' }));
      await firstSend!;
    });
    expect(openStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-A', conversationId: 'conv-A' }),
    );
  });

  it('reports status per conversation, so a send elsewhere never shows as this one\'s', async () => {
    fetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
    const { result } = mount({ conversationId: 'conv-1' });

    act(() => {
      void result.current.sendMessage(userMessage('x'), 'conv-OTHER');
    });

    // A send into a conversation the user is not looking at keeps running and keeps writing to
    // the store; it simply stops being this surface's status.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(result.current.status).toBe('ready');
  });
});

describe('useChatSession — ask_user after a reload', () => {
  const askUserMessage = (state: string): UIMessage =>
    ({
      id: 'msg-persisted',
      role: 'assistant',
      parts: [{ type: 'tool-ask_user', toolCallId: 'call-1', state }],
    }) as unknown as UIMessage;

  it('answers from the PERSISTED assistant message, with no hydration step', async () => {
    // After a reload useChat's internal array was EMPTY, so `hydrateTransportBeforeReinvoke`
    // had to copy the store's snapshot into it before every re-invocation or the SDK threw on
    // an undefined last message and the route 400'd on `messages are required`. Here the store
    // IS the base, so the persisted message carrying the question is what gets sent.
    const base = [askUserMessage('input-available')];
    const { result } = mount({ getBaseMessages: () => base });

    await act(async () => {
      await result.current.addToolResult({
        tool: 'ask_user',
        toolCallId: 'call-1',
        output: { answers: ['yes'] },
        conversationId: 'conv-1',
      });
    });

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const sent = requestBody().messages as UIMessage[];
    const part = sent[0].parts[0] as unknown as { state: string; output: unknown };
    expect(part.state).toBe('output-available');
    expect(part.output).toEqual({ answers: ['yes'] });
  });

  it('does NOT resume while a question on the turn is still unanswered', async () => {
    // The predicate is ask_user-specific on purpose: every PageSpace turn ends with the executed
    // `finish` tool, so the SDK's stock `lastAssistantMessageIsCompleteWithToolCalls` would
    // auto-resubmit after every normal turn and loop forever.
    const base = [
      {
        id: 'msg-persisted',
        role: 'assistant',
        parts: [
          { type: 'tool-ask_user', toolCallId: 'call-1', state: 'input-available' },
          { type: 'tool-ask_user', toolCallId: 'call-2', state: 'input-available' },
        ],
      } as unknown as UIMessage,
    ];
    const { result } = mount({ getBaseMessages: () => base });

    await act(async () => {
      await result.current.addToolResult({
        tool: 'ask_user',
        toolCallId: 'call-1',
        output: { answers: ['yes'] },
        conversationId: 'conv-1',
      });
    });

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('useChatSession — regenerate', () => {
  it('re-sends the settled store view for the named conversation', async () => {
    // `regenerate` used to index into useChat's own array, crashing when empty and throwing
    // "not found" on an unknown id — so a Retry on a conversation opened from history acted on
    // an empty or stale transport copy.
    const base = [userMessage('the question')];
    const { result } = mount({ getBaseMessages: () => base });

    await act(async () => {
      await result.current.regenerate('conv-1', { body: { chatId: 'page-1' } });
    });

    expect(requestBody()).toMatchObject({ chatId: 'page-1' });
    expect((requestBody().messages as UIMessage[]).map((m) => m.id)).toEqual(['u-the question']);
  });
});
