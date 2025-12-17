'use client';

import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Mic } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputToolbarProps {
  /** Whether to show speech-to-text button */
  showSpeech?: boolean;
  /** Handler for speech transcription changes */
  onTranscriptionChange?: (text: string) => void;
  /** Custom toolbar buttons */
  customButtons?: React.ReactNode;
  /** Whether the toolbar is disabled */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * InputToolbar - Action buttons row for the chat input
 *
 * Provides:
 * - Speech-to-text button
 * - Extensible slots for custom buttons
 */
export function InputToolbar({
  showSpeech = true,
  onTranscriptionChange,
  customButtons,
  disabled = false,
  className,
}: InputToolbarProps) {
  const [isListening, setIsListening] = React.useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Speech recognition setup
  React.useEffect(() => {
    if (!showSpeech) return;

    if (
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
    ) {
      const SpeechRecognitionAPI =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognitionAPI();

      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0]?.transcript ?? '';
          }
        }

        if (finalTranscript) {
          onTranscriptionChange?.(finalTranscript);
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [showSpeech, onTranscriptionChange]);

  const toggleListening = () => {
    if (!recognitionRef.current) return;

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  const hasSpeechSupport =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // Don't render if nothing to show
  if (!showSpeech && !customButtons) {
    return null;
  }

  return (
    <div className={cn('flex items-center gap-1 px-3 pb-2', className)}>
      {/* Speech-to-text button */}
      {showSpeech && hasSpeechSupport && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 transition-all duration-200',
            isListening && 'animate-pulse bg-accent text-accent-foreground'
          )}
          onClick={toggleListening}
          disabled={disabled}
          title={isListening ? 'Stop listening' : 'Start voice input'}
        >
          <Mic className="h-4 w-4" />
        </Button>
      )}

      {/* Custom buttons slot */}
      {customButtons}

      {/* Spacer */}
      <div className="flex-1" />
    </div>
  );
}

export default InputToolbar;
