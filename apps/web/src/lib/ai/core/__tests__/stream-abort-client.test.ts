import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { assert } from './riteway';

const { mockToastWarning } = vi.hoisted(() => ({ mockToastWarning: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { warning: mockToastWarning },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../browser-session-id', () => ({
  getBrowserSessionId: () => 'test-browser-session-id',
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

describe('stream-abort-client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The two names Stop can actually use, now that the activeStreams chatId->streamId map is gone
  // (PR 5A, leaf 5.5.8). Neither needs a client-side map to stay in sync: the messageId is
  // recorded in usePendingStreamsStore at stream_start, and the conversationId is captured at
  // send. Both are covered here because they are the ONLY server-abort paths left.
  describe('abortActiveStreamByConversation', () => {
    // THE submitted-window path. A real send spends 0.5-3s before the response headers land, and
    // the conversation is the one name the client holds from t=0. Before this existed, a Stop in
    // that window named nothing: the fetch was cancelled, the button flipped back to Send, and
    // the server (which deliberately survives client disconnect) kept generating and billing.
    it('given a conversation, should post it to the abort endpoint and report the outcome', async () => {
      const client = await import('../stream-abort-client');
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(
        new Response(JSON.stringify({ aborted: true, code: 'aborted', reason: 'stopped' }), { status: 200 }),
      );

      const result = await client.abortActiveStreamByConversation({ conversationId: 'conv-1' });

      const [, init] = vi.mocked(fetchWithAuth).mock.calls[0];
      assert({
        given: 'a conversation id',
        should: 'name that conversation in the abort request',
        actual: JSON.parse(String(init?.body)),
        expected: { conversationId: 'conv-1' },
      });
      assert({
        given: 'the server confirmed the abort',
        should: 'report it aborted',
        actual: result.code,
        expected: 'aborted',
      });
    });

    // A failure to even reach the endpoint is not ambiguous: the server never heard the Stop, so
    // the generation is definitely still running, and still billing. That is 'unconfirmed', and
    // the user must be told — silence here would be a lie.
    it('given the abort endpoint is unreachable, should report unconfirmed rather than claiming success', async () => {
      const client = await import('../stream-abort-client');
      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network down'));

      const result = await client.abortActiveStreamByConversation({ conversationId: 'conv-1' });

      assert({
        given: 'the abort endpoint could not be reached',
        should: 'report the generation as still possibly running',
        actual: { aborted: result.aborted, code: result.code },
        expected: { aborted: false, code: 'unconfirmed' },
      });
    });
  });

  // AC1: the transport is the choke point where a client declares "I am consuming this
  // stream's body". It is the ONLY reason the client's own chat:stream_start is
  // uninteresting to it — and the reason a RELOADED tab (fresh module state, empty set)
  // re-attaches to its own stream instead of dropping it forever.
  describe('createStreamTrackingFetch — consuming-channel marking', () => {
    const streamingResponse = (chunks: string[] = ['data']) => {
      const encoder = new TextEncoder();
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
        },
      });
      return new Response(body, { status: 200 });
    };

    const drain = async (response: Response) => {
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    };

    it('given a POST in flight, should mark the channel as consuming BEFORE the request leaves (it must not lose the race against broadcastAiStreamStart)', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      let markedAtRequestTime = false;
      vi.mocked(fetchWithAuth).mockImplementationOnce(async () => {
        markedAtRequestTime = consuming.isChannelConsuming('page-1');
        return streamingResponse();
      });

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(markedAtRequestTime).toBe(true);
      await drain(response);
    });

    // THE FREEZE. useChat only rebuilds its `Chat` when its `id` changes, every surface passes a
    // CONSTANT id, and `Chat` binds its transport once in the constructor — so the FIRST transport
    // a surface builds serves every POST for the life of that surface. Baking the keys into this
    // closure froze them at whatever conversation/agent the surface happened to start with: after
    // one switch the streamId was WRITTEN under the old chatId and READ under the new one (a
    // guaranteed abort miss — the local fetch stops, the server keeps generating and billing), and
    // the wrong channel was marked consuming (so the tab failed to recognise its OWN stream on the
    // socket, joined its own multicast, and rendered the reply twice).
    //
    // The keys must be resolved at CALL time. One fetch, one switch, current keys.
    it('given the surface switched agent, should mark the CURRENT channel — not the one it was built with', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      let channelId: string | undefined = 'agent-1';
      const trackingFetch = client.createStreamTrackingFetch({
        getChannelId: () => channelId,
      });

      // The surface moves on — exactly the switch the frozen closure could not see.
      channelId = 'agent-2';

      let markedChannel: string | null = null;
      vi.mocked(fetchWithAuth).mockImplementationOnce(async () => {
        markedChannel = consuming.isChannelConsuming('agent-2') ? 'agent-2'
          : consuming.isChannelConsuming('agent-1') ? 'agent-1' : null;
        const base = streamingResponse();
        return new Response(base.body, { status: 200, headers: { 'X-Stream-Id': 'stream-xyz' } });
      });

      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      // The CURRENT channel is marked, not the one the transport was born with.
      expect(markedChannel).toBe('agent-2');

      await drain(response);
    });

    it('given the response body finishes, should unmark the channel', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(streamingResponse(['a', 'b']));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      // Still consuming while tokens are arriving — the headers landing is NOT the end.
      expect(consuming.isChannelConsuming('page-1')).toBe(true);

      await drain(response);

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given the body is cancelled (user hits Stop), should unmark the channel', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(streamingResponse(['a', 'b', 'c']));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      await response.body!.cancel('user stopped');

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given the fetch rejects, should unmark the channel (a stale mark would make this tab ignore its own stream forever)', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network down'));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });

      await expect(trackingFetch('/api/ai/chat', { method: 'POST' })).rejects.toThrow('network down');
      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given a non-ok response (e.g. 402 out of credits), should unmark the channel and throw a typed-cause Error (epic leaf 6.5) instead of returning the raw response', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'out_of_credits', message: 'balance too low' }), { status: 402 }),
      );

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      await expect(trackingFetch('/api/ai/chat', { method: 'POST' })).rejects.toMatchObject({
        cause: { code: 'out_of_credits', httpStatus: 402, message: 'balance too low', retryable: false },
      });

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    // Conversation scoping (the dual-stream fix): the mark must name the conversation the POST
    // body targets, so the socket can attach a DIFFERENT conversation's own handed-off stream on
    // the same channel — and the unmark must release that same key, not a channel-wide one.
    it('given a body carrying a conversationId, should scope the mark to that conversation and release the same key', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(streamingResponse(['a']));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: [], conversationId: 'conv-a' }),
      });

      // Marked for conv-a; conv-b on the same channel is NOT consuming, so its own
      // stream may attach off the socket.
      expect(consuming.isChannelConsuming('page-1', 'conv-a')).toBe(true);
      expect(consuming.isChannelConsuming('page-1', 'conv-b')).toBe(false);

      await drain(response);

      expect(consuming.isChannelConsuming('page-1', 'conv-a')).toBe(false);
      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given a body without a conversationId, should fall back to the channel-wide mark (conservative)', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(streamingResponse(['a']));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      // The sentinel mark makes EVERY conversation on the channel report consuming.
      expect(consuming.isChannelConsuming('page-1', 'conv-anything')).toBe(true);

      await drain(response);

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given a non-ok response with a non-JSON body, should still throw a safe typed-cause Error (never crash)', async () => {
      const client = await import('../stream-abort-client');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response('not json', { status: 500 }));

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      await expect(trackingFetch('/api/ai/chat', { method: 'POST' })).rejects.toMatchObject({
        cause: { code: 'unknown', httpStatus: 500, retryable: true },
      });
    });

    it('given the tracked response, should preserve status and headers (the X-Stream-Id contract must survive the body re-wrap)', async () => {
      const client = await import('../stream-abort-client');

      const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'X-Stream-Id': 'stream-9' } }),
      );

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(response.status).toBe(200);
      // The header still reaches the caller intact — the body re-wrap must not eat it. (Nothing
      // stores it client-side any more: the activeStreams map it fed is deleted, PR 5A.)
      expect(response.headers.get('X-Stream-Id')).toBe('stream-9');
    });
  });

  describe('createStreamTrackingFetch', () => {
    // The map slot is keyed by chatId, which is CONSTANT across turns. So an unconditional delete
    // on body-end lets a stream that is ENDING wipe the name of one that is still RUNNING: send
    // turn 2 while turn 1 is still streaming (exactly what the takeover exists for), turn 2's
    // headers claim the slot, then turn 1's body finally closes — and deletes turn 2's streamId.
    // Stop would then have no precise name for a live generation.
    it('handles Request object as URL', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        ok: true,
        headers: {
          get: vi.fn().mockReturnValue('stream-id'),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => undefined });
      const request = new Request('https://example.com/api/ai/chat');
      await trackingFetch(request, {});

      expect(fetchWithAuth).toHaveBeenCalledWith(
        'https://example.com/api/ai/chat',
        { headers: { 'x-browser-session-id': 'test-browser-session-id' } }
      );
    });

    it('includes X-Browser-Session-Id header and preserves existing headers', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        ok: true,
        headers: { get: vi.fn().mockReturnValue(null) },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ getChannelId: () => undefined });
      await trackingFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/chat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json',
            'x-browser-session-id': 'test-browser-session-id',
          }),
        })
      );
    });
  });

  // `aborted: false` used to mean two completely different things, and every caller threw the
  // result away — so the Stop button flipped back to Send regardless of what actually happened on
  // the server. Now that a cross-instance abort can genuinely fail, that distinction has to reach
  // the user, and ONLY when it is real.
  describe('reportAbortOutcome', () => {
    it('warns the user when the generation could not be confirmed stopped', async () => {
      const client = await import('../stream-abort-client');

      client.reportAbortOutcome({ aborted: false, code: 'unconfirmed', reason: 'still running' });

      assert({
        given: 'a stream that was asked to stop and did not',
        should: 'tell the user — it is still running, and still billing',
        actual: mockToastWarning.mock.calls.length,
        expected: 1,
      });
    });

    // The benign race: the stream ended a beat before Stop was pressed. This is COMMON. A toast
    // here would fire constantly, for a non-event the user cannot act on, and would teach them to
    // dismiss the warning above without reading it — which is worse than showing nothing at all.
    it('stays silent when there was no in-flight stream to stop', async () => {
      const client = await import('../stream-abort-client');

      client.reportAbortOutcome({ aborted: false, code: 'not_found', reason: 'nothing in flight' });

      assert({
        given: 'a Stop pressed just after the stream finished on its own',
        should: 'say nothing — a benign race is not a failure',
        actual: mockToastWarning.mock.calls.length,
        expected: 0,
      });
    });

    it('stays silent when the stream stopped', async () => {
      const client = await import('../stream-abort-client');

      client.reportAbortOutcome({ aborted: true, code: 'aborted', reason: '' });

      expect(mockToastWarning).not.toHaveBeenCalled();
    });

    it('warns only once when one Stop fires several aborts at the same stream', async () => {
      const client = await import('../stream-abort-client');

      client.reportAbortOutcomes([
        { aborted: false, code: 'unconfirmed', reason: 'still running' },
        { aborted: false, code: 'unconfirmed', reason: 'still running' },
      ]);

      assert({
        given: 'a surface that names its stream under two keys, both unconfirmed',
        should: 'warn once — they are the same stream',
        actual: mockToastWarning.mock.calls.length,
        expected: 1,
      });
    });

    // A request that never reached the server means the server never heard the Stop. The
    // generation is definitely still running. That is not "unknown" — it is the alarm case.
    it('treats an unreachable abort endpoint as still running', async () => {
      const client = await import('../stream-abort-client');
      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('offline'));

      const result = await client.abortActiveStreamByMessageId({ messageId: 'msg-1' });

      assert({
        given: 'the abort request never reaching the server',
        should: 'report the generation as unconfirmed rather than stopped',
        actual: result.code,
        expected: 'unconfirmed',
      });
    });
  });
});
