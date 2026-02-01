'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { EmojiPickerPopover } from '@/components/ui/emoji-picker';
import { Plus } from 'lucide-react';

export interface Reaction {
  id: string;
  emoji: string;
  userId: string;
  user: {
    id: string;
    name: string | null;
  };
}

export interface MessageReactionsProps {
  /** Reactions on this message */
  reactions: Reaction[];
  /** Current user ID */
  currentUserId: string;
  /** Called when adding a reaction */
  onAddReaction: (emoji: string) => void;
  /** Called when removing a reaction */
  onRemoveReaction: (emoji: string) => void;
  /** Whether the user can add reactions */
  canReact?: boolean;
  /** Additional class names */
  className?: string;
}

interface GroupedReaction {
  emoji: string;
  count: number;
  users: { id: string; name: string | null }[];
  hasReacted: boolean;
}

/**
 * MessageReactions - Display and manage reactions on a message
 *
 * Features:
 * - Grouped reaction chips with counts
 * - Hover tooltip showing who reacted
 * - Click to toggle own reaction
 * - Add reaction button with emoji picker
 */
export function MessageReactions({
  reactions,
  currentUserId,
  onAddReaction,
  onRemoveReaction,
  canReact = true,
  className,
}: MessageReactionsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  // Group reactions by emoji
  const groupedReactions = useMemo<GroupedReaction[]>(() => {
    const groups = new Map<string, GroupedReaction>();

    for (const reaction of reactions) {
      const existing = groups.get(reaction.emoji);
      if (existing) {
        existing.count++;
        existing.users.push(reaction.user);
        if (reaction.userId === currentUserId) {
          existing.hasReacted = true;
        }
      } else {
        groups.set(reaction.emoji, {
          emoji: reaction.emoji,
          count: 1,
          users: [reaction.user],
          hasReacted: reaction.userId === currentUserId,
        });
      }
    }

    // Sort by count descending, then by emoji
    return Array.from(groups.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.emoji.localeCompare(b.emoji);
    });
  }, [reactions, currentUserId]);

  // Handle clicking a reaction chip
  const handleReactionClick = (group: GroupedReaction) => {
    if (!canReact) return;

    if (group.hasReacted) {
      onRemoveReaction(group.emoji);
    } else {
      onAddReaction(group.emoji);
    }
  };

  // Handle selecting emoji from picker
  const handleEmojiSelect = (emoji: string) => {
    // Check if already reacted with this emoji
    const existing = groupedReactions.find((g) => g.emoji === emoji);
    if (existing?.hasReacted) {
      // Already reacted, remove it
      onRemoveReaction(emoji);
    } else {
      // Add new reaction
      onAddReaction(emoji);
    }
    setPickerOpen(false);
  };

  // Format user names for tooltip
  const formatUserNames = (users: { id: string; name: string | null }[]) => {
    const names = users
      .map((u) => (u.id === currentUserId ? 'You' : u.name || 'Unknown'))
      .slice(0, 10);

    if (users.length > 10) {
      names.push(`and ${users.length - 10} more`);
    }

    return names.join(', ');
  };

  if (groupedReactions.length === 0 && !canReact) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1 mt-1', className)}>
      {/* Reaction chips */}
      {groupedReactions.map((group) => (
        <Tooltip key={group.emoji}>
          <TooltipTrigger asChild>
            <button
              onClick={() => handleReactionClick(group)}
              disabled={!canReact}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs',
                'transition-all duration-150',
                'border',
                group.hasReacted
                  ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                  : 'bg-muted/50 border-border/50 text-muted-foreground hover:bg-muted',
                !canReact && 'cursor-default opacity-80'
              )}
            >
              <span className="text-sm">{group.emoji}</span>
              <span className="font-medium">{group.count}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-sm">{formatUserNames(group.users)}</p>
          </TooltipContent>
        </Tooltip>
      ))}

      {/* Add reaction button */}
      {canReact && (
        <EmojiPickerPopover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onEmojiSelect={handleEmojiSelect}
          side="top"
          align="start"
        >
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 w-6 p-0 rounded-full',
              'text-muted-foreground hover:text-foreground',
              'hover:bg-muted/50',
              'opacity-0 group-hover:opacity-100 transition-opacity',
              // Always show if there are reactions
              groupedReactions.length > 0 && 'opacity-100'
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="sr-only">Add reaction</span>
          </Button>
        </EmojiPickerPopover>
      )}
    </div>
  );
}

export default MessageReactions;
