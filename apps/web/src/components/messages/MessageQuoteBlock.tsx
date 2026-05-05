'use client';

import React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import MessagePartRenderer from './MessagePartRenderer';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';

interface MessageQuoteBlockProps {
  quoted: QuotedMessageSnapshot | null | undefined;
  onJumpToOriginal?: (messageId: string) => void;
  className?: string;
}

function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.charAt(0).toUpperCase();
}

const MessageQuoteBlock: React.FC<MessageQuoteBlockProps> = ({
  quoted,
  onJumpToOriginal,
  className,
}) => {
  const tombstone = !quoted || !quoted.isActive;

  if (tombstone) {
    return (
      <div
        className={cn(
          'border-l-2 border-muted pl-3 py-1 mb-1 text-xs text-muted-foreground italic',
          className,
        )}
        data-testid="message-quote-tombstone"
      >
        Original message deleted
      </div>
    );
  }

  const handleClick = () => {
    if (onJumpToOriginal) onJumpToOriginal(quoted.id);
  };

  const isClickable = Boolean(onJumpToOriginal);
  const createdAt = quoted.createdAt instanceof Date
    ? quoted.createdAt
    : new Date(quoted.createdAt);

  return (
    <div
      className={cn(
        'border-l-2 border-primary/40 pl-3 py-1 mb-1 text-xs',
        isClickable && 'cursor-pointer hover:bg-muted/30 rounded-r transition-colors',
        className,
      )}
      data-testid="message-quote-block"
      onClick={isClickable ? handleClick : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); } : undefined}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <Avatar className="h-4 w-4">
          {quoted.authorImage ? (
            <AvatarImage src={quoted.authorImage} alt={quoted.authorName ?? ''} />
          ) : null}
          <AvatarFallback className="text-[8px]">
            {getInitials(quoted.authorName)}
          </AvatarFallback>
        </Avatar>
        <span className="font-medium text-foreground">
          {quoted.authorName ?? 'Unknown'}
        </span>
        <span className="text-muted-foreground">
          {formatDistanceToNow(createdAt, { addSuffix: true })}
        </span>
      </div>
      <div className="text-muted-foreground line-clamp-1">
        <MessagePartRenderer
          part={{ type: 'text', text: quoted.contentSnippet }}
          index={0}
          context="message"
        />
      </div>
    </div>
  );
};

export default MessageQuoteBlock;
