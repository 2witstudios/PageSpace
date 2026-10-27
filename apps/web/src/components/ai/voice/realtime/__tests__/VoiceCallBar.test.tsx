/**
 * The call header, driven through the REAL provider so that pressing Mute
 * actually reaches a microphone track and pressing End actually closes a peer
 * connection. A version of this file that mocked the session would pass with
 * buttons wired to nothing.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VoiceSessionProvider,
  useVoiceSessionControls,
  type VoiceSessionDeps,
} from '@/contexts/VoiceSessionContext';
import {
  FakePeerConnection,
  asPeer,
  asStream,
  fakeCreateMediaStream,
  fakeStream,
  respondWith,
} from '@/lib/ai/realtime/__tests__/webrtc-fakes';
import { VoiceCallBar } from '../VoiceCallBar';

const TARGET = { conversationId: 'conv-a', type: 'global' as const };

const harness = (attached = true) => {
  const peers: FakePeerConnection[] = [];
  const microphone = fakeStream('mic-device');
  const deps: VoiceSessionDeps = {
    fetchImpl: async () =>
      respondWith({
        body: { callId: 'rtc_1', answerSdp: 'v=0 answer', attached },
      }),
    createPeerConnection: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return asPeer(peer);
    },
    getUserMedia: async () => asStream(microphone),
    createMediaStream: fakeCreateMediaStream,
  };
  return { peers, deps };
};

function StartButton() {
  const { start } = useVoiceSessionControls();
  return <button type="button" data-testid="start" onClick={() => void start(TARGET)} />;
}

const renderBar = (deps: VoiceSessionDeps) =>
  render(
    <VoiceSessionProvider deps={deps}>
      <StartButton />
      <VoiceCallBar assistantName="Agent A" />
    </VoiceSessionProvider>,
  );

const startCall = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('start'));
  });
  await waitFor(() =>
    expect(screen.getByTestId('voice-call-bar')).not.toHaveAttribute(
      'data-voice-state',
      'connecting',
    ),
  );
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('VoiceCallBar — the controls actually reach the call', () => {
  it('should silence the microphone track when muted, and restore it when unmuted', async () => {
    const h = harness();
    renderBar(h.deps);
    await startCall();

    expect(h.peers[0].addedTracks.map((t) => t.enabled)).toEqual([true]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mute-toggle'));
    });

    expect(h.peers[0].addedTracks.map((t) => t.enabled)).toEqual([false]);
    expect(screen.getByTestId('voice-mute-toggle')).toHaveAttribute('aria-pressed', 'true');
    // The call is untouched — mute is not a hang-up with extra steps.
    expect(h.peers[0].closed).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mute-toggle'));
    });
    expect(h.peers[0].addedTracks.map((t) => t.enabled)).toEqual([true]);
  });

  it('should end the call from the End button — the ONLY control that hangs up', async () => {
    const h = harness();
    renderBar(h.deps);
    await startCall();

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-end-call'));
    });

    expect(h.peers[0].closed).toBe(true);
    // The session is genuinely down, not merely visually reset: the surfaces
    // gate this bar on the binding, and Mute has nothing left to act on.
    expect(screen.getByTestId('voice-call-bar')).toHaveAttribute('data-voice-state', 'idle');
    expect(screen.getByTestId('voice-mute-toggle')).toBeDisabled();
  });
});

describe('VoiceCallBar — telling the truth about what the call can do', () => {
  it('should say nothing extra when the call is fully capable', async () => {
    const h = harness(true);
    renderBar(h.deps);
    await startCall();

    expect(screen.getByTestId('voice-call-bar')).toHaveAttribute('data-voice-state', 'live');
    expect(screen.queryByTestId('voice-call-detail')).not.toBeInTheDocument();
  });

  it('should warn, in the bar, when nothing said will reach the thread', async () => {
    // `attached: false` is a WORKING audio call with no transcript, no tools and
    // no metering. It looks identical to a good one until the user hangs up and
    // finds the conversation empty.
    const h = harness(false);
    renderBar(h.deps);
    await startCall();

    expect(screen.getByTestId('voice-call-bar')).toHaveAttribute('data-voice-state', 'degraded');
    expect(screen.getByTestId('voice-call-detail').textContent).toMatch(/saved|transcript/i);
  });
});

describe('VoiceCallBar — the current utterance, and nothing more', () => {
  it('should show what is being said before it has been persisted anywhere', async () => {
    const h = harness();
    renderBar(h.deps);
    await startCall();

    await act(async () => {
      h.peers[0].events.deliver(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'what is on this page',
        }),
      );
    });

    expect(screen.getByTestId('voice-call-bar').textContent).toContain('what is on this page');
  });

  it('should name the running tool INSTEAD of the last thing said', async () => {
    // The bug this exists for: the bar rendered the last transcript whenever
    // one existed, so the tool status was unreachable after the first spoken
    // turn — which is every real call. The silence the status explains always
    // follows something being said.
    const h = harness();
    renderBar(h.deps);
    await startCall();

    await act(async () => {
      h.peers[0].events.deliver(
        JSON.stringify({
          type: 'response.output_audio_transcript.done',
          transcript: 'Let me check that.',
        }),
      );
      h.peers[0].events.deliver(
        JSON.stringify({
          type: 'response.done',
          response: {
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_page',
                arguments: JSON.stringify({ title: 'Roadmap' }),
              },
            ],
          },
        }),
      );
    });

    const bar = screen.getByTestId('voice-call-bar').textContent ?? '';
    expect(bar).toContain('Read Page: Roadmap');
    expect(bar).not.toContain('Let me check that.');
  });

  it('should go back to the last thing said once the model speaks again', async () => {
    const h = harness();
    renderBar(h.deps);
    await startCall();

    await act(async () => {
      h.peers[0].events.deliver(
        JSON.stringify({
          type: 'response.done',
          response: {
            output: [
              { type: 'function_call', call_id: 'call_1', name: 'read_page', arguments: '{}' },
            ],
          },
        }),
      );
      h.peers[0].events.deliver(
        JSON.stringify({
          type: 'response.output_audio_transcript.done',
          transcript: 'It is in your Inbox.',
        }),
      );
    });

    const bar = screen.getByTestId('voice-call-bar').textContent ?? '';
    expect(bar).toContain('It is in your Inbox.');
    expect(bar).not.toContain('Read Page');
  });

  it('should render NO transcript history — that is the message list\'s job', async () => {
    // Spoken turns are written into the conversation and arrive on the ordinary
    // `conversation:*` events. A second copy here would be a second history,
    // free to drift from the one of record.
    const h = harness();
    renderBar(h.deps);
    await startCall();

    await act(async () => {
      for (const transcript of ['first thing', 'second thing', 'third thing']) {
        h.peers[0].events.deliver(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript,
          }),
        );
      }
    });

    const text = screen.getByTestId('voice-call-bar').textContent ?? '';
    expect(text).toContain('third thing');
    expect(text).not.toContain('first thing');
    expect(text).not.toContain('second thing');
  });
});
