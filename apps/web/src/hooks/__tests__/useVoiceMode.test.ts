import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockEnable = vi.hoisted(() => vi.fn());
const mockDisable = vi.hoisted(() => vi.fn());
const mockSetInteractionMode = vi.hoisted(() => vi.fn());
const mockSetTTSVoice = vi.hoisted(() => vi.fn());
const mockSetAutoSend = vi.hoisted(() => vi.fn());
const mockSetVoiceState = vi.hoisted(() => vi.fn());
const mockSetCurrentAudioId = vi.hoisted(() => vi.fn());
const mockSetCurrentTranscript = vi.hoisted(() => vi.fn());
const mockSetError = vi.hoisted(() => vi.fn());
const mockStartListeningStore = vi.hoisted(() => vi.fn());
const mockStopListeningStore = vi.hoisted(() => vi.fn());
const mockStartSpeakingStore = vi.hoisted(() => vi.fn());
const mockStopSpeakingStore = vi.hoisted(() => vi.fn());
const mockBargeInStore = vi.hoisted(() => vi.fn());

const mockStoreState = vi.hoisted(() => ({
  isEnabled: false,
  voiceState: 'idle' as string,
  hasLoadedSettings: true,
  interactionMode: 'tap-to-speak' as string,
  ttsVoice: 'nova' as string,
  ttsSpeed: 1.0,
  autoSend: true,
  currentTranscript: '',
  error: null as string | null,
  enable: mockEnable,
  disable: mockDisable,
  setInteractionMode: mockSetInteractionMode,
  setTTSVoice: mockSetTTSVoice,
  setAutoSend: mockSetAutoSend,
  setVoiceState: mockSetVoiceState,
  setCurrentAudioId: mockSetCurrentAudioId,
  setCurrentTranscript: mockSetCurrentTranscript,
  setError: mockSetError,
  startListening: mockStartListeningStore,
  stopListening: mockStopListeningStore,
  startSpeaking: mockStartSpeakingStore,
  stopSpeaking: mockStopSpeakingStore,
  bargeIn: mockBargeInStore,
  loadSettings: mockLoadSettings,
}));

vi.mock('@/stores/useVoiceModeStore', () => ({
  useVoiceModeStore: Object.assign(
    (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
    {
      getState: () => mockStoreState,
    }
  ),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid-123'),
}));

import { useVoiceMode } from '../useVoiceMode';

describe('useVoiceMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState.isEnabled = false;
    mockStoreState.voiceState = 'idle';
    mockStoreState.hasLoadedSettings = true;
    mockStoreState.interactionMode = 'tap-to-speak';
    mockStoreState.ttsVoice = 'nova';
    mockStoreState.ttsSpeed = 1.0;
    mockStoreState.autoSend = true;
    mockStoreState.currentTranscript = '';
    mockStoreState.error = null;
  });

  describe('returns store state', () => {
    it('should return isEnabled from store', () => {
      mockStoreState.isEnabled = true;

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isEnabled).toBe(true);
    });

    it('should return voiceState from store', () => {
      mockStoreState.voiceState = 'listening';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.voiceState).toBe('listening');
    });

    it('should return hasLoadedSettings from store', () => {
      mockStoreState.hasLoadedSettings = false;

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.hasLoadedSettings).toBe(false);
    });

    it('should return interactionMode from store', () => {
      mockStoreState.interactionMode = 'barge-in';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.interactionMode).toBe('barge-in');
    });

    it('should return ttsVoice from store', () => {
      mockStoreState.ttsVoice = 'echo';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.ttsVoice).toBe('echo');
    });

    it('should return autoSend from store', () => {
      mockStoreState.autoSend = false;

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.autoSend).toBe(false);
    });

    it('should return currentTranscript from store', () => {
      mockStoreState.currentTranscript = 'hello world';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.currentTranscript).toBe('hello world');
    });

    it('should return error from store', () => {
      mockStoreState.error = 'Mic error';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.error).toBe('Mic error');
    });
  });

  describe('derived state', () => {
    it('should return isListening=true when voiceState is listening', () => {
      mockStoreState.voiceState = 'listening';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isListening).toBe(true);
    });

    it('should return isListening=false when voiceState is not listening', () => {
      mockStoreState.voiceState = 'idle';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isListening).toBe(false);
    });

    it('should return isProcessing=true when voiceState is processing', () => {
      mockStoreState.voiceState = 'processing';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isProcessing).toBe(true);
    });

    it('should return isProcessing=false when voiceState is not processing', () => {
      mockStoreState.voiceState = 'idle';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isProcessing).toBe(false);
    });

    it('should return isSpeaking=true when voiceState is speaking', () => {
      mockStoreState.voiceState = 'speaking';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isSpeaking).toBe(true);
    });

    it('should return isSpeaking=false when voiceState is not speaking', () => {
      mockStoreState.voiceState = 'idle';

      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.isSpeaking).toBe(false);
    });
  });

  describe('enable/disable proxy to store', () => {
    it('should proxy enable to store enable', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.enable).toBe(mockEnable);
    });

    it('should proxy disable to store disable', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.disable).toBe(mockDisable);
    });

    it('should proxy setInteractionMode to store', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.setInteractionMode).toBe(mockSetInteractionMode);
    });

    it('should proxy setTTSVoice to store', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.setTTSVoice).toBe(mockSetTTSVoice);
    });

    it('should proxy setAutoSend to store', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.setAutoSend).toBe(mockSetAutoSend);
    });
  });

  describe('loads settings on mount', () => {
    it('should call loadSettings on mount', () => {
      renderHook(() => useVoiceMode());

      expect(mockLoadSettings).toHaveBeenCalled();
    });
  });

  describe('action functions', () => {
    it('should provide startListening function', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.startListening).toBeInstanceOf(Function);
    });

    it('should provide stopListening function', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.stopListening).toBeInstanceOf(Function);
    });

    it('should provide speak function', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.speak).toBeInstanceOf(Function);
    });

    it('should provide stopSpeaking function', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.stopSpeaking).toBeInstanceOf(Function);
    });

    it('should provide bargeIn function', () => {
      const { result } = renderHook(() => useVoiceMode());

      expect(result.current.bargeIn).toBeInstanceOf(Function);
    });
  });
});
