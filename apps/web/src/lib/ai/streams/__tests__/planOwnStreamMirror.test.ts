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
  lastMirroredParts: [] as ReturnType<typeof text>[],
  // Default: the surface has not moved. The array-moved tests set this false explicitly.
  surfaceStillOnStreamConversation: true,
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
      ...BASE,
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
      surfaceStillOnStreamConversation: false,
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

  // The two failures can COINCIDE — a load-on-select moves the array while an auth refresh wipes
  // the channel — and that combination is the worst case, because once the array has moved off our
  // latched id NO further token will ever arrive for it. Returning nothing here lost the stream's
  // entry PERMANENTLY for that send: no Stop, no SWR protection, server still generating and
  // billing. Restore the LATCHED stream (with the content we last mirrored), and still refuse to
  // adopt the history message.
  it('given the array moved onto another message AND the entry was wiped, should restore the latched stream and adopt nothing', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'someone-elses-old-message', parts: [text('old')] },
      mirroredMessageId: 'm1',
      mirroredEntryExists: false,
      surfaceStillOnStreamConversation: false,
      lastMirroredParts: [text('what we had so far')],
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
          parts: [text('what we had so far')],
        },
      },
    ]);
  });

  // Same, when the array was EMPTIED rather than moved (agent deselect) and the entry was wiped in
  // the same window. No message on screen is not a reason to lose a running generation.
  it('given the array was emptied AND the entry was wiped, should restore the latched stream', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: undefined,
      mirroredMessageId: 'm1',
      mirroredEntryExists: false,
      surfaceStillOnStreamConversation: false,
      lastMirroredParts: [text('what we had so far')],
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
          parts: [text('what we had so far')],
        },
      },
    ]);
  });

  // ...but with the entry intact, a moved array is still just noise: hold, and adopt nothing.
  it('given the array moved onto another message while our entry is intact, should plan nothing', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'someone-elses-old-message', parts: [text('old')] },
      mirroredMessageId: 'm1',
      mirroredEntryExists: true,
      surfaceStillOnStreamConversation: false,
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

  // The planner still mirrors whatever message it is HANDED during submitted — but its caller
  // (useOwnStreamMirror) never hands it one, because an assistant message visible during the
  // submitted window is the previous turn's reply, not this stream's. That rule lives in the hook,
  // where the status/array timing is observable; this stays a pure function of its inputs.
  it('given a submitted status and a message it was handed, should mirror it (the caller decides what to hand it)', () => {
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
  // THE SDK's SERVER-ID ADOPTION — a mid-send id change that is NOT the array moving, and that the
  // mirror MUST follow. When the route writes a data part before the `start` chunk (the ungated
  // `data-command-execution` path — any message containing a command token), useChat pushes the
  // assistant message under a CLIENT-generated id, React renders, and the mirror latches it. The
  // `start` chunk then swaps in the server id. This repo pins that behaviour in
  // sdkServerIdAdoption.test.ts.
  //
  // Refusing to re-target froze the entry under the client id — a name the server has never heard
  // of. Stop then took the isOwn branch (which outranks the pendingSend fallback that WOULD have
  // worked), aborted a nonexistent stream, got 'not_found', and said nothing — while the
  // generation kept running its write tools and kept billing.
  //
  // The discriminator is the surface: an external setMessages() that replaces the array is a
  // load-on-select for ANOTHER conversation, so the surface has moved off the stream's
  // conversation. The SDK adopting an id happens with the surface sitting exactly where it was.
  it('given the SDK adopts the server-issued id mid-send while the surface has not moved, should re-target onto it', () => {
    expect(planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'server-issued-id', parts: [text('He')] },
      mirroredMessageId: 'client-generated-id',
      surfaceStillOnStreamConversation: true,
    })).toEqual([
      { type: 'removeStream', messageId: 'client-generated-id' },
      {
        type: 'addStream',
        stream: {
          messageId: 'server-issued-id',
          pageId: 'page-1',
          conversationId: 'conv-1',
          triggeredBy: { userId: 'u1', displayName: 'Me' },
          isOwn: true,
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'setStreamParts', messageId: 'server-issued-id', parts: [text('He')], seq: 1 },
    ]);
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
