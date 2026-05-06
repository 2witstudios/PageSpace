'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmojiPickerPopover } from '@/components/ui/emoji-picker';
import type { Reaction } from '@/components/shared/MessageReactions';
import {
  CornerUpLeft,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Smile,
  Trash2,
} from 'lucide-react';

export interface MessageHoverToolbarProps {
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReplyInThread: boolean;
  canQuoteReply: boolean;
  /** Existing reactions on the message — used to make picker selection toggle. */
  reactions?: Reaction[];
  /** Current user id — used together with `reactions` for toggle behavior. */
  currentUserId?: string;
  onAddReaction: (emoji: string) => void;
  onRemoveReaction?: (emoji: string) => void;
  onQuoteReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onReplyInThread?: () => void;
  className?: string;
}

export function MessageHoverToolbar({
  canReact,
  canEdit,
  canDelete,
  canReplyInThread,
  canQuoteReply,
  reactions,
  currentUserId,
  onAddReaction,
  onRemoveReaction,
  onQuoteReply,
  onEdit,
  onDelete,
  onReplyInThread,
  className,
}: MessageHoverToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const showQuote = canQuoteReply && !!onQuoteReply;
  const showEdit = canEdit && !!onEdit;
  const showDelete = canDelete && !!onDelete;
  const hasOverflow = showEdit || showDelete;
  const showReplyInThread = canReplyInThread && !!onReplyInThread;
  const hasAny = canReact || showQuote || showReplyInThread || hasOverflow;
  if (!hasAny) return null;

  const handleEmojiSelect = (emoji: string) => {
    const alreadyReacted =
      !!currentUserId &&
      !!reactions?.some((r) => r.emoji === emoji && r.userId === currentUserId);
    if (alreadyReacted && onRemoveReaction) {
      onRemoveReaction(emoji);
    } else {
      onAddReaction(emoji);
    }
    setPickerOpen(false);
  };

  return (
    <div
      className={cn(
        'absolute -top-3 right-2 z-10',
        'flex items-center gap-0.5 p-0.5',
        'rounded-md border border-border bg-popover shadow-sm',
        // Hover devices: hidden by default, shown on hover/focus or when picker is open.
        // Touch / no-hover devices: always visible so message actions remain reachable.
        'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100',
        '[@media(hover:none)]:opacity-100',
        'transition-opacity',
        pickerOpen && 'opacity-100',
        className,
      )}
    >
      {canReact && (
        <EmojiPickerPopover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onEmojiSelect={handleEmojiSelect}
          side="top"
          align="end"
        >
          <button
            type="button"
            aria-label="Add reaction"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <Smile size={14} aria-hidden />
          </button>
        </EmojiPickerPopover>
      )}
      {showQuote && (
        <button
          type="button"
          aria-label="Quote reply"
          onClick={onQuoteReply}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <CornerUpLeft size={14} aria-hidden />
        </button>
      )}
      {showReplyInThread && (
        <button
          type="button"
          aria-label="Reply in thread"
          onClick={onReplyInThread}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <MessageSquareReply size={14} aria-hidden />
        </button>
      )}
      {hasOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Message options"
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showEdit && (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </DropdownMenuItem>
            )}
            {showDelete && (
              <>
                {showEdit && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export default MessageHoverToolbar;
