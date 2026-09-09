/**
 * WHICH surface shows the call, against a real session.
 *
 * The wrong answer that looks right is "the surface that started the call".
 * That version works until the user walks from the sidebar to the dashboard
 * mid-call, at which point the call is live with its chrome nowhere — no mute,
 * no End, no indication of which thread is being spoken into. Keying on the
 * CONVERSATION is what makes the chrome follow the thread instead of the panel.
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
import { VoiceCallBarForConversation } from '../VoiceCallBarForConversation';

const deps = (): VoiceSessionDeps => ({
  fetchImpl: async () =>
    respondWith({ body: { callId: 'rtc_1', answerSdp: 'v=0 answer', attached: true } }),
  createPeerConnection: () => asPeer(new FakePeerConnection()),
  getUserMedia: async () => asStream(fakeStream('mic-device')),
  createMediaStream: fakeCreateMediaStream,
});

/** Two surfaces mounted at once, each showing a different conversation. */
function Surfaces({ conversationId }: { conversationId: string }) {
  const { start } = useVoiceSessionControls();
  return (
    <>
      <button
        type="button"
        data-testid="start"
        onClick={() => void start({ conversationId, type: 'global' })}
      />
      <div data-testid="surface-a">
        <VoiceCallBarForConversation conversationId="conv-a" assistantName="Agent A" />
      </div>
      <div data-testid="surface-b">
        <VoiceCallBarForConversation conversationId="conv-b" assistantName="Agent B" />
      </div>
      <div data-testid="surface-unresolved">
        <VoiceCallBarForConversation conversationId={null} assistantName="Loading" />
      </div>
    </>
  );
}

const renderSurfaces = (conversationId: string) =>
  render(
    <VoiceSessionProvider deps={deps()}>
      <Surfaces conversationId={conversationId} />
    </VoiceSessionProvider>,
  );

const barIn = (surface: string) =>
  screen.getByTestId(surface).querySelector('[data-testid="voice-call-bar"]');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('VoiceCallBarForConversation', () => {
  it('should show the chrome on the surface holding the call\'s conversation, and NOWHERE else', async () => {
    renderSurfaces('conv-a');

    await act(async () => {
      fireEvent.click(screen.getByTestId('start'));
    });
    await waitFor(() => expect(barIn('surface-a')).not.toBeNull());

    expect(barIn('surface-b')).toBeNull();
    expect(barIn('surface-unresolved')).toBeNull();
  });

  it('should follow the conversation, not the surface that started the call', async () => {
    renderSurfaces('conv-b');

    await act(async () => {
      fireEvent.click(screen.getByTestId('start'));
    });
    await waitFor(() => expect(barIn('surface-b')).not.toBeNull());

    expect(barIn('surface-a')).toBeNull();
  });

  it('should show nothing at all when no call is running', () => {
    renderSurfaces('conv-a');

    expect(barIn('surface-a')).toBeNull();
    expect(barIn('surface-b')).toBeNull();
  });

  it('should name the assistant the way its own surface names it', async () => {
    renderSurfaces('conv-a');

    await act(async () => {
      fireEvent.click(screen.getByTestId('start'));
    });
    await waitFor(() => expect(barIn('surface-a')).not.toBeNull());

    expect(barIn('surface-a')?.textContent).toContain('Agent A');
  });
});
