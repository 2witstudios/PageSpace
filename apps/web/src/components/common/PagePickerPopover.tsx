'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Check, ChevronDown } from 'lucide-react';
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
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDebounce } from '@/hooks/useDebounce';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/utils/enums';
import { cn } from '@/lib/utils';

interface PageSearchResult {
  id: string;
  label: string;
  type: 'page' | 'user';
  description?: string;
  data?: { pageType?: PageType; mimeType?: string | null };
}

const searchFetcher = async (url: string): Promise<PageSearchResult[]> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to search pages');
  const json: unknown = await res.json();
  return Array.isArray(json) ? (json as PageSearchResult[]) : [];
};

const pageFetcher = async (url: string): Promise<{ id: string; title: string | null }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch page');
  return res.json();
};

function SelectedPageLabel({ pageId }: { pageId: string }) {
  const hasLoadedRef = useRef(false);
  const { data, error } = useSWR(`/api/pages/${pageId}`, pageFetcher, {
    revalidateOnFocus: false,
    onSuccess: () => {
      hasLoadedRef.current = true;
    },
  });
  if (error) return <span className="text-destructive">unavailable</span>;
  return <span className="truncate">{data?.title ?? '…'}</span>;
}

export interface PagePickerPopoverProps {
  driveId: string;
  value: string | null;
  onChange: (pageId: string | null) => void;
  /** Restrict results to a single pages.type, e.g. 'CANVAS' for a 404-page picker. */
  pageType?: PageType;
  /** Restrict FILE results to image mime types — for OG image / favicon pickers. */
  imageOnly?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Generic "pick a page in this drive" popover, reused for the custom 404 page
 * picker (pageType='CANVAS') and the OG image / favicon pickers
 * (pageType='FILE', imageOnly). Built on the same Popover + Command shape as
 * `TriggerPagePicker`, backed by the same `/api/mentions/search` endpoint with
 * its `pageType`/`imageOnly` filters.
 */
export function PagePickerPopover({
  driveId,
  value,
  onChange,
  pageType,
  imageOnly,
  placeholder,
  disabled,
}: PagePickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  const searchKey = open && driveId
    ? `/api/mentions/search?q=${encodeURIComponent(debouncedQuery)}&driveId=${driveId}&types=page`
      + (pageType ? `&pageType=${pageType}` : '')
      + (imageOnly ? '&imageOnly=true' : '')
    : null;
  const { data: results = [], isLoading } = useSWR(searchKey, searchFetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const searching = isLoading || query !== debouncedQuery;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const handleSelect = (id: string) => {
    onChange(id === value ? null : id);
    setOpen(false);
  };

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
              {pageType && <PageTypeIcon type={pageType} className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              {value ? (
                <SelectedPageLabel pageId={value} />
              ) : (
                <span className="text-muted-foreground">{placeholder ?? 'Select a page…'}</span>
              )}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search pages…" value={query} onValueChange={setQuery} />
            <CommandList onWheel={(e) => e.stopPropagation()}>
              <CommandEmpty>{searching ? 'Searching…' : 'No pages found.'}</CommandEmpty>
              {results
                .filter((r) => r.type === 'page')
                .map((page) => {
                  const isSelected = page.id === value;
                  const isImage = imageOnly && page.data?.mimeType?.startsWith('image/');
                  return (
                    <CommandItem
                      key={page.id}
                      value={page.id}
                      onSelect={() => handleSelect(page.id)}
                    >
                      {isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/files/${page.id}/thumbnail`}
                          alt=""
                          className="mr-2 h-6 w-6 rounded object-cover shrink-0 bg-muted"
                        />
                      ) : (
                        <PageTypeIcon
                          type={page.data?.pageType ?? PageType.DOCUMENT}
                          className="mr-2 h-3.5 w-3.5 text-muted-foreground shrink-0"
                        />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{page.label}</span>
                        {page.description && (
                          <span className="truncate text-xs text-muted-foreground">{page.description}</span>
                        )}
                      </div>
                      {isSelected && <Check className="ml-2 h-4 w-4 shrink-0" />}
                    </CommandItem>
                  );
                })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value && (
        <div className="flex">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
