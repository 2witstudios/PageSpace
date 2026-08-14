/**
 * What the server does on the socket, exercised by feeding frames in and
 * watching what goes out. The session, the bridge, the meter and the hangup are
 * all fakes, so nothing here opens a connection or touches a ledger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { startVoiceCallRuntime } from '../voice-call-runtime';
import type { RealtimeCallSession } from '../realtime-call-session';
import type { VoiceBridgeClient } from '../voice-bridge-client';
import type { CallMeter } from '../call-metering';
import type { VoiceBridgeRequest } from '@pagespace/lib/realtime/voice-bridge-contract';

const SEED = [
  {
    type: 'conversation.item.create' as const,
    item: {
      type: 'message' as const,
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: 'earlier question' }],
    },
  },
];

function fakeSession(over: Partial<RealtimeCallSession> = {}) {
  const sent: Record<string, unknown>[] = [];
  let listener: ((event: unknown) => void) | undefined;
  let unsubscribed = false;
  const session: RealtimeCallSession & {
    sent: Record<string, unknown>[];
    emit: (event: unknown) => void;
    unsubscribed: () => boolean;
  } = {
    callId: 'rtc_1',
    userId: 'u1',
    conversationId: 'conv1',
    subscribe: (fn) => {
      listener = fn;
      return () => {
        unsubscribed = true;
      };
    },
    send: (event) => {
      sent.push(event);
    },
    end: vi.fn(),
    ended: false,
    ...over,
    sent,
    emit: (event: unknown) => listener?.(event),
    unsubscribed: () => unsubscribed,
  };
  return session;
}

function fakeMeter() {
  return {
    record: vi.fn(),
    touch: vi.fn(),
    settle: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    billedDollars: 0,
    stopped: false,
  } satisfies CallMeter;
}

/** Answers each hop as the web tier would: a tool result, or a recorded row. */
const defaultRespond = (
  request: VoiceBridgeRequest,
): Awaited<ReturnType<VoiceBridgeClient['send']>> =>
  request.kind === 'tool_started' || request.kind === 'tool_finished'
    ? { ok: true, kind: 'tool_activity', saved: true, messageId: 'm1', rev: 1 }
    : { ok: true, kind: 'tool', output: 'Two pages.', failed: false };

function fakeBridge(
  respond: (request: VoiceBridgeRequest) => Awaited<ReturnType<VoiceBridgeClient['send']>> = defaultRespond,
) {
  const requests: VoiceBridgeRequest[] = [];
  return {
    requests,
    /** The dispatch hop, found by kind — the thread record also uses this bridge. */
    dispatch: () => requests.find((r) => r.kind === 'tool'),
    ofKind: (kind: VoiceBridgeRequest['kind']) => requests.filter((r) => r.kind === kind),
    client: {
      send: vi.fn(async (request: VoiceBridgeRequest) => {
        requests.push(request);
        return respond(request);
      }),
    } as VoiceBridgeClient,
  };
}

const responseDone = (over: Record<string, unknown> = {}) => ({
  type: 'response.done',
  response: { output: [], ...over },
});

const toolCall = (over: Record<string, unknown> = {}) => ({
  type: 'function_call',
  name: 'list_pages',
  call_id: 'call_1',
  arguments: '{\n  "driveId": "d1"\n}',
  ...over,
});

/** Lets the runtime's un-awaited bridge work settle before assertions. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('startVoiceCallRuntime — seeding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a seed, should send every item immediately', async () => {
    const session = fakeSession();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: SEED,
    });

    expect(session.sent).toEqual(SEED);
  });

  it('given an empty seed, should send nothing — a fresh conversation seeds nothing', () => {
    const session = fakeSession();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    expect(session.sent).toEqual([]);
  });
});

describe('startVoiceCallRuntime — showing the work in the thread', () => {
  it('should record the call as running BEFORE the tool answers, then as done', async () => {
    // The order is the feature: a row that only appears once the tool has
    // finished is a result, not a spinner, and the whole point is filling the
    // wait.
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    const kinds = bridge.requests.map((r) => r.kind);
    expect(kinds.indexOf('tool_started')).toBeLessThan(kinds.indexOf('tool'));
    expect(kinds.indexOf('tool')).toBeLessThan(kinds.indexOf('tool_finished'));
  });

  it('should name the SAME row in both phases, so it converges instead of doubling', async () => {
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    const [finished] = bridge.ofKind('tool_finished');
    expect(finished).toMatchObject({
      messageId: 'm1',
      toolCallId: 'call_1',
      output: 'Two pages.',
    });
  });

  it('should not delay the model behind the thread record', async () => {
    // The caller is already sitting through the tool. A row nobody is waiting
    // for must not be added to that wait.
    const session = fakeSession();
    let releaseRecord: () => void = () => {};
    const bridge = fakeBridge();
    const slow = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const original = bridge.client.send;
    bridge.client.send = (async (request: VoiceBridgeRequest) => {
      if (request.kind === 'tool_started') await slow;
      return original(request);
    }) as VoiceBridgeClient['send'];

    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    // The model already has its answer while the record is still blocked.
    expect(session.sent[0]).toMatchObject({
      item: { type: 'function_call_output', output: 'Two pages.' },
    });
    expect(session.sent[1]).toEqual({ type: 'response.create' });
    releaseRecord();
  });

  it('given the hop itself failed, should record the call as an error', async () => {
    const session = fakeSession();
    const bridge = fakeBridge((request) =>
      request.kind === 'tool'
        ? { ok: false, error: 'Voice bridge is unreachable' }
        : { ok: true, kind: 'tool_activity', saved: true, messageId: 'm1', rev: 1 },
    );
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    const [finished] = bridge.ofKind('tool_finished') as { errorText?: string }[];
    expect(finished.errorText).toContain("couldn't run that");
  });

  it('given a tool that RAN and failed, should record an error rather than a result', async () => {
    // The sharp case. A tool that threw, was refused, or was called with bad
    // parameters still comes back over a perfectly healthy hop carrying a
    // speakable sentence — the model is blocked until it gets one. Reading
    // `ok` alone would file a permission error in the thread as a completed
    // call, rendered green.
    const session = fakeSession();
    const bridge = fakeBridge((request) =>
      request.kind === 'tool'
        ? { ok: true, kind: 'tool', output: "That didn't work: permission denied", failed: true }
        : { ok: true, kind: 'tool_activity', saved: true, messageId: 'm1', rev: 1 },
    );
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.ofKind('tool_finished')[0]).toMatchObject({
      errorText: "That didn't work: permission denied",
    });
    // The model still gets its answer — it is blocked until it does.
    expect(session.sent[0]).toMatchObject({
      item: { output: "That didn't work: permission denied" },
    });
  });

  it('given a tool that succeeded, should record a result and no error', async () => {
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    const [finished] = bridge.ofKind('tool_finished') as { errorText?: string }[];
    expect(finished.errorText).toBeUndefined();
  });

  it('given an UNBOUND call, should run the tool and record nothing', async () => {
    // No conversation means no thread to write into — a real, supported state.
    const session = fakeSession({ conversationId: undefined });
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.ofKind('tool_started')).toEqual([]);
    expect(bridge.ofKind('tool_finished')).toEqual([]);
    expect(bridge.dispatch()).toBeDefined();
  });

  it('given the row could not be created, should not try to update one', async () => {
    const session = fakeSession();
    const bridge = fakeBridge((request) =>
      request.kind === 'tool_started'
        ? { ok: false, error: 'nope' }
        : request.kind === 'tool_finished'
          ? { ok: true, kind: 'tool_activity', saved: true, messageId: 'm1', rev: 1 }
          : { ok: true, kind: 'tool', output: 'Two pages.', failed: false },
    );
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.ofKind('tool_finished')).toEqual([]);
    // And the turn is unharmed.
    expect(session.sent[1]).toEqual({ type: 'response.create' });
  });
});

describe('startVoiceCallRuntime — tool dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a function call, should dispatch it and answer with a STRING output then response.create', async () => {
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.dispatch()).toMatchObject({
      kind: 'tool',
      name: 'list_pages',
      argumentsJson: '{\n  "driveId": "d1"\n}',
      userId: 'u1',
      conversationId: 'conv1',
    });
    expect(session.sent[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: 'Two pages.' },
    });
    expect(typeof (session.sent[0].item as { output: unknown }).output).toBe('string');
    // Without this the model holds the result and never speaks.
    expect(session.sent[1]).toEqual({ type: 'response.create' });
  });

  it('given the call context, should forward timezone and location so tools resolve "this page"', async () => {
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
      timezone: 'America/New_York',
      locationContext: { currentPage: { id: 'p1', title: 'Notes', type: 'DOCUMENT', path: '/n' } },
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.dispatch()).toMatchObject({
      timezone: 'America/New_York',
      locationContext: { currentPage: { id: 'p1' } },
    });
  });

  it('given TWO calls in one turn, should answer both and send exactly ONE response.create', async () => {
    // A response per output would have the model start speaking about the first
    // tool and interrupt itself when the second landed.
    const session = fakeSession();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(
      responseDone({ output: [toolCall(), toolCall({ call_id: 'call_2', name: 'read_page' })] }),
    );
    await flush();

    const outputs = session.sent.filter((event) => event.type === 'conversation.item.create');
    const creates = session.sent.filter((event) => event.type === 'response.create');
    expect(outputs).toHaveLength(2);
    expect(creates).toHaveLength(1);
  });

  it('given the bridge is down, should STILL answer the call so the model is never left waiting', async () => {
    const session = fakeSession();
    const bridge = fakeBridge(() => ({ ok: false, error: 'Voice bridge is unreachable' }));
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(session.sent[0]).toMatchObject({
      item: { type: 'function_call_output', call_id: 'call_1' },
    });
    expect(typeof (session.sent[0].item as { output: unknown }).output).toBe('string');
    expect(session.sent[1]).toEqual({ type: 'response.create' });
  });

  it('given ONE answer that THROWS, should still send response.create for the rest of the turn', async () => {
    // `session.send` throws if the socket rejects a frame. Under `Promise.all`
    // the first such throw skipped the response.create below it, and the model
    // held a turn it never spoke — the one unrecoverable outcome.
    const session = fakeSession();
    let sends = 0;
    const sent: Record<string, unknown>[] = [];
    session.send = (event) => {
      sends += 1;
      if (sends === 1) throw new Error('socket rejected the frame');
      sent.push(event);
    };
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(
      responseDone({ output: [toolCall(), toolCall({ call_id: 'call_2', name: 'read_page' })] }),
    );
    await flush();

    expect(sent).toContainEqual({ type: 'response.create' });
  });

  it('given an UNBOUND call, should still dispatch tools — with no conversation on the request', async () => {
    // A call with no thread still runs tools and still meters; it simply has
    // nowhere to write a transcript.
    const session = fakeSession({ conversationId: undefined });
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.dispatch()).not.toHaveProperty('conversationId');
    expect(session.sent[1]).toEqual({ type: 'response.create' });
  });

  it('given an answer that throws a NON-Error, should still reach response.create', async () => {
    const session = fakeSession();
    let sends = 0;
    const sent: Record<string, unknown>[] = [];
    session.send = (event) => {
      sends += 1;
      if (sends === 1) throw 'socket string blip';
      sent.push(event);
    };
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(sent).toContainEqual({ type: 'response.create' });
  });

  it('given the session ENDED while the tools ran, should not ask a dead socket to respond', async () => {
    const session = fakeSession();
    const bridge = fakeBridge(() => {
      // The call ends mid-dispatch — the caller hung up while a tool was running.
      (session as { ended: boolean }).ended = true;
      return { ok: true, kind: 'tool', output: 'Two pages.', failed: false };
    });
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(session.sent.filter((event) => event.type === 'response.create')).toHaveLength(0);
  });

  it('given the bridge REFUSES a transcript, should log the dropped row and carry on', async () => {
    const session = fakeSession();
    const bridge = fakeBridge((request) =>
      request.kind === 'transcript'
        ? { ok: false, error: 'Voice bridge is unreachable' }
        : { ok: true, kind: 'tool', output: 'ok', failed: false },
    );
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello there',
    });
    await flush();

    // A dropped transcript is a logged row, never a dropped call.
    expect(bridge.requests).toHaveLength(1);
    expect(session.ended).toBe(false);
  });

  it('given a transcript write that rejects with a NON-Error, should still not raise an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const session = fakeSession();
    const bridge = fakeBridge((request) => {
      if (request.kind === 'transcript') throw 'bridge string blip';
      return { ok: true, kind: 'tool', output: 'ok', failed: false };
    });
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello there',
    });
    await flush();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('given a transcript write that REJECTS, should log it rather than raise an unhandled rejection', async () => {
    // An unhandled rejection inside a socket event handler takes the process
    // down by default, which would drop every other live call in it.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const session = fakeSession();
    const bridge = fakeBridge((request) => {
      if (request.kind === 'transcript') throw new Error('bridge exploded');
      return { ok: true, kind: 'tool', output: 'ok', failed: false };
    });
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello there',
    });
    await flush();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('given a response with no tool calls, should send nothing back', async () => {
    const session = fakeSession();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone());
    await flush();

    expect(session.sent).toEqual([]);
  });
});

describe('startVoiceCallRuntime — transcripts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a user transcript, should persist it as a user turn', async () => {
    const session = fakeSession();
    const bridge = fakeBridge(() => ({ ok: true, kind: 'transcript', saved: true, messageId: 'm1', rev: 2 }));
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'where are my notes?',
    });
    await flush();

    expect(bridge.requests[0]).toMatchObject({
      kind: 'transcript',
      role: 'user',
      text: 'where are my notes?',
      conversationId: 'conv1',
    });
  });

  it('given an assistant transcript, should persist it as an assistant turn', async () => {
    const session = fakeSession();
    const bridge = fakeBridge(() => ({ ok: true, kind: 'transcript', saved: true, messageId: 'm1', rev: 2 }));
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({ type: 'response.output_audio_transcript.done', transcript: 'In your Inbox.' });
    await flush();

    expect(bridge.requests[0]).toMatchObject({ kind: 'transcript', role: 'assistant' });
  });

  it('given an UNBOUND call, should skip persistence without failing the call', async () => {
    // Binding state must never gate a call: it still runs tools and still meters.
    const session = fakeSession({ conversationId: undefined });
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello',
    });
    await flush();

    expect(bridge.requests.filter((request) => request.kind === 'transcript')).toEqual([]);
  });
});

describe('startVoiceCallRuntime — metering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a response with usage, should record it', async () => {
    const session = fakeSession();
    const meter = fakeMeter();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ usage: { input_tokens: 7, output_tokens: 3 } }));

    expect(meter.record).toHaveBeenCalledWith({ input_tokens: 7, output_tokens: 3 });
  });

  it('given a response that BOTH carries usage and asks for a tool, should record the usage too', async () => {
    const session = fakeSession();
    const meter = fakeMeter();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()], usage: { input_tokens: 7 } }));
    await flush();

    expect(meter.record).toHaveBeenCalledWith({ input_tokens: 7 });
  });

  it('given conversational activity, should keep the idle timer alive', () => {
    const session = fakeSession();
    const meter = fakeMeter();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
    });

    session.emit({ type: 'input_audio_buffer.speech_started' });

    expect(meter.touch).toHaveBeenCalled();
  });

  it('given only housekeeping frames, should NOT count them as activity', () => {
    // Otherwise the idle reaper is permanently unreachable — an abandoned call
    // still receives rate-limit updates.
    const session = fakeSession();
    const meter = fakeMeter();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
    });

    session.emit({
      type: 'rate_limits.updated',
      rate_limits: [{ name: 'tokens', limit: 40000, remaining: 100 }],
    });

    expect(meter.touch).not.toHaveBeenCalled();
  });

  it('given a malformed frame, should not throw into the socket', () => {
    const session = fakeSession();
    startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    expect(() => session.emit(undefined)).not.toThrow();
    expect(() => session.emit('a string')).not.toThrow();
    expect(() => session.emit({ type: 42 })).not.toThrow();
  });
});

describe('startVoiceCallRuntime — teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a limit was hit, should settle the meter, hang up the BROWSER, then end the session', async () => {
    // Closing our own socket does not end the caller's WebRTC session; without
    // the hangup, every limit would be half a limit.
    const order: string[] = [];
    const session = fakeSession({ end: vi.fn(() => order.push('end')) });
    const meter = fakeMeter();
    meter.stop = vi.fn(async () => {
      order.push('meter');
    });
    const hangUp = vi.fn(async () => {
      order.push('hangup');
      return true;
    });

    const runtime = startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_secret',
      seed: [],
      hangUp,
    });

    await runtime.stop('duration_cap');

    expect(order).toEqual(['meter', 'hangup', 'end']);
    expect(hangUp).toHaveBeenCalledWith('rtc_1', 'ek_secret');
    expect(meter.stop).toHaveBeenCalledWith('duration_cap');
  });

  it("given our attached socket closed, should STILL hang up — that does not prove the browser's call ended", async () => {
    // 'call_ended' is the reason `onClosed` reports for every attached-socket
    // close, including a network drop, a process shutdown and the one-hour
    // socket backstop. None of those touch the browser's independent WebRTC
    // session, so skipping the hangup here left a live, unmetered call up.
    const hangUp = vi.fn(async () => true);
    const runtime = startVoiceCallRuntime({
      session: fakeSession(),
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
      hangUp,
    });

    await runtime.stop('call_ended');

    expect(hangUp).toHaveBeenCalledWith('rtc_1', 'ek_1');
  });

  it('should stop listening on teardown', async () => {
    const session = fakeSession();
    const runtime = startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
      hangUp: vi.fn(async () => true),
    });

    await runtime.stop('call_ended');

    expect(session.unsubscribed()).toBe(true);
  });

  it('should be idempotent — a call torn down twice settles once', async () => {
    const meter = fakeMeter();
    const runtime = startVoiceCallRuntime({
      session: fakeSession(),
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
      hangUp: vi.fn(async () => true),
    });

    await Promise.all([runtime.stop('idle_timeout'), runtime.stop('call_ended')]);

    expect(meter.stop).toHaveBeenCalledTimes(1);
    expect(meter.stop).toHaveBeenCalledWith('idle_timeout');
  });
});

describe('startVoiceCallRuntime — the bound assistant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should echo the assistant on every tool dispatch', async () => {
    // The web tier holds no per-call state, so this process is the only one
    // that remembers which agent the call belongs to. Dropping it means the
    // tool runs as the caller, with the caller's broader reach.
    const assistant = {
      agentPageId: 'agent1',
      agentTitle: 'Release Notes Bot',
      enabledTools: ['read_page'],
    };
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
      assistant,
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.requests[0]).toMatchObject({ assistant });
  });

  it('given no assistant, should omit the field rather than send an empty one', async () => {
    const session = fakeSession();
    const bridge = fakeBridge();
    startVoiceCallRuntime({
      session,
      bridge: bridge.client,
      meter: fakeMeter(),
      secret: 'ek_1',
      seed: [],
    });

    session.emit(responseDone({ output: [toolCall()] }));
    await flush();

    expect(bridge.requests[0]).not.toHaveProperty('assistant');
  });
});

describe('startVoiceCallRuntime — a failing meter settle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should STILL hang up and end the session, rather than leave a live unmetered call', async () => {
    // Awaiting the settle first is right — the final window is usually the most
    // expensive part of the call — but it must not be able to block the
    // teardown it precedes.
    const meter = fakeMeter();
    meter.stop = vi.fn(async () => {
      throw new Error('ledger unreachable');
    });
    const hangUp = vi.fn(async () => true);
    const session = fakeSession();
    const runtime = startVoiceCallRuntime({
      session,
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
      hangUp,
    });

    await expect(runtime.stop('credit_exhausted')).resolves.toBeUndefined();

    expect(hangUp).toHaveBeenCalledWith('rtc_1', 'ek_1');
    expect(session.end).toHaveBeenCalledWith('credit_exhausted');
  });

  it('should not let the rejection escape into the void stop() callers', async () => {
    // attach-handler fires `void runtime?.stop(...)`; an unhandled rejection
    // there takes the process down and every other live call with it.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const meter = fakeMeter();
    meter.stop = vi.fn(async () => {
      throw 'ledger string blip';
    });
    const runtime = startVoiceCallRuntime({
      session: fakeSession(),
      bridge: fakeBridge().client,
      meter,
      secret: 'ek_1',
      seed: [],
      hangUp: vi.fn(async () => true),
    });

    void runtime.stop('call_ended');
    await flush();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
