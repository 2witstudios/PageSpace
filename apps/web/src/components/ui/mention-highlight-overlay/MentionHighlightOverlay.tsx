'use client';

import React, { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { COMMAND_TOKEN_TYPE, type TrackedToken } from '@/lib/tokens/message-tokens';

interface MentionHighlightOverlayProps {
  /** Display text (same as textarea value — no markdown IDs) */
  value: string;
  /**
   * Tracked token positions within the display text. Accepts plain mentions
   * (TrackedMention is assignable) and command chips alike; command tokens
   * render as primary-tinted rounded chips, mentions as underlined spans.
   */
  mentions: TrackedToken[];
  /** Additional class names applied to the overlay container */
  className?: string;
}

/**
 * MentionHighlightOverlay renders text with @mentions as colored, underlined spans.
 *
 * It is designed to sit on top of a textarea with transparent text,
 * mirroring the exact same layout so that the formatted mentions
 * align perfectly with the invisible raw text underneath.
 *
 * Because the display text in the textarea now matches the overlay text
 * character-for-character (no hidden IDs), alignment is perfect.
 *
 * pointer-events: none lets all clicks/input pass through to the textarea.
 */
export const MentionHighlightOverlay = forwardRef<
  HTMLDivElement,
  MentionHighlightOverlayProps
>(({ value, mentions, className }, ref) => {
  const renderFormattedText = (
    text: string,
    trackedTokens: TrackedToken[]
  ): React.ReactNode[] => {
    if (trackedTokens.length === 0) {
      return [<span key="text-0">{text || '\u200B'}</span>];
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const token of trackedTokens) {
      // Add preceding plain text
      if (token.start > lastIndex) {
        elements.push(
          <span key={`text-${lastIndex}`}>
            {text.slice(lastIndex, token.start)}
          </span>
        );
      }

      // Render the token as a styled inline element. Styles must never change
      // glyph metrics (no padding/weight changes) \u2014 the overlay text has to
      // stay aligned character-for-character with the transparent textarea.
      const tokenText = text.slice(token.start, token.end);
      const isCommand = token.type === COMMAND_TOKEN_TYPE;

      elements.push(
        <span
          key={`token-${token.start}`}
          className={
            isCommand
              ? 'text-primary bg-primary/10 rounded'
              : 'text-primary underline decoration-primary/50'
          }
        >
          {tokenText}
        </span>
      );

      lastIndex = token.end;
    }

    // Add any remaining plain text
    if (lastIndex < text.length) {
      elements.push(
        <span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>
      );
    }

    // If text is empty, render a zero-width space to maintain line height
    if (elements.length === 0) {
      elements.push(<span key="empty">{'\u200B'}</span>);
    }

    return elements;
  };

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        'absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
        className
      )}
    >
      {renderFormattedText(value, mentions)}
    </div>
  );
});
MentionHighlightOverlay.displayName = 'MentionHighlightOverlay';

export default MentionHighlightOverlay;
