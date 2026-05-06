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
  onAddReaction: (emoji: string) => void;
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
  onAddReaction,
  onQuoteReply,
  onEdit,
  onDelete,
  onReplyInThread,
  className,
}: MessageHoverToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasOverflow =
    (canQuoteReply && !!onQuoteReply) ||
    (canEdit && !!onEdit) ||
    (canDelete && !!onDelete);

  return (
    <div
      className={cn(
        'absolute -top-3 right-2 z-10',
        'flex items-center gap-0.5 p-0.5',
        'rounded-md border border-border bg-popover shadow-sm',
        'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100',
        'transition-opacity',
        pickerOpen && 'opacity-100',
        className,
      )}
    >
      {canReact && (
        <EmojiPickerPopover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onEmojiSelect={(emoji) => {
            onAddReaction(emoji);
            setPickerOpen(false);
          }}
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
      {canReplyInThread && onReplyInThread && (
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
            {canQuoteReply && onQuoteReply && (
              <DropdownMenuItem onClick={onQuoteReply}>
                <CornerUpLeft className="mr-2 h-4 w-4" /> Quote reply
              </DropdownMenuItem>
            )}
            {canEdit && onEdit && (
              <>
                {canQuoteReply && onQuoteReply && <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </DropdownMenuItem>
              </>
            )}
            {canDelete && onDelete && (
              <>
                <DropdownMenuSeparator />
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
