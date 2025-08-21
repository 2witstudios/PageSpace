"use client";

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { useSuggestion } from '@/hooks/useSuggestion';
import { Textarea } from '@/components/ui/textarea';
import SuggestionPopup from '@/components/mentions/SuggestionPopup';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';

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
  const context = useSuggestionContext();

  const suggestion = useSuggestion({
    inputRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
    onValueChange: onChange,
    trigger: '@',
    driveId,
    crossDrive,
    mentionFormat: 'markdown-typed',
    variant: 'chat',
    popupPlacement: 'top',
  });

  useImperativeHandle(ref, () => ({
    clear: () => {
      onChange('');
    },
    focus: () => {
      textareaRef.current?.focus();
    }
  }));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    suggestion.handleKeyDown(e);
    
    if (!context.isOpen && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSendMessage();
      }
    }
  };

  return (
    <div className="w-full relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => suggestion.handleValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="min-h-[40px] max-h-[120px] w-full"
      />
      
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