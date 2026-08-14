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
  // TWO `createStreamTrackingFetch` DESCRIBES WERE HERE, AND THEY ARE GONE FOR DIFFERENT REASONS.
  //
  // "consuming-channel marking" pinned a DEAD MECHANISM. It asserted that a POST marked its
  // channel as being consumed by this browser context for as long as the response body was
  // being read — the one signal that stopped the originating tab from also joining its own
  // stream off the socket and rendering every token twice. Under detached mode no tab reads a
  // body: the sender's own send and the socket event open the SAME session through an
  // idempotent registry, keyed by the same messageId. The double-render is impossible rather
  // than prevented, so there is no behaviour left under those cases to preserve. Deleted.
  //
  // The second describe covered REAL behaviour that MOVED rather than died — the
  // `X-Browser-Session-Id` header on every send, and URL normalization. Those are now
  // `useChatSession`'s job, and the cases moved with them: see
  // `lib/ai/shared/hooks/__tests__/useChatSession.test.ts`.


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
