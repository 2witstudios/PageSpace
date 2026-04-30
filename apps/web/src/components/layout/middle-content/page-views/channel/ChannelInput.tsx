'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUp, X, FileIcon, ImageIcon, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputCard } from '@/components/ui/floating-input';
import { ChatTextarea, type ChatTextareaRef } from '@/components/ai/chat/input/ChatTextarea';
import { ChannelInputFooter } from './ChannelInputFooter';
import { useAttachmentUpload, type FileAttachment } from '@/hooks/useAttachmentUpload';

export type { FileAttachment };

export interface ChannelInputProps {
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Send message handler - receives optional attachment */
  onSend: (attachment?: FileAttachment) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Enable cross-drive mention search */
  crossDrive?: boolean;
  /** Whether attachments are enabled */
  attachmentsEnabled?: boolean;
  /** Channel page ID for uploads */
  channelId?: string;
  /** Additional class names */
  className?: string;
}

export interface ChannelInputRef {
  /** Focus the input */
  focus: () => void;
  /** Clear the input */
  clear: () => void;
  /** Insert text at cursor position */
  insertText: (text: string) => void;
}

/**
 * ChannelInput - Floating card input for channel messages
 *
 * Uses the PageSpace floating input design system with:
 * - Glass-morphism card styling (InputCard)
 * - Auto-growing textarea with @ mention support
 * - Formatting/emoji/attachment footer
 * - Send button with animation
 *
 * Similar to AI chat input but tailored for team messaging:
 * - No AI-specific controls (model selector, web search)
 * - Markdown formatting hints
 * - Future: file attachments, emoji picker
 */
export const ChannelInput = forwardRef<ChannelInputRef, ChannelInputProps>(
  (
    {
      value,
      onChange,
      onSend,
      disabled = false,
      placeholder = 'Type a message... (supports markdown)',
      driveId,
      crossDrive = false,
      attachmentsEnabled = false,
      channelId,
      className,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const [isFocused, setIsFocused] = useState(false);

    const { attachment, isUploading, uploadFile, clearAttachment } = useAttachmentUpload({
      uploadUrl: channelId ? `/api/channels/${channelId}/upload` : null,
      onUploaded: () => textareaRef.current?.focus(),
    });

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => textareaRef.current?.clear(),
      insertText: (text: string) => {
        // Insert text at current position
        onChange(value + text);
        textareaRef.current?.focus();
      },
    }));

    const handleSend = () => {
      if ((value.trim() || attachment) && !disabled && !isUploading) {
        onSend(attachment || undefined);
        clearAttachment();
      }
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await uploadFile(file);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    const handleAttachmentClick = () => {
      fileInputRef.current?.click();
    };

    // Get icon for file type
    const getFileIcon = (mimeType: string) => {
      if (mimeType.startsWith('image/')) return ImageIcon;
      if (mimeType.includes('pdf') || mimeType.includes('document')) return FileText;
      return FileIcon;
    };

    // Format file size
    const formatFileSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    // Handle formatting shortcuts
    const handleFormatClick = (format: 'bold' | 'italic' | 'code' | 'list') => {
      const formatMap = {
        bold: { prefix: '**', suffix: '**', placeholder: 'bold text' },
        italic: { prefix: '_', suffix: '_', placeholder: 'italic text' },
        code: { prefix: '`', suffix: '`', placeholder: 'code' },
        list: { prefix: '\n- ', suffix: '', placeholder: 'list item' },
      };

      const { prefix, suffix, placeholder: ph } = formatMap[format];
      const newValue = value + prefix + ph + suffix;
      onChange(newValue);
      textareaRef.current?.focus();
    };

    // Handle mention button - insert @ to trigger mention popup
    const handleMentionClick = () => {
      onChange(value + '@');
      textareaRef.current?.focus();
    };

    // Handle emoji selection from picker
    const handleEmojiSelect = (emoji: string) => {
      onChange(value + emoji);
      textareaRef.current?.focus();
    };

    const canSend = (value.trim().length > 0 || attachment) && !disabled && !isUploading;

    const sendButton = (
      <button
        onClick={handleSend}
        disabled={!canSend}
        className={cn(
          'group flex items-center justify-center h-9 w-9 shrink-0 rounded-full',
          'transition-all duration-200',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          // Channel-specific styling: softer blue, team-oriented feel
          canSend
            ? 'bg-primary text-primary-foreground hover:bg-primary/90 dark:bg-primary/90 dark:hover:bg-primary'
            : 'bg-muted text-muted-foreground'
        )}
        title="Send message"
        aria-label="Send message"
      >
        <ArrowUp className={cn(
          'h-4 w-4 transition-transform duration-200',
          canSend && 'group-hover:-translate-y-0.5'
        )} />
      </button>
    );

    return (
      <div className={cn('w-full', className)}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          accept="image/*,.pdf,.doc,.docx,.txt,.md"
        />

        <InputCard
          className={cn(
            // Subtle focus ring for the card
            'transition-all duration-200',
            isFocused && 'ring-1 ring-primary/20'
          )}
        >
          {/* Attachment preview */}
          {(attachment || isUploading) && (
            <div className="px-3 pt-3">
              <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg">
                {isUploading ? (
                  <>
                    <div className="w-8 h-8 rounded bg-muted animate-pulse" />
                    <div className="flex-1 min-w-0">
                      <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                      <div className="h-3 w-16 bg-muted animate-pulse rounded mt-1" />
                    </div>
                  </>
                ) : attachment ? (
                  <>
                    {attachment.mimeType.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 32px thumbnail preview; auth-gated API route
                      <img
                        src={`/api/files/${attachment.id}/view`}
                        alt={attachment.originalName}
                        className="w-8 h-8 rounded object-cover"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                        {(() => {
                          const Icon = getFileIcon(attachment.mimeType);
                          return <Icon className="h-4 w-4 text-muted-foreground" />;
                        })()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{attachment.originalName}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</p>
                    </div>
                    <button
                      onClick={clearAttachment}
                      className="p-1 hover:bg-muted rounded"
                      title="Remove attachment"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          )}

          {/* Input row */}
          <div
            className="flex items-end gap-2 p-3"
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          >
            <ChatTextarea
              ref={textareaRef}
              value={value}
              onChange={onChange}
              onSend={handleSend}
              placeholder={placeholder}
              driveId={driveId}
              crossDrive={crossDrive}
              disabled={disabled}
              variant="main"
              popupPlacement="top"
            />

            {/* Send button with press animation */}
            {shouldReduceMotion ? (
              <div className="shrink-0 self-end pb-0.5">{sendButton}</div>
            ) : (
              <motion.div
                className="shrink-0 self-end pb-0.5"
                whileTap={{ scale: 0.95 }}
                transition={{ duration: 0.1 }}
              >
                {sendButton}
              </motion.div>
            )}
          </div>

          {/* Footer with formatting actions */}
          <ChannelInputFooter
            onFormatClick={handleFormatClick}
            onMentionClick={handleMentionClick}
            onEmojiSelect={handleEmojiSelect}
            onAttachmentClick={handleAttachmentClick}
            attachmentsEnabled={attachmentsEnabled && !!channelId}
            disabled={disabled || isUploading}
          />
        </InputCard>
      </div>
    );
  }
);

ChannelInput.displayName = 'ChannelInput';

export default ChannelInput;
