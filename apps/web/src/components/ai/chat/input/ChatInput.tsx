'use client';

import React, { forwardRef, useRef, useImperativeHandle, useState, useCallback } from 'react';
import type { FileUIPart } from 'ai';
import { X, Image as ImageIcon, FileIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChatTextarea, type ChatTextareaRef } from './ChatTextarea';
import { InputActions } from './InputActions';
import { InputToolbar } from './InputToolbar';

/** Attachment with ID for tracking */
export type AttachmentFile = FileUIPart & { id: string };

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

  // Attachment props
  /** Attached files */
  attachments?: AttachmentFile[];
  /** Handler when files are added */
  onAddAttachments?: (files: File[]) => void;
  /** Handler when an attachment is removed */
  onRemoveAttachment?: (id: string) => void;

  // Toolbar feature toggles
  /** Show action menu (+ button) - default true */
  showActionMenu?: boolean;
  /** Show speech-to-text button - default true */
  showSpeech?: boolean;
  /** Custom action menu items */
  customMenuItems?: React.ReactNode;
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
 * AttachmentChip - Displays a single attachment with preview and remove button
 */
interface AttachmentChipProps {
  file: AttachmentFile;
  onRemove?: () => void;
}

function AttachmentChip({ file, onRemove }: AttachmentChipProps) {
  const isImage = file.mediaType?.startsWith('image/') && file.url;
  const filename = file.filename || (isImage ? 'Image' : 'Attachment');

  return (
    <div className="group relative flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-sm">
      {/* Preview/Icon */}
      <div className="relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.url}
            alt={filename}
            className="size-5 object-cover"
          />
        ) : (
          <FileIcon className="size-3 text-muted-foreground" />
        )}
      </div>

      {/* Filename */}
      <span className="max-w-[120px] truncate">{filename}</span>

      {/* Remove button */}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-3 w-3" />
          <span className="sr-only">Remove</span>
        </Button>
      )}
    </div>
  );
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
      // Attachment props
      attachments = [],
      onAddAttachments,
      onRemoveAttachment,
      // Toolbar props
      showActionMenu = true,
      showSpeech = true,
      customMenuItems,
      customToolbarButtons,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);

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

    // Drag and drop handlers
    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        if (!onAddAttachments) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
          setIsDragging(true);
        }
      },
      [onAddAttachments]
    );

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Only set to false if we're leaving the container, not entering a child
      if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
        setIsDragging(false);
      }
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!onAddAttachments) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          onAddAttachments(files);
        }
      },
      [onAddAttachments]
    );

    // Paste handler for files
    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        if (!onAddAttachments) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        const files: File[] = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
              files.push(file);
            }
          }
        }

        if (files.length > 0) {
          e.preventDefault();
          onAddAttachments(files);
        }
      },
      [onAddAttachments]
    );

    const computedPlaceholder = isReadOnly ? readOnlyMessage : placeholder;
    const isDisabled = disabled || isReadOnly;
    const canSend = (value.trim().length > 0 || attachments.length > 0) && !isDisabled;
    const hasToolbar = (showActionMenu || showSpeech || customToolbarButtons) && !isReadOnly;

    return (
      <div
        ref={containerRef}
        className={cn(
          'flex flex-col relative',
          isDragging && 'ring-2 ring-primary ring-inset rounded-2xl'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 bg-primary/5 rounded-2xl flex items-center justify-center z-10 pointer-events-none">
            <p className="text-sm text-primary font-medium">Drop files here</p>
          </div>
        )}

        {/* Attachments display */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.id}
                file={file}
                onRemove={onRemoveAttachment ? () => onRemoveAttachment(file.id) : undefined}
              />
            ))}
          </div>
        )}

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
            showActionMenu={showActionMenu}
            showSpeech={showSpeech}
            onAddFiles={onAddAttachments}
            textareaRef={textareaRef}
            onTranscriptionChange={handleTranscription}
            customMenuItems={customMenuItems}
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
