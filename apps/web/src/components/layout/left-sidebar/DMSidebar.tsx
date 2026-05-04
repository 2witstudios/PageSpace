'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { cn, isElectron } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import DashboardFooter from './DashboardFooter';
import PrimaryNavigation from './PrimaryNavigation';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

const API_URL = '/api/inbox?type=dm&limit=20';

export default function DMSidebar({ className }: SidebarProps) {
  const pathname = usePathname();
  const [searchQuery, setSearchQuery] = useState('');
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const [isElectronMac, setIsElectronMac] = useState(false);
  const isSheetBreakpoint = useBreakpoint('(max-width: 1023px)');
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

  const { hasLoadedRef } = useInboxSocket({});

  const { data, error } = useSWR<InboxResponse>(API_URL, fetcher, {
    refreshInterval: 0,
    isPaused: () => hasLoadedRef.current && isEditingActive(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: false,
  });

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

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  const loadMore = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const url = `${API_URL}&cursor=${pagination.nextCursor}`;
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const moreData: InboxResponse = await response.json();
      setAllItems((prev) => {
        const existingIds = new Set(prev.map((item) => `${item.type}-${item.id}`));
        const newItems = moreData.items.filter(
          (item) => !existingIds.has(`${item.type}-${item.id}`)
        );
        return [...prev, ...newItems];
      });
      setPagination(moreData.pagination);
      setHasLoadedMore(true);
    } catch (err) {
      console.error('Failed to load more DMs:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredItems = allItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const itemHref = (item: InboxItem) => `/dashboard/dms/${item.id}`;

  const isItemActive = (item: InboxItem) => {
    const href = itemHref(item);
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden',
        className
      )}
    >
      <div className="flex h-full flex-col px-3 py-3">
        <div className={cn('mb-3', isElectronMac && isSheetBreakpoint && 'pl-[60px]')}>
          <DriveSwitcher />
        </div>

        <PrimaryNavigation />

        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1">
            {error && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Failed to load DMs
              </div>
            )}

            {!error && filteredItems.length === 0 && !data && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Loading...
              </div>
            )}

            {!error && filteredItems.length === 0 && data && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No conversations yet
              </div>
            )}

            {filteredItems.map((item) => {
              const isActive = isItemActive(item);
              return (
                <Link
                  key={`${item.type}-${item.id}`}
                  href={itemHref(item)}
                  onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
                  className={cn(
                    'flex items-start gap-3 p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer',
                    isActive && 'bg-accent'
                  )}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarImage src={item.avatarUrl || ''} />
                    <AvatarFallback className="text-xs">
                      {item.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm truncate flex-1">{item.name}</p>
                      {item.unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                          {item.unreadCount}
                        </span>
                      )}
                    </div>

                    {item.lastMessageAt && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span>
                          {formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })}
                        </span>
                      </div>
                    )}

                    {item.lastMessagePreview && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {item.lastMessagePreview}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}

            {!searchQuery && pagination?.hasMore && (
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="w-full p-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {isLoadingMore ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        </ScrollArea>

        <DashboardFooter />
      </div>
    </aside>
  );
}
