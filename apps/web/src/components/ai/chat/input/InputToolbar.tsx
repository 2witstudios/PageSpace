'use client';

import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Mic, ImageIcon, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputToolbarProps {
  /** Whether to show the action menu (+ button) */
  showActionMenu?: boolean;
  /** Whether to show speech-to-text button */
  showSpeech?: boolean;
  /** Handler when files are selected via file picker */
  onAddFiles?: (files: File[]) => void;
  /** Handler for speech transcription changes */
  onTranscriptionChange?: (text: string) => void;
  /** Custom action menu items to add */
  customMenuItems?: React.ReactNode;
  /** Custom toolbar buttons */
  customButtons?: React.ReactNode;
  /** Whether to accept only images */
  acceptImages?: boolean;
  /** Whether the toolbar is disabled */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * InputToolbar - Action buttons row for the chat input
 *
 * Provides:
 * - Action menu with file/image attachment options
 * - Speech-to-text button
 * - Extensible slots for custom buttons
 */
export function InputToolbar({
  showActionMenu = true,
  showSpeech = true,
  onAddFiles,
  onTranscriptionChange,
  customMenuItems,
  customButtons,
  acceptImages = false,
  disabled = false,
  className,
}: InputToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isListening, setIsListening] = React.useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Handle file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0 && onAddFiles) {
      onAddFiles(Array.from(files));
    }
    // Reset input to allow selecting same file again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

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
  if (!showActionMenu && !showSpeech && !customButtons) {
    return null;
  }

  return (
    <div className={cn('flex items-center gap-1 px-3 pb-2', className)}>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={acceptImages ? 'image/*' : undefined}
        onChange={handleFileChange}
        className="hidden"
        aria-label="Upload files"
      />

      {/* Action menu */}
      {showActionMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={disabled}
              title="Add attachment"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={openFilePicker}>
              <ImageIcon className="mr-2 h-4 w-4" />
              Add photos or files
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openFilePicker}>
              <Paperclip className="mr-2 h-4 w-4" />
              Upload document
            </DropdownMenuItem>
            {customMenuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

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
