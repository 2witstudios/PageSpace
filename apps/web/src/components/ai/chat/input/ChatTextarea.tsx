'use client';

import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useSuggestion } from '@/hooks/useSuggestion';
import { Textarea } from '@/components/ui/textarea';
import { MentionPickerPortal } from '@/components/mentions/MentionPickerPortal';
import {
  SuggestionProvider,
  useSuggestionContext,
} from '@/components/providers/SuggestionProvider';
import { cn } from '@/lib/utils';
import { MentionHighlightOverlay } from '@/components/ui/mention-highlight-overlay';
import { useMentionOverlay } from '@/hooks/useMentionOverlay';
import { useMessageTokens } from '@/hooks/useMessageTokens';
import { useEnterToSend } from '@/hooks/useEnterToSend';
import { useAuthStore } from '@/stores/useAuthStore';
import { canUseCommands } from '@/lib/commands/command-gating';
import { useCommandSuggestion } from '@/hooks/useCommandSuggestion';
import { CommandPickerPortal } from '@/components/commands/CommandPickerPortal';
import { commandResultsAnnouncement } from '@/lib/commands/command-picker-core';

// Typography classes applied to both the textarea and the mention overlay.
// They must stay in sync — mismatched line-height causes the overlay text to
// drift relative to the caret with each newline.
const CHAT_TYPOGRAPHY = 'text-base md:text-sm leading-relaxed';

export interface ChatTextareaProps {
  /** Current input value (markdown format with @[label](id:type) mentions) */
  value: string;
  /** Input change handler (receives markdown format) */
  onChange: (value: string) => void;
  /** Send message handler (triggered on Enter without Shift) */
  onSend: () => void;
  /** Allow Enter to send when the textarea is empty, for attachment-only sends */
  canSendEmpty?: boolean;
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
 * ChatTextareaInner - Textarea with mention + slash-command support
 * Must be wrapped in SuggestionProvider
 */
const ChatTextareaInner = forwardRef<ChatTextareaRef, ChatTextareaProps>(
  (
    {
      value,
      onChange,
      onSend,
      canSendEmpty = false,
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
    const enterToSend = useEnterToSend();

    // Exposure gating (spec §0): the `/` trigger and picker exist only for
    // admin accounts at launch; for everyone else `/` is a literal character.
    // Reads the auth store directly (same user object useAuth returns) to keep
    // every chat input from mounting useAuth's session/router machinery.
    const user = useAuthStore((state) => state.user);
    const commandsEnabled = canUseCommands(user);

    // Convert between markdown (parent) and display text (textarea).
    // Tracks both mention tokens and command chips through edits.
    const {
      displayText,
      tokens,
      hasTokens,
      hasCommandToken,
      handleDisplayTextChange,
      registerToken,
    } = useMessageTokens(value, onChange);

    const { overlayRef, handleScroll } = useMentionOverlay(textareaRef, hasTokens);

    const suggestion = useSuggestion({
      inputRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      onValueChange: handleDisplayTextChange,
      trigger: '@',
      driveId,
      crossDrive,
      mentionFormat: 'label',
      variant: 'chat',
      popupPlacement,
      mentionRanges: tokens,
      onMentionInserted: registerToken,
    });

    const command = useCommandSuggestion({
      inputRef: textareaRef,
      enabled: commandsEnabled && !disabled,
      driveId,
      popupPlacement,
      hasCommandToken,
      tokenRanges: tokens,
      enterSelects: enterToSend,
      onValueChange: handleDisplayTextChange,
      onTokenInserted: registerToken,
    });
    const { syncDisplayText } = command;

    // Keep the command trigger detector in sync with programmatic value
    // changes (clear on send, draft restore, emoji/mention button insertion).
    // User typing flows through handleInput first, making this a no-op.
    useEffect(() => {
      syncDisplayText(displayText);
    }, [displayText, syncDisplayText]);

    const baseId = useId();
    const commandListboxId = `${baseId}-command-listbox`;
    const commandOptionId = (index: number) => `${baseId}-command-option-${index}`;

    useImperativeHandle(ref, () => ({
      clear: () => onChange(''),
      focus: () => textareaRef.current?.focus(),
    }));

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // The command picker consumes navigation keys while open (spec §1.7)
      command.handleKeyDown(e);
      if (e.defaultPrevented) return;

      // Let the mention suggestion system handle navigation keys when open
      suggestion.handleKeyDown(e);

      // Send on Enter (without Shift) when suggestions are closed
      // On mobile phones (and iPad with on-screen keyboard), Enter inserts a newline instead;
      // users send via the send button. Desktop and iPad with external keyboard keep Enter-to-send.
      if (!context.isOpen && !command.isOpen && e.key === 'Enter' && !e.shiftKey && enterToSend) {
        // Don't send during IME composition (predictive text, etc.)
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        e.preventDefault();
        if ((value.trim() || canSendEmpty) && !disabled) {
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

    // Combobox wiring for the command picker (spec §9). DOM focus stays in
    // the textarea while the picker is open — there is no inner search field.
    const commandComboboxProps = commandsEnabled
      ? {
          role: 'combobox' as const,
          'aria-expanded': command.isOpen,
          'aria-haspopup': 'listbox' as const,
          'aria-controls': command.isOpen ? commandListboxId : undefined,
          'aria-activedescendant':
            command.isOpen && command.items.length > 0
              ? commandOptionId(command.selectedIndex)
              : undefined,
        }
      : {};

    return (
      <div className="relative flex-1 min-w-0 overflow-hidden">
        <Textarea
          ref={textareaRef}
          value={displayText}
          onChange={(e) => {
            suggestion.handleValueChange(e.target.value);
            // Command trigger detection needs the native inputType to tell
            // typing insertions from paste/drop/autofill (spec §1.1)
            const inputType =
              e.nativeEvent instanceof InputEvent ? e.nativeEvent.inputType : null;
            command.handleInput(e.target.value, inputType);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onScroll={handleScroll}
          onCompositionStart={() => {
            setIsComposing(true);
            command.handleCompositionStart();
          }}
          onCompositionEnd={() => {
            setIsComposing(false);
            command.handleCompositionEnd();
          }}
          placeholder={placeholder}
          disabled={disabled}
          {...commandComboboxProps}
          className={cn(
            'min-h-[36px] max-h-48 resize-none break-words',
            CHAT_TYPOGRAPHY,
            // Context-aware background:
            // - main: transparent to blend with InputCard, no shadow in light mode for flush look
            // - sidebar: white in light mode for contrast, slight gray lift in dark mode
            variant === 'sidebar'
              ? 'bg-white dark:bg-card/50'
              : 'bg-transparent dark:bg-transparent shadow-none dark:shadow-xs',
            'border-none outline-none',
            'text-foreground placeholder:text-muted-foreground',
            'focus-visible:ring-0 focus-visible:ring-offset-0',
            // When tokens are present, make text transparent so the overlay shows through
            hasTokens && 'text-transparent caret-foreground',
            className
          )}
          rows={1}
        />

        {/* Overlay that renders formatted mentions/command chips on top of the transparent textarea text */}
        {hasTokens && (
          <MentionHighlightOverlay
            ref={overlayRef}
            value={displayText}
            mentions={tokens}
            className={cn(
              'px-3 py-2',
              CHAT_TYPOGRAPHY,
              'text-foreground',
              'min-h-[36px] max-h-48'
            )}
          />
        )}

        <MentionPickerPortal
          isOpen={context.isOpen}
          position={context.position}
          driveId={driveId}
          crossDrive={crossDrive}
          initialQuery={suggestion.query}
          onSelect={suggestion.actions.selectSuggestion}
          onClose={suggestion.actions.close}
        />

        {commandsEnabled && (
          <>
            <CommandPickerPortal
              isOpen={command.isOpen}
              position={command.position}
              anchorRef={textareaRef}
              items={command.items}
              loading={command.loading}
              query={command.query}
              selectedIndex={command.selectedIndex}
              onSelect={command.actions.select}
              onSelectionChange={command.actions.setSelectedIndex}
              listboxId={commandListboxId}
              optionId={commandOptionId}
              hasAnyCommands={command.hasAnyCommands}
              onNavigateToSettings={command.actions.close}
              onClose={command.actions.close}
              onDismiss={command.actions.dismiss}
            />
            {/* Polite live region announcing result counts (spec §9) */}
            <span role="status" aria-live="polite" className="sr-only">
              {command.isOpen && !command.loading
                ? commandResultsAnnouncement(command.items.length)
                : ''}
            </span>
          </>
        )}
      </div>
    );
  }
);
ChatTextareaInner.displayName = 'ChatTextareaInner';

/**
 * ChatTextarea - Textarea with @ mention and / command support
 *
 * Provides:
 * - Auto-growing textarea
 * - @ mention suggestions with search
 * - / slash-command picker at message start (admin-gated at launch, spec §0)
 * - Platform-aware Enter key: sends on desktop/external keyboard, newline on mobile
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
