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

  describe('setActiveStreamId / getActiveStreamId', () => {
    it('stores and retrieves streamId for chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBe('stream-456');
    });

    it('returns undefined for unknown chatId', async () => {
      const client = await import('../stream-abort-client');

      const result = client.getActiveStreamId({ chatId: 'unknown-chat' });
      expect(result).toBeUndefined();
    });

    it('overwrites previous streamId for same chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-old',
      });

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-new',
      });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBe('stream-new');
    });
  });

  describe('clearActiveStreamId', () => {
    it('removes streamId for chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      client.clearActiveStreamId({ chatId: 'chat-123' });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBeUndefined();
    });

    it('handles clearing non-existent chatId gracefully', async () => {
      const client = await import('../stream-abort-client');

      // Should not throw
      expect(() => {
        client.clearActiveStreamId({ chatId: 'non-existent' });
      }).not.toThrow();
    });
  });

  describe('abortActiveStream', () => {
    it('calls abort endpoint and clears state on success', async () => {
      const client = await import('../stream-abort-client');

      // Setup active stream
      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      // Mock successful abort response
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({
          aborted: true,
          code: 'aborted',
          reason: 'Stream aborted by user request',
        }),
      } as unknown as Response);

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(true);
      expect(result.reason).toBe('Stream aborted by user request');

      // Verify fetch was called correctly
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId: 'stream-456' }),
      });

      // Verify streamId was cleared
      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBeUndefined();
    });

    // The rolling-deploy hole. A stream started by a worker running the previous image has no
    // `stream_id` on its row, so the X-Stream-Id the client holds resolves to nothing. If the
    // conversation is not sent alongside it, the server has no second name to fall back to, reports
    // `not_found`, and the client stays SILENT by design — while the generation runs on and bills.
    it('sends the conversation alongside the streamId, so a streamId that resolves to nothing can still be stopped', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({ chatId: 'chat-123', streamId: 'stream-456' });
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ aborted: true, code: 'aborted', reason: '' }),
      } as unknown as Response);

      await client.abortActiveStream({ chatId: 'chat-123', conversationId: 'conv-1' });

      assert({
        given: 'a Stop naming a streamId, on a conversation the client also knows',
        should: 'send BOTH names, so the server can fall back when the precise one resolves to nothing',
        actual: JSON.parse(vi.mocked(fetchWithAuth).mock.calls[0][1]?.body as string),
        expected: { streamId: 'stream-456', conversationId: 'conv-1' },
      });
    });

    // The other half of the same guarantee: with no streamId in the map at all (the 0.5-3s TTFB
    // window, where the map is EMPTY because the response headers have not landed), Stop must still
    // reach the server by naming the conversation. Without this it was a guaranteed no-op.
    it('falls back to the conversation when the client holds no streamId yet', async () => {
      const client = await import('../stream-abort-client');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ aborted: true, code: 'aborted', reason: '' }),
      } as unknown as Response);

      const result = await client.abortActiveStream({ chatId: 'chat-none', conversationId: 'conv-1' });

      expect(JSON.parse(vi.mocked(fetchWithAuth).mock.calls[0][1]?.body as string)).toEqual({ conversationId: 'conv-1' });
      assert({
        given: 'Stop pressed before the response headers land, so no streamId exists client-side',
        should: 'still reach the server by naming the conversation',
        actual: result.code,
        expected: 'aborted',
      });
    });

    it('returns failure when no active stream exists', async () => {
      const client = await import('../stream-abort-client');

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('No active stream for this chat');
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('handles fetch error gracefully and preserves streamId', async () => {
      const client = await import('../stream-abort-client');

      // Setup active stream
      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      // Mock fetch error
      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('Network error'));

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Failed to call abort endpoint');
      // Verify streamId is preserved after fetch error (allows retry)
      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBe('stream-456');
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
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    };

    it('given a POST in flight, should mark the channel as consuming BEFORE the request leaves (it must not lose the race against broadcastAiStreamStart)', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      let markedAtRequestTime = false;
      vi.mocked(fetchWithAuth).mockImplementationOnce(async () => {
        markedAtRequestTime = consuming.isChannelConsuming('page-1');
        return streamingResponse();
      });

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });
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
    it('given the surface switched conversation, should use the CURRENT keys — not the ones it was built with', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      let chatId = 'conv-1';
      let channelId: string | undefined = 'agent-1';
      const trackingFetch = client.createStreamTrackingFetch({
        getChatId: () => chatId,
        getChannelId: () => channelId,
      });

      // The surface moves on — exactly the switch the frozen closure could not see.
      chatId = 'conv-2';
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
      // ...and the streamId is filed under the CURRENT conversation, so Stop can find it.
      expect(client.getActiveStreamId({ chatId: 'conv-2' })).toBe('stream-xyz');
      expect(client.getActiveStreamId({ chatId: 'conv-1' })).toBeUndefined();

      await drain(response);
    });

    it('given the response body finishes, should unmark the channel', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(streamingResponse(['a', 'b']));

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });
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

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      await response.body!.cancel('user stopped');

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given the fetch rejects, should unmark the channel (a stale mark would make this tab ignore its own stream forever)', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network down'));

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });

      await expect(trackingFetch('/api/ai/chat', { method: 'POST' })).rejects.toThrow('network down');
      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given a non-ok response (e.g. 402 out of credits), should unmark the channel', async () => {
      const client = await import('../stream-abort-client');
      const consuming = await import('@/lib/ai/streams/consumingChannels');

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response('{}', { status: 402 }));

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });
      await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(consuming.isChannelConsuming('page-1')).toBe(false);
    });

    it('given the tracked response, should preserve status and headers (the X-Stream-Id contract must survive the body re-wrap)', async () => {
      const client = await import('../stream-abort-client');

      const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'X-Stream-Id': 'stream-9' } }),
      );

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-1', getChannelId: () => 'page-1' });
      const response = await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Stream-Id')).toBe('stream-9');
      expect(client.getActiveStreamId({ chatId: 'chat-1' })).toBe('stream-9');
    });
  });

  describe('createStreamTrackingFetch', () => {
    it('extracts X-Stream-Id header and stores it for as long as the stream is running', async () => {
      const client = await import('../stream-abort-client');

      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('tok'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'X-Stream-Id': 'extracted-stream-id' } },
      );

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(response);

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-123', getChannelId: () => undefined });
      const tracked = await trackingFetch('/api/ai/chat', { method: 'POST' });

      // The headers have landed but the tokens are still arriving: this is exactly the window in
      // which Stop must be able to name the stream.
      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBe('extracted-stream-id');

      // Drain the body — the generation is now over.
      const reader = tracked.body!.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      // The streamId names THIS generation and dies with it. Keeping it meant that from the SECOND
      // turn of a conversation onward, the map held the PREVIOUS turn's id until the new headers
      // landed — so a Stop pressed in the TTFB window named a stream that had already finished.
      assert({
        given: 'a generation whose response body has ended',
        should: 'forget its streamId, so no later Stop can name a stream that is already over',
        actual: client.getActiveStreamId({ chatId: 'chat-123' }),
        expected: undefined,
      });
    });

    // The map slot is keyed by chatId, which is CONSTANT across turns. So an unconditional delete
    // on body-end lets a stream that is ENDING wipe the name of one that is still RUNNING: send
    // turn 2 while turn 1 is still streaming (exactly what the takeover exists for), turn 2's
    // headers claim the slot, then turn 1's body finally closes — and deletes turn 2's streamId.
    // Stop would then have no precise name for a live generation.
    it('does not let a finishing stream forget the name of a newer one', async () => {
      const client = await import('../stream-abort-client');

      // Turn 1 is streaming; we hold its body open.
      let releaseTurn1: (() => void) | undefined;
      const turn1 = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => {
              releaseTurn1 = () => { controller.close(); resolve(); };
            });
          },
        }),
        { status: 200, headers: { 'X-Stream-Id': 'stream-turn-1' } },
      );
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(turn1);

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'conv-1', getChannelId: () => undefined });
      const tracked1 = await trackingFetch('/api/ai/chat', { method: 'POST' });
      const drain1 = (async () => {
        const reader = tracked1.body!.getReader();
        while (!(await reader.read()).done) { /* drain */ }
      })();

      // Turn 2 is sent while turn 1 is still open, and claims the slot.
      client.setActiveStreamId({ chatId: 'conv-1', streamId: 'stream-turn-2' });

      // NOW turn 1's body finally ends.
      releaseTurn1!();
      await drain1;

      assert({
        given: "turn 1's body closing after turn 2 has already claimed the slot",
        should: "leave turn 2's streamId alone — it names a generation that is still running",
        actual: client.getActiveStreamId({ chatId: 'conv-1' }),
        expected: 'stream-turn-2',
      });
    });

    it('does not set streamId when header is missing', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        headers: {
          get: vi.fn().mockReturnValue(null),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-123', getChannelId: () => undefined });
      await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBeUndefined();
    });

    it('handles Request object as URL', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        headers: {
          get: vi.fn().mockReturnValue('stream-id'),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-123', getChannelId: () => undefined });
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
        headers: { get: vi.fn().mockReturnValue(null) },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ getChatId: () => 'chat-123', getChannelId: () => undefined });
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

  describe('co-mount collision — same chatId from two surfaces', () => {
    it('given two surfaces use the same chatId, second setActiveStreamId overwrites the first', async () => {
      const client = await import('../stream-abort-client');

      // Surface A (middle panel) registers its stream
      client.setActiveStreamId({ chatId: 'conv-xyz', streamId: 'middle-stream-A' });

      // Surface B (sidebar) registers with the same chatId — this is the bug
      client.setActiveStreamId({ chatId: 'conv-xyz', streamId: 'sidebar-stream-B' });

      // Middle panel's stop lookup now targets the sidebar's stream (wrong!)
      const storedId = client.getActiveStreamId({ chatId: 'conv-xyz' });
      expect(storedId).toBe('sidebar-stream-B');
    });

    it('given two surfaces use distinct chatIds, each surface retains its own entry', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({ chatId: 'conv-xyz', streamId: 'middle-stream-A' });
      client.setActiveStreamId({ chatId: 'sidebar:conv-xyz', streamId: 'sidebar-stream-B' });

      expect(client.getActiveStreamId({ chatId: 'conv-xyz' })).toBe('middle-stream-A');
      expect(client.getActiveStreamId({ chatId: 'sidebar:conv-xyz' })).toBe('sidebar-stream-B');
    });

    it('given distinct chatIds, clearing sidebar entry does not affect middle panel entry', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({ chatId: 'conv-xyz', streamId: 'middle-stream-A' });
      client.setActiveStreamId({ chatId: 'sidebar:conv-xyz', streamId: 'sidebar-stream-B' });

      client.clearActiveStreamId({ chatId: 'sidebar:conv-xyz' });

      expect(client.getActiveStreamId({ chatId: 'conv-xyz' })).toBe('middle-stream-A');
      expect(client.getActiveStreamId({ chatId: 'sidebar:conv-xyz' })).toBeUndefined();
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
