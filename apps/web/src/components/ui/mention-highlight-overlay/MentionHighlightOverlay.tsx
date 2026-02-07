'use client';

import React, { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import type { MentionData } from '@/lib/mentions/mentionDisplayUtils';

interface MentionHighlightOverlayProps {
  /** Display value (IDs already stripped — contains @Label, not @[Label](id:type)) */
  value: string;
  /** Ordered mention metadata produced by useMentionDisplay */
  mentions: MentionData[];
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
 * Because the textarea now holds the *display* value (without IDs),
 * the overlay text matches character-for-character — no invisible gaps.
 *
 * pointer-events: none lets all clicks/input pass through to the textarea.
 */
export const MentionHighlightOverlay = forwardRef<
  HTMLDivElement,
  MentionHighlightOverlayProps
>(({ value, mentions, className }, ref) => {
  const { navigateToPage } = usePageNavigation();

  const renderFormattedText = (text: string): React.ReactNode[] => {
    if (mentions.length === 0) {
      return [<span key="plain">{text || '\u200B'}</span>];
    }

    const elements: React.ReactNode[] = [];
    let remaining = text;
    let offset = 0;

    // Walk through mentions in order, finding each @Label in the text.
    for (const mention of mentions) {
      const pattern = `@${mention.label}`;
      const idx = remaining.indexOf(pattern);
      if (idx === -1) continue;

      // Plain text before the mention
      if (idx > 0) {
        elements.push(
          <span key={`text-${offset}`}>
            {remaining.substring(0, idx)}
          </span>
        );
      }

      // The mention itself
      if (mention.type === 'page') {
        elements.push(
          <span
            key={`mention-${offset}-${mention.id}`}
            role="link"
            tabIndex={-1}
            className="font-semibold text-primary cursor-pointer hover:underline pointer-events-auto"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigateToPage(mention.id);
            }}
          >
            {pattern}
          </span>
        );
      } else {
        elements.push(
          <span
            key={`mention-${offset}-${mention.id}`}
            className="font-semibold text-primary"
          >
            {pattern}
          </span>
        );
      }

      offset += idx + pattern.length;
      remaining = remaining.substring(idx + pattern.length);
    }

    // Trailing plain text
    if (remaining.length > 0) {
      elements.push(
        <span key={`text-${offset}`}>{remaining}</span>
      );
    }

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
      {renderFormattedText(value)}
    </div>
  );
});
MentionHighlightOverlay.displayName = 'MentionHighlightOverlay';

export default MentionHighlightOverlay;
