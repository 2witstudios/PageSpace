/**
 * ChatInputArea - Input area with error display and send/stop buttons
 * Used by both Agent engine and Global Assistant engine
 */

import React, { useRef, forwardRef, useImperativeHandle } from 'react';
import { Button } from '@/components/ui/button';
import { Send, StopCircle } from 'lucide-react';
import AiInput from './AiInput';
import { ChatInputRef } from '@/components/messages/ChatInput';
import { getAIErrorMessage } from '@/lib/ai/shared/error-messages';

interface ChatInputAreaProps {
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Whether the chat is loading */
  isLoading?: boolean;
  /** Input placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Allow cross-drive mentions */
  crossDrive?: boolean;
  /** Current error (if any) */
  error?: Error | null;
  /** Whether to show the error */
  showError?: boolean;
  /** Callback when error is cleared */
  onClearError?: () => void;
  /** Whether user is in read-only mode */
  isReadOnly?: boolean;
  /** Message to show when read-only */
  readOnlyMessage?: string;
}

export interface ChatInputAreaRef {
  /** Focus the input */
  focus: () => void;
  /** Clear the input */
  clear: () => void;
}

/**
 * Chat input area with error display, send button, and stop button
 */
export const ChatInputArea = forwardRef<ChatInputAreaRef, ChatInputAreaProps>(
  (
    {
      value,
      onChange,
      onSend,
      onStop,
      isStreaming,
      disabled = false,
      isLoading = false,
      placeholder = 'Type your message...',
      driveId,
      crossDrive = false,
      error,
      showError = true,
      onClearError,
      isReadOnly = false,
      readOnlyMessage = 'View only - cannot send messages',
    },
    ref
  ) => {
    const chatInputRef = useRef<ChatInputRef>(null);

    // Expose methods to parent
    useImperativeHandle(ref, () => ({
      focus: () => chatInputRef.current?.focus?.(),
      clear: () => chatInputRef.current?.clear(),
    }));

    // Handle send
    const handleSend = () => {
      if (value.trim() && !disabled && !isLoading && !isReadOnly) {
        onSend();
      }
    };

    // Compute placeholder
    const computedPlaceholder = isLoading
      ? 'Loading...'
      : isReadOnly
        ? readOnlyMessage
        : placeholder;

    return (
      <div className="border-t border-[var(--separator)] p-4">
        <div className="max-w-4xl mx-auto w-full">
          {/* Error display */}
          {error && showError && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between">
              <p className="text-sm text-red-700 dark:text-red-300">
                {getAIErrorMessage(error.message)}
              </p>
              {onClearError && (
                <button
                  onClick={onClearError}
                  className="text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {/* Input and buttons */}
          <div className="flex space-x-2">
            <AiInput
              ref={chatInputRef}
              value={value}
              onChange={onChange}
              onSendMessage={handleSend}
              placeholder={computedPlaceholder}
              driveId={driveId}
              crossDrive={crossDrive}
            />
            {isStreaming ? (
              <Button
                onClick={onStop}
                variant="destructive"
                size="icon"
                title="Stop generating"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSend}
                disabled={!value.trim() || disabled || isLoading || isReadOnly}
                size="icon"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Read-only indicator */}
          {isReadOnly && (
            <div className="mt-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2">
              <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
                {readOnlyMessage}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }
);

ChatInputArea.displayName = 'ChatInputArea';
