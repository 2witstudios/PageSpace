'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useVoiceModeStore, type TTSVoice } from '@/stores/useVoiceModeStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { createId } from '@paralleldrive/cuid2';

export interface UseVoiceModeOptions {
  /** Callback when transcript is available */
  onTranscript?: (text: string) => void;
  /** Callback when ready to send message (transcript finalized) */
  onSend?: (text: string) => void;
  /** Callback when TTS playback completes */
  onSpeakComplete?: () => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
  /** Language for transcription (default: 'en') */
  language?: string;
}

export interface UseVoiceModeReturn {
  // State
  isEnabled: boolean;
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  voiceState: string;
  currentTranscript: string;
  error: string | null;

  // Actions
  enable: () => void;
  disable: () => void;
  toggle: () => void;
  startListening: () => Promise<void>;
  stopListening: () => void;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  bargeIn: () => void;

  // Settings
  interactionMode: 'barge-in' | 'tap-to-speak';
  setInteractionMode: (mode: 'barge-in' | 'tap-to-speak') => void;
  ttsVoice: TTSVoice;
  setTTSVoice: (voice: TTSVoice) => void;
  autoSend: boolean;
  setAutoSend: (autoSend: boolean) => void;
}

/**
 * Hook for voice mode functionality.
 *
 * Provides:
 * - Audio recording via MediaRecorder API
 * - Speech-to-text via OpenAI Whisper
 * - Text-to-speech via OpenAI TTS
 * - Barge-in support (interrupt TTS when user speaks)
 * - Two interaction modes: tap-to-speak and barge-in
 */
export function useVoiceMode({
  onTranscript,
  onSend,
  onSpeakComplete,
  onError,
  language = 'en',
}: UseVoiceModeOptions = {}): UseVoiceModeReturn {
  // Store state
  const isEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceState = useVoiceModeStore((s) => s.voiceState);
  const interactionMode = useVoiceModeStore((s) => s.interactionMode);
  const ttsVoice = useVoiceModeStore((s) => s.ttsVoice);
  const ttsSpeed = useVoiceModeStore((s) => s.ttsSpeed);
  const autoSend = useVoiceModeStore((s) => s.autoSend);
  const currentTranscript = useVoiceModeStore((s) => s.currentTranscript);
  const error = useVoiceModeStore((s) => s.error);

  // Store actions
  const enable = useVoiceModeStore((s) => s.enable);
  const disable = useVoiceModeStore((s) => s.disable);
  const toggle = useVoiceModeStore((s) => s.toggle);
  const setInteractionMode = useVoiceModeStore((s) => s.setInteractionMode);
  const setTTSVoice = useVoiceModeStore((s) => s.setTTSVoice);
  const setAutoSend = useVoiceModeStore((s) => s.setAutoSend);
  const setVoiceState = useVoiceModeStore((s) => s.setVoiceState);
  const setCurrentTranscript = useVoiceModeStore((s) => s.setCurrentTranscript);
  const setError = useVoiceModeStore((s) => s.setError);
  const startListeningStore = useVoiceModeStore((s) => s.startListening);
  const stopListeningStore = useVoiceModeStore((s) => s.stopListening);
  const startSpeakingStore = useVoiceModeStore((s) => s.startSpeaking);
  const stopSpeakingStore = useVoiceModeStore((s) => s.stopSpeaking);
  const bargeInStore = useVoiceModeStore((s) => s.bargeIn);

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Callbacks ref to avoid stale closures
  const callbacksRef = useRef({ onTranscript, onSend, onSpeakComplete, onError });
  callbacksRef.current = { onTranscript, onSend, onSpeakComplete, onError };

  // Derived state
  const isListening = voiceState === 'listening';
  const isProcessing = voiceState === 'processing';
  const isSpeaking = voiceState === 'speaking';

  // Initialize audio context lazily
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  // Stop any ongoing audio playback
  const stopAudioPlayback = useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // Ignore if already stopped
      }
      audioSourceRef.current = null;
    }
    stopSpeakingStore();
  }, [stopSpeakingStore]);

  // Transcribe audio blob
  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      try {
        const formData = new FormData();
        const extension = audioBlob.type.includes('mp4') ? 'mp4' : 'webm';
        formData.append('audio', audioBlob, `recording.${extension}`);
        if (language) {
          formData.append('language', language);
        }

        const response = await fetchWithAuth('/api/voice/transcribe', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || errorData.error || 'Transcription failed');
        }

        const result = await response.json();
        return result.text as string;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transcription failed';
        setError(message);
        callbacksRef.current.onError?.(message);
        return null;
      }
    },
    [language, setError]
  );

  // Voice Activity Detection for barge-in mode
  const setupVAD = useCallback(
    (stream: MediaStream) => {
      if (interactionMode !== 'barge-in') return;

      const audioContext = getAudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceStart: number | null = null;
      const SILENCE_THRESHOLD = 10; // Adjust based on testing
      const SILENCE_DURATION = 1500; // 1.5 seconds of silence to stop

      const checkAudio = () => {
        if (!analyserRef.current) return;

        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

        if (average < SILENCE_THRESHOLD) {
          if (!silenceStart) {
            silenceStart = Date.now();
          } else if (Date.now() - silenceStart > SILENCE_DURATION) {
            // Silence detected - stop recording
            if (voiceState === 'listening') {
              stopListening();
            }
            return;
          }
        } else {
          silenceStart = null;
        }

        animationFrameRef.current = requestAnimationFrame(checkAudio);
      };

      animationFrameRef.current = requestAnimationFrame(checkAudio);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopListening is defined after this hook and would cause circular dependency
    [interactionMode, getAudioContext, voiceState]
  );

  // Stop listening and process audio
  const stopListening = useCallback(() => {
    // Cancel VAD
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    stopListeningStore();
  }, [stopListeningStore]);

  // Start listening
  const startListening = useCallback(async () => {
    if (!isEnabled) return;

    // If speaking, barge in first
    if (voiceState === 'speaking') {
      stopAudioPlayback();
      bargeInStore();
    }

    try {
      setError(null);
      audioChunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      // Determine the best supported format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) {
          setVoiceState('idle');
          return;
        }

        setVoiceState('processing');

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const transcript = await transcribeAudio(audioBlob);

        if (transcript) {
          setCurrentTranscript(transcript);
          callbacksRef.current.onTranscript?.(transcript);

          if (autoSend) {
            callbacksRef.current.onSend?.(transcript);
            setCurrentTranscript('');
          }
        }

        setVoiceState('idle');
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      startListeningStore();

      // Setup VAD for barge-in mode
      setupVAD(stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access denied';
      setError(message);
      callbacksRef.current.onError?.(message);
      setVoiceState('idle');
    }
  }, [
    isEnabled,
    voiceState,
    stopAudioPlayback,
    bargeInStore,
    setError,
    transcribeAudio,
    setCurrentTranscript,
    autoSend,
    setVoiceState,
    startListeningStore,
    setupVAD,
  ]);

  // Speak text using TTS
  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      try {
        setError(null);
        const audioId = createId();

        const response = await fetchWithAuth('/api/voice/synthesize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            voice: ttsVoice,
            speed: ttsSpeed,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || errorData.error || 'Speech synthesis failed');
        }

        const audioData = await response.arrayBuffer();
        const audioContext = getAudioContext();

        // Resume audio context if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const audioBuffer = await audioContext.decodeAudioData(audioData);

        // Stop any existing playback
        stopAudioPlayback();

        // Create and play new source
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        audioSourceRef.current = source;

        source.onended = () => {
          if (audioSourceRef.current === source) {
            stopSpeakingStore();
            callbacksRef.current.onSpeakComplete?.();

            // In barge-in mode, start listening after speaking
            if (interactionMode === 'barge-in' && isEnabled) {
              setTimeout(() => {
                startListening();
              }, 300);
            }
          }
        };

        startSpeakingStore(audioId);
        source.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Speech synthesis failed';
        setError(message);
        callbacksRef.current.onError?.(message);
        stopSpeakingStore();
      }
    },
    [
      ttsVoice,
      ttsSpeed,
      getAudioContext,
      stopAudioPlayback,
      startSpeakingStore,
      stopSpeakingStore,
      setError,
      interactionMode,
      isEnabled,
      startListening,
    ]
  );

  // Barge-in: interrupt TTS and start listening
  const bargeIn = useCallback(() => {
    stopAudioPlayback();
    bargeInStore();
    startListening();
  }, [stopAudioPlayback, bargeInStore, startListening]);

  // Stop speaking
  const stopSpeaking = useCallback(() => {
    stopAudioPlayback();
  }, [stopAudioPlayback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      // Stop playback
      if (audioSourceRef.current) {
        try {
          audioSourceRef.current.stop();
        } catch {
          // Ignore
        }
      }
      // Cancel animations
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Load settings on mount
  useEffect(() => {
    useVoiceModeStore.getState().loadSettings();
  }, []);

  return {
    // State
    isEnabled,
    isListening,
    isProcessing,
    isSpeaking,
    voiceState,
    currentTranscript,
    error,

    // Actions
    enable,
    disable,
    toggle,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    bargeIn,

    // Settings
    interactionMode,
    setInteractionMode,
    ttsVoice,
    setTTSVoice,
    autoSend,
    setAutoSend,
  };
}

export default useVoiceMode;
