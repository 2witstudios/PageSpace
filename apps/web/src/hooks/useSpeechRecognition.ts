'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';

/**
 * Cross-surface dictation activity. Each `useSpeechRecognition()` instance
 * is otherwise local state — a mounted sidebar chat and main chat each own
 * an independent SpeechRecognition object — so consumers that need to know
 * "is dictation active ANYWHERE" (e.g. to avoid Read Aloud's TTS getting
 * transcribed back into a draft) can't read that off any single instance.
 * A count (not a boolean) so two simultaneously-listening surfaces don't
 * have one's stop clear the other's still-active state.
 */
interface DictationActivityState {
  activeCount: number;
}

export const useDictationActivityStore = create<DictationActivityState>(() => ({
  activeCount: 0,
}));

export interface UseSpeechRecognitionOptions {
  /** Callback when speech is transcribed */
  onTranscript: (text: string) => void;
  /** Language for recognition (default: 'en-US') */
  lang?: string;
  /** Whether to use continuous mode (default: true) */
  continuous?: boolean;
}

export interface UseSpeechRecognitionReturn {
  /** Whether speech recognition is currently active */
  isListening: boolean;
  /** Whether the browser supports speech recognition */
  isSupported: boolean;
  /** Current error message (null if no error) */
  error: string | null;
  /** Toggle listening on/off */
  toggleListening: () => void;
  /** Stop listening */
  stopListening: () => void;
  /** Clear the current error */
  clearError: () => void;
}

/**
 * Hook for speech-to-text functionality using the Web Speech API.
 *
 * @example
 * const { isListening, isSupported, toggleListening } = useSpeechRecognition({
 *   onTranscript: (text) => setValue(prev => prev + ' ' + text)
 * });
 */
export function useSpeechRecognition({
  onTranscript,
  lang = 'en-US',
  continuous = true,
}: UseSpeechRecognitionOptions): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  // Guards against double-decrementing the shared activeCount — onerror is
  // typically followed by onend for the same session, and this instance's
  // unmount cleanup could otherwise also fire after one of those already did.
  const isCountedActiveRef = useRef(false);

  // Keep callback ref updated
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setIsSupported(false);
      return;
    }

    setIsSupported(true);
    const recognition = new SpeechRecognitionAPI();

    recognition.continuous = continuous;
    recognition.interimResults = true;
    recognition.lang = lang;

    const markActive = () => {
      if (isCountedActiveRef.current) return;
      isCountedActiveRef.current = true;
      useDictationActivityStore.setState((s) => ({ activeCount: s.activeCount + 1 }));
    };
    const markInactive = () => {
      if (!isCountedActiveRef.current) return;
      isCountedActiveRef.current = false;
      useDictationActivityStore.setState((s) => ({ activeCount: Math.max(0, s.activeCount - 1) }));
    };

    recognition.onstart = () => {
      setIsListening(true);
      markActive();
    };

    recognition.onend = () => {
      setIsListening(false);
      markInactive();
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? '';
        }
      }

      if (finalTranscript) {
        onTranscriptRef.current(finalTranscript);
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      markInactive();

      const errorMessages: Record<string, string> = {
        'not-allowed': 'Microphone access denied. Check your browser permissions.',
        'audio-capture': 'No microphone found. Please connect a microphone.',
        'network': 'Network error during speech recognition.',
        'no-speech': 'No speech detected. Try again.',
        'service-not-available': 'Speech recognition service is unavailable.',
        'language-not-supported': 'Language not supported for speech recognition.',
      };

      const message = errorMessages[event.error] || `Speech recognition error: ${event.error}`;
      setError(message);

      // Auto-clear after 6 seconds
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setError(null), 6000);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      // Belt-and-suspenders in case onend never fires before unmount —
      // guarded by isCountedActiveRef, so this is a no-op when it already did.
      markInactive();
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [lang, continuous]);

  const clearError = useCallback(() => {
    setError(null);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const toggleListening = useCallback(async () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    // Clear any previous error when user tries again
    clearError();

    if (isListening) {
      recognition.stop();
      return;
    }

    // Explicitly request microphone permission before starting recognition.
    // SpeechRecognition.start() alone does NOT trigger the browser's permission
    // prompt in many cases (non-secure contexts, previously denied, etc.).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission granted - stop the stream immediately, we only needed the prompt
      stream.getTracks().forEach((track) => track.stop());
      recognition.start();
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access denied. Check your browser permissions.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone found. Please connect a microphone.'
            : 'Could not access microphone.';
      setError(message);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setError(null), 6000);
    }
  }, [isListening, clearError]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return {
    isListening,
    isSupported,
    error,
    toggleListening,
    stopListening,
    clearError,
  };
}
