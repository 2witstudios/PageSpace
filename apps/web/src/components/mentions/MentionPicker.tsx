'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { MentionSuggestion, MentionType } from '@/types/mentions';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

type TabType = 'all' | 'people' | 'pages' | 'groups';

const TAB_TYPES: Record<TabType, MentionType[]> = {
  all: ['page', 'user', 'everyone', 'role'],
  people: ['user'],
  pages: ['page'],
  groups: ['everyone', 'role'],
};

export interface MentionPickerProps {
  driveId: string;
  crossDrive?: boolean;
  allowedTypes?: MentionType[];
  onMentionSelect: (suggestion: MentionSuggestion) => void;
  className?: string;
}

export function MentionPicker({
  driveId,
  crossDrive = false,
  allowedTypes = ['page', 'user', 'everyone', 'role'],
  onMentionSelect,
  className,
}: MentionPickerProps) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(
    async (q: string, tab: TabType) => {
      setLoading(true);
      const types = TAB_TYPES[tab]
        .filter((t) => allowedTypes.includes(t))
        .join(',');
      const url = `/api/mentions/search?q=${encodeURIComponent(q)}&driveId=${encodeURIComponent(driveId)}&types=${types}${crossDrive ? '&crossDrive=true' : ''}`;
      try {
        const response = await fetchWithAuth(url);
        const data: MentionSuggestion[] = await response.json();
        setItems(data);
        setSelectedIndex(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [driveId, crossDrive, allowedTypes],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(query, activeTab);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, activeTab, fetchSuggestions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) onMentionSelect(item);
      }
    },
    [items, selectedIndex, onMentionSelect],
  );

  return (
    <div className={cn('w-80', className)} onKeyDown={handleKeyDown}>
      <div className="p-2 border-b border-border/50">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search mentions..."
          className="h-8 text-sm"
        />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabType)}
      >
        <TabsList className="w-full grid grid-cols-4 h-auto p-1 bg-muted/30">
          <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
          <TabsTrigger value="people" className="text-xs">People</TabsTrigger>
          <TabsTrigger value="pages" className="text-xs">Pages</TabsTrigger>
          <TabsTrigger value="groups" className="text-xs">Groups</TabsTrigger>
        </TabsList>
      </Tabs>

      <ScrollArea className="max-h-64">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
            <span className="animate-spin inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No results found</div>
        ) : (
          <ul role="listbox">
            {items.map((item, index) => {
              const isGroup = item.type === 'everyone' || item.type === 'role';
              return (
                <li
                  key={`${item.id}-${index}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={() => onMentionSelect(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    'px-3 py-2 cursor-pointer flex items-center gap-2',
                    'hover:bg-muted/50 transition-colors',
                    index === selectedIndex && 'bg-muted/50',
                  )}
                >
                  {isGroup && (
                    <span
                      data-testid="group-badge"
                      className="text-xs font-bold text-white bg-indigo-500 rounded px-1 py-0.5 shrink-0"
                    >
                      @
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-sm font-medium',
                      isGroup
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-foreground',
                    )}
                  >
                    {item.label}
                  </span>
                  {!isGroup && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {item.type}
                    </span>
                  )}
                  {item.description && (
                    <span className="text-xs text-muted-foreground truncate">
                      {item.description}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

export interface MentionPickerPopoverProps extends MentionPickerProps {
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function MentionPickerPopover({
  children,
  side = 'top',
  align = 'start',
  open,
  onOpenChange,
  onMentionSelect,
  ...pickerProps
}: MentionPickerPopoverProps) {
  const handleSelect = (suggestion: MentionSuggestion) => {
    onMentionSelect(suggestion);
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
        <MentionPicker {...pickerProps} onMentionSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}

export default MentionPicker;
