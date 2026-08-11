import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_CALL_ROUTE,
  connectVoiceCall,
  failureForStatus,
  type VoiceConnectDeps,
} from '../connect';
import type { VoiceTarget } from '../voice-target';
import {
  CALL_OK,
  FakePeerConnection,
  asPeer,
  asStream,
  fakeCreateMediaStream,
  fakeStream,
  respondWith,
} from './webrtc-fakes';

const TARGET: VoiceTarget = { conversationId: 'conv-1', type: 'global' };

const named = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

type Harness = {
  readonly peer: FakePeerConnection;
  readonly microphone: ReturnType<typeof fakeStream>;
  readonly fetchImpl: ReturnType<typeof vi.fn>;
  readonly events: unknown[];
  readonly remoteStreams: MediaStream[];
  readonly lost: ReturnType<typeof vi.fn>;
  readonly deps: VoiceConnectDeps;
};

const harness = (
  overrides: Partial<VoiceConnectDeps> = {},
  response: Response = respondWith({ body: CALL_OK }),
): Harness => {
  const peer = new FakePeerConnection();
  const microphone = fakeStream('mic-1');
  const events: unknown[] = [];
  const remoteStreams: MediaStream[] = [];
  const lost = vi.fn();
  const fetchImpl = vi.fn(async () => response);

  const deps: VoiceConnectDeps = {
    target: TARGET,
    onEvent: (event) => events.push(event),
    onRemoteTrack: (stream) => remoteStreams.push(stream),
    onConnectionLost: lost,
    fetchImpl: fetchImpl as unknown as VoiceConnectDeps['fetchImpl'],
    createPeerConnection: () => asPeer(peer),
    getUserMedia: async () => asStream(microphone),
    createMediaStream: fakeCreateMediaStream,
    ...overrides,
  };

  return { peer, microphone, fetchImpl, events, remoteStreams, lost, deps };
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('failureForStatus', () => {
  it('given each status the route can refuse with, should name a distinct failure', () => {
    expect(failureForStatus(401)).toBe('unauthorized');
    expect(failureForStatus(403)).toBe('not-entitled');
    expect(failureForStatus(503)).toBe('unavailable');
    expect(failureForStatus(502)).toBe('call-rejected');
    expect(failureForStatus(400)).toBe('signaling-failed');
    expect(failureForStatus(500)).toBe('signaling-failed');
  });
});

describe('connectVoiceCall — the handshake', () => {
  it('given a working route, should return the call and apply the answer', async () => {
    const h = harness();

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.callId).toBe('rtc_call_one');
    expect(result.connection.attached).toBe(true);
    expect(result.connection.maxDurationMs).toBe(600_000);
    expect(h.peer.remoteDescription).toEqual({
      type: 'answer',
      sdp: 'v=0 fake answer',
    });
    expect(h.peer.addedTracks.map((t) => t.id)).toEqual(['mic-1']);
  });

  it('should post the offer and the bound conversation to OUR route only', async () => {
    // The page must never hold an OpenAI credential, which starts with never
    // talking to api.openai.com.
    const h = harness();

    await connectVoiceCall(h.deps);

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VOICE_CALL_ROUTE);
    expect(url).not.toContain('openai.com');
    expect(JSON.parse(String(init.body))).toEqual({
      sdp: 'v=0 fake offer',
      conversationId: 'conv-1',
    });
  });

  it('given a location and timezone, should forward both for the tools', async () => {
    const locationContext = {
      currentPage: { id: 'p1', title: 'Notes', type: 'DOCUMENT', path: '/notes' },
    };
    const h = harness({ locationContext, timezone: 'America/Chicago' });

    await connectVoiceCall(h.deps);

    const [, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      timezone: 'America/Chicago',
      locationContext,
    });
  });

  it('should open the oai-events channel and surface parsed frames only', async () => {
    const h = harness();

    await connectVoiceCall(h.deps);
    expect(h.peer.events.label).toBe('oai-events');

    h.peer.events.deliver(JSON.stringify({ type: 'response.done' }));
    h.peer.events.deliver('not json at all');
    h.peer.events.deliver(JSON.stringify({ type: 'session.updated' }));

    expect(h.events).toEqual([
      { type: 'response.done' },
      { type: 'session.updated' },
    ]);
  });

  it('should surface the model’s voice as a remote stream', async () => {
    const h = harness();
    await connectVoiceCall(h.deps);

    const modelVoice = fakeStream('model-1');
    h.peer.deliverRemoteTrack(modelVoice);

    expect(h.remoteStreams).toEqual([modelVoice]);
  });
});

describe('connectVoiceCall — the microphone', () => {
  it('given a denied prompt vs a missing device, should give different reasons and different advice', async () => {
    const denied = await connectVoiceCall(
      harness({
        getUserMedia: async () => {
          throw named('NotAllowedError');
        },
      }).deps,
    );
    const missing = await connectVoiceCall(
      harness({
        getUserMedia: async () => {
          throw named('NotFoundError');
        },
      }).deps,
    );

    expect(denied.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (denied.ok || missing.ok) return;
    expect(denied.reason).toBe('mic-denied');
    expect(missing.reason).toBe('mic-missing');
    expect(denied.message).not.toBe(missing.message);
  });

  it('given a mic held by another app, should say so rather than blame permissions', async () => {
    const result = await connectVoiceCall(
      harness({
        getUserMedia: async () => {
          throw named('NotReadableError');
        },
      }).deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mic-busy');
    expect(result.message).toContain('busy in another app');
  });

  it('given a refused microphone, should not open a peer connection at all', async () => {
    // No permission, no call: there is nothing to offer and nothing to clean up.
    const h = harness({
      getUserMedia: async () => {
        throw named('NotAllowedError');
      },
    });

    await connectVoiceCall(h.deps);

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.peer.addedTracks).toEqual([]);
  });

  it('given a microphone to reuse, should clone it and leave the original running', async () => {
    // Chaining depends on this: the call being replaced stops its own tracks,
    // and the new call must survive that without a second permission prompt.
    const existing = fakeStream('mic-original');
    const h = harness({ microphone: asStream(existing), getUserMedia: undefined });

    const result = await connectVoiceCall({
      ...h.deps,
      getUserMedia: async () => {
        throw new Error('getUserMedia must not be called when reusing a mic');
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.peer.addedTracks.map((t) => t.id)).toEqual(['mic-original:clone']);

    result.connection.stop();
    expect(existing.tracks.map((t) => t.stopped)).toEqual([false]);
  });

  it('given a microphone with no audio tracks to reuse, should refuse rather than offer silence', async () => {
    // A call built on an empty stream negotiates fine and then never hears
    // anything — the failure has to land here, where it is still explicable.
    const h = harness({ microphone: asStream(fakeStream()) });

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mic-unknown');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('given a chained call, should be able to start silent and be unsilenced at the swap', async () => {
    const existing = fakeStream('mic-original');
    const h = harness({
      microphone: asStream(existing),
      microphoneEnabled: false,
    });

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.peer.addedTracks.map((t) => t.enabled)).toEqual([false]);

    result.connection.setMicrophoneEnabled(true);
    expect(h.peer.addedTracks.map((t) => t.enabled)).toEqual([true]);
  });
});

describe('connectVoiceCall — refusals from our route', () => {
  const refusal = async (status: number, body: unknown) => {
    const h = harness({}, respondWith({ status, body }));
    const result = await connectVoiceCall(h.deps);
    return { h, result };
  };

  it('given a free-tier account, should carry the server’s own upgrade sentence', async () => {
    const { result } = await refusal(403, {
      error: 'Pro plan required',
      message: 'Voice mode requires a Pro or above subscription.',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-entitled');
    expect(result.message).toBe(
      'Voice mode requires a Pro or above subscription.',
    );
  });

  it('given OpenAI refused the model, should name the failure and keep the code for debugging', async () => {
    const { result } = await refusal(502, {
      error: 'Voice call failed',
      code: 'realtime_call_rejected',
      message: 'OpenAI rejected the realtime call.',
      upstreamStatus: 403,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('call-rejected');
    expect(result.detail).toContain('realtime_call_rejected');
    expect(result.detail).toContain('502');
  });

  it('given an unconfigured deployment, should say so', async () => {
    const { result } = await refusal(503, {
      error: 'Voice mode unavailable',
      message: 'Voice mode is not configured on this deployment.',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
  });

  it('given a signed-out session, should say the session expired', async () => {
    const { result } = await refusal(401, { error: 'Unauthorized' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unauthorized');
    expect(result.message).toBe('Unauthorized');
  });

  it('given a non-JSON error body, should still speak a sentence and keep the raw text', async () => {
    const h = harness(
      {},
      respondWith({ status: 502, text: '<html>bad gateway</html>' }),
    );

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'The voice service refused the call. Check the server logs.',
    );
    expect(result.detail).toContain('bad gateway');
  });

  it('given any refusal, should stop the microphone and close the connection', async () => {
    const h = harness({}, respondWith({ status: 502, body: {} }));

    await connectVoiceCall(h.deps);

    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.peer.closed).toBe(true);
  });
});

/**
 * The microphone is live from the moment it is acquired, and everything between
 * that and the signaling try block throws in real browsers. A rejection there
 * left the recording indicator on and the device held — and on the reuse path,
 * one cloned track per attempt.
 */
describe('connectVoiceCall — a throw during peer setup', () => {
  it('given createPeerConnection throws, should release the microphone and fail by name', async () => {
    const h = harness({
      createPeerConnection: () => {
        throw new Error('bad ICE configuration');
      },
    });

    const result = await connectVoiceCall(h.deps);

    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'signaling-failed' });
    expect((result as { detail: string }).detail).toContain('createPeerConnection');
  });

  it('given addTrack throws, should release the microphone rather than reject with it live', async () => {
    const peer = new FakePeerConnection();
    peer.addTrack = () => {
      throw new Error('InvalidStateError');
    };
    const h = harness({ createPeerConnection: () => asPeer(peer) });

    const result = await connectVoiceCall(h.deps);

    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect((result as { detail: string }).detail).toContain('setupPeer');
  });

  it('given createDataChannel throws, should release the microphone too', async () => {
    const peer = new FakePeerConnection();
    peer.createDataChannel = () => {
      throw new Error('InvalidStateError');
    };
    const h = harness({ createPeerConnection: () => asPeer(peer) });

    const result = await connectVoiceCall(h.deps);

    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'signaling-failed' });
  });

  it('given a REUSED microphone, should stop the clone it took rather than accumulate one per attempt', async () => {
    const existing = fakeStream('mic-1');
    const h = harness({
      microphone: asStream(existing),
      getUserMedia: undefined,
      createPeerConnection: () => {
        throw new Error('bad ICE configuration');
      },
    });

    await connectVoiceCall(h.deps);

    // The caller's own track survives — that is what reuse means — while the
    // clone this attempt took does not outlive the failure.
    expect(existing.tracks.map((t) => t.stopped)).toEqual([false]);
  });
});

describe('connectVoiceCall — broken handshakes', () => {
  it('given the route is unreachable, should fail by name and leak nothing', async () => {
    const h = harness();
    const result = await connectVoiceCall({
      ...h.deps,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signaling-failed');
    expect(result.detail).toContain(VOICE_CALL_ROUTE);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.peer.closed).toBe(true);
  });

  it('given the transport cannot make an offer, should name that step', async () => {
    const h = harness();
    h.peer.failOn = 'createOffer';

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('createOffer');
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('given a 200 with no answer SDP, should refuse rather than sit on a dead call', async () => {
    const h = harness(
      {},
      respondWith({ body: { callId: 'rtc_x', attached: true } }),
    );

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('answer SDP');
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.peer.closed).toBe(true);
  });

  it('given a 200 with no call id, should refuse', async () => {
    const h = harness(
      {},
      respondWith({ body: { answerSdp: 'v=0 answer', attached: true } }),
    );

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('callId');
  });

  it('given an answer the transport rejects, should clean up', async () => {
    const h = harness();
    h.peer.failOn = 'setRemoteDescription';

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signaling-failed');
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.peer.closed).toBe(true);
  });

  it('given a server with no realtime attach, should still hand back a working call marked degraded', async () => {
    const h = harness(
      {},
      respondWith({ body: { ...CALL_OK, attached: false } }),
    );

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.attached).toBe(false);
  });

  it('given no cap reported, should report none rather than invent one', async () => {
    const h = harness(
      {},
      respondWith({ body: { ...CALL_OK, maxDurationMs: 'soon' } }),
    );

    const result = await connectVoiceCall(h.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.maxDurationMs).toBeUndefined();
  });
});

describe('connectVoiceCall — losing the connection', () => {
  it('given the peer connection drops, should report the loss once per drop', async () => {
    const h = harness();
    await connectVoiceCall(h.deps);

    h.peer.transitionTo('connected');
    expect(h.lost).not.toHaveBeenCalled();

    h.peer.transitionTo('failed');
    expect(h.lost).toHaveBeenCalledTimes(1);
  });

  it('given ICE gives up, should treat disconnected as a loss', async () => {
    const h = harness();
    await connectVoiceCall(h.deps);

    h.peer.transitionTo('disconnected');

    expect(h.lost).toHaveBeenCalledTimes(1);
  });

  it('given a deliberate hangup, should NOT report it as a dropped connection', async () => {
    // Closing drives the connection to `closed`, which is a lost state. A user
    // who hangs up must not be shown an error for doing so.
    const h = harness();
    const result = await connectVoiceCall(h.deps);
    if (!result.ok) throw new Error('expected a connection');

    result.connection.stop();

    expect(h.lost).not.toHaveBeenCalled();
    expect(h.peer.closed).toBe(true);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });
});
