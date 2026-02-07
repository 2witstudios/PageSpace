"use client";

import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { useSuggestion } from '@/hooks/useSuggestion';
import { Textarea } from '@/components/ui/textarea';
import SuggestionPopup from '@/components/mentions/SuggestionPopup';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';
import { cn } from '@/lib/utils';
import { MentionHighlightOverlay } from '@/components/ui/mention-highlight-overlay';
import { useMentionDisplay } from '@/hooks/useMentionDisplay';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSendMessage: () => void;
  placeholder?: string;
  driveId?: string;
  crossDrive?: boolean; // Enable cross-drive mention search
}

export interface ChatInputRef {
  clear: () => void;
  focus: () => void;
}

const ChatInputWithProvider = forwardRef<ChatInputRef, ChatInputProps>(({
  value,
  onChange,
  onSendMessage,
  placeholder = "Type your message...",
  driveId,
  crossDrive = false
}, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const context = useSuggestionContext();
  // Track IME composition state to prevent accidental sends during predictive text
  const [isComposing, setIsComposing] = useState(false);

  // Bidirectional display ↔ raw conversion.
  const {
    displayValue,
    hasMentions,
    mentions,
    handleDisplayChange,
    trackMention,
    clearMentions,
  } = useMentionDisplay({ value, onChange });

  const suggestion = useSuggestion({
    inputRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
    onValueChange: handleDisplayChange,
    trigger: '@',
    driveId,
    crossDrive,
    mentionFormat: 'label',
    variant: 'chat',
    popupPlacement: 'top',
    onMentionInserted: trackMention,
  });

  useImperativeHandle(ref, () => ({
    clear: () => {
      clearMentions();
      onChange('');
    },
    focus: () => {
      textareaRef.current?.focus();
    }
  }));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    suggestion.handleKeyDown(e);

    if (!context.isOpen && e.key === 'Enter' && !e.shiftKey) {
      // Don't send during IME composition (predictive text, etc.)
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }
      e.preventDefault();
      if (value.trim()) {
        onSendMessage();
      }
    }
  };

  const handleScroll = useCallback(() => {
    if (textareaRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  return (
    <div className="w-full relative">
      <Textarea
        ref={textareaRef}
        value={displayValue}
        onChange={(e) => suggestion.handleValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={placeholder}
        className={cn(
          'min-h-[40px] max-h-[120px] w-full',
          hasMentions && 'text-transparent caret-foreground'
        )}
      />

      {hasMentions && (
        <MentionHighlightOverlay
          ref={overlayRef}
          value={displayValue}
          mentions={mentions}
          className="px-3 py-2 text-base md:text-sm text-foreground min-h-[40px] max-h-[120px]"
        />
      )}

      <SuggestionPopup
        isOpen={context.isOpen}
        items={context.items}
        selectedIndex={context.selectedIndex}
        position={context.position}
        loading={context.loading}
        error={context.error}
        onSelect={suggestion.actions.selectSuggestion}
        onSelectionChange={suggestion.actions.selectItem}
        variant="overlay"
        popupPlacement="top"
      />
    </div>
  );
});
ChatInputWithProvider.displayName = 'ChatInputWithProvider';

const ChatInput = forwardRef<ChatInputRef, ChatInputProps>((props, ref) => (
  <SuggestionProvider>
    <ChatInputWithProvider {...props} ref={ref} />
  </SuggestionProvider>
));
ChatInput.displayName = 'ChatInput';

export default ChatInput;
