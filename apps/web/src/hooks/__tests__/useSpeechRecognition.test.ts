import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSpeechRecognition } from '../useSpeechRecognition';

// Mock SpeechRecognition class
function createMockSpeechRecognition() {
  return {
    continuous: false,
    interimResults: false,
    lang: '',
    onstart: null as (() => void) | null,
    onend: null as (() => void) | null,
    onresult: null as ((event: unknown) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
}

let mockRecognitionInstance: ReturnType<typeof createMockSpeechRecognition>;

describe('useSpeechRecognition', () => {
  const mockOnTranscript = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRecognitionInstance = createMockSpeechRecognition();

    // Remove any previous SpeechRecognition from window
    delete (window as Record<string, unknown>).SpeechRecognition;
    delete (window as Record<string, unknown>).webkitSpeechRecognition;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Record<string, unknown>).SpeechRecognition;
    delete (window as Record<string, unknown>).webkitSpeechRecognition;
  });

  describe('isSupported', () => {
    it('should report isSupported=false when SpeechRecognition is not available', () => {
      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      expect(result.current.isSupported).toBe(false);
    });

    it('should report isSupported=true when SpeechRecognition is available', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      expect(result.current.isSupported).toBe(true);
    });

    it('should report isSupported=true when webkitSpeechRecognition is available', () => {
      (window as Record<string, unknown>).webkitSpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      expect(result.current.isSupported).toBe(true);
    });
  });

  describe('initial state', () => {
    it('should have isListening=false initially', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      expect(result.current.isListening).toBe(false);
    });

    it('should have error=null initially', () => {
      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      expect(result.current.error).toBeNull();
    });
  });

  describe('toggleListening', () => {
    it('should start listening when not currently listening', async () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      // Mock getUserMedia
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      await act(async () => {
        await result.current.toggleListening();
      });

      expect(mockRecognitionInstance.start).toHaveBeenCalled();
    });

    it('should stop listening when currently listening', async () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      // Start listening first
      await act(async () => {
        await result.current.toggleListening();
      });

      // Simulate the recognition starting
      act(() => {
        mockRecognitionInstance.onstart?.();
      });

      expect(result.current.isListening).toBe(true);

      // Now toggle to stop
      await act(async () => {
        await result.current.toggleListening();
      });

      expect(mockRecognitionInstance.stop).toHaveBeenCalled();
    });
  });

  describe('error messages mapping', () => {
    it('should set error for not-allowed speech recognition error', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'not-allowed' });
      });

      expect(result.current.error).toBe('Microphone access denied. Check your browser permissions.');
    });

    it('should set error for audio-capture speech recognition error', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'audio-capture' });
      });

      expect(result.current.error).toBe('No microphone found. Please connect a microphone.');
    });

    it('should set error for network speech recognition error', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'network' });
      });

      expect(result.current.error).toBe('Network error during speech recognition.');
    });

    it('should set error for no-speech error', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'no-speech' });
      });

      expect(result.current.error).toBe('No speech detected. Try again.');
    });

    it('should set generic error for unknown error type', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'something-unknown' });
      });

      expect(result.current.error).toBe('Speech recognition error: something-unknown');
    });

    it('should auto-clear error after 6 seconds', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'no-speech' });
      });

      expect(result.current.error).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('clearError', () => {
    it('should clear error when called', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onerror?.({ error: 'no-speech' });
      });

      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('stopListening', () => {
    it('should call recognition.stop', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        result.current.stopListening();
      });

      expect(mockRecognitionInstance.stop).toHaveBeenCalled();
    });
  });

  describe('onresult handling', () => {
    it('should call onTranscript with final transcript text', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onresult?.({
          resultIndex: 0,
          results: [
            {
              isFinal: true,
              0: { transcript: 'hello world' },
              length: 1,
            },
          ],
        });
      });

      expect(mockOnTranscript).toHaveBeenCalledWith('hello world');
    });

    it('should not call onTranscript for interim results', () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      act(() => {
        mockRecognitionInstance.onresult?.({
          resultIndex: 0,
          results: [
            {
              isFinal: false,
              0: { transcript: 'hello' },
              length: 1,
            },
          ],
        });
      });

      expect(mockOnTranscript).not.toHaveBeenCalled();
    });
  });

  describe('microphone permission error', () => {
    it('should set error when microphone access is denied', async () => {
      (window as Record<string, unknown>).SpeechRecognition = vi.fn(() => mockRecognitionInstance);

      const notAllowedError = new DOMException('Permission denied', 'NotAllowedError');
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn().mockRejectedValue(notAllowedError),
        },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() =>
        useSpeechRecognition({ onTranscript: mockOnTranscript })
      );

      await act(async () => {
        await result.current.toggleListening();
      });

      expect(result.current.error).toBe('Microphone access denied. Check your browser permissions.');
    });
  });
});
