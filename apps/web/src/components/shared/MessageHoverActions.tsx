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
  SmilePlus,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';

export interface MessageHoverActionsProps {
  canReact?: boolean;
  canReply?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  onAddReaction?: (emoji: string) => void;
  onReplyInThread?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Used for stable test ids on individual buttons */
  messageId?: string;
  className?: string;
}

const buttonClass =
  'h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:bg-muted';

export function MessageHoverActions({
  canReact = false,
  canReply = false,
  canEdit = false,
  canDelete = false,
  onAddReaction,
  onReplyInThread,
  onEdit,
  onDelete,
  messageId,
  className,
}: MessageHoverActionsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const showReact = canReact && !!onAddReaction;
  const showReply = canReply && !!onReplyInThread;
  const showEdit = canEdit && !!onEdit;
  const showDelete = canDelete && !!onDelete;
  const showMore = showEdit || showDelete;

  if (!showReact && !showReply && !showMore) return null;

  return (
    <div
      className={cn(
        'absolute -top-3 right-3 z-10 flex items-center rounded-md border bg-popover shadow-sm overflow-hidden',
        'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity',
        className,
      )}
      role="toolbar"
      aria-label="Message actions"
    >
      {showReact && (
        <EmojiPickerPopover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onEmojiSelect={(emoji) => {
            onAddReaction?.(emoji);
            setPickerOpen(false);
          }}
          side="top"
          align="end"
        >
          <button
            type="button"
            aria-label="Add reaction"
            title="Add reaction"
            data-testid={messageId ? `add-reaction-${messageId}` : undefined}
            className={buttonClass}
          >
            <SmilePlus size={14} aria-hidden />
          </button>
        </EmojiPickerPopover>
      )}
      {showReply && (
        <button
          type="button"
          aria-label="Reply in thread"
          title="Reply in thread"
          data-testid={messageId ? `reply-in-thread-${messageId}` : undefined}
          onClick={onReplyInThread}
          className={buttonClass}
        >
          <MessageSquareReply size={14} aria-hidden />
        </button>
      )}
      {showMore && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More message options"
              title="More"
              data-testid={messageId ? `message-more-${messageId}` : undefined}
              className={buttonClass}
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
            {showEdit && showDelete && <DropdownMenuSeparator />}
            {showDelete && (
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export default MessageHoverActions;
