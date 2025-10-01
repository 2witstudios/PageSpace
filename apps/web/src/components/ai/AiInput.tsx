"use client";

import React, { forwardRef } from 'react';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import styles from './ai-input.module.css';

interface AiInputProps {
  value: string;
  onChange: (value: string) => void;
  onSendMessage: () => void;
  placeholder?: string;
  driveId?: string;
  crossDrive?: boolean;
  disabled?: boolean;
}

const AiInput = forwardRef<ChatInputRef, AiInputProps>(({
  value,
  onChange,
  onSendMessage,
  placeholder = "Type your message...",
  driveId,
  crossDrive = false,
}, ref) => {
  return (
    <div className={styles.container}>
      <div className={`${styles.main} liquid-glass-regular rounded-lg border border-[var(--separator)] shadow-[var(--shadow-ambient)]`}>
        <ChatInput
          ref={ref}
          value={value}
          onChange={onChange}
          onSendMessage={onSendMessage}
          placeholder={placeholder}
          driveId={driveId}
          crossDrive={crossDrive}
        />
      </div>
    </div>
  );
});

AiInput.displayName = 'AiInput';

export default AiInput;