import { describe, it, expect } from 'vitest';
import { planOwnStreamMirror, isOwnStreamSending } from '../planOwnStreamMirror';

const IDENTITY = {
  pageId: 'page-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'u1', displayName: 'Me' },
  startedAt: '2024-01-01T00:00:00.000Z',
};

const BASE = {
  streamIdentity: IDENTITY,
  seq: 1,
  mirroredEntryExists: true,
};

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('planOwnStreamMirror', () => {
  it('given nothing sending and nothing mirrored, should plan no ops', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'ready',
      ownAssistantMessage: undefined,
      mirroredMessageId: undefined,
    })).toEqual([]);
  });

  // The local stream genuinely ended (the SDK reached ready/error). This entry is this tab's
  // mirror of its OWN local fetch, so it ends with it.
  it('given the local stream has ended but a mirror entry remains, should plan removeStream', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'ready',
      ownAssistantMessage: { id: 'm1', parts: [text('done')] },
      mirroredMessageId: 'm1',
    })).toEqual([{ type: 'removeStream', messageId: 'm1' }]);
  });

  it('given an error status with a mirror entry, should also plan removeStream', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'error',
      ownAssistantMessage: undefined,
      mirroredMessageId: 'm1',
    })).toEqual([{ type: 'removeStream', messageId: 'm1' }]);
  });

  it('given a fresh stream start (streaming, nothing mirrored yet), should plan addStream then setStreamParts', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      mirroredMessageId: undefined,
      mirroredEntryExists: false,
    })).toEqual([
      {
        type: 'addStream',
        stream: {
          messageId: 'm1',
          pageId: 'page-1',
          conversationId: 'conv-1',
          triggeredBy: { userId: 'u1', displayName: 'Me' },
          isOwn: true,
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'setStreamParts', messageId: 'm1', parts: [text('He')], seq: 1 },
    ]);
  });

  // THE identity fix (PR 5A). `streamIdentity` is LATCHED by the caller at the rising edge of the
  // send — while the surface is still on the conversation being sent to — and passed in here.
  // This function uses it verbatim and never a "live" value, because the surface moves
  // independently of the stream: useChat's id is constant, so switching conversation mid-flight
  // does NOT abort the POST. Recording the stream under wherever the surface has since wandered
  // is the epic's named past bug — Stop then names the wrong conversation (or nothing) while the
  // real generation keeps running its write tools and keeps billing.
  it('given the caller latched the send-time identity, should record the stream under THAT identity', () => {
    const ops = planOwnStreamMirror({
      seq: 1,
      streamIdentity: { ...IDENTITY, conversationId: 'conv-sent-from', pageId: 'page-sent-from' },
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('hi')] },
      mirroredMessageId: undefined,
      mirroredEntryExists: false,
    });
    expect(ops[0]).toEqual({
      type: 'addStream',
      stream: {
        messageId: 'm1',
        pageId: 'page-sent-from',
        conversationId: 'conv-sent-from',
        triggeredBy: { userId: 'u1', displayName: 'Me' },
        isOwn: true,
        startedAt: '2024-01-01T00:00:00.000Z',
      },
    });
  });

  it('given the same message already mirrored, should plan only setStreamParts', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      mirroredMessageId: 'm1',
    })).toEqual([
      { type: 'setStreamParts', messageId: 'm1', parts: [text('Hello')], seq: 1 },
    ]);
  });

  // THE array-replacement fix (PR 5A). Something OUTSIDE this chat can replace useChat's messages
  // while our stream is still in flight — the surfaces' load-on-select effects call
  // setMessages(<another conversation's history>), whose last entry is typically an assistant
  // message. Re-targeting the mirror onto it would (a) removeStream OUR live stream, killing its
  // Stop button and its SWR protection while the server keeps generating and billing, and
  // (b) addStream a PHANTOM live stream on a message that finished long ago, whose Stop aborts
  // nothing and reports not_found — on which reportAbortOutcome is deliberately silent.
  //
  // Within one send the mirrored id is latched. A different id means the array moved under us,
  // not that a new stream started: a new stream needs a new send, which passes through 'ready'
  // and clears the latch.
  it('given the assistant message is replaced mid-send by another conversation history, should ignore it and keep the latched stream', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'someone-elses-old-message', parts: [text('old reply')] },
      mirroredMessageId: 'm1',
    })).toEqual([]);
  });

  // THE vanishing-message fix (PR 5A). GlobalAssistantView clears agent messages when the user
  // deselects the agent (setAgentMessages([])) and never calls agentStop() on that path, so the
  // agent chat stays 'streaming' with an empty array. Treating "no assistant message on screen"
  // as "the stream ended" removed a live stream's entry — and a local stop would not have stopped
  // the server anyway. Liveness is the STATUS's answer, not the array's.
  it('given the message array is emptied mid-send, should keep the latched stream rather than removing it', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: undefined,
      mirroredMessageId: 'm1',
    })).toEqual([]);
  });

  // THE external-wipe fix (PR 5A round 2). `useChannelStreamSocket`'s cleanup calls
  // clearPageStreams(channelId) whenever its effect re-runs — and a routine `auth:refreshed` mints
  // a brand-new socket, so this happens mid-stream on an ordinary token refresh. That wipes EVERY
  // entry on the channel, including this tab's own live mirrored one.
  //
  // The mirror could not recover: its id is latched, so it emitted only setStreamParts, and
  // applySetStreamParts no-ops on an absent entry (`if (!existing) return streams`). The stream was
  // gone from the store for the rest of the send — content vanished from screen (store-first
  // render), the Stop button disappeared, the editing-store registration lapsed, and the server
  // kept generating and billing.
  //
  // Re-asserting addStream is idempotent (applyAddStream no-ops when the id is present), so this
  // costs nothing in the normal case and restores the entry in the wiped one.
  it('given the latched entry was wiped from the store externally mid-send, should re-assert addStream', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'm1', parts: [text('Hello')] },
      mirroredMessageId: 'm1',
      mirroredEntryExists: false,
    })).toEqual([
      {
        type: 'addStream',
        stream: {
          messageId: 'm1',
          pageId: 'page-1',
          conversationId: 'conv-1',
          triggeredBy: { userId: 'u1', displayName: 'Me' },
          isOwn: true,
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'setStreamParts', messageId: 'm1', parts: [text('Hello')], seq: 1 },
    ]);
  });

  // The re-assert must NOT fire for a message the array moved onto — that is the phantom this
  // module already refuses to create. Absent entry + different id is still "not ours".
  it('given the array moved onto another message AND no entry exists, should still plan nothing', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'someone-elses-old-message', parts: [text('old')] },
      mirroredMessageId: 'm1',
      mirroredEntryExists: false,
    })).toEqual([]);
  });

  it('given submitted status with no assistant message pushed yet and nothing mirrored, should plan no ops', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'submitted',
      ownAssistantMessage: undefined,
      mirroredMessageId: undefined,
    })).toEqual([]);
  });

  it('given a submitted status with the assistant message already present, should mirror it', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'submitted',
      ownAssistantMessage: { id: 'm1', parts: [text('He')] },
      mirroredMessageId: undefined,
      mirroredEntryExists: false,
    });
    expect(ops.map((o) => o.type)).toEqual(['addStream', 'setStreamParts']);
  });

  it('given identical input called twice, should produce deep-equal ops both times (idempotent)', () => {
    const input = {
      ...BASE,
      status: 'streaming' as const,
      ownAssistantMessage: { id: 'm1', parts: [text('Hi')] },
      mirroredMessageId: undefined,
      mirroredEntryExists: false,
    };
    expect(planOwnStreamMirror(input)).toEqual(planOwnStreamMirror(input));
  });
});

describe('isOwnStreamSending', () => {
  // Liveness is the status's answer alone. It deliberately does NOT consult the message array:
  // consulting it is what let an external setMessages() call look like "the stream ended".
  it('given status streaming, should be sending', () => {
    expect(isOwnStreamSending('streaming')).toBe(true);
  });

  it('given status submitted (the request is out, no chunk yet), should be sending', () => {
    expect(isOwnStreamSending('submitted')).toBe(true);
  });

  it('given status ready, should NOT be sending — this is what ends a send and clears the latch', () => {
    expect(isOwnStreamSending('ready')).toBe(false);
  });

  it('given status error, should NOT be sending', () => {
    expect(isOwnStreamSending('error')).toBe(false);
  });
});
