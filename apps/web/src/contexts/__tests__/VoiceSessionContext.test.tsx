/**
 * The session lifecycle, driven end to end through the REAL handshake against
 * fake browser APIs — no live network, no real microphone.
 *
 * These assert the four things that make voice a transport rather than a panel
 * feature: closing the sidebar does not hang up, navigating does not rebind,
 * switching agent DOES rebind, and a conversation outlives the ceiling on a
 * single call.
 */

import React, { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceSessionProvider,
  useVoiceSession,
  useVoiceSessionControls,
  type VoiceSessionControls,
  type VoiceSessionDeps,
  type VoiceSessionState,
} from '../VoiceSessionContext';
import type { VoiceTarget } from '@/lib/ai/realtime/voice-target';
import { CHAIN_LEAD_MS } from '@/lib/ai/realtime/chain-schedule';
import {
  FakePeerConnection,
  asPeer,
  asStream,
  fakeCreateMediaStream,
  fakeStream,
  respondWith,
} from '@/lib/ai/realtime/__tests__/webrtc-fakes';

const MAX_DURATION_MS = 600_000;

const GLOBAL_TARGET: VoiceTarget = { conversationId: 'conv-global', type: 'global' };
const AGENT_TARGET: VoiceTarget = {
  conversationId: 'conv-agent',
  type: 'page',
  contextId: 'page-1',
  agentPageId: 'agent-1',
};

type Probe = {
  state: VoiceSessionState;
  controls: VoiceSessionControls;
};

const probe: Probe = {} as Probe;

/** Sits inside the provider for the whole test; never unmounts. */
function StateProbe() {
  probe.state = useVoiceSession();
  probe.controls = useVoiceSessionControls();
  return null;
}

/**
 * Stands in for `RightPanel` — the surface that hosts the voice trigger AND is
 * unmounted outright when the sidebar closes. It both starts calls and reads
 * session state, so a session scoped to it would die with it.
 */
function SidebarPanel() {
  const { status, callId } = useVoiceSession();
  const { start } = useVoiceSessionControls();
  return (
    <button
      type="button"
      data-testid="panel"
      data-call={callId ?? ''}
      onClick={() => void start(GLOBAL_TARGET)}
    >
      {status}
    </button>
  );
}

type Harness = {
  readonly peers: FakePeerConnection[];
  readonly bodies: Record<string, unknown>[];
  readonly microphone: ReturnType<typeof fakeStream>;
  readonly micGrants: () => number;
  readonly deps: VoiceSessionDeps;
};

const harness = (
  respond: (attempt: number) => Response = (attempt) =>
    respondWith({
      body: {
        callId: `rtc_call_${attempt}`,
        answerSdp: `v=0 answer ${attempt}`,
        attached: true,
        maxDurationMs: MAX_DURATION_MS,
      },
    }),
): Harness => {
  const peers: FakePeerConnection[] = [];
  const bodies: Record<string, unknown>[] = [];
  const microphone = fakeStream('mic-device');
  let grants = 0;
  let attempts = 0;

  return {
    peers,
    bodies,
    microphone,
    micGrants: () => grants,
    deps: {
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        attempts += 1;
        return respond(attempts);
      },
      createPeerConnection: () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return asPeer(peer);
      },
      getUserMedia: async () => {
        grants += 1;
        return asStream(microphone);
      },
      createMediaStream: fakeCreateMediaStream,
    },
  };
};

/** `route` stands in for whatever page the router is currently showing. */
function App({
  deps,
  showPanel = true,
  route = '/dashboard/a',
}: {
  deps: VoiceSessionDeps;
  showPanel?: boolean;
  route?: string;
}) {
  return (
    <VoiceSessionProvider deps={deps}>
      <StateProbe />
      <RouteView route={route} />
      {showPanel && <SidebarPanel />}
    </VoiceSessionProvider>
  );
}

/** A page that reports where the user is standing, the way navigation does. */
function RouteView({ route }: { route: string }) {
  const { setLocationContext } = useVoiceSessionControls();
  useEffect(() => {
    setLocationContext({
      currentPage: { id: route, title: route, type: 'DOCUMENT', path: route },
    });
  }, [route, setLocationContext]);
  return <div data-testid="route">{route}</div>;
}

const startCall = async (target: VoiceTarget = GLOBAL_TARGET) => {
  await act(async () => {
    await probe.controls.start(target);
  });
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VoiceSessionProvider — starting a call', () => {
  it('given a target, should bind the session to that conversation', async () => {
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();

    expect(probe.state.status).toBe('connected');
    expect(probe.state.callId).toBe('rtc_call_1');
    expect(probe.state.attached).toBe(true);
    expect(probe.state.target).toEqual(GLOBAL_TARGET);
    expect(h.bodies[0]).toMatchObject({ conversationId: 'conv-global' });
  });

  it('should carry where the user is standing into the call', async () => {
    const h = harness();
    render(<App deps={h.deps} route="/dashboard/notes" />);

    await startCall();

    expect(h.bodies[0].locationContext).toMatchObject({
      currentPage: { id: '/dashboard/notes' },
    });
  });

  it('given the same target again, should not open a second call', async () => {
    // A second press, or a re-render handing back the same target, must not
    // restart a conversation mid-sentence.
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    await startCall({ ...GLOBAL_TARGET });

    expect(h.peers).toHaveLength(1);
    expect(probe.state.callId).toBe('rtc_call_1');
  });

  it('given the microphone is denied vs missing, should surface different messages', async () => {
    const denied = harness();
    const missing = harness();
    const fail = (name: string) => async () => {
      const error = new Error(name);
      error.name = name;
      throw error;
    };

    const first = render(
      <App deps={{ ...denied.deps, getUserMedia: fail('NotAllowedError') }} />,
    );
    await startCall();
    const deniedMessage = probe.state.error;
    first.unmount();

    render(
      <App deps={{ ...missing.deps, getUserMedia: fail('NotFoundError') }} />,
    );
    await startCall();
    const missingMessage = probe.state.error;

    expect(probe.state.status).toBe('error');
    expect(deniedMessage).toBeDefined();
    expect(missingMessage).toBeDefined();
    expect(deniedMessage).not.toBe(missingMessage);
  });

  it('given a failed start, should clear the binding so it can be retried', async () => {
    let failNext = true;
    const h = harness((attempt) =>
      failNext
        ? respondWith({ status: 502, body: { message: 'nope' } })
        : respondWith({
            body: {
              callId: `rtc_call_${attempt}`,
              answerSdp: 'v=0 answer',
              attached: true,
              maxDurationMs: MAX_DURATION_MS,
            },
          }),
    );
    render(<App deps={h.deps} />);

    await startCall();
    expect(probe.state.status).toBe('error');
    expect(probe.state.target).toBeNull();

    failNext = false;
    await startCall();

    expect(probe.state.status).toBe('connected');
    expect(probe.state.target).toEqual(GLOBAL_TARGET);
  });
});

describe('VoiceSessionProvider — surviving the UI', () => {
  it('given the sidebar closes mid-call, should keep the session alive', async () => {
    // This is the entire reason the provider sits above RightPanel rather than
    // inside it: the panel is unmounted outright when the sidebar closes. The
    // call is deliberately STARTED from inside the panel here — a session
    // scoped to the surface that started it would hang up on close.
    const h = harness();
    const view = render(<App deps={h.deps} showPanel />);

    await act(async () => {
      view.getByTestId('panel').click();
    });
    expect(probe.state.callId).toBe('rtc_call_1');

    await act(async () => {
      view.rerender(<App deps={h.deps} showPanel={false} />);
    });

    expect(view.queryByTestId('panel')).toBeNull();
    expect(probe.state.status).toBe('connected');
    expect(probe.state.callId).toBe('rtc_call_1');
    expect(h.peers[0].closed).toBe(false);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(false);

    // Reopening finds the same call still running, not a new one.
    await act(async () => {
      view.rerender(<App deps={h.deps} showPanel />);
    });

    expect(view.getByTestId('panel').dataset.call).toBe('rtc_call_1');
    expect(view.getByTestId('panel').textContent).toBe('connected');
    expect(h.peers).toHaveLength(1);
  });

  it('given client-side navigation, should keep the same session and the same conversation', async () => {
    const h = harness();
    const view = render(<App deps={h.deps} route="/dashboard/a" />);
    await startCall();

    await act(async () => {
      view.rerender(<App deps={h.deps} route="/dashboard/b" />);
    });

    expect(view.getByTestId('route').textContent).toBe('/dashboard/b');
    expect(h.peers).toHaveLength(1);
    expect(probe.state.callId).toBe('rtc_call_1');
    expect(probe.state.target).toEqual(GLOBAL_TARGET);
    expect(probe.state.status).toBe('connected');
  });

  it('given the provider unmounts, should stop the microphone', async () => {
    const h = harness();
    const view = render(<App deps={h.deps} />);
    await startCall();

    await act(async () => {
      view.unmount();
    });

    expect(h.peers[0].closed).toBe(true);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });
});

describe('VoiceSessionProvider — rebinding', () => {
  it('given the agent switcher changes agent, should rebind to the new conversation', async () => {
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall(GLOBAL_TARGET);
    await startCall(AGENT_TARGET);

    expect(h.peers).toHaveLength(2);
    expect(h.peers[0].closed).toBe(true);
    expect(probe.state.target).toEqual(AGENT_TARGET);
    expect(probe.state.callId).toBe('rtc_call_2');
    expect(h.bodies[1]).toMatchObject({ conversationId: 'conv-agent' });
  });

  it('given the same conversation under a different agent, should still rebind', async () => {
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall(AGENT_TARGET);
    await startCall({ ...AGENT_TARGET, agentPageId: 'agent-2' });

    expect(h.peers).toHaveLength(2);
    expect(h.peers[0].closed).toBe(true);
    expect(probe.state.target?.agentPageId).toBe('agent-2');
  });
});

describe('VoiceSessionProvider — chaining past the duration cap', () => {
  it('should mint a fresh call before the cap without changing the conversation', async () => {
    vi.useFakeTimers();
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    expect(probe.state.callId).toBe('rtc_call_1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    expect(h.peers).toHaveLength(2);
    expect(probe.state.callId).toBe('rtc_call_2');
    // The transport changed; the conversation did not.
    expect(probe.state.target).toEqual(GLOBAL_TARGET);
    expect(h.bodies.map((b) => b.conversationId)).toEqual([
      'conv-global',
      'conv-global',
    ]);
    expect(probe.state.status).toBe('connected');
  });

  it('should hand the microphone over rather than prompt for it again', async () => {
    vi.useFakeTimers();
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    expect(h.micGrants()).toBe(1);
    // The outgoing call is closed, the incoming one carries a live clone.
    expect(h.peers[0].closed).toBe(true);
    expect(h.peers[1].closed).toBe(false);
    expect(h.peers[1].addedTracks.map((t) => t.id)).toEqual([
      'mic-device:clone',
    ]);
    expect(h.peers[1].addedTracks.every((t) => t.enabled)).toBe(true);
  });

  it('given the outgoing call is still talking, should not report it as a drop', async () => {
    // Stopping the replaced call drives it to `closed`, which is a lost state.
    vi.useFakeTimers();
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    expect(probe.state.status).toBe('connected');
    expect(probe.state.error).toBeUndefined();
  });

  it('should keep chaining, so a conversation is not capped at two calls', async () => {
    vi.useFakeTimers();
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
      });
    }

    expect(probe.state.callId).toBe('rtc_call_3');
    expect(h.peers).toHaveLength(3);
  });

  it('given no cap is reported, should not chain at all', async () => {
    vi.useFakeTimers();
    const h = harness((attempt) =>
      respondWith({
        body: {
          callId: `rtc_call_${attempt}`,
          answerSdp: 'v=0 answer',
          attached: true,
        },
      }),
    );
    render(<App deps={h.deps} />);

    await startCall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    expect(h.peers).toHaveLength(1);
    expect(probe.state.callId).toBe('rtc_call_1');
  });

  it('given the chain fails, should stay on the working call rather than claim a failure', async () => {
    vi.useFakeTimers();
    const h = harness((attempt) =>
      attempt === 1
        ? respondWith({
            body: {
              callId: 'rtc_call_1',
              answerSdp: 'v=0 answer',
              attached: true,
              maxDurationMs: MAX_DURATION_MS,
            },
          })
        : respondWith({ status: 502, body: { message: 'upstream is down' } }),
    );
    render(<App deps={h.deps} />);

    await startCall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    expect(probe.state.status).toBe('connected');
    expect(probe.state.callId).toBe('rtc_call_1');
    expect(h.peers[0].closed).toBe(false);
  });

  it('given the user hangs up mid-chain, should not leave the new call holding the mic', async () => {
    // The dangerous window: a replacement call is already negotiating — peer
    // open, mic clone live — when the user hangs up. Nothing is watching it any
    // more, so if the superseded attempt is not torn down on arrival it holds
    // the microphone open for a session that no longer exists.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const h = harness();
    const suspendSecondCall: VoiceSessionDeps = {
      ...h.deps,
      fetchImpl: async (url, init) => {
        const response = await h.deps.fetchImpl!(url, init);
        if (h.bodies.length > 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return response;
      },
    };
    render(<App deps={suspendSecondCall} />);

    await startCall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    // The replacement is open and waiting on its answer.
    expect(h.peers).toHaveLength(2);
    expect(release).toBeDefined();

    await act(async () => {
      probe.controls.stop();
    });
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(probe.state.status).toBe('idle');
    expect(h.peers.every((peer) => peer.closed)).toBe(true);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });
});

describe('VoiceSessionProvider — ending a call', () => {
  it('given the connection drops, should name the failure and stop the microphone', async () => {
    const h = harness();
    render(<App deps={h.deps} />);
    await startCall();

    await act(async () => {
      h.peers[0].transitionTo('failed');
    });

    expect(probe.state.status).toBe('error');
    expect(probe.state.error).toBe('The voice connection dropped.');
    expect(probe.state.callId).toBeNull();
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('given a hangup, should go idle and release the microphone', async () => {
    const h = harness();
    render(<App deps={h.deps} />);
    await startCall();

    await act(async () => {
      probe.controls.stop();
    });

    expect(probe.state.status).toBe('idle');
    expect(probe.state.error).toBeUndefined();
    expect(probe.state.callId).toBeNull();
    expect(probe.state.target).toBeNull();
    expect(h.peers[0].closed).toBe(true);
    expect(h.microphone.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('given a hangup with nothing running, should do nothing', async () => {
    const h = harness();
    render(<App deps={h.deps} />);

    await act(async () => {
      probe.controls.stop();
    });

    expect(probe.state.status).toBe('idle');
    expect(h.peers).toHaveLength(0);
  });

  it('given a hangup, should let the next call start clean', async () => {
    const h = harness();
    render(<App deps={h.deps} />);

    await startCall();
    await act(async () => {
      probe.controls.stop();
    });
    await startCall();

    expect(probe.state.status).toBe('connected');
    expect(probe.state.callId).toBe('rtc_call_2');
  });
});

describe('VoiceSessionProvider — the seam for the voice UI', () => {
  it('given a consumer mounted outside the provider, should say so rather than fail silently', () => {
    // Voice UI that renders outside Layout would otherwise read an undefined
    // session and appear to work while owning nothing.
    function Orphan() {
      useVoiceSession();
      return null;
    }
    function OrphanControls() {
      useVoiceSessionControls();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(/VoiceSessionProvider/);
    expect(() => render(<OrphanControls />)).toThrow(/VoiceSessionProvider/);
  });
});

describe('VoiceSessionProvider — the live event stream', () => {
  it('should drive the UI from the call the user is actually on', async () => {
    const h = harness();
    render(<App deps={h.deps} />);
    await startCall();

    await act(async () => {
      h.peers[0].events.deliver(
        JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
      );
    });
    expect(probe.state.userSpeaking).toBe(true);

    await act(async () => {
      h.peers[0].events.deliver(
        JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }),
      );
    });
    expect(probe.state.userSpeaking).toBe(false);
  });

  it('given a call being replaced, should not double up the transcript', async () => {
    // Both calls are briefly live during a chain. Only the one being heard may
    // speak into the UI.
    vi.useFakeTimers();
    const h = harness();
    render(<App deps={h.deps} />);
    await startCall();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - CHAIN_LEAD_MS);
    });

    await act(async () => {
      h.peers[1].events.deliver(
        JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
      );
      // The replaced call's channel is closed, but a frame already in flight
      // must not reach the UI either.
      h.peers[0].events.deliver(
        JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }),
      );
    });

    expect(probe.state.userSpeaking).toBe(true);
  });

  it('should route the model’s voice to the audio element', async () => {
    const h = harness();
    const view = render(<App deps={h.deps} />);
    await startCall();

    const modelVoice = fakeStream('model-voice');
    await act(async () => {
      h.peers[0].deliverRemoteTrack(modelVoice);
    });

    const audio = view.getByTestId('voice-session-audio') as HTMLAudioElement;
    expect(audio.srcObject).toBe(modelVoice);
    expect(probe.state.remoteStream).toBe(modelVoice);
  });
});
