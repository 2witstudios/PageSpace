/**
 * THE ACCEPTANCE SENTENCES, at the level the bug lived.
 *
 * "A PageSpace user cannot send a message, open another chat, send a second one, and trust the
 * first completes." Everything in this workstream is in service of making that sentence false.
 *
 * This composes the REAL send shell, the REAL app-wide session registry, the REAL pending-streams
 * store and the REAL render selector, driven the way a surface drives them. Only two things are
 * faked, and both are network: `fetch` (which answers admission envelopes) and `consumeStreamJoin`
 * (which stands in for the SSE channel, so a test can deliver frames on demand).
 *
 * IT REPLACES `dualStreamHandoff.integration.test.tsx`, which composed the real own-stream mirror
 * and the real cross-conversation handoff over the same store. That test's subject was that a
 * second send was made SAFE by being made impossible-until-handed-off: stop the first read, wait
 * for the falling edge, rejoin. Its central case — chat 2's content must never land under chat 1's
 * key — is preserved below, but the mechanism it asserted is gone: there is no shared `Chat`, no
 * latch to mis-name, and no handoff to run. So the case is re-asked as what the user actually
 * wants, which is that BOTH sends work and neither disturbs the other.
 *
 * WHAT THIS CANNOT REACH: sentences that need a browser. Hard reload, second physical browser, and
 * true tab-close are asserted at the unit level instead (`useChannelStreamSocket` for unmount,
 * `isOwnStream` for cross-device ownership, `streamSessionRegistry` for bootstrap reseeding).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';

const fetchWithAuth = vi.fn();
// Typed from the real export, so a change to the join's signature fails COMPILATION here
// rather than leaving a mock that silently no longer matches its subject (review:
// coderabbitai on PR #2410). The `unknown[]` spread it replaced accepted anything forever.
const consumeStreamJoin =
  vi.fn<typeof import('@/lib/ai/core/stream-join-client').consumeStreamJoin>();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: () => 'session-A',
}));

vi.mock('@/lib/ai/core/stream-join-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/core/stream-join-client')>(
    '@/lib/ai/core/stream-join-client',
  );
  return {
    ...actual,
    consumeStreamJoin: (...args: Parameters<typeof actual.consumeStreamJoin>) =>
      consumeStreamJoin(...args),
  };
});

import {
  ADMISSION_ENVELOPE_CONTENT_TYPE,
  STREAM_MODE_DETACHED,
} from '@/lib/ai/core/detached-stream-mode';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { resetStreamSessionRegistry } from '@/lib/ai/streams/streamSessionRegistry';
import { selectRenderedMessages } from '@/lib/ai/streams/selectRenderedMessages';
import { deriveStreamingRegistrations } from '@/lib/ai/streams/deriveStreamingRegistrations';
import { selectActiveStream } from '@/lib/ai/streams/selectActiveStream';
import { useChatSession } from '@/lib/ai/shared/hooks/useChatSession';

const CHANNEL = 'user:u1:global';
const IDENTITY = { userId: 'u1', displayName: 'Me' };

const envelope = (messageId: string, conversationId: string) =>
  new Response(
    JSON.stringify({
      mode: STREAM_MODE_DETACHED,
      messageId,
      conversationId,
      channelId: CHANNEL,
      streamId: `stream-${messageId}`,
      startedAt: new Date().toISOString(),
    }),
    { status: 200, headers: { 'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE } },
  );

const userMessage = (id: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text: id }] }) as UIMessage;

const streams = () => usePendingStreamsStore.getState().streams;
const forConversation = (conversationId: string) =>
  [...streams().values()].filter((s) => s.conversationId === conversationId);

/** Per-messageId frame delivery, so a test can drive two streams independently. */
type JoinOnParts = Parameters<
  typeof import('@/lib/ai/core/stream-join-client').consumeStreamJoin
>[2];
const deliverers = new Map<string, JoinOnParts>();
const resolvers = new Map<string, (result: { aborted: boolean }) => void>();

const mountShell = (conversationId: string) =>
  renderHook(
    ({ convId }: { convId: string }) =>
      useChatSession({
        api: '/api/ai/global/messages',
        channelId: CHANNEL,
        conversationId: convId,
        triggeredBy: IDENTITY,
        getBaseMessages: () => [],
      }),
    { initialProps: { convId: conversationId } },
  );

beforeEach(() => {
  vi.clearAllMocks();
  deliverers.clear();
  resolvers.clear();
  resetStreamSessionRegistry();
  usePendingStreamsStore.setState({ streams: new Map() });

  consumeStreamJoin.mockImplementation((messageId, _signal, onParts) => {
    deliverers.set(messageId, onParts);
    return new Promise((resolve) => resolvers.set(messageId, resolve));
  });
});

afterEach(() => {
  resetStreamSessionRegistry();
});

describe('sentence 1 — send in A, switch to B, send in B; both send', () => {
  it('leaves the first generating and visible, with no stop, no settle wait, and no refusal', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(envelope('msg-A', 'conv-A'))
      .mockResolvedValueOnce(envelope('msg-B', 'conv-B'));

    const { result, rerender } = mountShell('conv-A');

    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'A is thinking' }], 0));

    // Switch to B and send IMMEDIATELY. Nothing gates this: the old path called `stop()`,
    // awaited a status settle for up to 1.5s, and could refuse outright.
    rerender({ convId: 'conv-B' });
    await act(async () => {
      await result.current.sendMessage(userMessage('u-b'), 'conv-B');
    });

    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    act(() => deliverers.get('msg-B')!([{ type: 'text', text: 'B is thinking' }], 0));

    // Both live, each under its OWN conversation. The bug the deleted test guarded against was
    // conv-A's entry adopting conv-B's content; here they cannot touch, because the store key is
    // the messageId the server stated in each envelope.
    expect(forConversation('conv-A')).toHaveLength(1);
    expect(forConversation('conv-B')).toHaveLength(1);
    expect(forConversation('conv-A')[0].parts).toEqual([{ type: 'text', text: 'A is thinking' }]);
    expect(forConversation('conv-B')[0].parts).toEqual([{ type: 'text', text: 'B is thinking' }]);

    // Switch back to A: still streaming, no seam — its entry never left the store.
    rerender({ convId: 'conv-A' });
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'A is thinking harder' }], 1));
    expect(forConversation('conv-A')[0].parts).toEqual([
      { type: 'text', text: 'A is thinking harder' },
    ]);
  });

  it('never fires a second request for the same generation, however many announcers arrive', async () => {
    // The originating tab's own send AND the socket's `chat:stream_start` both name the same
    // messageId. Under the old design a "consuming" mark had to suppress the second or every
    // token rendered twice; here the registry is idempotent.
    fetchWithAuth.mockResolvedValue(envelope('msg-A', 'conv-A'));
    const { result } = mountShell('conv-A');

    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });

    const { openStreamSession } = await import('@/lib/ai/streams/streamSessionRegistry');
    act(() => {
      // What the socket handler would do on `chat:stream_start` for the same stream.
      openStreamSession({
        messageId: 'msg-A',
        conversationId: 'conv-A',
        channelId: CHANNEL,
        triggeredBy: IDENTITY,
        isOwn: true,
        startedAt: new Date().toISOString(),
      });
    });

    expect(consumeStreamJoin).toHaveBeenCalledTimes(1);
    expect(forConversation('conv-A')).toHaveLength(1);
  });
});

describe('sentence 2 — both generating simultaneously', () => {
  it('renders two live entries, each naming its own messageId for its own Stop', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(envelope('msg-A', 'conv-A'))
      .mockResolvedValueOnce(envelope('msg-B', 'conv-B'));

    const { result, rerender } = mountShell('conv-A');
    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });
    rerender({ convId: 'conv-B' });
    await act(async () => {
      await result.current.sendMessage(userMessage('u-b'), 'conv-B');
    });

    // `selectActiveStream` is what every Stop button reads. Each conversation resolves to its
    // own stream, so each Stop aborts the generation the user is looking at — the mis-naming
    // the own-stream mirror's latch existed to prevent has no way to occur.
    const map = streams();
    const a = selectActiveStream(map, { pageId: CHANNEL, conversationId: 'conv-A' });
    const b = selectActiveStream(map, { pageId: CHANNEL, conversationId: 'conv-B' });

    expect(a?.messageId).toBe('msg-A');
    expect(b?.messageId).toBe('msg-B');
    expect(a?.isOwn).toBe(true);
    expect(b?.isOwn).toBe(true);

    // And SWR suppression covers both conversations at once rather than one winning.
    expect(deriveStreamingRegistrations({ pendingSends: new Set(), streams: map })).toEqual([
      'conv-A',
      'conv-B',
    ]);
  });
});

describe('sentence 3 — a mode/view switch is a pure view change', () => {
  it('keeps both streams recorded and rendering while the surface moves between them', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(envelope('msg-A', 'conv-A'))
      .mockResolvedValueOnce(envelope('msg-B', 'conv-B'));

    const { result, rerender } = mountShell('conv-A');
    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });
    rerender({ convId: 'conv-B' });
    await act(async () => {
      await result.current.sendMessage(userMessage('u-b'), 'conv-B');
    });

    // Frames keep landing for A while the surface shows B — the thing the deleted mode-switch
    // stops made impossible, freezing the reply at whatever had arrived before you looked away.
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'still going' }], 5));

    rerender({ convId: 'conv-A' });
    const rendered = selectRenderedMessages(
      { messages: [], optimisticSends: [] } as never,
      forConversation('conv-A'),
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].mode).toBe('streaming');
    expect(rendered[0].message.parts).toEqual([{ type: 'text', text: 'still going' }]);
  });
});

describe('sentence 4 — navigate away and back keeps full fidelity', () => {
  it('survives the surface unmounting entirely, command chips and reasoning intact', async () => {
    fetchWithAuth.mockResolvedValue(envelope('msg-A', 'conv-A'));
    const { result, unmount } = mountShell('conv-A');

    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });

    // The user leaves.
    unmount();

    // The generation keeps arriving — the subscription is the module's, not the component's.
    // Non-text parts are the fidelity half: the pre-#2408 wire carried a four-case projection
    // that dropped reasoning, files, sources and step boundaries.
    act(() =>
      deliverers.get('msg-A')!(
        [
          { type: 'reasoning', text: 'thinking about it' },
          { type: 'data-command-execution', data: { command: '/help' } },
          { type: 'text', text: 'the answer' },
        ],
        9,
      ),
    );

    const entry = forConversation('conv-A')[0];
    expect(entry, 'the store entry must outlive the surface that started it').toBeDefined();
    expect(entry.parts.map((p) => p.type)).toEqual([
      'reasoning',
      'data-command-execution',
      'text',
    ]);

    // And the app-wide SWR suppression is still in force for it, which is the other half of
    // "no seam" — a revalidation here would clobber the very content being streamed.
    expect(deriveStreamingRegistrations({ pendingSends: new Set(), streams: streams() })).toEqual([
      'conv-A',
    ]);
  });
});

describe('sentence 5 — a hard reload, as close as code can reach', () => {
  it('given fresh module state, a bootstrap reseeds the stream and it keeps rendering', async () => {
    // A hard reload is: module state gone, store gone, then `/active-streams` replays what is
    // still running. This simulates exactly that — `resetStreamSessionRegistry()` plus an empty
    // store IS the post-reload condition — and then drives the real registry through the same
    // `openStreamSession` call the socket hook makes from a bootstrap row.
    //
    // What it CANNOT reach is the browser half: an actual navigation, and the SDK's own
    // rehydration. Sentence 5 stays unverified end to end for that reason; this pins the
    // mechanism it depends on.
    fetchWithAuth.mockResolvedValue(envelope('msg-A', 'conv-A'));
    const { result, unmount } = mountShell('conv-A');
    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'before the reload' }], 3));

    // ---- the reload ----
    unmount();
    resetStreamSessionRegistry();
    usePendingStreamsStore.setState({ streams: new Map() });
    deliverers.clear();
    expect(forConversation('conv-A')).toHaveLength(0);

    // ---- what the bootstrap does on the way back up ----
    const { openStreamSession } = await import('@/lib/ai/streams/streamSessionRegistry');
    act(() => {
      openStreamSession({
        messageId: 'msg-A',
        conversationId: 'conv-A',
        channelId: CHANNEL,
        triggeredBy: IDENTITY,
        // Still the user's own stream after a reload — ownership is a USER question, and
        // `browserSessionId` (which survives in sessionStorage) is not what decides it.
        isOwn: true,
        startedAt: new Date().toISOString(),
        seedParts: [{ type: 'text', text: 'before the reload' }],
      });
    });

    // The persisted snapshot renders immediately rather than a blank bubble...
    expect(forConversation('conv-A')[0].parts).toEqual([
      { type: 'text', text: 'before the reload' },
    ]);
    expect(forConversation('conv-A')[0].isOwn).toBe(true);

    // ...and the re-opened join carries on from there.
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'and after it' }], 4));
    expect(forConversation('conv-A')[0].parts).toEqual([{ type: 'text', text: 'and after it' }]);
  });
});

describe('the completion ordering the render path depends on', () => {
  it('drops the entry only AFTER listeners have seen it, so the reply never blinks out', async () => {
    fetchWithAuth.mockResolvedValue(envelope('msg-A', 'conv-A'));
    const { result } = mountShell('conv-A');
    await act(async () => {
      await result.current.sendMessage(userMessage('u-a'), 'conv-A');
    });
    act(() => deliverers.get('msg-A')!([{ type: 'text', text: 'the full reply' }], 3));

    const { onStreamSessionEnd } = await import('@/lib/ai/streams/streamSessionRegistry');
    const partsAtEnd: unknown[] = [];
    const unsubscribe = onStreamSessionEnd((end) => {
      // What `conversationCacheSocketHandlers` does: commit the finished reply FROM the entry.
      partsAtEnd.push(streams().get(end.messageId)?.parts);
    });

    await act(async () => {
      resolvers.get('msg-A')!({ aborted: false });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    unsubscribe();

    expect(
      partsAtEnd[0],
      'the entry must still hold the reply when the completion fires — otherwise every turn '
        + 'falls through to a reload-from-DB and flashes',
    ).toEqual([{ type: 'text', text: 'the full reply' }]);
    await waitFor(() => expect(forConversation('conv-A')).toHaveLength(0));
  });
});
