'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

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
  /** Toggle listening on/off */
  toggleListening: () => void;
  /** Stop listening */
  stopListening: () => void;
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
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onTranscriptRef = useRef(onTranscript);

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

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onend = () => {
      setIsListening(false);
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
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
    };
  }, [lang, continuous]);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return {
    isListening,
    isSupported,
    toggleListening,
    stopListening,
  };
}

export default useSpeechRecognition;
