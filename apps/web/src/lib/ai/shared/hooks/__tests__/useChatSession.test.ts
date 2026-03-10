import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatSession } from '../useChatSession';
import type { UIMessage } from 'ai';

// Mock stores
vi.mock('@/stores/useVoiceModeStore', () => ({
  useVoiceModeStore: vi.fn((selector) => {
    const state = {
      isEnabled: false,
      owner: null,
      voiceState: 'idle' as const,
      hasLoadedSettings: true,
      interactionMode: 'barge-in' as const,
      ttsVoice: 'alloy' as const,
      ttsSpeed: 1.0,
      autoSend: true,
      currentTranscript: '',
      error: null,
      currentAudioId: null,
      enable: vi.fn(),
      disable: vi.fn(),
      setInteractionMode: vi.fn(),
      setTTSVoice: vi.fn(),
      setTTSSpeed: vi.fn(),
      setAutoSend: vi.fn(),
      setVoiceState: vi.fn(),
      setCurrentTranscript: vi.fn(),
      appendTranscript: vi.fn(),
      clearTranscript: vi.fn(),
      setError: vi.fn(),
      setCurrentAudioId: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      startSpeaking: vi.fn(),
      stopSpeaking: vi.fn(),
      bargeIn: vi.fn(),
    };
    return selector(state);
  }),
}));

vi.mock('@/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: vi.fn(() => ({
    preferences: {
      showTokenCounts: true,
      compactMode: false,
    },
  })),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = fetchWithAuth as ReturnType<typeof vi.fn>;

// Helper to create complete mock state
function createMockVoiceState(overrides: Record<string, unknown> = {}) {
  return {
    isEnabled: false,
    owner: null,
    voiceState: 'idle' as const,
    hasLoadedSettings: true,
    interactionMode: 'barge-in' as const,
    ttsVoice: 'alloy' as const,
    ttsSpeed: 1.0,
    autoSend: true,
    currentTranscript: '',
    error: null,
    currentAudioId: null,
    enable: vi.fn(),
    disable: vi.fn(),
    setInteractionMode: vi.fn(),
    setTTSVoice: vi.fn(),
    setTTSSpeed: vi.fn(),
    setAutoSend: vi.fn(),
    setVoiceState: vi.fn(),
    setCurrentTranscript: vi.fn(),
    appendTranscript: vi.fn(),
    clearTranscript: vi.fn(),
    setError: vi.fn(),
    setCurrentAudioId: vi.fn(),
    startListening: vi.fn(),
    stopListening: vi.fn(),
    startSpeaking: vi.fn(),
    stopSpeaking: vi.fn(),
    bargeIn: vi.fn(),
    ...overrides,
  };
}

function createMockMessage(role: 'user' | 'assistant', id: string, text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    createdAt: new Date(),
  } as UIMessage;
}

describe('useChatSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ providers: { openai: { isConfigured: true } } }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('given initial state', () => {
    it('should return voice mode inactive by default', async () => {
      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.isVoiceModeActive).toBe(false);
    });

    it('should return error visibility as true by default', async () => {
      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.showError).toBe(true);
    });

    it('should fetch OpenAI configuration on mount', async () => {
      await act(async () => {
        renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/settings');
    });
  });

  describe('given voice mode toggle', () => {
    it('should call enable when voice mode is inactive', async () => {
      const mockEnable = vi.fn();
      vi.mocked(useVoiceModeStore).mockImplementation((selector) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return selector(createMockVoiceState({
          isEnabled: false,
          owner: null,
          enable: mockEnable,
        }) as any);
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      act(() => {
        result.current.handleVoiceModeToggle();
      });

      expect(mockEnable).toHaveBeenCalledWith('ai-page');
    });

    it('should call disable when voice mode is active for same owner', async () => {
      const mockDisable = vi.fn();
      vi.mocked(useVoiceModeStore).mockImplementation((selector) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return selector(createMockVoiceState({
          isEnabled: true,
          owner: 'ai-page',
          disable: mockDisable,
        }) as any);
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      act(() => {
        result.current.handleVoiceModeToggle();
      });

      expect(mockDisable).toHaveBeenCalled();
    });
  });

  describe('given error state changes', () => {
    it('should set showError to true when error appears', async () => {
      const { result, rerender } = await act(async () => {
        return renderHook(
          ({ error }) =>
            useChatSession({
              owner: 'ai-page',
              isStreaming: false,
              messages: [],
              error,
            }),
          { initialProps: { error: undefined as Error | undefined } }
        );
      });

      // Reset showError first
      act(() => {
        result.current.setShowError(false);
      });

      expect(result.current.showError).toBe(false);

      // Now trigger error
      const testError = new Error('Test error');
      await act(async () => {
        rerender({ error: testError });
      });

      expect(result.current.showError).toBe(true);
    });
  });

  describe('given AI response tracking', () => {
    it('should track last assistant message when voice mode is active and not streaming', async () => {
      const messages: UIMessage[] = [
        createMockMessage('user', 'msg-1', 'Hello'),
        createMockMessage('assistant', 'msg-2', 'Hi there!'),
      ];

      // Mock voice mode as active
      vi.mocked(useVoiceModeStore).mockImplementation((selector) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return selector(createMockVoiceState({
          isEnabled: true,
          owner: 'ai-page',
        }) as any);
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages,
            error: undefined,
          })
        );
      });

      // Wait for effects
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(result.current.lastAIResponse).not.toBeNull();
      expect(result.current.lastAIResponse?.id).toBe('msg-2');
      expect(result.current.lastAIResponse?.text).toContain('Hi there!');
    });

    it('should not track response when voice mode is inactive', async () => {
      const messages: UIMessage[] = [
        createMockMessage('assistant', 'msg-1', 'Response'),
      ];

      // Voice mode is inactive (default mock state)
      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages,
            error: undefined,
          })
        );
      });

      // Wait for effects
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // Should NOT track when voice mode is inactive
      expect(result.current.lastAIResponse).toBeNull();
    });

    it('should not track response while streaming', async () => {
      const messages: UIMessage[] = [
        createMockMessage('assistant', 'msg-1', 'Streaming response...'),
      ];

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: true,
            messages,
            error: undefined,
          })
        );
      });

      expect(result.current.lastAIResponse).toBeNull();
    });
  });

  describe('given OpenAI configuration fetch', () => {
    it('should set isOpenAIConfigured to true when configured', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ providers: { openai: { isConfigured: true } } }),
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.isOpenAIConfigured).toBe(true);
    });

    it('should set isOpenAIConfigured to false when not configured', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ providers: { openai: { isConfigured: false } } }),
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.isOpenAIConfigured).toBe(false);
    });

    it('should set isOpenAIConfigured to false on fetch error', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('Network error'));

      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.isOpenAIConfigured).toBe(false);
    });
  });

  describe('given voice settings state', () => {
    it('should allow toggling voice settings visibility', async () => {
      const { result } = await act(async () => {
        return renderHook(() =>
          useChatSession({
            owner: 'ai-page',
            isStreaming: false,
            messages: [],
            error: undefined,
          })
        );
      });

      expect(result.current.showVoiceSettings).toBe(false);

      act(() => {
        result.current.setShowVoiceSettings(true);
      });

      expect(result.current.showVoiceSettings).toBe(true);
    });
  });
});
