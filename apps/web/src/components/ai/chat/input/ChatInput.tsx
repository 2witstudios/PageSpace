'use client';

import React, { forwardRef, useRef, useImperativeHandle, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { ChatTextarea, type ChatTextareaRef } from './ChatTextarea';
import { InputActions } from './InputActions';
import { InputFooter } from '@/components/ui/floating-input';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';

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
  /** Hide the model/provider selector in footer (for compact layouts) */
  hideModelSelector?: boolean;
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
      hideModelSelector = false,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);

    // Get settings from centralized store
    const webSearchEnabled = useAssistantSettingsStore((s) => s.webSearchEnabled);
    const writeMode = useAssistantSettingsStore((s) => s.writeMode);
    const toggleWebSearch = useAssistantSettingsStore((s) => s.toggleWebSearch);
    const toggleWriteMode = useAssistantSettingsStore((s) => s.toggleWriteMode);
    const currentProvider = useAssistantSettingsStore((s) => s.currentProvider);
    const currentModel = useAssistantSettingsStore((s) => s.currentModel);
    const setProviderSettings = useAssistantSettingsStore((s) => s.setProviderSettings);
    const loadSettings = useAssistantSettingsStore((s) => s.loadSettings);

    // Load settings on mount
    useEffect(() => {
      loadSettings();
    }, [loadSettings]);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => textareaRef.current?.clear(),
    }));

    const handleSend = () => {
      if (value.trim() && !disabled) {
        onSend();
      }
    };

    const canSend = value.trim().length > 0 && !disabled;

    return (
      <div className={cn('flex flex-col relative')}>
        {/* Input row */}
        <div className="flex items-end gap-2 p-3">
          <ChatTextarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onSend={handleSend}
            placeholder={placeholder}
            driveId={driveId}
            crossDrive={crossDrive}
            disabled={disabled}
          />

          <InputActions
            isStreaming={isStreaming}
            onSend={handleSend}
            onStop={onStop}
            disabled={!canSend}
          />
        </div>

        {/* Footer menu */}
        <InputFooter
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={toggleWebSearch}
          writeMode={writeMode}
          onWriteModeToggle={toggleWriteMode}
          onMicClick={() => console.log('Mic clicked')}
          selectedProvider={currentProvider}
          selectedModel={currentModel}
          onProviderModelChange={setProviderSettings}
          hideModelSelector={hideModelSelector}
          disabled={isStreaming}
        />
      </div>
    );
  }
);

ChatInput.displayName = 'ChatInput';

export default ChatInput;
