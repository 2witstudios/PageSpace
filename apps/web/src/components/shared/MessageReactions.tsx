'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

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
  onRemoveReaction: (emoji: string) => void;
  onAddReaction: (emoji: string) => void;
  canReact?: boolean;
  className?: string;
}

interface GroupedReaction {
  emoji: string;
  count: number;
  users: { id: string; name: string | null }[];
  hasReacted: boolean;
}

interface ReactionPillProps {
  group: GroupedReaction;
  currentUserId: string;
  canReact: boolean;
  onReactionClick: (group: GroupedReaction) => void;
}

function ReactionPill({
  group,
  currentUserId,
  canReact,
  onReactionClick,
}: ReactionPillProps) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prevent synthetic click from firing after a long press on mobile
  const suppressNextClick = useRef(false);

  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  const scheduleOpen = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), 300);
  };

  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const onTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      suppressNextClick.current = true;
      setOpen(true);
    }, 500);
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    if (suppressNextClick.current) {
      // Prevent the synthetic click that mobile browsers fire after touchend
      e.preventDefault();
      suppressNextClick.current = false;
    }
  };

  const onTouchMove = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleClick = () => {
    onReactionClick(group);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={handleClick}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchMove={onTouchMove}
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
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-auto min-w-[120px] max-w-[200px] p-3 space-y-2"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-lg leading-none">{group.emoji}</span>
          <span className="text-foreground">
            {group.count} {group.count === 1 ? 'reaction' : 'reactions'}
          </span>
        </div>
        <div className="border-t pt-2 space-y-1">
          {group.users.slice(0, 10).map((u) => (
            <div key={u.id} className="text-sm text-muted-foreground">
              {u.id === currentUserId ? 'You' : (u.name ?? 'Unknown')}
            </div>
          ))}
          {group.users.length > 10 && (
            <div className="text-xs text-muted-foreground">
              and {group.users.length - 10} more
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MessageReactions({
  reactions,
  currentUserId,
  onRemoveReaction,
  onAddReaction,
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

  if (groupedReactions.length === 0) {
    return null;
  }

  const handleReactionClick = (group: GroupedReaction) => {
    if (!canReact) return;
    if (group.hasReacted) {
      onRemoveReaction(group.emoji);
    } else {
      onAddReaction(group.emoji);
    }
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1 mt-1', className)}>
      {groupedReactions.map((group) => (
        <ReactionPill
          key={group.emoji}
          group={group}
          currentUserId={currentUserId}
          canReact={canReact}
          onReactionClick={handleReactionClick}
        />
      ))}
    </div>
  );
}

export default MessageReactions;
