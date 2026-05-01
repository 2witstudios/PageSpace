'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Check, ChevronDown, FileText, X } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';

interface PageSuggestion {
  id: string;
  label: string;
  type: 'page' | 'user';
  description?: string;
}

const searchFetcher = async (url: string): Promise<PageSuggestion[]> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to search pages');
  const json: unknown = await res.json();
  return Array.isArray(json) ? (json as PageSuggestion[]) : [];
};

const pageFetcher = async (url: string): Promise<{ id: string; title: string | null }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch page');
  return res.json();
};

interface SingleProps {
  driveId: string;
  mode: 'single';
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

interface MultiProps {
  driveId: string;
  mode: 'multi';
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  max?: number;
}

type Props = SingleProps | MultiProps;

function PageLabel({ pageId }: { pageId: string }) {
  const { data, error } = useSWR(`/api/pages/${pageId}`, pageFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  if (error) return <span className="text-destructive">unavailable</span>;
  return <span className="truncate">{data?.title ?? '…'}</span>;
}

export function TriggerPagePicker(props: Props) {
  const { driveId, mode, placeholder, disabled } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const searchKey = open && driveId
    ? `/api/mentions/search?q=${encodeURIComponent(query)}&driveId=${driveId}&types=page`
    : null;
  const { data: results = [], isLoading: searching } = useSWR(searchKey, searchFetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const selectedIds = useMemo(
    () => new Set(mode === 'multi' ? props.value : props.value ? [props.value] : []),
    [mode, props.value],
  );

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const handleSelect = (id: string) => {
    if (mode === 'single') {
      props.onChange(id === props.value ? null : id);
      setOpen(false);
      return;
    }
    const next = props.value.includes(id)
      ? props.value.filter((x) => x !== id)
      : [...props.value, id];
    if (props.max && next.length > props.max) return;
    props.onChange(next);
  };

  const handleRemove = (id: string) => {
    if (mode === 'single') {
      props.onChange(null);
    } else {
      props.onChange(props.value.filter((x) => x !== id));
    }
  };

  const triggerLabel =
    mode === 'single'
      ? props.value
        ? <PageLabel pageId={props.value} />
        : <span className="text-muted-foreground">{placeholder ?? 'Select a page…'}</span>
      : <span className="text-muted-foreground">{placeholder ?? 'Add pages…'}</span>;

  const atMax = mode === 'multi' && props.max !== undefined && props.value.length >= props.max;

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'w-full justify-between font-normal',
              disabled && 'pointer-events-none opacity-60',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {triggerLabel}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search pages…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {searching ? 'Searching…' : 'No pages found.'}
              </CommandEmpty>
              {results
                .filter((r) => r.type === 'page')
                .map((page) => {
                  const isSelected = selectedIds.has(page.id);
                  const blocked = !isSelected && atMax;
                  return (
                    <CommandItem
                      key={page.id}
                      value={page.id}
                      disabled={blocked}
                      onSelect={() => !blocked && handleSelect(page.id)}
                      className={cn(blocked && 'opacity-50')}
                    >
                      <FileText className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{page.label}</span>
                        {page.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {page.description}
                          </span>
                        )}
                      </div>
                      {isSelected && <Check className="ml-2 h-4 w-4" />}
                    </CommandItem>
                  );
                })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {mode === 'multi' && props.value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {props.value.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="max-w-[14rem] gap-1 pr-1"
            >
              <PageLabel pageId={id} />
              <button
                type="button"
                onClick={() => handleRemove(id)}
                disabled={disabled}
                className="ml-1 rounded p-0.5 hover:bg-muted-foreground/10"
                aria-label="Remove page"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {props.max !== undefined && (
            <span className="text-xs text-muted-foreground self-center">
              {props.value.length} / {props.max}
            </span>
          )}
        </div>
      )}

      {mode === 'single' && props.value && (
        <div className="flex">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => handleRemove(props.value!)}
            disabled={disabled}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
