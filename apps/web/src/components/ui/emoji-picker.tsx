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
      '😬', '🤯', '😴', '🥱', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
      '🥶', '🥴', '😵', '🤠', '🥳', '🥺', '😎', '🤓', '🧐', '😕', '😟', '🙁',
      '😮', '😯', '😲', '😳', '😦', '😧', '😨', '😰', '😥', '😢', '😭',
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

// Searchable keywords for each emoji. Used to filter results in the search input.
const EMOJI_KEYWORDS: Record<string, string[]> = {
  // Smileys
  '😀': ['grinning', 'smile', 'happy', 'face'],
  '😃': ['smiley', 'smile', 'happy', 'joy', 'face'],
  '😄': ['smile', 'happy', 'joy', 'laugh', 'face'],
  '😁': ['grin', 'beaming', 'smile', 'happy', 'face'],
  '😅': ['sweat', 'smile', 'nervous', 'laugh', 'face'],
  '😂': ['joy', 'laugh', 'tears', 'lol', 'crying', 'face'],
  '🤣': ['rofl', 'laugh', 'rolling', 'lol', 'face'],
  '😊': ['blush', 'smile', 'happy', 'face'],
  '😇': ['angel', 'halo', 'innocent', 'face'],
  '🙂': ['slight', 'smile', 'face'],
  '😉': ['wink', 'face'],
  '😌': ['relieved', 'smile', 'face'],
  '😍': ['heart', 'eyes', 'love', 'in', 'face'],
  '🥰': ['hearts', 'smiling', 'love', 'face'],
  '😘': ['kiss', 'blow', 'face'],
  '😗': ['kissing', 'face'],
  '😙': ['kissing', 'smile', 'face'],
  '😚': ['kissing', 'closed', 'eyes', 'face'],
  '😋': ['yum', 'savoring', 'tongue', 'food', 'face'],
  '😛': ['tongue', 'stuck', 'out', 'face'],
  '😜': ['winking', 'tongue', 'face'],
  '🤪': ['zany', 'crazy', 'silly', 'face'],
  '😝': ['squinting', 'tongue', 'face'],
  '🤑': ['money', 'mouth', 'face'],
  '🤗': ['hug', 'hugging', 'face'],
  '🤭': ['hand', 'over', 'mouth', 'face'],
  '🤫': ['shush', 'quiet', 'shh', 'face'],
  '🤔': ['thinking', 'think', 'hmm', 'face'],
  '🤐': ['zipper', 'mouth', 'quiet', 'face'],
  '🤨': ['raised', 'eyebrow', 'face'],
  '😐': ['neutral', 'face'],
  '😑': ['expressionless', 'face'],
  '😶': ['no', 'mouth', 'face'],
  '😏': ['smirk', 'smirking', 'face'],
  '😒': ['unamused', 'face'],
  '🙄': ['eye', 'roll', 'eyeroll', 'rolling', 'face'],
  '😬': ['grimace', 'grimacing', 'face'],
  '🤯': ['mind', 'blown', 'exploding', 'head', 'face'],
  '😴': ['sleep', 'sleeping', 'zzz', 'face'],
  '🥱': ['yawning', 'yawn', 'tired', 'face'],
  '😷': ['mask', 'sick', 'medical', 'face'],
  '🤒': ['thermometer', 'sick', 'fever', 'ill', 'face'],
  '🤕': ['bandage', 'hurt', 'injured', 'face'],
  '🤢': ['nauseated', 'sick', 'green', 'face'],
  '🤮': ['vomiting', 'puke', 'sick', 'face'],
  '🤧': ['sneezing', 'sneeze', 'sick', 'face'],
  '🥵': ['hot', 'sweat', 'heat', 'face'],
  '🥶': ['cold', 'freezing', 'face'],
  '🥴': ['woozy', 'drunk', 'face'],
  '😵': ['dizzy', 'dead', 'face'],
  '🤠': ['cowboy', 'hat', 'face'],
  '🥳': ['partying', 'party', 'face'],
  '🥺': ['pleading', 'puppy', 'face'],
  '😎': ['cool', 'sunglasses', 'face'],
  '🤓': ['nerd', 'glasses', 'face'],
  '🧐': ['monocle', 'fancy', 'face'],
  '😕': ['confused', 'face'],
  '😟': ['worried', 'face'],
  '🙁': ['frown', 'frowning', 'sad', 'face'],
  '😮': ['open', 'mouth', 'surprised', 'wow', 'face'],
  '😯': ['hushed', 'face'],
  '😲': ['astonished', 'shocked', 'face'],
  '😳': ['flushed', 'embarrassed', 'face'],
  '😦': ['frowning', 'open', 'mouth', 'face'],
  '😧': ['anguished', 'face'],
  '😨': ['fearful', 'scared', 'face'],
  '😰': ['anxious', 'sweat', 'face'],
  '😥': ['sad', 'disappointed', 'face'],
  '😢': ['cry', 'crying', 'sad', 'tear', 'face'],
  '😭': ['sobbing', 'crying', 'loud', 'sad', 'face'],

  // Gestures
  '👍': ['thumbs', 'up', 'like', 'yes', 'good', 'approve'],
  '👎': ['thumbs', 'down', 'dislike', 'no', 'bad'],
  '👌': ['ok', 'okay', 'perfect', 'hand'],
  '🤌': ['pinched', 'fingers', 'italian', 'hand'],
  '✌️': ['peace', 'victory', 'hand'],
  '🤞': ['fingers', 'crossed', 'hope', 'luck', 'hand'],
  '🤟': ['love', 'you', 'hand'],
  '🤘': ['rock', 'horns', 'hand', 'metal'],
  '🤙': ['call', 'me', 'shaka', 'hand'],
  '👈': ['point', 'left', 'finger', 'hand'],
  '👉': ['point', 'right', 'finger', 'hand'],
  '👆': ['point', 'up', 'finger', 'hand'],
  '👇': ['point', 'down', 'finger', 'hand'],
  '☝️': ['index', 'point', 'up', 'finger', 'hand'],
  '👋': ['wave', 'waving', 'hi', 'hello', 'bye', 'hand'],
  '🤚': ['raised', 'back', 'hand', 'stop'],
  '🖐️': ['hand', 'splayed', 'five'],
  '✋': ['stop', 'raised', 'hand', 'high', 'five'],
  '🖖': ['vulcan', 'spock', 'hand', 'salute'],
  '👏': ['clap', 'clapping', 'applause', 'hand'],
  '🙌': ['raised', 'hands', 'praise', 'celebrate'],
  '🤲': ['palms', 'together', 'hands'],
  '🤝': ['handshake', 'shake', 'hands', 'deal'],
  '🙏': ['pray', 'prayer', 'please', 'thanks', 'hands'],
  '✍️': ['writing', 'hand', 'write'],
  '💪': ['muscle', 'strong', 'flex', 'arm', 'biceps'],
  '🦾': ['mechanical', 'arm', 'prosthetic'],
  '🦿': ['mechanical', 'leg', 'prosthetic'],
  '🦵': ['leg'],
  '🦶': ['foot'],
  '👂': ['ear', 'hear', 'listen'],
  '🦻': ['ear', 'hearing', 'aid'],
  '👃': ['nose', 'smell'],
  '🧠': ['brain', 'mind', 'think'],
  '👀': ['eyes', 'looking', 'look', 'watching', 'see'],
  '👁️': ['eye', 'see', 'look'],
  '👅': ['tongue'],
  '👄': ['mouth', 'lips'],
  '💋': ['kiss', 'lipstick', 'mark'],
  '🫀': ['heart', 'anatomical', 'organ'],
  '🫁': ['lungs', 'breath'],
  '🦷': ['tooth', 'teeth'],
  '🦴': ['bone'],
  '💀': ['skull', 'death', 'dead'],
  '👤': ['person', 'silhouette', 'user'],
  '👥': ['people', 'silhouettes', 'users'],
  '🫂': ['hug', 'hugging', 'people'],
  '👣': ['footprints', 'feet'],

  // Hearts
  '❤️': ['red', 'heart', 'love'],
  '🧡': ['orange', 'heart', 'love'],
  '💛': ['yellow', 'heart', 'love'],
  '💚': ['green', 'heart', 'love'],
  '💙': ['blue', 'heart', 'love'],
  '💜': ['purple', 'heart', 'love'],
  '🖤': ['black', 'heart', 'love'],
  '🤍': ['white', 'heart', 'love'],
  '🤎': ['brown', 'heart', 'love'],
  '💔': ['broken', 'heart', 'breakup'],
  '❣️': ['heart', 'exclamation'],
  '💕': ['two', 'hearts', 'love'],
  '💞': ['revolving', 'hearts', 'love'],
  '💓': ['beating', 'heart', 'love'],
  '💗': ['growing', 'heart', 'love'],
  '💖': ['sparkling', 'heart', 'love'],
  '💘': ['heart', 'arrow', 'cupid', 'love'],
  '💝': ['heart', 'ribbon', 'gift', 'love'],
  '💟': ['heart', 'decoration'],
  '♥️': ['heart', 'suit', 'love'],
  '🫶': ['heart', 'hands', 'love'],
  '🩷': ['pink', 'heart', 'love'],
  '🩵': ['light', 'blue', 'heart', 'love'],
  '🩶': ['grey', 'gray', 'heart', 'love'],

  // Celebrations
  '🎉': ['party', 'popper', 'celebration', 'tada', 'celebrate'],
  '🎊': ['confetti', 'ball', 'celebration', 'celebrate'],
  '🎈': ['balloon', 'party'],
  '🎁': ['gift', 'present', 'box'],
  '🎀': ['ribbon', 'bow'],
  '🏆': ['trophy', 'win', 'winner', 'award'],
  '🏅': ['medal', 'award'],
  '🥇': ['first', 'gold', 'medal', 'award'],
  '🥈': ['second', 'silver', 'medal', 'award'],
  '🥉': ['third', 'bronze', 'medal', 'award'],
  '⭐': ['star'],
  '🌟': ['glowing', 'star', 'sparkle'],
  '✨': ['sparkles', 'sparkle', 'stars'],
  '💫': ['dizzy', 'swirl', 'star'],
  '🔥': ['fire', 'hot', 'lit', 'flame'],
  '💥': ['collision', 'boom', 'explosion'],
  '💯': ['hundred', 'percent', 'perfect', '100'],
  '🎯': ['target', 'dart', 'bullseye'],
  '🎪': ['circus', 'tent'],
  '🎭': ['theater', 'masks', 'performing', 'arts'],
  '🎨': ['art', 'palette', 'paint'],
  '🎬': ['clapper', 'movie', 'film'],
  '🎤': ['microphone', 'mic', 'sing', 'karaoke'],
  '🎧': ['headphones', 'music', 'audio'],
  '🎵': ['musical', 'note', 'music'],
  '🎶': ['musical', 'notes', 'music'],
  '🎹': ['keyboard', 'piano', 'music'],
  '🎸': ['guitar', 'music'],
  '🎺': ['trumpet', 'music'],
  '🎻': ['violin', 'music'],
  '🥁': ['drum', 'music'],
  '🎲': ['dice', 'game'],
  '🎮': ['video', 'game', 'controller'],
  '🕹️': ['joystick', 'game'],
  '🎰': ['slot', 'machine', 'gambling'],
  '🧩': ['puzzle', 'piece'],

  // Objects
  '💡': ['light', 'bulb', 'idea'],
  '🔦': ['flashlight', 'torch'],
  '🏮': ['lantern', 'lamp'],
  '📱': ['phone', 'mobile', 'cell'],
  '💻': ['laptop', 'computer'],
  '🖥️': ['desktop', 'computer'],
  '🖨️': ['printer'],
  '⌨️': ['keyboard'],
  '🖱️': ['computer', 'mouse'],
  '💾': ['floppy', 'disk', 'save'],
  '💿': ['cd', 'disc', 'optical'],
  '📀': ['dvd', 'disc'],
  '📷': ['camera', 'photo'],
  '📸': ['camera', 'flash', 'photo'],
  '📹': ['video', 'camera'],
  '🎥': ['movie', 'camera', 'film'],
  '📞': ['phone', 'telephone', 'call'],
  '☎️': ['telephone', 'phone'],
  '📺': ['tv', 'television'],
  '📻': ['radio'],
  '🎙️': ['microphone', 'studio', 'mic'],
  '⏰': ['alarm', 'clock'],
  '⏱️': ['stopwatch', 'timer'],
  '⏲️': ['timer', 'clock'],
  '🔋': ['battery'],
  '🔌': ['plug', 'electric'],
  '💎': ['gem', 'diamond', 'jewel'],
  '💰': ['money', 'bag', 'cash'],
  '💳': ['credit', 'card'],
  '✉️': ['envelope', 'mail'],
  '📧': ['email', 'mail'],
  '📨': ['incoming', 'envelope', 'mail'],
  '📩': ['envelope', 'arrow', 'mail'],
  '📦': ['package', 'box', 'shipping'],
  '📫': ['mailbox', 'closed', 'flag'],
  '📬': ['mailbox', 'open', 'flag'],
  '✏️': ['pencil', 'edit', 'write'],
  '📝': ['memo', 'note', 'pencil'],
  '📁': ['folder', 'file'],
  '📂': ['open', 'folder', 'file'],
  '📅': ['calendar', 'date'],
  '📆': ['tear', 'off', 'calendar', 'date'],
  '📌': ['pushpin', 'pin'],
  '📍': ['round', 'pin', 'location'],
  '🔍': ['magnifying', 'glass', 'search', 'find'],
  '🔎': ['magnifying', 'glass', 'search', 'find'],
  '🔐': ['lock', 'key', 'secure'],
  '🔑': ['key', 'unlock'],

  // Symbols
  '✅': ['check', 'mark', 'yes', 'done', 'tick'],
  '❌': ['cross', 'mark', 'no', 'x', 'wrong'],
  '❓': ['question', 'mark'],
  '❗': ['exclamation', 'mark'],
  '‼️': ['double', 'exclamation', 'mark'],
  '⁉️': ['exclamation', 'question', 'mark'],
  '💤': ['sleep', 'zzz'],
  '💢': ['anger', 'angry', 'mad'],
  '💬': ['speech', 'chat', 'talk', 'bubble', 'message'],
  '👁️‍🗨️': ['eye', 'speech', 'bubble'],
  '🗨️': ['left', 'speech', 'bubble'],
  '🗯️': ['right', 'anger', 'bubble'],
  '💭': ['thought', 'bubble'],
  '🔔': ['bell', 'notification'],
  '🔕': ['bell', 'off', 'mute', 'silent'],
  '➕': ['plus', 'add'],
  '➖': ['minus', 'subtract'],
  '➗': ['divide', 'division'],
  '✖️': ['multiply', 'multiplication', 'x'],
  '♾️': ['infinity'],
  '💲': ['dollar', 'money'],
  '💱': ['currency', 'exchange'],
  '©️': ['copyright'],
  '®️': ['registered'],
  '™️': ['trademark'],
  '🔴': ['red', 'circle'],
  '🟠': ['orange', 'circle'],
  '🟡': ['yellow', 'circle'],
  '🟢': ['green', 'circle'],
  '🔵': ['blue', 'circle'],
  '🟣': ['purple', 'circle'],
  '⚫': ['black', 'circle'],
  '⚪': ['white', 'circle'],
  '🟤': ['brown', 'circle'],
  '🔺': ['red', 'triangle', 'up'],
  '🔻': ['red', 'triangle', 'down'],
  '🔸': ['orange', 'diamond', 'small'],
  '🔹': ['blue', 'diamond', 'small'],
  '🔶': ['orange', 'diamond', 'large'],
  '🔷': ['blue', 'diamond', 'large'],
  '▪️': ['black', 'square', 'small'],
  '▫️': ['white', 'square', 'small'],
  '◾': ['black', 'square', 'medium'],
  '◽': ['white', 'square', 'medium'],
  '◼️': ['black', 'square'],
  '◻️': ['white', 'square'],
};

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
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return EMOJI_CATEGORIES;
    }

    const seen = new Set<string>();
    const results: string[] = [];

    Object.values(EMOJI_CATEGORIES).forEach((category) => {
      category.emojis.forEach((emoji) => {
        if (seen.has(emoji)) return;
        const keywords = EMOJI_KEYWORDS[emoji];
        if (keywords && keywords.some((kw) => kw.includes(query))) {
          seen.add(emoji);
          results.push(emoji);
        }
      });
    });

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
          {Object.values(filteredCategories)[0]?.emojis.length === 0 ? (
            <div className="flex h-48 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              No emoji found for &ldquo;{searchQuery}&rdquo;
            </div>
          ) : (
          <div className="p-2 grid grid-cols-8 gap-0.5">
            {Object.values(filteredCategories)[0]?.emojis.map((emoji: string, idx: number) => (
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
          )}
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
