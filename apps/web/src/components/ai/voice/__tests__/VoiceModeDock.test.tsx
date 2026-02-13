import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { VoiceModeDock } from '../VoiceModeDock';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';

const mockUseVoiceMode = vi.fn();

vi.mock('@/hooks/useVoiceMode', () => ({
  useVoiceMode: (...args: unknown[]) => mockUseVoiceMode(...args),
}));

describe('VoiceModeDock playback behavior', () => {
  const mockSpeak = vi.fn().mockResolvedValue(undefined);
  const mockStartListening = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceModeStore.setState({ owner: 'global-assistant' });

    mockUseVoiceMode.mockReturnValue({
      isEnabled: true,
      hasLoadedSettings: true,
      isListening: false,
      isProcessing: false,
      isSpeaking: false,
      voiceState: 'idle',
      currentTranscript: '',
      error: null,
      enable: vi.fn(),
      disable: vi.fn(),
      startListening: mockStartListening,
      stopListening: vi.fn(),
      speak: mockSpeak,
      stopSpeaking: vi.fn(),
      bargeIn: vi.fn(),
      interactionMode: 'tap-to-speak',
      setInteractionMode: vi.fn(),
      ttsVoice: 'nova',
      setTTSVoice: vi.fn(),
      autoSend: true,
      setAutoSend: vi.fn(),
    });
  });

  it('speaks each assistant message ID only once', async () => {
    const { rerender } = render(
      <VoiceModeDock
        owner="global-assistant"
        onSend={vi.fn()}
        aiResponse={{ id: 'msg-1', text: 'Hello there' }}
        isAIStreaming={false}
      />
    );

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledWith('Hello there');
    });

    rerender(
      <VoiceModeDock
        owner="global-assistant"
        onSend={vi.fn()}
        aiResponse={{ id: 'msg-1', text: 'Hello there again' }}
        isAIStreaming={false}
      />
    );

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(1);
    });

    rerender(
      <VoiceModeDock
        owner="global-assistant"
        onSend={vi.fn()}
        aiResponse={{ id: 'msg-2', text: 'Second response' }}
        isAIStreaming={false}
      />
    );

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(2);
      expect(mockSpeak).toHaveBeenLastCalledWith('Second response');
    });
  });

  it('suppresses playback while AI is streaming', async () => {
    useVoiceModeStore.setState({ owner: 'ai-page' });

    const { rerender } = render(
      <VoiceModeDock
        owner="ai-page"
        onSend={vi.fn()}
        aiResponse={{ id: 'streaming-msg', text: 'Still generating' }}
        isAIStreaming={true}
      />
    );

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(0);
    });

    rerender(
      <VoiceModeDock
        owner="ai-page"
        onSend={vi.fn()}
        aiResponse={{ id: 'streaming-msg', text: 'Still generating' }}
        isAIStreaming={false}
      />
    );

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledWith('Still generating');
    });
  });
});
