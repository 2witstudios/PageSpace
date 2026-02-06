'use client';

import React, { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { usePageNavigation } from '@/hooks/usePageNavigation';

/**
 * Regex matching the markdown-typed mention format: @[Label](id:type)
 * Captures: [1] label, [2] id, [3] type (page|user)
 */
const MENTION_REGEX = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

interface MentionHighlightOverlayProps {
  /** Raw text value containing @[label](id:type) mentions */
  value: string;
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
 * pointer-events: none lets all clicks/input pass through to the textarea.
 */
export const MentionHighlightOverlay = forwardRef<
  HTMLDivElement,
  MentionHighlightOverlayProps
>(({ value, className }, ref) => {
  const { navigateToPage } = usePageNavigation();

  const renderFormattedText = (text: string): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // Reset regex state
    MENTION_REGEX.lastIndex = 0;

    while ((match = MENTION_REGEX.exec(text)) !== null) {
      const [fullMatch, label, id, type] = match;

      // Add preceding plain text
      if (match.index > lastIndex) {
        elements.push(
          <span key={`text-${lastIndex}`}>
            {text.slice(lastIndex, match.index)}
          </span>
        );
      }

      // Render the mention as a styled inline element
      if (type === 'page') {
        elements.push(
          <span
            key={`mention-${match.index}`}
            role="link"
            tabIndex={-1}
            className="font-semibold text-primary cursor-pointer hover:underline pointer-events-auto"
            onMouseDown={(e) => {
              // Use mousedown so the textarea doesn't lose focus from a full click
              e.preventDefault();
              e.stopPropagation();
              navigateToPage(id);
            }}
          >
            @{label}
          </span>
        );
      } else {
        elements.push(
          <span
            key={`mention-${match.index}`}
            className="font-semibold text-primary"
          >
            @{label}
          </span>
        );
      }

      lastIndex = match.index + fullMatch.length;
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
      {renderFormattedText(value)}
    </div>
  );
});
MentionHighlightOverlay.displayName = 'MentionHighlightOverlay';

export default MentionHighlightOverlay;
