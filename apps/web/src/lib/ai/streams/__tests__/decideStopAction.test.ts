import { describe, it, expect } from 'vitest';
import { decideStopAction } from '../decideStopAction';

describe('decideStopAction', () => {
  // The normal case, and the one the old machinery got wrong the most: a stream the store
  // knows about is named by its messageId — the ONE name that survives a mid-stream
  // conversation switch, a surface swap, and a refresh, because it names the STREAM and not
  // the surface. This is what replaces holdForStream's latched refs: the store entry IS the
  // held identity.
  it('given a live own stream, should abort by its messageId', () => {
    expect(decideStopAction({
      activeStream: { messageId: 'm1', conversationId: 'conv-1', isOwn: true },
      pendingSendConversationId: null,
    })).toEqual({ type: 'abortByMessageId', messageId: 'm1' });
  });

  // A bootstrapped own stream (refresh mid-stream) or one this tab's own POST is producing: same
  // answer. The old code needed a claim protocol to decide who was allowed to answer this; a read
  // of the store needs no claim, which is why the "declined co-mounted surface never re-claims a
  // freed slot" gap (useAgentChannelMultiplayer:110-116) cannot exist here.
  it('given an own stream this tab did not start locally (bootstrapped after a refresh), should abort by its messageId', () => {
    expect(decideStopAction({
      activeStream: { messageId: 'm1', conversationId: 'conv-1', isOwn: true },
      pendingSendConversationId: null,
    })).toEqual({ type: 'abortByMessageId', messageId: 'm1' });
  });

  // A REMOTE stream is not ours to stop, and naming it would be worse than doing nothing: the
  // server's abort-by-messageId is scoped to the calling user, so someone else's stream resolves
  // to zero rows and reports 'not_found' — on which reportAbortOutcome is deliberately silent.
  // The Stop would look like it worked and stop nothing.
  it('given only a REMOTE stream and no pending send, should do nothing rather than name a stream it cannot stop', () => {
    expect(decideStopAction({
      activeStream: { messageId: 'their-m1', conversationId: 'conv-1', isOwn: false },
      pendingSendConversationId: null,
    })).toEqual({ type: 'none' });
  });

  // THE regression this ordering exists to prevent. On a shared conversation a remote stream can
  // be live while OUR send is still in its submitted window (useSendHandoff is passed
  // `isOwn === true` for exactly this reason). Naming the remote messageId here would abort
  // nothing, silently, while our generation kept running its write tools and kept billing —
  // and it would throw away the one name that would have worked.
  it('given a remote stream is live while our own send is still in the submitted window, should abort OUR conversation, not their messageId', () => {
    expect(decideStopAction({
      activeStream: { messageId: 'their-m1', conversationId: 'conv-1', isOwn: false },
      pendingSendConversationId: 'conv-1',
    })).toEqual({ type: 'abortByConversation', conversationId: 'conv-1' });
  });

  // THE submitted-window case. useChat sets status='submitted' BEFORE it issues the request and
  // pushes the assistant message only on the flip to 'streaming' — so for the 0.5-3s a real send
  // spends in auth/rate-limit/context-assembly there is no messageId anywhere, and no store entry.
  // That is the single most likely moment for a user to hit Stop (they just spotted a typo).
  // Streams are server-owned and survive the client disconnect, so without a name here the abort
  // was a guaranteed no-op: the fetch was cancelled, the button flipped back to Send, and the
  // server kept generating, kept running write tools, and kept BILLING.
  //
  // The conversationId captured AT SEND (the pendingSend key) is the one name the client holds
  // from t=0.
  it('given the submitted window with no store entry yet, should abort by the send-time conversationId', () => {
    expect(decideStopAction({
      activeStream: undefined,
      pendingSendConversationId: 'conv-at-send',
    })).toEqual({ type: 'abortByConversation', conversationId: 'conv-at-send' });
  });

  // The send-time id, NEVER the live surface id. A user who sends and then immediately switches
  // conversation (or hits New Chat) still has that first generation running; naming the surface's
  // CURRENT conversation would abort the wrong one — or nothing at all — while the real stream
  // billed on. This is the invariant holdForStream existed to protect, now carried by the
  // pendingSend key instead of a latched ref.
  it('given the surface switched conversation during the submitted window, should still abort the conversation the send was made in', () => {
    expect(decideStopAction({
      activeStream: undefined,
      pendingSendConversationId: 'conv-at-send',
    })).toEqual({ type: 'abortByConversation', conversationId: 'conv-at-send' });
  });

  // Precedence: once the stream exists in the store, its messageId is strictly better than the
  // conversation fallback — it is exact, and it reaches a stream whose conversation has since
  // been superseded. The fallback exists only for the window where no messageId exists at all.
  it('given both a live store entry and a pending send, should prefer the precise messageId', () => {
    expect(decideStopAction({
      activeStream: { messageId: 'm1', conversationId: 'conv-1', isOwn: true },
      pendingSendConversationId: 'conv-at-send',
    })).toEqual({ type: 'abortByMessageId', messageId: 'm1' });
  });

  // Nothing live and nothing sent: the button should not be rendered at all, but a Stop that
  // does reach here must not invent a name. Aborting by a guessed conversation would be a
  // request that can only ever report "nothing in flight" — noise, and a lie if it hit
  // something.
  it('given no live stream and no pending send, should do nothing', () => {
    expect(decideStopAction({ activeStream: undefined, pendingSendConversationId: null }))
      .toEqual({ type: 'none' });
  });
});
