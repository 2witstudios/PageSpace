'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { MentionPickerPanel } from '@/components/mentions/MentionPicker';
import type { MentionSuggestion, PageMentionData } from '@/types/mentions';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDriveStore } from '@/hooks/useDrive';
import { cn } from '@/lib/utils';
import { FileText, X, ChevronsUpDown } from 'lucide-react';

export interface EntryPageSelection {
  id: string;
  title: string;
  driveId: string | null;
}

interface EntryPagePickerProps {
  /**
   * Drive commands: search scoped to this drive. Personal commands: omit for
   * a cross-drive search (the driveId-less fetch path the spec calls out —
   * MentionPicker's own fetch always embeds driveId, so this component owns
   * the fetch and reuses only the panel).
   */
  driveId?: string;
  value: EntryPageSelection | null;
  onChange: (page: EntryPageSelection | null) => void;
  invalid?: boolean;
  describedBy?: string;
}

export function EntryPagePicker({
  driveId,
  value,
  onChange,
  invalid,
  describedBy,
}: EntryPagePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drives = useDriveStore((state) => state.drives);

  const crossDrive = !driveId;

  const fetchSuggestions = useCallback(
    async (q: string) => {
      setLoading(true);
      const base = driveId
        ? `/api/mentions/search?q=${encodeURIComponent(q)}&driveId=${encodeURIComponent(driveId)}&types=page`
        : `/api/mentions/search?q=${encodeURIComponent(q)}&types=page`;
      const url = crossDrive ? `${base}&crossDrive=true` : base;
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
    [driveId, crossDrive]
  );

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(query);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, fetchSuggestions]);

  const handleSelect = (suggestion: MentionSuggestion) => {
    const pageData =
      suggestion.type === 'page' ? (suggestion.data as PageMentionData) : null;
    onChange({
      id: suggestion.id,
      title: suggestion.label,
      driveId: pageData?.driveId ?? null,
    });
    setOpen(false);
    setQuery('');
  };

  const selectedDriveName = value?.driveId
    ? drives.find((drive) => drive.id === value.driveId)?.name
    : undefined;

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-sm font-medium text-primary">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{value.title}</span>
          {selectedDriveName && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              in {selectedDriveName}
            </span>
          )}
          <button
            type="button"
            aria-label="Clear entry page"
            onClick={() => onChange(null)}
            className="ml-0.5 rounded-sm p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full justify-between font-normal text-muted-foreground',
            invalid && 'border-destructive'
          )}
        >
          Choose a page…
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        <MentionPickerPanel
          items={items}
          loading={loading}
          query={query}
          onQueryChange={setQuery}
          activeTab="pages"
          onTabChange={() => {}}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          onSelectionChange={setSelectedIndex}
          allowedTypes={['page']}
        />
      </PopoverContent>
    </Popover>
  );
}
