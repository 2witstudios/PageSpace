'use client';

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUp, X, FileIcon, ImageIcon, FileText, CornerUpLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputCard } from '@/components/ui/floating-input';
import { ChatTextarea, type ChatTextareaRef } from '@/components/ai/chat/input/ChatTextarea';
import { ChannelInputFooter } from './ChannelInputFooter';
import { useAttachmentUpload, type FileAttachment } from '@/hooks/useAttachmentUpload';
import { formatFileSize } from '@/lib/attachment-utils';
import { useEditingSession } from '@/stores/useEditingSession';

export type { FileAttachment };

export interface ChannelInputSendOptions {
  /** When true (thread mode), the reply should be mirrored as a top-level message in the parent context */
  alsoSendToParent?: boolean;
}

export interface ChannelInputProps {
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Send message handler - receives optional attachment and thread options */
  onSend: (attachments?: FileAttachment[], options?: ChannelInputSendOptions) => void;
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
  /** Channel page ID for uploads (mutually exclusive with conversationId; channelId wins if both set) */
  channelId?: string;
  /** DM conversation ID for uploads (used when this input is rendered in a DM context) */
  conversationId?: string;
  /** Thread root id — when set, this input composes a reply for that thread */
  parentId?: string;
  /** Render the "Also send to channel/DM" checkbox in the footer (thread composer only) */
  showAlsoSendToParent?: boolean;
  /** Stable key used to register the draft with useEditingStore so SWR can't clobber unsent text */
  editingSessionKey?: string;
  /** Author + snippet for the quote-reply chip rendered above the input row.
      Parent owns the active quoted message id; this prop only drives the chip UI. */
  quotedPreview?: { authorName: string; snippet: string } | null;
  /** Dismiss the active quote — invoked when the user clicks the chip's X. */
  onClearQuote?: () => void;
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
  /** Upload a file into the composer's attachment slot (used for drops outside the composer) */
  uploadFile: (file: File) => void;
  /** Whether the composer can currently accept a new attachment */
  canAcceptDrop: () => boolean;
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
      conversationId,
      parentId,
      showAlsoSendToParent = false,
      editingSessionKey,
      quotedPreview,
      onClearQuote,
      className,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const [isFocused, setIsFocused] = useState(false);
    const [alsoSendToParent, setAlsoSendToParent] = useState(false);

    // Hold an editing-store session whenever the user has unsent draft text in
    // this composer instance. Prevents SWR refreshes / auth refreshes from
    // unmounting or clobbering the in-progress message — see useEditingStore
    // for the broader contract.
    useEditingSession(
      editingSessionKey ?? '',
      Boolean(editingSessionKey) && value.trim().length > 0,
      'form',
      { componentName: 'ChannelInput', pageId: channelId, conversationId },
    );

    const uploadUrl = channelId
      ? `/api/channels/${channelId}/upload`
      : conversationId
        ? `/api/messages/${conversationId}/upload`
        : null;
    const hasUploadTarget = !!uploadUrl;

    const { attachments, isUploading, uploadFiles, clearAttachment, removeAttachment } = useAttachmentUpload({
      uploadUrl,
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
      uploadFile: (file: File) => {
        if (!canUpload) return;
        void uploadFiles([file]);
      },
      canAcceptDrop: () => canUpload,
    }));

    const handleSend = () => {
      if ((value.trim() || attachments.length > 0) && !disabled && !isUploading) {
        const toSend = attachments.length > 0 ? attachments : undefined;
        if (parentId) {
          onSend(toSend, { alsoSendToParent });
        } else {
          onSend(toSend);
        }
        clearAttachment();
        if (parentId) setAlsoSendToParent(false);
      }
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      try {
        await uploadFiles(files);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    const handleAttachmentClick = () => {
      fileInputRef.current?.click();
    };

    const canUpload = attachmentsEnabled && hasUploadTarget && !isUploading;

    const handlePasteFiles = (files: File[]) => {
      if (!canUpload || files.length === 0) return;
      void uploadFiles(files);
    };

    const handleDragOver = (e: React.DragEvent) => {
      if (!canUpload) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = (e: React.DragEvent) => {
      if (!canUpload) return;
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    };

    const getFileIcon = (mimeType: string) => {
      if (mimeType.startsWith('image/')) return ImageIcon;
      if (mimeType.includes('pdf') || mimeType.includes('document')) return FileText;
      return FileIcon;
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

    const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled && !isUploading;

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
      <div
        className={cn('w-full', className)}
        data-testid="channel-input-root"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <InputCard
          className={cn(
            // Subtle focus ring for the card
            'transition-all duration-200',
            isFocused && 'ring-1 ring-primary/20'
          )}
        >
          {/* Quote-reply chip — mirrors the attachment-preview language so users
              recognise it as a dismissable composer affordance. Parent owns the
              state; we only render the chip when quotedPreview is set. */}
          {quotedPreview && (
            <div className="px-3 pt-3" data-testid="channel-input-quote-chip">
              <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg border-l-2 border-primary/40">
                <CornerUpLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">
                    Replying to {quotedPreview.authorName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {quotedPreview.snippet}
                  </p>
                </div>
                {onClearQuote ? (
                  <button
                    onClick={onClearQuote}
                    className="p-1 hover:bg-muted rounded"
                    title="Cancel quote reply"
                    aria-label="Cancel quote reply"
                    type="button"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {/* Attachment previews */}
          {(attachments.length > 0 || isUploading) && (
            <div className="px-3 pt-3 flex flex-col gap-1">
              {isUploading && (
                <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg">
                  <div className="w-8 h-8 rounded bg-muted animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-16 bg-muted animate-pulse rounded mt-1" />
                  </div>
                </div>
              )}
              {attachments.map(att => (
                <div key={att.id} className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg">
                  {att.mimeType.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 32px thumbnail preview; auth-gated API route
                    <img
                      src={`/api/files/${att.id}/view`}
                      alt={att.originalName}
                      className="w-8 h-8 rounded object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                      {(() => {
                        const Icon = getFileIcon(att.mimeType);
                        return <Icon className="h-4 w-4 text-muted-foreground" />;
                      })()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{att.originalName}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(att.size)}</p>
                  </div>
                  <button
                    onClick={() => removeAttachment(att.id)}
                    className="p-1 hover:bg-muted rounded"
                    title="Remove attachment"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              ))}
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
              canSendEmpty={attachments.length > 0}
              placeholder={placeholder}
              driveId={driveId}
              crossDrive={crossDrive}
              disabled={disabled}
              variant="main"
              popupPlacement="top"
              onPasteFiles={canUpload ? handlePasteFiles : undefined}
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
            attachmentsEnabled={attachmentsEnabled && hasUploadTarget}
            disabled={disabled || isUploading}
            alsoSendToParentEnabled={Boolean(parentId) && showAlsoSendToParent}
            alsoSendToParentLabel={
              conversationId && !channelId ? 'Also send to DM' : 'Also send to channel'
            }
            alsoSendToParent={alsoSendToParent}
            onAlsoSendToParentChange={setAlsoSendToParent}
          />
        </InputCard>
      </div>
    );
  }
);

ChannelInput.displayName = 'ChannelInput';

export default ChannelInput;
