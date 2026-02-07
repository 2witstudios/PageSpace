'use client';

import React, { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import type { TrackedMention } from '@/hooks/useMentionTracker';

interface MentionHighlightOverlayProps {
  /** Display text (same as textarea value — no markdown IDs) */
  value: string;
  /** Tracked mention positions within the display text */
  mentions: TrackedMention[];
  /** Additional class names applied to the overlay container */
  className?: string;
}

/**
 * MentionHighlightOverlay renders text with @mentions as formatted bold links.
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
    trackedMentions: TrackedMention[]
  ): React.ReactNode[] => {
    if (trackedMentions.length === 0) {
      return [<span key="text-0">{text || '\u200B'}</span>];
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const mention of trackedMentions) {
      // Add preceding plain text
      if (mention.start > lastIndex) {
        elements.push(
          <span key={`text-${lastIndex}`}>
            {text.slice(lastIndex, mention.start)}
          </span>
        );
      }

      // Render the mention as a styled inline element
      const mentionText = text.slice(mention.start, mention.end);

      elements.push(
        <span
          key={`mention-${mention.start}`}
          className="font-semibold text-primary"
        >
          {mentionText}
        </span>
      );

      lastIndex = mention.end;
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
