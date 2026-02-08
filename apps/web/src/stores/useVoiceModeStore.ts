/**
 * Voice Mode Store
 *
 * Manages voice mode state for hands-free AI interaction.
 * Supports two interaction modes:
 * - Barge-in: Automatically detects speech and interrupts TTS playback
 * - Tap-to-speak: Manual control with tap to start/stop recording
 *
 * Uses OpenAI's Whisper for STT and OpenAI TTS for speech synthesis.
 * The base AI model remains whatever the user has selected globally.
 */

import { create } from 'zustand';

const VOICE_MODE_KEY = 'pagespace:voice:enabled';
const VOICE_INTERACTION_MODE_KEY = 'pagespace:voice:interactionMode';
const VOICE_TTS_VOICE_KEY = 'pagespace:voice:ttsVoice';
const VOICE_AUTO_SEND_KEY = 'pagespace:voice:autoSend';

export type VoiceInteractionMode = 'barge-in' | 'tap-to-speak';

export type VoiceState =
  | 'idle' // Voice mode off
  | 'listening' // Recording user speech
  | 'processing' // Transcribing audio
  | 'waiting' // Waiting for AI response
  | 'speaking' // TTS playing AI response
  | 'paused'; // TTS paused (barge-in detected)

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

interface VoiceModeState {
  // Core state
  isEnabled: boolean;
  voiceState: VoiceState;
  interactionMode: VoiceInteractionMode;

  // TTS settings
  ttsVoice: TTSVoice;
  ttsSpeed: number; // 0.25 to 4.0

  // Auto-send transcribed text immediately
  autoSend: boolean;

  // Current transcript (accumulated during recording)
  currentTranscript: string;

  // Error state
  error: string | null;

  // Audio context for playback tracking
  currentAudioId: string | null;

  // Actions
  enable: () => void;
  disable: () => void;
  toggle: () => void;

  setInteractionMode: (mode: VoiceInteractionMode) => void;
  setTTSVoice: (voice: TTSVoice) => void;
  setTTSSpeed: (speed: number) => void;
  setAutoSend: (autoSend: boolean) => void;

  setVoiceState: (state: VoiceState) => void;
  setCurrentTranscript: (transcript: string) => void;
  appendTranscript: (text: string) => void;
  clearTranscript: () => void;

  setError: (error: string | null) => void;
  setCurrentAudioId: (id: string | null) => void;

  // Convenience actions
  startListening: () => void;
  stopListening: () => void;
  startSpeaking: (audioId: string) => void;
  stopSpeaking: () => void;
  bargeIn: () => void;

  // Load persisted settings
  loadSettings: () => void;
}

export const useVoiceModeStore = create<VoiceModeState>()((set, get) => ({
  // Initial state
  isEnabled: false,
  voiceState: 'idle',
  interactionMode: 'tap-to-speak',
  ttsVoice: 'nova',
  ttsSpeed: 1.0,
  autoSend: true,
  currentTranscript: '',
  error: null,
  currentAudioId: null,

  // Enable/disable voice mode
  enable: () => {
    set({ isEnabled: true, voiceState: 'idle', error: null });
    if (typeof window !== 'undefined') {
      localStorage.setItem(VOICE_MODE_KEY, 'true');
    }
  },

  disable: () => {
    set({
      isEnabled: false,
      voiceState: 'idle',
      currentTranscript: '',
      error: null,
      currentAudioId: null,
    });
    if (typeof window !== 'undefined') {
      localStorage.setItem(VOICE_MODE_KEY, 'false');
    }
  },

  toggle: () => {
    if (get().isEnabled) {
      get().disable();
    } else {
      get().enable();
    }
  },

  // Settings
  setInteractionMode: (mode) => {
    set({ interactionMode: mode });
    if (typeof window !== 'undefined') {
      localStorage.setItem(VOICE_INTERACTION_MODE_KEY, mode);
    }
  },

  setTTSVoice: (voice) => {
    set({ ttsVoice: voice });
    if (typeof window !== 'undefined') {
      localStorage.setItem(VOICE_TTS_VOICE_KEY, voice);
    }
  },

  setTTSSpeed: (speed) => {
    // Clamp to valid range
    const clampedSpeed = Math.min(4.0, Math.max(0.25, speed));
    set({ ttsSpeed: clampedSpeed });
  },

  setAutoSend: (autoSend) => {
    set({ autoSend });
    if (typeof window !== 'undefined') {
      localStorage.setItem(VOICE_AUTO_SEND_KEY, String(autoSend));
    }
  },

  // State management
  setVoiceState: (voiceState) => set({ voiceState }),
  setCurrentTranscript: (currentTranscript) => set({ currentTranscript }),
  appendTranscript: (text) =>
    set((state) => ({
      currentTranscript: state.currentTranscript
        ? `${state.currentTranscript} ${text}`
        : text,
    })),
  clearTranscript: () => set({ currentTranscript: '' }),
  setError: (error) => set({ error }),
  setCurrentAudioId: (currentAudioId) => set({ currentAudioId }),

  // Convenience actions
  startListening: () => {
    if (!get().isEnabled) return;
    set({ voiceState: 'listening', error: null });
  },

  stopListening: () => {
    if (get().voiceState === 'listening') {
      set({ voiceState: 'processing' });
    }
  },

  startSpeaking: (audioId) => {
    set({ voiceState: 'speaking', currentAudioId: audioId });
  },

  stopSpeaking: () => {
    set({ voiceState: 'idle', currentAudioId: null });
  },

  bargeIn: () => {
    // Called when user starts speaking during TTS playback
    if (get().voiceState === 'speaking') {
      set({ voiceState: 'paused', currentAudioId: null });
      // Immediately transition to listening
      setTimeout(() => {
        if (get().voiceState === 'paused') {
          set({ voiceState: 'listening' });
        }
      }, 100);
    }
  },

  // Load settings from localStorage
  loadSettings: () => {
    if (typeof window === 'undefined') return;

    // Note: We intentionally don't restore isEnabled - user should explicitly enable voice mode each session
    const interactionMode = localStorage.getItem(VOICE_INTERACTION_MODE_KEY) as VoiceInteractionMode | null;
    const ttsVoice = localStorage.getItem(VOICE_TTS_VOICE_KEY) as TTSVoice | null;
    const autoSend = localStorage.getItem(VOICE_AUTO_SEND_KEY);

    set({
      isEnabled: false,
      interactionMode: interactionMode || 'tap-to-speak',
      ttsVoice: ttsVoice || 'nova',
      autoSend: autoSend !== 'false', // Default true
    });
  },
}));

// Selector helpers
export const selectIsVoiceModeEnabled = (state: VoiceModeState) => state.isEnabled;
export const selectVoiceState = (state: VoiceModeState) => state.voiceState;
export const selectIsListening = (state: VoiceModeState) => state.voiceState === 'listening';
export const selectIsSpeaking = (state: VoiceModeState) => state.voiceState === 'speaking';
export const selectIsProcessing = (state: VoiceModeState) => state.voiceState === 'processing';
