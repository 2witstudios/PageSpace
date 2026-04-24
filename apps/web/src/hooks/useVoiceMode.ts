'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useVoiceModeStore, type TTSVoice, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { createId } from '@paralleldrive/cuid2';

function getMicPermissionErrorMessage(err: unknown): string {
  const isDesktop = typeof window !== 'undefined' && !!window.electron?.isDesktop;

  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      if (isDesktop) {
        return 'Microphone access was blocked. Allow PageSpace in System Settings > Privacy & Security > Microphone, then try again.';
      }
      return 'Microphone access was blocked. Please allow microphone permissions in your browser settings and try again.';
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No microphone was detected. Connect a microphone and try again.';
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return 'Your microphone is busy in another app. Close other apps using the mic and try again.';
    }
  }

  if (err instanceof TypeError) {
    return 'This browser does not support microphone capture for voice mode.';
  }

  return 'Unable to start voice mode because microphone access failed. Please try again.';
}

function getTranscriptionErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return `Could not transcribe your speech: ${err.message}`;
  }
  return 'Could not transcribe your speech. Please try again.';
}

function getSynthesisErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return `Could not play AI voice response: ${err.message}`;
  }
  return 'Could not play AI voice response. Please try again.';
}

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
  hasLoadedSettings: boolean;
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  voiceState: string;
  currentTranscript: string;
  error: string | null;

  // Actions
  enable: (owner?: VoiceModeOwner) => void;
  disable: () => void;
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

// Ref interfaces - grouped by concern for clarity and maintainability
interface RecordingRefs {
  mediaRecorder: MediaRecorder | null;
  audioChunks: Blob[];
  stream: MediaStream | null;
}

interface PlaybackRefs {
  audioContext: AudioContext | null;
  audioSource: AudioBufferSourceNode | null;
  autoListenTimer: ReturnType<typeof setTimeout> | null;
}

interface VadRefs {
  analyser: AnalyserNode | null;
  animationFrame: number | null;
  silenceTimeout: NodeJS.Timeout | null;
}

interface BargeInRefs {
  analyser: AnalyserNode | null;
  stream: MediaStream | null;
  animationFrame: number | null;
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
  const hasLoadedSettings = useVoiceModeStore((s) => s.hasLoadedSettings);
  const interactionMode = useVoiceModeStore((s) => s.interactionMode);
  const ttsVoice = useVoiceModeStore((s) => s.ttsVoice);
  const ttsSpeed = useVoiceModeStore((s) => s.ttsSpeed);
  const autoSend = useVoiceModeStore((s) => s.autoSend);
  const currentTranscript = useVoiceModeStore((s) => s.currentTranscript);
  const error = useVoiceModeStore((s) => s.error);

  // Store actions
  const enable = useVoiceModeStore((s) => s.enable);
  const disable = useVoiceModeStore((s) => s.disable);
  const setInteractionMode = useVoiceModeStore((s) => s.setInteractionMode);
  const setTTSVoice = useVoiceModeStore((s) => s.setTTSVoice);
  const setAutoSend = useVoiceModeStore((s) => s.setAutoSend);
  const setVoiceState = useVoiceModeStore((s) => s.setVoiceState);
  const setCurrentAudioId = useVoiceModeStore((s) => s.setCurrentAudioId);
  const setCurrentTranscript = useVoiceModeStore((s) => s.setCurrentTranscript);
  const setError = useVoiceModeStore((s) => s.setError);
  const startListeningStore = useVoiceModeStore((s) => s.startListening);
  const stopListeningStore = useVoiceModeStore((s) => s.stopListening);
  const startSpeakingStore = useVoiceModeStore((s) => s.startSpeaking);
  const stopSpeakingStore = useVoiceModeStore((s) => s.stopSpeaking);
  const bargeInStore = useVoiceModeStore((s) => s.bargeIn);

  // Grouped refs for related functionality
  const recordingRefs = useRef<RecordingRefs>({
    mediaRecorder: null,
    audioChunks: [],
    stream: null,
  });
  const playbackRefs = useRef<PlaybackRefs>({
    audioContext: null,
    audioSource: null,
    autoListenTimer: null,
  });
  const vadRefs = useRef<VadRefs>({
    analyser: null,
    animationFrame: null,
    silenceTimeout: null,
  });
  const bargeInRefs = useRef<BargeInRefs>({
    analyser: null,
    stream: null,
    animationFrame: null,
  });

  // State tracking refs
  const isStartingListeningRef = useRef(false);
  const voiceStateRef = useRef(voiceState);

  // Function ref to break circular dependency between setupVAD and stopListening
  const stopListeningRef = useRef<(() => void) | null>(null);

  // Callbacks ref to avoid stale closures
  const callbacksRef = useRef({ onTranscript, onSend, onSpeakComplete, onError });
  callbacksRef.current = { onTranscript, onSend, onSpeakComplete, onError };

  // Derived state
  const isListening = voiceState === 'listening';
  const isProcessing = voiceState === 'processing';
  const isSpeaking = voiceState === 'speaking';

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  // Initialize audio context lazily
  const getAudioContext = useCallback(() => {
    if (!playbackRefs.current.audioContext) {
      playbackRefs.current.audioContext = new AudioContext();
    }
    return playbackRefs.current.audioContext;
  }, []);

  // Stop barge-in speech detection that listens while TTS is playing.
  const stopBargeInMonitoring = useCallback(() => {
    if (bargeInRefs.current.animationFrame) {
      cancelAnimationFrame(bargeInRefs.current.animationFrame);
      bargeInRefs.current.animationFrame = null;
    }

    if (bargeInRefs.current.stream) {
      bargeInRefs.current.stream.getTracks().forEach((track) => { track.stop(); });
      bargeInRefs.current.stream = null;
    }

    bargeInRefs.current.analyser = null;
  }, []);

  // Stop audio playback without changing voice state.
  // Callers choose whether this should be treated as a normal stop or a barge-in transition.
  const stopAudioPlayback = useCallback(() => {
    stopBargeInMonitoring();
    if (playbackRefs.current.audioSource) {
      try {
        playbackRefs.current.audioSource.stop();
      } catch {
        // Ignore if already stopped
      }
      playbackRefs.current.audioSource = null;
    }
  }, [stopBargeInMonitoring]);

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
        const message = getTranscriptionErrorMessage(err);
        setError(message);
        callbacksRef.current.onError?.(message);
        return null;
      }
    },
    [language, setError]
  );

  // Voice Activity Detection while actively recording (silence auto-stop).
  // Uses stopListeningRef to access stopListening without circular dependency.
  const setupVAD = useCallback(
    (stream: MediaStream) => {
      const audioContext = getAudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      vadRefs.current.analyser = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceStart: number | null = null;
      const SILENCE_THRESHOLD = 12;
      const SILENCE_DURATION = 1400;

      const checkAudio = () => {
        if (!vadRefs.current.analyser) return;

        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (average < SILENCE_THRESHOLD) {
          if (!silenceStart) {
            silenceStart = Date.now();
          } else if (Date.now() - silenceStart > SILENCE_DURATION) {
            // Silence detected - stop recording via ref to break circular dependency
            if (voiceStateRef.current === 'listening' && stopListeningRef.current) {
              stopListeningRef.current();
            }
            return;
          }
        } else {
          silenceStart = null;
        }

        vadRefs.current.animationFrame = requestAnimationFrame(checkAudio);
      };

      vadRefs.current.animationFrame = requestAnimationFrame(checkAudio);
    },
    [getAudioContext]
  );

  // Stop listening and process audio
  const stopListening = useCallback(() => {
    stopBargeInMonitoring();

    // Cancel VAD
    if (vadRefs.current.animationFrame) {
      cancelAnimationFrame(vadRefs.current.animationFrame);
      vadRefs.current.animationFrame = null;
    }
    if (vadRefs.current.silenceTimeout) {
      clearTimeout(vadRefs.current.silenceTimeout);
      vadRefs.current.silenceTimeout = null;
    }

    // Stop media recorder
    const recorder = recordingRefs.current.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }

    // Stop media stream
    if (recordingRefs.current.stream) {
      recordingRefs.current.stream.getTracks().forEach((track) => { track.stop(); });
      recordingRefs.current.stream = null;
    }

    stopListeningStore();
  }, [stopBargeInMonitoring, stopListeningStore]);

  // Keep stopListeningRef in sync with stopListening
  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  // Start listening
  const startListening = useCallback(async () => {
    if (!isEnabled || !hasLoadedSettings) return;
    if (isStartingListeningRef.current || isListening || isProcessing) return;
    const recorder = recordingRefs.current.mediaRecorder;
    if (recorder && recorder.state === 'recording') return;

    isStartingListeningRef.current = true;

    // If speaking, barge in first and transition to listening
    try {
      if (voiceStateRef.current === 'speaking') {
        bargeInStore();
        stopAudioPlayback();
        setCurrentAudioId(null);
        // Transition from paused to listening (store.bargeIn sets to paused)
        setVoiceState('listening');
      }

      setError(null);
      recordingRefs.current.audioChunks = [];

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (!useVoiceModeStore.getState().isEnabled) {
        stream.getTracks().forEach((track) => { track.stop(); });
        return;
      }

      recordingRefs.current.stream = stream;

      // Determine the best supported format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      recordingRefs.current.mediaRecorder = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingRefs.current.audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (recordingRefs.current.audioChunks.length === 0) {
          setVoiceState('idle');
          return;
        }

        setVoiceState('processing');

        const audioBlob = new Blob(recordingRefs.current.audioChunks, { type: mimeType });
        const transcript = await transcribeAudio(audioBlob);

        if (transcript) {
          setCurrentTranscript(transcript);
          callbacksRef.current.onTranscript?.(transcript);

          if (autoSend) {
            callbacksRef.current.onSend?.(transcript);
            setCurrentTranscript('');
            setVoiceState('waiting');
            return;
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
      const message = getMicPermissionErrorMessage(err);
      setError(message);
      callbacksRef.current.onError?.(message);
      setVoiceState('idle');
    } finally {
      isStartingListeningRef.current = false;
    }
  }, [
    isEnabled,
    hasLoadedSettings,
    isListening,
    isProcessing,
    stopAudioPlayback,
    bargeInStore,
    setCurrentAudioId,
    setVoiceState,
    setError,
    transcribeAudio,
    setCurrentTranscript,
    autoSend,
    startListeningStore,
    setupVAD,
  ]);

  // Voice Activity Detection while TTS is speaking (real barge-in).
  const startBargeInMonitoring = useCallback(async () => {
    if (!isEnabled || interactionMode !== 'barge-in') return;

    stopBargeInMonitoring();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (voiceStateRef.current !== 'speaking') {
        stream.getTracks().forEach((track) => { track.stop(); });
        return;
      }

      const audioContext = getAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      bargeInRefs.current.stream = stream;
      bargeInRefs.current.analyser = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const SPEECH_THRESHOLD = 22;
      const REQUIRED_SPEECH_FRAMES = 7;
      let speechFrames = 0;

      const checkSpeech = () => {
        const currentAnalyser = bargeInRefs.current.analyser;
        if (!currentAnalyser) return;
        if (voiceStateRef.current !== 'speaking') {
          stopBargeInMonitoring();
          return;
        }

        currentAnalyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (average >= SPEECH_THRESHOLD) {
          speechFrames += 1;
        } else if (speechFrames > 0) {
          speechFrames -= 1;
        }

        if (speechFrames >= REQUIRED_SPEECH_FRAMES) {
          stopBargeInMonitoring();
          bargeInStore();
          stopAudioPlayback();
          setCurrentAudioId(null);
          void startListening();
          return;
        }

        bargeInRefs.current.animationFrame = requestAnimationFrame(checkSpeech);
      };

      bargeInRefs.current.animationFrame = requestAnimationFrame(checkSpeech);
    } catch {
      // Keep speaking even if we cannot monitor for interruption.
      stopBargeInMonitoring();
    }
  }, [
    isEnabled,
    interactionMode,
    stopBargeInMonitoring,
    getAudioContext,
    bargeInStore,
    stopAudioPlayback,
    setCurrentAudioId,
    startListening,
  ]);

  // Speak text using TTS
  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      try {
        setError(null);
        const audioId = createId();
        startSpeakingStore(audioId);

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

        // Guard: if barge-in cleared the audio ID during the fetch, discard this synthesis
        const { currentAudioId: liveAudioId } = useVoiceModeStore.getState();
        if (liveAudioId !== audioId) return;

        // Stop any existing playback without resetting state (we're already 'speaking')
        stopAudioPlayback();

        // Create and play new source
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        playbackRefs.current.audioSource = source;

        source.onended = () => {
          stopBargeInMonitoring();
          if (playbackRefs.current.audioSource === source) {
            playbackRefs.current.audioSource = null;
            stopSpeakingStore();
            callbacksRef.current.onSpeakComplete?.();

            // Read live store state to avoid stale closure — always auto-listen after TTS
            const { isEnabled: liveEnabled, interactionMode: liveMode } =
              useVoiceModeStore.getState();
            if (liveEnabled && liveMode === 'barge-in') {
              playbackRefs.current.autoListenTimer = setTimeout(() => {
                playbackRefs.current.autoListenTimer = null;
                void startListening();
              }, 300);
            }
          }
        };

        source.start();

        if (interactionMode === 'barge-in' && isEnabled) {
          void startBargeInMonitoring();
        }
      } catch (err) {
        const message = getSynthesisErrorMessage(err);
        setError(message);
        callbacksRef.current.onError?.(message);
        stopBargeInMonitoring();
        stopSpeakingStore();
      }
    },
    [
      ttsVoice,
      ttsSpeed,
      getAudioContext,
      stopAudioPlayback,
      stopBargeInMonitoring,
      startSpeakingStore,
      stopSpeakingStore,
      setError,
      interactionMode,
      isEnabled,
      startBargeInMonitoring,
      startListening,
    ]
  );

  // Barge-in: interrupt TTS and start listening

  const bargeIn = useCallback(() => {
    bargeInStore();
    stopAudioPlayback();
    setCurrentAudioId(null);
    // Transition from paused to listening
    setVoiceState('listening');
    startListening();
  }, [bargeInStore, stopAudioPlayback, setCurrentAudioId, setVoiceState, startListening]);

  // Stop speaking
  const stopSpeaking = useCallback(() => {
    stopAudioPlayback();
    stopSpeakingStore();
    setCurrentAudioId(null);
  }, [stopAudioPlayback, stopSpeakingStore, setCurrentAudioId]);

  // Cleanup on unmount
  useEffect(() => {
    // Capture ref values at effect start to use in cleanup (React hooks lint rule)
    const recording = recordingRefs.current;
    const playback = playbackRefs.current;
    const vad = vadRefs.current;

    return () => {
      // Stop recording
      if (recording.mediaRecorder && recording.mediaRecorder.state !== 'inactive') {
        recording.mediaRecorder.stop();
      }
      if (recording.stream) {
        recording.stream.getTracks().forEach((track) => { track.stop(); });
      }
      // Stop playback
      if (playback.autoListenTimer) {
        clearTimeout(playback.autoListenTimer);
        playback.autoListenTimer = null;
      }
      if (playback.audioSource) {
        try {
          playback.audioSource.stop();
        } catch {
          // Ignore
        }
        playback.audioSource = null;
      }
      stopBargeInMonitoring();
      // Cancel animations
      if (vad.animationFrame) {
        cancelAnimationFrame(vad.animationFrame);
      }
      if (vad.silenceTimeout) {
        clearTimeout(vad.silenceTimeout);
      }
      // Close audio context
      if (playback.audioContext) {
        playback.audioContext.close();
      }
    };
  }, [stopBargeInMonitoring]);

  // Load settings on mount
  useEffect(() => {
    useVoiceModeStore.getState().loadSettings();
  }, []);

  return {
    // State
    isEnabled,
    hasLoadedSettings,
    isListening,
    isProcessing,
    isSpeaking,
    voiceState,
    currentTranscript,
    error,

    // Actions
    enable,
    disable,
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
