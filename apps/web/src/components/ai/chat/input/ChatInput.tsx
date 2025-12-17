'use client';

import React, { forwardRef, useRef, useImperativeHandle, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChatTextarea, type ChatTextareaRef } from './ChatTextarea';
import { InputActions } from './InputActions';
import { InputToolbar } from './InputToolbar';

export interface ChatInputProps {
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
  /** Placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Enable cross-drive mention search */
  crossDrive?: boolean;
  /** Whether user is in read-only mode */
  isReadOnly?: boolean;
  /** Message to show when read-only */
  readOnlyMessage?: string;

  // Toolbar feature toggles
  /** Show speech-to-text button - default true */
  showSpeech?: boolean;
  /** Custom toolbar buttons */
  customToolbarButtons?: React.ReactNode;
}

export interface ChatInputRef {
  /** Focus the input */
  focus: () => void;
  /** Clear the input */
  clear: () => void;
}

/**
 * ChatInput - Composed input component for AI chat
 *
 * Combines:
 * - ChatTextarea with @ mention support
 * - InputActions (send/stop buttons)
 * - Read-only indicator when applicable
 *
 * This component provides the inner content for InputCard.
 * It does NOT include the card styling - that's handled by ChatLayout.
 */
export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
  (
    {
      value,
      onChange,
      onSend,
      onStop,
      isStreaming,
      disabled = false,
      placeholder = 'Type your message...',
      driveId,
      crossDrive = false,
      isReadOnly = false,
      readOnlyMessage = 'View only - cannot send messages',
      // Toolbar props
      showSpeech = true,
      customToolbarButtons,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => textareaRef.current?.clear(),
    }));

    const handleSend = () => {
      if (value.trim() && !disabled && !isReadOnly) {
        onSend();
      }
    };

    // Handle speech transcription by appending to current value
    const handleTranscription = useCallback(
      (text: string) => {
        const newValue = value + (value ? ' ' : '') + text;
        onChange(newValue);
      },
      [value, onChange]
    );

    const computedPlaceholder = isReadOnly ? readOnlyMessage : placeholder;
    const isDisabled = disabled || isReadOnly;
    const canSend = value.trim().length > 0 && !isDisabled;
    const hasToolbar = (showSpeech || customToolbarButtons) && !isReadOnly;

    return (
      <div className={cn('flex flex-col relative')}>
        {/* Input row */}
        <div className="flex items-end gap-2 p-3">
          <ChatTextarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onSend={handleSend}
            placeholder={computedPlaceholder}
            driveId={driveId}
            crossDrive={crossDrive}
            disabled={isDisabled}
          />

          <InputActions
            isStreaming={isStreaming}
            onSend={handleSend}
            onStop={onStop}
            disabled={!canSend}
          />
        </div>

        {/* Toolbar row */}
        {hasToolbar && (
          <InputToolbar
            showSpeech={showSpeech}
            onTranscriptionChange={handleTranscription}
            customButtons={customToolbarButtons}
            disabled={isDisabled}
          />
        )}

        {/* Read-only indicator */}
        {isReadOnly && (
          <div className="px-3 pb-3">
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2">
              <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
                {readOnlyMessage}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }
);

ChatInput.displayName = 'ChatInput';

export default ChatInput;
