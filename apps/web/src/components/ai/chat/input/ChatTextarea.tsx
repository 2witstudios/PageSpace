'use client';

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useSuggestion } from '@/hooks/useSuggestion';
import { Textarea } from '@/components/ui/textarea';
import SuggestionPopup from '@/components/mentions/SuggestionPopup';
import {
  SuggestionProvider,
  useSuggestionContext,
} from '@/components/providers/SuggestionProvider';
import { cn } from '@/lib/utils';
import { MentionHighlightOverlay } from '@/components/ui/mention-highlight-overlay';
import { useMentionOverlay } from '@/hooks/useMentionOverlay';
import { useMentionTracker } from '@/hooks/useMentionTracker';

export interface ChatTextareaProps {
  /** Current input value (markdown format with @[label](id:type) mentions) */
  value: string;
  /** Input change handler (receives markdown format) */
  onChange: (value: string) => void;
  /** Send message handler (triggered on Enter without Shift) */
  onSend: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Enable cross-drive mention search */
  crossDrive?: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Style variant: 'main' for InputCard context, 'sidebar' for sidebar contrast */
  variant?: 'main' | 'sidebar';
  /** Popup placement: 'top' for suggestions above (docked input), 'bottom' for suggestions below (centered input) */
  popupPlacement?: 'top' | 'bottom';
  /** Handler for pasted image files (vision support) */
  onPasteFiles?: (files: File[]) => void;
  /** Additional class names */
  className?: string;
}

export interface ChatTextareaRef {
  /** Clear the input */
  clear: () => void;
  /** Focus the input */
  focus: () => void;
}

/**
 * ChatTextareaInner - Textarea with mention support
 * Must be wrapped in SuggestionProvider
 */
const ChatTextareaInner = forwardRef<ChatTextareaRef, ChatTextareaProps>(
  (
    {
      value,
      onChange,
      onSend,
      placeholder = 'Type your message...',
      driveId,
      crossDrive = false,
      disabled = false,
      variant = 'main',
      popupPlacement = 'top',
      onPasteFiles,
      className,
    },
    ref
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const context = useSuggestionContext();
    // Track IME composition state to prevent accidental sends during predictive text
    const [isComposing, setIsComposing] = useState(false);

    // Convert between markdown (parent) and display text (textarea)
    const {
      displayText,
      mentions,
      hasMentions,
      handleDisplayTextChange,
      registerMention,
    } = useMentionTracker(value, onChange);

    const { overlayRef, handleScroll } = useMentionOverlay(textareaRef, hasMentions);

    const suggestion = useSuggestion({
      inputRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      onValueChange: handleDisplayTextChange,
      trigger: '@',
      driveId,
      crossDrive,
      mentionFormat: 'label',
      variant: 'chat',
      popupPlacement,
      mentionRanges: mentions,
      onMentionInserted: registerMention,
    });

    useImperativeHandle(ref, () => ({
      clear: () => onChange(''),
      focus: () => textareaRef.current?.focus(),
    }));

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let the suggestion system handle navigation keys when open
      suggestion.handleKeyDown(e);

      // Send on Enter (without Shift) when suggestions are closed
      // Also check for IME composition to prevent sends during predictive text selection
      if (!context.isOpen && e.key === 'Enter' && !e.shiftKey) {
        // Don't send during IME composition (predictive text, etc.)
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        e.preventDefault();
        if (value.trim() && !disabled) {
          onSend();
        }
      }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteFiles) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        onPasteFiles(imageFiles);
      }
      // If no image files, let normal text paste proceed
    };

    return (
      <div className="relative flex-1 min-w-0 overflow-hidden">
        <Textarea
          ref={textareaRef}
          value={displayText}
          onChange={(e) => suggestion.handleValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onScroll={handleScroll}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'min-h-[36px] max-h-48 resize-none break-words',
            // Context-aware background:
            // - main: transparent to blend with InputCard, no shadow in light mode for flush look
            // - sidebar: white in light mode for contrast, slight gray lift in dark mode
            variant === 'sidebar'
              ? 'bg-white dark:bg-card/50'
              : 'bg-transparent dark:bg-transparent shadow-none dark:shadow-xs',
            'border-none outline-none',
            'text-foreground placeholder:text-muted-foreground',
            'focus-visible:ring-0 focus-visible:ring-offset-0',
            // When mentions are present, make text transparent so the overlay shows through
            hasMentions && 'text-transparent caret-foreground',
            className
          )}
          rows={1}
        />

        {/* Overlay that renders formatted mentions on top of the transparent textarea text */}
        {hasMentions && (
          <MentionHighlightOverlay
            ref={overlayRef}
            value={displayText}
            mentions={mentions}
            className={cn(
              'px-3 py-2 text-base md:text-sm',
              'text-foreground',
              'min-h-[36px] max-h-48'
            )}
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
          popupPlacement={popupPlacement}
        />
      </div>
    );
  }
);
ChatTextareaInner.displayName = 'ChatTextareaInner';

/**
 * ChatTextarea - Textarea with @ mention support
 *
 * Provides:
 * - Auto-growing textarea
 * - @ mention suggestions with search
 * - Enter to send, Shift+Enter for newline
 * - Cross-drive mention support
 */
export const ChatTextarea = forwardRef<ChatTextareaRef, ChatTextareaProps>(
  (props, ref) => (
    <SuggestionProvider>
      <ChatTextareaInner {...props} ref={ref} />
    </SuggestionProvider>
  )
);
ChatTextarea.displayName = 'ChatTextarea';

export default ChatTextarea;
