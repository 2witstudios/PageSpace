'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search, Hash, ChevronRight } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import { ThreadUnreadBadge } from '@/components/inbox/ThreadUnreadBadge';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface ChannelsCenterListProps {
  driveId?: string;
}

export default function ChannelsCenterList({ driveId }: ChannelsCenterListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const hasLoadedRef = useRef(false);

  const apiUrl = driveId
    ? `/api/inbox?type=channel&driveId=${driveId}&limit=20`
    : '/api/inbox?type=channel&limit=20';

  useInboxSocket({ driveId, hasLoadedRef });

  const { data, error, isLoading } = useSWR<InboxResponse>(apiUrl, fetcher, {
    refreshInterval: 0,
    isPaused: () => hasLoadedRef.current && isEditingActive(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: false,
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

  const loadMore = async () => {
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
      console.error('Failed to load more channels:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredItems = allItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
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
      <div className="flex-shrink-0 px-4 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Hash className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Channels</h1>
            <p className="text-sm text-muted-foreground">
              {driveId ? 'Channels in this drive' : 'Channels across your drives'}
            </p>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 pl-9 bg-muted/50"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2">
          {isLoading && filteredItems.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              Loading...
            </div>
          )}

          {!isLoading && filteredItems.length === 0 && (
            <div className="py-12 text-center">
              <Hash className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-1">No channels yet</h3>
              <p className="text-muted-foreground text-sm">
                {driveId ? 'No channels in this drive' : 'Channels will appear here'}
              </p>
            </div>
          )}

          {filteredItems.map((item) => (
            <Link
              key={`${item.type}-${item.id}`}
              href={itemHref(item)}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer group',
                item.unreadCount > 0 && 'bg-accent/30'
              )}
            >
              <div className="h-11 w-11 flex-shrink-0 rounded-full bg-muted flex items-center justify-center">
                <Hash className="h-5 w-5 text-muted-foreground" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className={cn(
                    'text-sm truncate',
                    item.unreadCount > 0 ? 'font-semibold' : 'font-medium'
                  )}>
                    #{item.name}
                  </p>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.lastMessageAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })}
                      </span>
                    )}
                    <ThreadUnreadBadge source="channel" contextId={item.id} />
                    {item.unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                        {item.unreadCount}
                      </span>
                    )}
                  </div>
                </div>

                {!driveId && item.driveName && (
                  <p className="text-xs text-muted-foreground mb-0.5">
                    in {item.driveName}
                  </p>
                )}

                {item.lastMessagePreview && (
                  <p className={cn(
                    'text-sm truncate',
                    item.unreadCount > 0 ? 'text-foreground/80' : 'text-muted-foreground'
                  )}>
                    {item.lastMessageSender && (
                      <span className="font-medium">{item.lastMessageSender}: </span>
                    )}
                    {item.lastMessagePreview}
                  </p>
                )}
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
            </Link>
          ))}

          {!searchQuery && pagination?.hasMore && (
            <button
              onClick={loadMore}
              disabled={isLoadingMore}
              className="w-full p-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {isLoadingMore ? 'Loading...' : 'Load more channels'}
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
