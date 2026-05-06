'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';

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
  reactions: Reaction[];
  currentUserId: string;
  onAddReaction: (emoji: string) => void;
  onRemoveReaction: (emoji: string) => void;
  /** Whether the current user is allowed to toggle their own reactions */
  canReact?: boolean;
  className?: string;
}

interface GroupedReaction {
  emoji: string;
  count: number;
  users: { id: string; name: string | null }[];
  hasReacted: boolean;
}

export function MessageReactions({
  reactions,
  currentUserId,
  onAddReaction,
  onRemoveReaction,
  canReact = true,
  className,
}: MessageReactionsProps) {
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

    return Array.from(groups.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.emoji.localeCompare(b.emoji);
    });
  }, [reactions, currentUserId]);

  const handleReactionClick = (group: GroupedReaction) => {
    if (!canReact) return;
    if (group.hasReacted) {
      onRemoveReaction(group.emoji);
    } else {
      onAddReaction(group.emoji);
    }
  };

  const formatUserNames = (users: { id: string; name: string | null }[]) => {
    const names = users
      .map((u) => (u.id === currentUserId ? 'You' : u.name || 'Unknown'))
      .slice(0, 10);

    if (users.length > 10) {
      names.push(`and ${users.length - 10} more`);
    }

    return names.join(', ');
  };

  if (groupedReactions.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-1 mt-1', className)}>
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
                !canReact && 'cursor-default opacity-80',
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
    </div>
  );
}

export default MessageReactions;
