'use client';

import { useState, useEffect, useRef } from 'react';
import Link from '@/retained-adapters/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search, Hash } from 'lucide-react';

import { ScrollArea } from '@/retained/components/ui/scroll-area';
import { Input } from '@/retained/components/ui/input';
import { cn } from '@/retained/lib/utils';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useInboxSocket } from '@/retained/hooks/useInboxSocket';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { ThreadUnreadBadge } from '@/retained/components/inbox/ThreadUnreadBadge';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

const ALL_DRIVES = '';

interface ChannelsCenterListProps {
  driveId?: string;
}

export default function ChannelsCenterList({ driveId }: ChannelsCenterListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [driveFilter, setDriveFilter] = useState(ALL_DRIVES);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const hasLoadedRef = useRef(false);

  const apiUrl = driveId
    ? `/api/inbox?type=channel&driveId=${driveId}&limit=20`
    : '/api/inbox?type=channel&limit=20';

  useInboxSocket({ cacheKey: apiUrl, scope: 'channel', driveId, hasLoadedRef });

  const { data, error, isLoading } = useSWR<InboxResponse>(apiUrl, fetcher, {
    refreshInterval: 0,
    isPaused: () => hasLoadedRef.current && useEditingStore.getState().isAnyEditing(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: true,
  });

  // Reset state on driveId change BEFORE the data-sync effect so that an
  // SWR cache hit for the new drive can repopulate the list in the same
  // commit (otherwise the clear would run after, leaving the list empty).
  useEffect(() => {
    setAllItems([]);
    setPagination(null);
    setIsLoadingMore(false);
    setHasLoadedMore(false);
  }, [driveId]);

  useEffect(() => {
    if (!data) return;
    if (hasLoadedMore) {
      setAllItems((prev) => {
        const firstPageIds = new Set(data.items.map((item) => `${item.type}-${item.id}`));
        const additionalItems = prev.filter((item) => !firstPageIds.has(`${item.type}-${item.id}`));
        const merged = [...data.items, ...additionalItems];
        merged.sort((a, b) => {
          if (!a.lastMessageAt && !b.lastMessageAt) return 0;
          if (!a.lastMessageAt) return 1;
          if (!b.lastMessageAt) return -1;
          return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
        });
        return merged;
      });
    } else {
      setAllItems(data.items);
      setPagination(data.pagination);
    }
  }, [data, hasLoadedMore]);

  // Follows the inbox cursor; the next page is appended to the loaded rows.
  const loadOlder = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const url = `${apiUrl}&cursor=${pagination.nextCursor}`;
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const moreData: InboxResponse = await response.json();

      setAllItems((prev) => {
        const existingIds = new Set(prev.map((item) => `${item.type}-${item.id}`));
        const newItems = moreData.items.filter((item) => !existingIds.has(`${item.type}-${item.id}`));
        return [...prev, ...newItems];
      });
      setPagination(moreData.pagination);
      setHasLoadedMore(true);
    } catch (err) {
      console.error('Failed to load older channels:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Drive options come from the rows loaded so far, so the list never offers a drive it cannot show.
  const drives = Array.from(
    new Map(
      allItems
        .filter((item): item is InboxItem & { driveId: string } => Boolean(item.driveId))
        .map((item) => [item.driveId, item.driveName ?? 'Unnamed drive'] as const),
    ),
  );

  const query = searchQuery.trim().toLowerCase();
  const filteredItems = allItems.filter(
    (item) =>
      (!query || item.name.toLowerCase().includes(query)) &&
      (driveFilter === ALL_DRIVES || item.driveId === driveFilter) &&
      (!unreadOnly || item.unreadCount > 0),
  );

  const itemHref = (item: InboxItem) =>
    driveId
      ? `/dashboard/${driveId}/${item.id}`
      : `/dashboard/channels/${item.id}`;

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Hash className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Failed to load channels</h2>
          <p className="text-muted-foreground">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
      <div className="flex-shrink-0 px-4 pt-6 pb-4 space-y-4">
        <div>
          <h1 className="text-[30px] leading-tight font-bold tracking-tight">Channels</h1>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
            Every channel you can read, across all your drives, newest first.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="relative flex-1 basis-[260px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search channels"
              placeholder="Search channels"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 pl-9 bg-muted/50"
            />
          </label>
          <select
            aria-label="Drive"
            value={driveFilter}
            onChange={(e) => setDriveFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value={ALL_DRIVES}>All drives</option>
            {drives.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((on) => !on)}
            className={cn(
              'h-9 rounded-md border px-3 text-sm transition-colors',
              unreadOnly ? 'border-primary bg-primary/10 font-medium' : 'border-input text-muted-foreground hover:text-foreground',
            )}
          >
            Unread
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 pb-6">
          {isLoading && allItems.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              Loading...
            </div>
          )}

          {!isLoading && allItems.length === 0 && (
            <div className="py-12 text-center">
              <Hash className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-1">No messages yet</h3>
              <p className="text-muted-foreground text-sm">Channels will appear here</p>
            </div>
          )}

          {allItems.length > 0 && filteredItems.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No channels match these filters
            </div>
          )}

          {filteredItems.length > 0 && (
            <div role="table" aria-label="Channels" className="overflow-hidden rounded-xl border border-border">
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_140px_90px] gap-3 border-b border-border bg-muted/40 px-3.5 py-2 text-xs font-medium text-muted-foreground"
              >
                <span role="columnheader">Channel</span>
                <span role="columnheader">Drive</span>
                <span role="columnheader" className="text-right">Last message</span>
              </div>

              {filteredItems.map((item) => (
                <Link
                  key={`${item.type}-${item.id}`}
                  href={itemHref(item)}
                  role="row"
                  className={cn(
                    'grid grid-cols-[minmax(0,1fr)_140px_90px] items-center gap-3 border-b border-border/60 px-3.5 py-2.5 transition-colors hover:bg-accent/50 last:border-b-0',
                  )}
                >
                  <span role="cell" className="flex min-w-0 items-center gap-2.5">
                    <Hash className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2">
                        <span className={cn('truncate text-sm', item.unreadCount > 0 ? 'font-semibold' : 'font-medium')}>
                          {item.name}
                        </span>
                        <ThreadUnreadBadge source="channel" contextId={item.id} />
                        {item.unreadCount > 0 && (
                          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                            {item.unreadCount}
                          </span>
                        )}
                      </span>
                      {item.lastMessagePreview && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.lastMessageSender && <span className="font-medium">{item.lastMessageSender}: </span>}
                          {item.lastMessagePreview}
                        </span>
                      )}
                    </span>
                  </span>

                  <span role="cell" className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                    {item.driveName && (
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold text-foreground">
                        {item.driveName.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate">{item.driveName ?? ''}</span>
                  </span>

                  <span role="cell" className="text-right text-xs text-muted-foreground">
                    {item.lastMessageAt
                      ? formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })
                      : ''}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {pagination?.hasMore && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={isLoadingMore}
              className="mt-3 h-8 rounded-md border border-input px-3 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {isLoadingMore ? 'Loading...' : 'Load older'}
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
