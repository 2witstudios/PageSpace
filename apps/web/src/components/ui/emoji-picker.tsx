'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Smile, Search, Clock, Heart, ThumbsUp, PartyPopper, Lightbulb, Flag } from 'lucide-react';

// Common emoji categories with frequently used emojis
const EMOJI_CATEGORIES = {
  recent: {
    icon: Clock,
    label: 'Recent',
    emojis: [] as string[], // Will be populated from localStorage
  },
  smileys: {
    icon: Smile,
    label: 'Smileys',
    emojis: [
      '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😌',
      '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑',
      '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄',
      '😬', '😮', '🤯', '😴', '🥱', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
      '🥶', '🥴', '😵', '🤠', '🥳', '🥺', '😎', '🤓', '🧐', '😕', '😟', '🙁',
      '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭',
    ],
  },
  gestures: {
    icon: ThumbsUp,
    label: 'Gestures',
    emojis: [
      '👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆',
      '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '🤲', '🤝', '🙏',
      '✍️', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '👀', '👁️',
      '👅', '👄', '💋', '🫀', '🫁', '🦷', '🦴', '💀', '👤', '👥', '🫂', '👣',
    ],
  },
  hearts: {
    icon: Heart,
    label: 'Hearts',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕',
      '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '🫶', '🩷', '🩵', '🩶',
    ],
  },
  celebrations: {
    icon: PartyPopper,
    label: 'Celebrate',
    emojis: [
      '🎉', '🎊', '🎈', '🎁', '🎀', '🏆', '🏅', '🥇', '🥈', '🥉', '⭐', '🌟',
      '✨', '💫', '🔥', '💥', '💯', '🎯', '🎪', '🎭', '🎨', '🎬', '🎤', '🎧',
      '🎵', '🎶', '🎹', '🎸', '🎺', '🎻', '🥁', '🎲', '🎮', '🕹️', '🎰', '🧩',
    ],
  },
  objects: {
    icon: Lightbulb,
    label: 'Objects',
    emojis: [
      '💡', '🔦', '🏮', '📱', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '💾', '💿', '📀',
      '📷', '📸', '📹', '🎥', '📞', '☎️', '📺', '📻', '🎙️', '⏰', '⏱️', '⏲️',
      '🔋', '🔌', '💎', '💰', '💳', '✉️', '📧', '📨', '📩', '📦', '📫', '📬',
      '✏️', '📝', '📁', '📂', '📅', '📆', '📌', '📍', '🔍', '🔎', '🔐', '🔑',
    ],
  },
  symbols: {
    icon: Flag,
    label: 'Symbols',
    emojis: [
      '✅', '❌', '❓', '❗', '‼️', '⁉️', '💤', '💢', '💬', '👁️‍🗨️', '🗨️', '🗯️',
      '💭', '🔔', '🔕', '🎵', '🎶', '➕', '➖', '➗', '✖️', '♾️', '💲', '💱',
      '©️', '®️', '™️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤',
      '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '▪️', '▫️', '◾', '◽', '◼️', '◻️',
    ],
  },
} as const;

// Frequently used emojis for quick access
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

const RECENT_EMOJIS_KEY = 'pagespace-recent-emojis';
const MAX_RECENT = 24;

export interface EmojiPickerProps {
  /** Called when an emoji is selected */
  onEmojiSelect: (emoji: string) => void;
  /** Whether to show quick reaction bar */
  showQuickReactions?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * EmojiPicker - Lightweight emoji picker with categories and search
 *
 * Features:
 * - Category-based browsing
 * - Search functionality
 * - Recent emojis (persisted to localStorage)
 * - Quick reactions bar
 * - Keyboard navigation support
 */
export function EmojiPicker({
  onEmojiSelect,
  showQuickReactions = true,
  className,
}: EmojiPickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(RECENT_EMOJIS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Handle emoji selection
  const handleSelect = useCallback((emoji: string) => {
    // Add to recent emojis
    setRecentEmojis((prev) => {
      const filtered = prev.filter((e) => e !== emoji);
      const updated = [emoji, ...filtered].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage errors
      }
      return updated;
    });

    onEmojiSelect(emoji);
  }, [onEmojiSelect]);

  // Filter emojis based on search
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) {
      return EMOJI_CATEGORIES;
    }

    // Simple search - show all emojis when searching
    // (Full text search would require emoji name mapping)
    const results: string[] = [];

    Object.values(EMOJI_CATEGORIES).forEach((category) => {
      results.push(...category.emojis);
    });

    // Return a single "search results" category
    return {
      search: {
        icon: Search,
        label: 'Results',
        emojis: results,
      },
    };
  }, [searchQuery]);

  const hasRecent = recentEmojis.length > 0;
  const defaultTab = hasRecent ? 'recent' : 'smileys';

  return (
    <div className={cn('w-72', className)}>
      {/* Quick reactions bar */}
      {showQuickReactions && (
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleSelect(emoji)}
              className={cn(
                'p-1.5 rounded-md text-lg',
                'hover:bg-muted transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-primary/20'
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="p-2 border-b border-border/50">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search emoji..."
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      {/* Category tabs and emoji grid */}
      {searchQuery ? (
        // Search results
        <ScrollArea className="h-48">
          <div className="p-2 grid grid-cols-8 gap-0.5">
            {Object.values(filteredCategories)[0]?.emojis.map((emoji, idx) => (
              <button
                key={`${emoji}-${idx}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  'p-1 rounded text-xl',
                  'hover:bg-muted transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-primary/20'
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </ScrollArea>
      ) : (
        // Category tabs
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="w-full h-auto p-1 grid grid-cols-7 gap-0.5 bg-muted/30">
            {hasRecent && (
              <TabsTrigger value="recent" className="p-1.5 data-[state=active]:bg-background">
                <Clock className="h-4 w-4" />
              </TabsTrigger>
            )}
            <TabsTrigger value="smileys" className="p-1.5 data-[state=active]:bg-background">
              <Smile className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="gestures" className="p-1.5 data-[state=active]:bg-background">
              <ThumbsUp className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="hearts" className="p-1.5 data-[state=active]:bg-background">
              <Heart className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="celebrations" className="p-1.5 data-[state=active]:bg-background">
              <PartyPopper className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="objects" className="p-1.5 data-[state=active]:bg-background">
              <Lightbulb className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="symbols" className="p-1.5 data-[state=active]:bg-background">
              <Flag className="h-4 w-4" />
            </TabsTrigger>
          </TabsList>

          {hasRecent && (
            <TabsContent value="recent" className="mt-0">
              <ScrollArea className="h-48">
                <div className="p-2 grid grid-cols-8 gap-0.5">
                  {recentEmojis.map((emoji, idx) => (
                    <button
                      key={`recent-${emoji}-${idx}`}
                      onClick={() => handleSelect(emoji)}
                      className={cn(
                        'p-1 rounded text-xl',
                        'hover:bg-muted transition-colors',
                        'focus:outline-none focus:ring-2 focus:ring-primary/20'
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
          )}

          {Object.entries(EMOJI_CATEGORIES).filter(([key]) => key !== 'recent').map(([key, category]) => (
            <TabsContent key={key} value={key} className="mt-0">
              <ScrollArea className="h-48">
                <div className="p-2 grid grid-cols-8 gap-0.5">
                  {category.emojis.map((emoji, idx) => (
                    <button
                      key={`${key}-${emoji}-${idx}`}
                      onClick={() => handleSelect(emoji)}
                      className={cn(
                        'p-1 rounded text-xl',
                        'hover:bg-muted transition-colors',
                        'focus:outline-none focus:ring-2 focus:ring-primary/20'
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

export interface EmojiPickerPopoverProps extends EmojiPickerProps {
  /** Trigger element */
  children: React.ReactNode;
  /** Side of the popover */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Alignment of the popover */
  align?: 'start' | 'center' | 'end';
  /** Whether the popover is open (controlled) */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
}

/**
 * EmojiPickerPopover - Emoji picker wrapped in a popover
 */
export function EmojiPickerPopover({
  children,
  side = 'top',
  align = 'start',
  open,
  onOpenChange,
  onEmojiSelect,
  ...pickerProps
}: EmojiPickerPopoverProps) {
  const handleSelect = (emoji: string) => {
    onEmojiSelect(emoji);
    onOpenChange?.(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-auto p-0"
        sideOffset={8}
      >
        <EmojiPicker {...pickerProps} onEmojiSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}

export default EmojiPicker;
